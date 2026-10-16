# T2/T3 宿主半：方案对比与取舍（writer-storage）

> 依据：docs/protocol-v1.md（已冻结）、docs/design-v1.md，以及本机 DSH 0.2.0-rc.2 的真实契约文件。
> 结论先说：存储用「per-record 一张表、key=sessionId」，纯逻辑独立成 lib/resolve.js，
> 域用官方 defineDomain + domainTable 声明，存储不可用降级为内存并在桥上用 503 明示。

## 1. 存储布局：per-record 一张表 vs 单文档一张表

| | (a) per-record（选中） | (b) 单文档单表 |
|---|---|---|
| 落盘 | 一会话一个文件 storages/session_settings/sessions/<sessionId>.json | 一个文件装全部会话 |
| 写放大 | 只重写被改会话 | 每写一次重写全部会话 |
| 并发 | 域内 update 写链按 key 串行；不同会话互不阻塞 | 单文档 = 全局串行 |
| 单条损坏 | invalidRecords: backup-and-skip 只搬走坏的那条 | 整个文档失效，全部会话的配置一起没 |
| 回收 | 直接 delete 一个 key | 需读改写整表 |
| 代价 | key 必须 path-safe（/^[a-zA-Z0-9_-]+$/） | 无此约束 |

选 (a)：会话配置天然按会话稀疏、单条可弃（设计稿 3.2 的定位就是「派生数据 + 可单独回收」），
正好命中 storage-domain 对 per-record 的定义。代价用 lib/store.js 的 assertStorageKey 显式吃掉：
sessionId 不匹配该正则就抛 bad-request（真实 DSH sessionId 是 UUID，永远匹配），
绝不做 hash 改名——key=sessionId 是协议第 5 节写死的。

## 2. 纯逻辑分层：lib/resolve.js 独立 vs 全塞进 index.js

选「独立成 lib/resolve.js」，理由是可测性而不是洁癖：
- 两层解析、稀疏合并、对账差集是唯一容易悄悄写错的地方（例如「写入值等于默认值要删覆盖」的深比较、
  「插件 map 空了要删键」、空 values 要删整条记录），这些规则必须能在 node:test 里裸测；
- 而 store/bridge 依赖 ctx、node:http、官方域，必须有假的 Cordis ctx 和假表才能测。
- 实际收益：tests/resolve.spec.mjs 23 条用例零依赖秒跑；tests/store.spec.mjs 与 tests/host.spec.mjs
  各自只造最小的假对象。
- 反面代价：多一个文件、多一层 import。对三百多行的逻辑来说是划算的。

分层结果：resolve.js（纯函数，零 import）→ store.js（域 + 内存降级）→ bridge.js（HTTP/fence）→ index.js（Cordis 装配）。

## 3. 错误码放哪：resolve.js

协议第 6 节的错误码表与 SessionSettingsError 放在 resolve.js，因为它是三方共用的叶子模块
（index.js 抛、bridge.js 映射、测试断言）。放在 index.js 会造成 bridge ← index 的循环依赖；
单独开 lib/errors.js 又会超出本任务的文件归属（只允许 index/store/resolve/bridge/trust-fence）。

## 4. 域声明：官方 defineDomain + domainTable

按 Lead 的指示用官方 helper，不手写字面量：defineDomain 会在模块加载期校验域名正则、version 为
非负整数、layout/invalidRecords 取值、表名正则；domainTable(schema) 只是 valueSchema 的载体。
record schema 用 zod 描述协议第 5 节记录形状；values 用两层 record，
zod 默认剥离未声明的键，所以手工塞进文档的垃圾字段不会流进内存。

依赖解析：Lead 已在插件目录装好 node_modules（zod 4.6.6、@deepseek-ai/dsh-storage-domain 0.2.0-rc.2）。
本插件是符号链接进 profile 的，Node 按真实路径解析模块，所以宿主半的每个 import 都必须能从
D:/projects/dsh-plugins/dsh-session-settings/node_modules 解析——这也是为什么这两条 import 依赖本地安装。

## 5. 写路径：get 判存在 + put / update + missing-key 重试

官方 table.update(key, fn) 对不存在的 key 抛 DomainError('missing-key')（domain.d.ts 71-77 行、
lib/index.js 280 行），所以「新会话第一次写入」不能直接 update。lib/store.js 的 mutate：
1. 先用同步的 table.get 看记录在不在：不在就 put 完整记录（空记录不落盘），在就走 update 原子读改写；
2. update 因 missing-key 失败（并发 reset 把记录删了）时重试，最多 3 次；
3. update 之后如果结果记录为空，再确认一次当前内存状态仍为空才 delete——避免删掉排队写刚写进去的值。
写链由域自己保证串行，我们的重试只覆盖「读和队列槽之间记录消失」这一个窗口。
单测：tests/store.spec.mjs 的「after attach, writes go through the domain (put then update…)」
（断言首次是 put、第二次是 update、清空走 delete）与「a record deleted between read and update is
recreated instead of failing」（人为让 update 抛一次 missing-key）。

## 6. 桥只依赖服务，不直接碰 store

桥不直接碰 store：index.js 的服务多了一个 snapshot(sessionId)（协议第 3 节方法表的附加项，不是桥方法），
由它调用 resolve.buildSnapshot。好处是桥只依赖服务接口，测试里可以用纯桩替换，装配层是唯一知道
「注册表 + 存储」两半怎么合起来的地方。

## 7. 存储不可用：内存降级 + values.* 返回 503

任务书要求「storageDomain 不可用时降级为内存，并通过明确状态暴露，绝不静默假装持久化」，
协议第 1/6 节又要求「宿主能力缺失 → 503 storage-unavailable」。两者的调和方式是按能力分方法：

- 宿主进程内服务（ctx.sessionSettings）：降级后继续可用（写内存），status() 明说 backend=memory 与原因；
- 桥：registrations.list 只需要注册表，照常 200，页面能渲染出骨架；
- 桥的 values.*：durable=false 时返回 503 storage-unavailable，错误消息写明
  「in-memory, lost on restart」——这正是设计稿 6.5「存储不可用 → 顶部错误条 + 只读」的输入，
  页面把 message 显示出来就等于「重启即丢」的告知，而不是假装写成功。

被否掉的备选：**整条桥都降级**——values.get/set 在内存模式下照常 200，页面正常工作、
只挂一条「重启即丢」提示。否掉的理由（Lead 裁决，已写进设计稿 7 节，与本节一致）：
让用户以为改得动、重启就丢，比直接拒绝更糟。所以桥对 values.* 一律 503，页面进只读错误态；
宿主进程内服务则保留内存降级（任务书要求「降级并在状态里明示」，status() 会说 backend=memory 与原因），
两件事不矛盾：一个是对同进程消费方的可用性，一个是对浏览器用户的诚实性。

## 8. 对账：sessionPersistence.list() + 低频

绝不用 session/disposed（切会话就触发，拿它删数据等于事故）。启动时跑一次，
之后由桥的请求驱动、间隔见 RECONCILE_INTERVAL_MS = 30 分钟；单飞（reconcileInFlight）防止叠加。
归档会话仍在 list() 里，所以永远不会被当成 stale。list() 抛错就整轮跳过并告警，绝不「读失败=全删」。

## 9. 桥：fence 第一行 + own-property 派发

- 顺序固定：fence（403）→ 非 POST（405）→ 路径解析/未知方法（404）→ 读体（400）→ 派发。
  fence 必须在最前面，因为它是唯一防 DNS rebinding / 跨站读写的闸门，未过闸的请求不应得到任何方法存在性信息。
- 派发表是对象字面量，只用 Object.hasOwn 命中，所以 POST .../constructor、.../toString、
  .../hasOwnProperty、.../__proto__ 全部 404（better-sidebar 踩过这个坑）。
- 能力缺失 503 见第 7 节；未知 pluginId/itemKey 由服务抛 400 unknown-plugin/unknown-item；
  其余异常 500 internal。conflict(409) 保留在映射表里，但 v1 客户端不提交版本栅栏，客观上不可达——
  不编造一个假的 409 出来。
- 注册包在 ctx.effect 里（webServer 是后到的服务，用 ctx.inject(['webServer'], …) 等它）。

## 10. trust-fence.js：照抄而不是依赖内部实现

官方 isTrustedApiRequest 不导出（@deepseek-ai/dsh-client-connection 只发 .d.ts，没有导出入口），
因此照 DSH-better-sidebar/src/trust-fence.ts 做等价实现：
Host 必须回环或命中 ctx.webRuntime.trustedHosts（每次请求现读）、sec-fetch-site: cross-site 拒绝、
Origin 必须同 hostname 或等于 dsh-app://app。
bfcache 的媒体例外（GET /sidebar/file + no-cors + image + Referer）原样保留并在注释里写明：
本桥只收 POST，该分支当前不可达，保留是为了让 fence 与官方规则保持等价，将来加 GET 路由时不用重新考古。

## 11. 值校验的边界

只校验「是不是 JSON 值」（拒绝 undefined/函数/NaN/循环），不做 switch/number 的范围与枚举校验。
理由：协议第 2.3 节只规定未知 pluginId/itemKey 是 400，没给「值非法」的错误码；
范围校验属于消费插件自己的语义，宿主越权拒绝会把合法的自定义控件（第二版可能加）锁死。
消费方渲染前能用 min/max/options 自行约束。

## 12. 测试入口（Node 24 的一个坑）

Node 24 执行「node --test <路径>」时把位置参数当模块路径，而不是要扫描的目录，
且默认发现规则不包含 *.spec.mjs（实测：目录参数直接报 Cannot find module）。
所以加了 tests/index.js：目录参数会解析到它，它再动态 import 同目录下所有 *.spec.mjs。
现在三种写法都全绿：node --test tests/、node --test "tests/*.spec.mjs"、node --test "tests/**/*.spec.mjs"。
writer-ui 新加的 tests/client.spec.mjs 也会被自动带上（无需改 index.js）。

---

## Lead 补记（2026-10-13，task-6 之后）

以下两条决定发生在 task-6 期间，因该文件不在 task-6 的归属内，由 Lead 补记：

### 1. 每会话写串行化（取代「不做额外锁」的早期决定）
早期结论是不为新会话并发首写引入额外锁，理由是域写链已串行、只影响首写窗口。R1 独立复现后改判：**严重级**——对全新会话并发 8 次写，只有 1 个覆盖存活（夹具升级为「后端耐久屏障后才改内存」，与官方语义一致）。
最终选择：在 store 层为每个 sessionId 维护一条写队列（writeChains + enqueueWrite），mutate/drop 都入队，`previous.then(task, task)` 保证失败不毒化，尾部 settle 后清理。保留原有 missing-key 重试（队列解决进程内竞态，重试解决持久层记录消失，两者正交）。
未覆盖：跨进程并发写同一 storages 目录仍可能后写覆盖——域没有 upsert/CAS 原语，记为 v2（在记录里加 revision）。

### 2. 对账跳过必须留下可诊断痕迹
早期实现对 sessionPersistence 缺失 / 存储降级两种跳过路径静默 return。R1 记为一般级发现（配置不再回收但运维看不到原因）。
最终选择：warnReconcileDisabled(reason) 按 30 分钟节流写 warn；挂载期用 ctx.loader.await() 落定后检查 reconcileAssembled，未装配则 warn，装配成功打一条 info。所有跳过原因共用一个节流窗（有意防刷屏）。


## 13. pending 重放：可见性、重试与合并优先级（task-10 补记）

前面第 5 节只写了写路径，没写「降级期接受的写入后来怎么样了」。V2 复核（R2-01/R2-02）指出
重放失败的收尾与日志不符，这里把最终语义补全。它属于运维/维护者会踩的地方，不再只活在代码注释里。

### 13.1 pendingReplay 是什么

存储降级（拿不到或打不开 storageDomain）期间，宿主侧服务照常接受写入，值先落在内存 map 里。
之后 storageDomain 到达、attach 成功，这些值会被「重放」进域。凡是还没成功落进域的内存条目，
都算 pending：

- 语义：**已被接受、但尚未耐久**的写入。不是垃圾，不能被静默丢弃。
- 可观测：store.status().pendingReplay = 条目数，store.status().retryScheduled = 重放定时器是否在跑。
  桥不暴露这两个字段（协议只冻结四个方法），页面在降级时走 values.* 的 503 只读态。
- 可见性：readValues() 把 pending 内存值**叠加**在耐久读之上（pending 优先），所以
  service.get / getItem / snapshot 以及走桥的读取都能读回这些值。桥的 values.* 本身在降级时是 503，
  这里说的可见性是「降级已结束、域已打开、只是某些条目还没落盘」这个窗口。

### 13.2 重试策略与日志节流

- 触发时机一：attach（域成功打开）后立刻重放一次。
- 触发时机二：一个低频定时器，间隔 RETRY_INTERVAL_MS = 30 秒（createStore 的 retryIntervalMs 可注入，
  测试用它缩短到毫秒级）。定时器只在 pendingReplay > 0 时存在，清零即停；它注册在插件的 ctx.effect 里，
  插件卸载/HMR 重载会随之取消（unref，不阻止进程退出）。
- 失败不丢：重放失败的条目继续留在内存、继续可见、下次 tick 再试。
- 日志节流：同一会话的失败第一次立刻打一条 error；之后每 RETRY_LOG_INTERVAL_MS（30 秒）或每第 10 次尝试
  才再打一条，文案里带 attempt 次数与真实间隔（"retried every 30s while this plugin is loaded"）。
  这样一条卡住的条目不会按 tick 刷屏。
- 没有可用 ctx.effect（脱离 Cordis 直接调 createStore）时定时器不安装，只保留可见性；
  这种情况会在日志里说明，绝不假装在重试。

### 13.3 合并优先级，以及它的前提

重放把内存记录合并进耐久记录：**逐插件组、逐键，内存侧优先**；耐久侧其它键、其它插件组、
未知顶层字段与 profile 全部保留（updatedAt 刷新为当前时间）。

前提是「内存那份比耐久新」——降级期间域是关着的，写不了，所以一般情况下成立。
但重放失败后内存会长期停在**旧快照**，而域仍在接受新写。这条前提就不成立了。
处理方式（R2-02）：

- 仍然内存优先（已接受的写入不能被丢掉），但比较 existing.updatedAt 与 pending.updatedAt；
- 耐久侧更新时，在 update **成功之后**打一条 warn，点名被覆盖的键（pluginId/itemKey），
  例如 "overwrites overrides that the durable record changed later (durable updatedAt 500 > pending 100), keys: p/k"；
- 之所以在成功后才 warn：失败的 update 什么都没覆盖，先 warn 就是假警报。

更好的做法（v2）是给重放条目记 tombstone / 用 revision 做 CAS，而不是靠时间戳猜谁新。

### 13.4 降级期的「删除」不可表达（已知缺口）

降级读看不到耐久记录，所以降级期的一次 reset 在内存里表现为「这个键不在内存里」，而不是
「耐久里这个键被删了」。后果：如果该键在耐久侧本来有覆盖，合并时它会被保留下来——用户以为
恢复默认了，重启后旧覆盖又出现（实测 kA/kB 会复活）。

这是有意的取舍：宿主无法区分「降级期没碰过这个键」和「降级期把它删了」，而把已接受的写入
按缺失键补齐（内存优先）比猜测删除意图更安全。要根治需要 v2 在记录里加 tombstone（记录本会话
在降级期删除过的键），这是存储形状变更。

另外，降级期「写入值 == 默认值」会让内存记录变空并从 map 移除，连重放的痕迹都不剩，
效果与上面同类：耐久侧的旧覆盖会保留。

### 13.5 多实例写同一个 storages 根的残留风险

storages 根是全 DSH_HOME 共享的（非 profile 级），sessionId 全局唯一所以按会话分键不撞，
但两个 DSH 进程同时写同一个会话时：

- per-session 写队列只在**进程内**串行，跨进程不生效；
- 域本身不提供 upsert/CAS 原语，两边各自 table.get + put/update 时仍是后写覆盖；
- 一个进程里 pending 的降级写入，另一个进程完全看不见（那是它的内存）。

结论：单实例（正常使用）没有问题；多实例并发写同一会话属于已知未解决场景，记为 v2（记录里加
revision 做 CAS，或让域提供 upsert）。对账要特别小心：它只按 sessionPersistence.list() 的差集删记录，
不会因为「另一个进程正在写」而误删，但两个进程各自的对账不会互相协调。

### 13.6 pending 窗口内的「写」与「删」：修复后的语义（V3-01 / V3-02）

13.1 说 pending 叠加在耐久之上、读得到；但第一版只有**读路径**认这份叠加，写路径（mutateNow）与
删除路径（dropNow）只看耐久记录，于是同一个窗口里读与写自相矛盾：

- 把某键写回它的默认值（协议 2.3 的稀疏删除）删不掉 pending 覆盖，读回仍是 pending 旧值；
- reset(plugin, item) 同样无效；
- resetSession / 对账删掉了耐久记录，值却仍可读，且下一个重放 tick 会把记录**写回磁盘**（复活）；
- 用户写一个更新的值时读回旧 pending 值，随后重放又用旧值盖掉这个更新的耐久写入。

修复后的规则（lead 裁定，写在这里作为契约）：

1. **有效记录 = 耐久记录叠加 pending 条目（pending 优先）**。写路径在队列槽内基于有效记录执行
   transform 与稀疏规则，所以「写默认值 = 删覆盖」「reset」在 pending 键上真的生效。
2. **一次成功的写会把该会话的 pending 条目退役**：有效状态已经落盘，继续留着旧快照只会在下一个
   tick 覆盖这次写入。退役后 pendingReplay 减一，减到 0 时重试定时器停掉。
3. **dropNow 同时清掉 pending 键**（耐久删除成功之后才清），条目清空即删；因此 resetSession 与
   对账的删除都是真的删除，不会复活。删除失败时 pending 保留（宁可留着重试，也不静默丢掉）。
4. **对账的删除因此名副其实**：日志仍旧是 "reconciliation removed N record(s)"，而 store 会在同一次
   drop 里补一条 "dropped 1 pending override set of session ... together with its durable record"，
   两行合起来
   如实反映「耐久和 pending 一起清了」。活跃（仍存在的会话）pending 会话仍不会被误删。
5. 域未就绪时的写入行为不变：仍然进内存、桥仍是 503 只读（协议 v1.1）。

**仍未解决**：13.4 的缺口不受本节影响——降级期（域还关着，等价于没有耐久基线可看）的删除意图
依然不可表达；本节修的是「域已打开、只是某些条目 pending」这一段，此时耐久基线是可读的，所以
写/删必须在它上面正确执行。要根治 13.4 仍需 v2 的 tombstone/revision。

**怎么证明不复活**：单测把重试间隔缩到 10ms，在 pending 状态下 drop 该会话，然后等 60ms（≈6 个 tick）
再断言耐久记录仍不存在、读取仍为空（tests/store.spec.mjs「resetSession clears the pending copy and the
record never comes back」）；宿主层再用真实 service.resetSession / 对账各验一遍（tests/host.spec.mjs）。

**一个写路径的对称后果（V4-02，必须知道）**：一次写让「有效记录变空」时，代码先 update 成空记录、
再 table.delete 兜底（协议 5：values 空 → 删整条）。如果这条 delete 失败，整次写入会 **reject**
（调用方看得到，不静默），但按上面第 3 条规则 pending 会保留——于是下一个重放 tick 可能把用户刚做的
reset **撤销**：旧 pending 又合并回耐久记录。实测（V3 夹具 D4）：写入 reject 之后读回
{"p":{"kC":300}}，pending 仍为 1，下个 tick 把记录写回。

这与 drop 的失败语义是同一条取舍的两面：**宁可留着重试，也不静默丢掉已接受的状态**。
代价是「失败之后状态可能回退一次」，而不是「失败被吞掉」。运维看到的是：error 日志 + pendingReplay 非零
（重试仍在继续），而不是一个看起来成功的 reset。

**日志口径（V4-01）**：drop 的 info 现在按事实分支——两者都删时说
"dropped 1 pending override set of session ... together with its durable record"，
只有 pending 时说 "... (no durable record existed)"。只删到耐久记录时不额外打这行
（对账自己那行 "reconciliation removed N record(s)" 已经覆盖）。
