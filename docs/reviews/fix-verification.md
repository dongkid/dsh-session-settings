# V2 修复复核报告（task-9）

> 复核对象：task-7（F1：重放合并 + 队列、默认值 clone、测试注释）与 task-8（F2：头部三档回退 + 标准 props 转发）。
> 复核者：verifier-2。全新独立代理，未参与 T2–T8，也未参与 R1/V1。
> 纪律：**不引用任何人的输出当证据**。下面每条结论都来自我自己打开的代码、我自己写的夹具、我自己跑的命令。
> 我的夹具全部在 D:/projects/tmp/v2-harness/；产品目录一个字节未改（见 §0.2 的前后哈希）。
> 硬性禁令遵守情况：未改任何产品文件；未使用任何浏览器 / chrome-devtools 工具；未运行 plugin_manager；未写 ~/.dsh。

## 0. 基线与冻结校验

### 0.1 我复核的代码版本（开工时实测）

| 文件 | 最后写入 | SHA256/16 |
|---|---|---|
| lib/bridge.js | 2026-10-13 00:31:57 | A53F889FE6E4456E |
| lib/client.js | 2026-10-13 01:07:29 | CD8F32102B99CBCD |
| lib/index.js | 2026-10-13 00:42:27 | A6E38F98561BB060 |
| lib/resolve.js | 2026-10-13 01:06:08 | 5EA79C92415269FB |
| lib/store.js | 2026-10-13 01:08:26 | C80CD516626D25E9 |
| lib/trust-fence.js | 2026-10-13 00:31:32 | D03C9FD4FB0061FF |
| tests/store.spec.mjs | 2026-10-13 01:06:35 | 0820E41B5328BCE5 |
| tests/host.spec.mjs | 2026-10-13 01:07:18 | 7AC02DC5A6504EC2 |
| tests/client.spec.mjs | 2026-10-13 01:06:47 | 24E150AB04606B93 |
| tests/resolve.spec.mjs | 2026-10-13 01:06:52 | 49604508206B956C |
| tests/bridge.spec.mjs | 2026-10-13 00:36:57 | 24BA694A1C011C41 |
| package.json | 2026-10-13 01:04:17 | 968BE2BD2DF27007 |

### 0.2 复核结束时重新哈希：**全部与开工时逐字节一致**

结论：我复核的是一份冻结的代码，我本人没有改动产品目录里的任何文件。

### 0.3 我写的夹具（全部自己写，放在 D:/projects/tmp/v2-harness/）

| 文件 | 作用 |
|---|---|
| domain-stub.mjs | 照**官方已发布契约**（读同步 / 写先耐久后改内存 / update 对缺失 key 抛 missing-key）自写的域桩，不是我拍的语义 |
| store-probes.mjs | A/B/C 复现 + 边界 a/b/c + 失败隔离 + 陈旧内存覆盖 |
| extra-probes.mjs | 两个我自己想到的时序边界（降级期入队但表已发布后才执行；drop 与 attach 同 tick） |
| clone-probes.mjs / host-mount.mjs | 用最小假 ctx 挂**真实** lib/index.js，驱动 get/getItem/snapshot/桥四个出口 |
| client-probes.mjs | 自写 mini-React + loader 桩，驱动**真实** lib/client.js，含 hook 顺序探针 |
| http-fence-probe.mjs | 真 node:http + 裸 socket，复核上一轮的假警报 |
| cf/ | 反事实检验用的**副本**目录（lib/tests/docs/package.json 的拷贝 + 指向产品 node_modules 的 junction）。产品目录未被触碰 |

---

## 1. 逐条结论

### 1.1 F1 三段 A/B/C：**成立**（修复真的生效）

命令：node D:/projects/tmp/v2-harness/store-probes.mjs（SECTION 1）

     PASS  A degraded status is memory/not durable  :: {"durable":false,"backend":"memory","pendingReplay":1}
     PASS  A one write in flight at the race point  :: ["put:s1"]
     PASS  A pendingReplay is 1 while the replay is in flight  :: pendingReplay=1
     PASS  A both keys survive  :: {"race":{"kA":100,"kB":200}}
     PASS  A replay put then racing update (serialized)  :: ["put:s1","update:s1"]
     PASS  A pendingReplay settles to 0
     PASS  B durable keys preserved and merged  :: {"race":{"kA":11,"kC":300},"other":{"keep":true}}
     PASS  B durable profile preserved  :: "web"
     PASS  B merged through update, never put  :: ["update:s1"]
     PASS  C fresh record created by the replay  :: {"race":{"kC":300}}
     PASS  C one put, no update  :: ["put:s1"]

判断依据：

- **A**：我在重放的 put 已在飞（durability 屏障卡住）时插入一条同会话持久写。最终写日志是 ["put:s1","update:s1"] 而不是旧代码的两次 put —— 这条日志就是「重放与 mutate 共用同一条 per-session 队列」的直接证据（lib/store.js:203-239 的 entries.map(... enqueueWrite(sessionId, ...))）。kA、kB 都在。
- **B**：这是上一轮 V1 发现的「不需要并发也会丢」的路径。既存耐久记录 {kA:11, q:{keep:true}} 与降级期写入 kC:300 合并成 {kA:11,kC:300,keep:true}，且走的是 update 而非 put（不是覆盖重建），profile:"web" 保留。
- **C**：无既存记录时正常 put 建记录，profile 带上。

与修复者声称的分歧：**无**。task-7 描述的三条（同一队列、槽内重读后 merge、无记录才 put）与实测完全一致。

### 1.2 边界 (a)：重放进行中并发 mutate/drop 同一会话：**成立**

命令同上（SECTION 2）+ node D:/projects/tmp/v2-harness/extra-probes.mjs

     PASS  a1 replay and racing write both go through update  :: ["update:s1","update:s1"]
     PASS  a1 merged result keeps every key  :: {"p":{"k":"memory","later":"newest"}}
     PASS  a2 the queued newer write wins over both replay and durable  :: {"p":{"k":"newer"}}
     PASS  a3 drop queued behind the replay wins (record gone)  :: ["put:s1","delete:s1"]
     PASS  a4 s1 keeps replayed + racing keys / s2 merged with its durable record
     PASS  a5 a write queued while degraded still lands after the table is published  :: {"p":{"k":1}} log=["put:s1"]
     PASS  a6 drop queued before the replay wins  :: log=[] pendingReplay=0

判断依据：四种交错（同会话并发 mutate、同 key 冲突、并发 drop、多会话 + 其中一个被并发写）都严格按入队顺序串行，没有撕裂、没有丢键、队列没被毒化。额外补的 a5 是一个修复者没测的时序：mutate() 在**降级期**创建 promise，但它的队列体在 table 已发布之后才执行——此时它走持久分支 put，随后重放读到记录并合并（同值，无害），结果仍是一份记录、一个键。

与修复者声称的分歧：无；只是把他们的 A 用例往更极端的方向推了四步。

### 1.3 边界 (b)：合并冲突谁赢：**成立**（内存优先，且耐久侧其它键真的保留）

命令同上（SECTION 3）

     PASS  b1 memory value wins the same-key conflict  :: winner=memory
     PASS  b1 durable sibling key inside the same plugin group survives  :: {"k":"memory","onlyDurable":"keep"}
     PASS  b1 durable other plugin group survives  :: {"x":1}
     PASS  b1 foreign top-level field of the durable record survives  :: "kept-field"
     PASS  b1 durable profile survives (incoming has none)  :: "web"
     PASS  b2 profile adopted when the durable record has none  :: "web"

判断依据：lib/store.js:172-186 的 values[pluginId] = { ...(durableGroup ?? {}), ...group }（组内逐键覆盖）+ const merged = { ...existing, sessionId: existing.sessionId, updatedAt, values }（保留耐久记录的外来字段）。我特意把冲突放在三层同时发生：同一 item key、同一插件的另一键、另一个插件组、记录的顶层陌生字段、profile。结论：**内存侧同键优先成立；耐久侧的其它键、其它插件组、未知顶层字段、profile 全部保留**；只有 updatedAt 被刷新（符合协议 §5）。

**但这条「内存优先」的假设有前提，见 §1.8 R2-02。**

与修复者声称的分歧：无。

### 1.4 边界 (c)：一条重放失败（不可合并）时：**部分成立**

命令同上（SECTION 4）

     PASS  c1 unmergeable entry stays held (pendingReplay 1)  :: pendingReplay=1
     PASS  c1 the degraded value is INVISIBLE to consumers after attach  :: {}
     PASS  c1 exactly one replay diagnostic, naming the session
     PASS  c1 the diagnostic says it stays in memory
     PASS  c1 the diagnostic promises "retried on the next attach"
     PASS  c1 a later attach() does NOT retry (isDurable short-circuit)  :: replay-errors=1 pendingReplay=1
     PASS  c1 only close()+attach() replays again (value was still held)  :: replay-errors=2
     PASS  c2 second attach is a no-op: NO in-process retry
     PASS  c3 only the broken session stays pending  :: pendingReplay=1
     PASS  c3 the two good sessions were merged
     PASS  c3 exactly one replay error, and an info saying 2 moved
     PASS  c3 the failed session queue is not poisoned
     PASS  c4 a rejecting put keeps the entry and logs

逐项对题设四问：

| 问 | 实测 | 结论 |
|---|---|---|
| 值是否仍在内存？ | pendingReplay===1；close()+attach() 会再次尝试重放该值并成功 | **是**（内存 map 里确实还在） |
| 有无可诊断信号？ | 每次都打一条 error，点名 session、说明原因（could not move the overrides ... : 原因） | **有** |
| pendingReplay 是否正确？ | 失败后 =1；部分失败（3 会话 1 坏）时 =1、成功 2 条被摘除，另有 moved 2 session override set(s) 的 info | **正确** |
| 重试成功前对消费者不可见——有没有说清？ | **没说清，而且错**：durable 之后 readValues 只读 table，内存那份完全不可见（实测 readValues 返回 {}）；错误日志写的是 "they stay in memory and replay is retried on the next attach"，但 attach() 第 248 行 if (isDurable()) return status() 让后续 attach 直接短路——**进程内永远不会重试**。只有 close()+attach() 才会重放，而产品没有任何调用方这么做 | **不成立**（见 §3 R2-01） |

判断依据（我自己读的代码）：lib/store.js:141 的 status() 注释写 "those values are still only in memory"，lib/store.js:231-233 的错误日志承诺 "retried on the next attach"，lib/store.js:248 的 if (isDurable()) return status()。三处互相打脸。

**与修复者声称的分歧**：他们说「失败条目留在内存并打 error」。这两半都成立，我实测确认。但「留在内存」的真实含义是**留在内存 map 里、对任何消费者不可见、本进程不会再被重放**——日志与注释给出的印象（还会重试）做不到。见 R2-01。

补充（同一分支的另一面）：**partial failure 隔离与队列健康都成立**——c3 里坏会话不影响两个好会话，坏会话之后的写依然能落到表（update:s1），Promise.allSettled 的收敛语义没问题。

补充（可达性，如实说）：我用「耐久记录的 values 是字符串」来逼出 merge 失败；而真实域是按 sessionRecordSchema（values: record(record(unknown))）校验的，invalidRecords:'backup-and-skip' 会把不合法记录搬走。**这个失败分支在真实 zod 校验下接近不可达**，是为防御留的路径。所以 R2-01 的严重性应据此下调（见 §3）。

### 1.5 反事实检验（在副本里改回旧行为）：**成立**——回归测试真有鉴别力

副本：D:/projects/tmp/v2-harness/cf/（拷贝 lib/tests/docs/package.json + junction node_modules）。先确认副本自身基线：node --test tests/ 得到 **82/82 通过**。

**反事实 1**：把重放移出队列（enqueueWrite(sessionId, async () => { 改成 (async () => {，})) 改成 })())），其余不动。

     $ cd cf; node --test tests/
     ✖ A: a write accepted while degraded survives a durable write racing the replay (6.0279ms)
     ℹ tests 82 / pass 81 / fail 1

**反事实 2**：先恢复原文件，再把「既有记录就 merge」改回旧的「既有记录就跳过」（if (existing !== undefined) return）。

     $ cd cf; node --test tests/
     ✖ B (host level): a value accepted before storageDomain arrives is not lost
     ✖ B: with a durable record already present, a degraded write is merged in
     ✖ C: an existing durable record is merged, never skipped (regression guard for V1 §4.1)
     ✖ a replay that cannot merge keeps the value in memory and reports it
     ℹ tests 82 / pass 78 / fail 4

判断依据：两次反事实各自精准地打红对应的用例，没有「改了也全绿」的空跑。特别地，反事实 2 连 tests/host.spec.mjs:251 的「B（宿主层）」也打红，说明回归覆盖不止在 store 单测里。**这两组新用例是有效鉴别器，不是摆设。**

与修复者声称的分歧：无（他们把回归用例写成了真断言，我这边反向验证通过）。唯一提醒：tests/store.spec.mjs 里「a replay that cannot merge」用的坏记录是我在 §1.4 说明的那种合成坏数据，它保护的是防御分支。

### 1.6 clone 复核（R1-02）：**成立**——四个出口都是拷贝，无循环/类型/性能回归

命令：node D:/projects/tmp/v2-harness/clone-probes.mjs

     D1 默认值层：get/getItem 都返回拷贝；就地改 obj/list 后注册默认值对象不被污染，后续读取仍是默认
     D2 覆盖值层：get/getItem 返回的不是 store 记录里的对象；就地改后耐久记录仍是 {nested:{n:7}}
     D3 snapshot：resolved 与 overrides 两层都是拷贝；改了 snapshot 后记录与后续 snapshot 都不变
     D4 桥（bridge.dispatch('values.get')）：返回值是拷贝；改了 payload 后记录不变，后续读也不变
     D6 cloneJson：循环对象不抛（structuredClone 原生支持环，返回自引用拷贝）；原始值/undefined 原样返回；
        环状 default 在注册时就被 isJsonValue 拒掉；结构化克隆在本运行时可用
     D7 性能：5000 元素 default 的单次 resolveValues = 0.1679ms（对照「直接引用」基线 0.0002ms，比值 687x）；
        小 default（switch）= 0.000034ms/op

判断依据：

- 默认值层：lib/resolve.js:269 的 resolved[item.key] = cloneJson(applied ? overrides[item.key] : item.default)——两条路径同一个 cloneJson，我分别构造了「无覆盖」和「有覆盖」两种会话来验证。
- 覆盖值层还有第二道防线：lib/store.js:284-291 的 readValues 自己 clone()，所以覆盖值实际上是「出库拷一次 + 解析拷一次」，我实测两层都不是同一个引用。
- 桥出口：dispatch('values.get') 返回的是 snapshot 的产物，同样是拷贝。
- 性能：比值高是因为对照基线几乎是零（只做属性赋值），**绝对值**才是有意义的：5000 元素的深拷贝 0.17ms/次，小标量 34ns/次。快照缓存又在客户端按 revision 命中，桥每请求一次的量级完全可接受。**不构成性能回归。**
- 循环/类型：cloneJson 对非对象直接返回（函数、undefined 原样），但注册校验 isJsonValue 拒绝 undefined/函数/NaN/环，存储侧 sanitizeOverrides 再拒一次，所以这些旁路在生产路径上不可达。**没有引入循环引用或类型回归。**

**残留（非本次修复引入，我顺手发现的）**：

- bridge.dispatch('registrations.list') 的返回值里 items[].default **仍与注册对象同一个引用**（我实测 === 为 true，就地改 nested.n=4242 后新会话的 get 也返回 4242）。走 HTTP 时 lib/bridge.js:79 的 JSON.stringify 立即拷贝，**浏览器不可达**；但任何在进程内直接用 bridge.dispatch 的消费者会中招。级别：建议/信息。
- service.set() 不拷贝传入值：调用方 await set(...) 之后再改自己那个对象，域内记录跟着变（实测 999），直到重启重读。既有行为，非本次修复引入。

### 1.7 F2 复核：**成立**——三档回退、title 属性、整体转发、hook 顺序全部实测通过

命令：node D:/projects/tmp/v2-harness/client-probes.mjs（自写 mini-React + loader 桩，跑真实 lib/client.js）

     E1 title 胜 cwd；无 title 用 cwd；无 summary/无套件用截断 id（session-…456）
     E1 三种情况完整 sessionId 都在 title 属性里  :: ["session-abcdef123456"]
     E2 空白 title 回退 cwd（并 trim）；title+cwd 都空/类型不对/byId 缺项/返回 undefined 全部安全回退
     E3 SessionSettingsPage 收到整体 props  :: keys=["sessionId","marker","useTabInfo","useSessions","store"]
     E3 store 是活的、sessionId 原样、页面为正确的 session 拉了 values.get
     E3 自定义渲染器仍能挂载并收到 sessionId + setValue/reset（props 消费者没被破坏）
     E4 挂载后再给 useSessions：不再采纳（ref 冻结），hook 序列两次渲染完全一致
     E4 挂载时给了再撤掉：仍继续调用，hook 序列也完全一致
     E4 带套件渲染比不带套件多且只多套件自己的 hook（10 vs 9）
     E5 12 字符 id 原样；13 字符截断；非字符串 sessionId 不崩

判断依据：

- 三档回退在 lib/client.js:1057-1063 的 sessionLabel：title.trim() → cwd.trim() → shortSession(sessionId)；shortSession 在 lib/client.js:1045-1048 按 12 字符分界。
- 完整 id 在 lib/client.js:961 的 h('div', { key:'session', ..., title: sessionId })，我在渲染树里遍历所有 div 的 title 属性确认。
- 整体转发在 lib/client.js:1348 的 Object.assign({}, props, { store: store, sessionId: sessionId })——我把 marker、useTabInfo 一起塞进去，确认它们抵达了 SessionSettingsPage，且 store/sessionId 被正确注入/归一。
- **hook 顺序稳定**是我自己加的重点：我的 mini-React 按组件路径记录 hook 调用序列，并让 useSessions 桩自己也消费一个 hook（模拟真套件内部订阅）。两个方向都测了（先无后有 / 先有后无），两次渲染的序列逐项相同；useRef 冻结在 lib/client.js:930-934。若有人把冻结去掉，先无后有的第二次渲染会多出一个 hook，我的 trace 会立刻变长——这条测试有鉴别力。
- 我也确认了 F2 修的「包装只转发 {store,sessionId}」确实改成了整体转发；TabTitle 席位（lib/client.js:1352-1358）未受影响，仍拿到 sessionId 并渲染出标题。

与修复者声称的分歧：**无**。他们说的三档回退、title 属性、整体转发三条我都独立测到了。

### 1.8 主动找新引入的问题

- **R2-01（一般）重放失败的收尾是「假承诺」**：见 §1.4。三处证据：pendingReplay 永久非零、attach() 短路不重试、错误日志承诺的重试不存在。附带：status() 注释说这些值 "still only in memory" 会让读者以为消费者还能读到它们，而实测 readValues 返回 {}。**真实可达性低**（要耐久记录本身不可合并，而 schema 挡住了），所以我没有定成「严重」。
- **R2-02（建议，潜在陷阱）「内存优先」的前提在失败后不再成立**：mergeRecords 的整个理由（lib/store.js:146-148）是「内存那份是域关闭期间写的、比耐久新」。可一旦某条重放失败，内存会一直留着**旧**快照；此后耐久侧还接受新的写；将来若补上重试，旧的会盖掉新的。我实测到了这个机制：close()+attach() 强制重放后，k 从 'newer-durable' 被改回 'from-degraded-window'。**当前不可达（因为没有重试），两个缺陷互相掩盖**——但修 R2-01 的人如果不看这条，就会把它变成真缺陷。
- **队列失败隔离**：没问题（c3/c4 + 既有用例；反事实也验证了）。
- **pendingReplay 泄漏**：就是 R2-01 的「永久非零」，同时是内存里永不释放的一条记录（真实可达性低）。
- **日志噪音**：一次 attach 里每个失败会话各一条 error，50 个失败会话 = 50 行；但 attach 本身极少发生，且相比「对账 30 分钟节流」这条路径没有刷屏风险。**不构成问题**，只是提醒不要给重试加逐次日志。
- **测试有没有空断言/永真断言**：我扫了全部 5 个 spec（assert.ok(true / 恒等式 / 空函数），**没有发现**空断言或永真断言；命中的都是桩里的 return () => {} 和 console.error = () => {} 之类的测试替身。A/B/C 与其他新用例断言的是真实值、真实写日志（put/update 次数）、pendingReplay，配合 §1.5 的反事实检验，确认真有鉴别力。

### 1.9 基线复跑：**成立**

     $ cd D:/projects/dsh-plugins/dsh-session-settings
     $ node --check lib/bridge.js ; ... lib/client.js lib/index.js lib/resolve.js lib/store.js lib/trust-fence.js
     CHECK_EXIT=0                                   # 6/6 exit 0

     $ node --test tests/
     ℹ tests 82 / suites 0 / pass 82 / fail 0 / cancelled 0 / skipped 0 / todo 0
     EXIT=0

     $ node --test        # 裸跑，包根
     ℹ tests 0 / pass 0 / fail 0
     EXIT=0

判断依据：

- 82 条的分文件计数（我 grep 了行首 test(）：bridge.spec.mjs 12、client.spec.mjs 21、store.spec.mjs 16、host.spec.mjs 17、resolve.spec.mjs 16，合计 82，与运行输出一致。
- 裸 node --test 仍是 **0 测试 + exit 0**（假绿的坑仍在，这是 Node 的发现规则，不是产品缺陷）；tests/index.js:12-14 现在明确写了「NOT bare node --test ... exits 0 with tests 0 / pass 0 — a green run that tested nothing」。**R1-03 的注释改正到位**：我读的是改后的原文，它不再声称裸跑可用，而且把原因说对了（默认发现规则不含 *.spec.mjs、复数目录不匹配）。同时 package.json 也补上了 "test": "node --test tests/"。
- 与 R1/V1 的 72 条相比现在是 82 条：新增的 10 条正好落在 F1 与 F2 两处，与我读到的用例对得上。

### 1.10 上一轮 4 条「已排除假警报」抽查：**4/4 仍成立**

命令：node D:/projects/tmp/v2-harness/http-fence-probe.mjs（真 node:http + 真裸 socket）+ 静态检索

     PASS  X-1 HTTP/1.0 without Host -> 403 (fence), not 400   :: HTTP/1.1 403 Forbidden
     PASS  X-1 Host: not a host -> 403
     PASS  X-1 sec-fetch-site: cross-site -> 403 forbidden
     PASS  X-1 non-POST -> 405 method-not-allowed
     PASS  X-2 values.set without value -> 400 bad-request
     PASS  X-2 values.set with value: null -> 200（own-property 判定，不是真值判定）
     PASS  X-4 registrations.list title 是求值后的字符串 "Wire now"；item title "A"
     PASS  X-4 locale 字典原样传输 {"zh":{"Wire now":"连线"},"en":{}}

- 「无 Host → 400」：HTTP/1.1 缺 Host 被 Node 解析器挡在 handler 外，换 HTTP/1.0 复测是 **403**，Host: not a host 也是 403 → 与上一轮结论一致，是 Node 行为不是产品问题。
- 「values.set 不带 value → 400」：仍 400 bad-request；我另加了 value: null → 200，证明用的是 own-property 而不是真值判断。
- 「session/disposed 被用于删除」：全 lib/ 检索只命中 lib/index.js:290 的一句**注释**，无监听、无删除路径 → 仍成立。
- 「serializeRegistration 未带 locale / 未求值函数」：真 HTTP 响应里 title 已是字符串、locale 原样、整包 JSON 无函数残留 → 仍成立。

---

## 2. 三分类统计

被复核的修复主张逐条计数：

| 主张 | 结论 |
|---|---|
| F1：重放任务与 mutate/drop 共用同一条 per-session 写队列 | **成立** |
| F1：队列槽内重新 table.get，无记录 put、有记录 mergeRecords 后 update | **成立** |
| F1：merge 时内存侧键优先、耐久侧其它键与 profile 保留 | **成立** |
| F1：Promise.allSettled 收敛，失败条目留内存并打 error | **部分成立**（留内存+打 error 成立；「留内存」的真实语义——不可见、本进程不再重放——与日志/注释不符） |
| F1：status() 新增 pendingReplay | **成立**（字段与数值正确；但可永久非零，语义有坑） |
| F1：cloneJson 默认值层与覆盖层都返回拷贝 | **成立** |
| F1：tests/index.js 注释改正 | **成立** |
| F2：三档回退 title → cwd → 截断 id | **成立** |
| F2：完整 sessionId 留在 title 属性 | **成立** |
| F2：修好「tab 席位包装只转发 {store,sessionId}」，整体转发标准 props | **成立** |

**成立 9 / 部分成立 1 / 不成立 0。**

另：反事实检验 2/2 证明新增用例有鉴别力；上一轮假警报抽查 4/4 仍成立；R1-03 注释确已改正；未发现空断言/永真断言。

---

## 3. 必须修复清单（按级别）

**阻断：0。严重：0。**

1. **【一般】R2-01 重放失败的收尾与日志/注释不实**（lib/store.js:141、:203-239、:248）
   - 事实：失败条目留在 memory，但 durable 之后消费者读不到它（readValues 走 table）；attach() 因 isDurable() 直接短路，**进程内没有任何路径会重放它**；错误日志却写 "replay is retried on the next attach"；status() 注释写 "still only in memory"，容易被读成「消费者还能用」。
   - 影响：一旦真的发生（需耐久记录不可合并），这条**已被接受**的写入在本进程内不可见、不会自愈，重启后内存清空即永久丢失，而运维从日志得到的印象是「会自动重试」。
   - 定级说明（如实）：真实域有 zod schema 兜底，不合法的 values 会被 backup-and-skip，所以这个分支近乎不可达；我按「已接受写入 + 可诊断性误导」定「一般」，Lead 若以可达性为准可下调为建议。
   - 合格修法（二选一，我建议第一种）：(a) 让重放真的可重试——例如 attach() 在 pendingReplay > 0 时先做一次重放再返回，或在状态里给一个可触发的重试入口；(b) 保持不重试，但把日志与注释改成事实：「this value stays in memory only, is not visible to consumers, and is not retried in this process; it is lost on restart」。
2. **【建议，潜在陷阱】R2-02 补重试时必须同时处理「陈旧内存覆盖较新耐久」**：mergeRecords 的「内存优先」只在「内存比耐久新」时成立；重放失败后内存会长期停留在旧快照。我实测 close()+attach() 强制重放时，'from-degraded-window' 盖掉了更新的 'newer-durable'。修 R2-01 时若直接加自动重试，就会把这个陷阱变成真缺陷。建议重放时用 updatedAt 或「只补缺失键」的策略，而不是无条件内存优先。
3. **【建议，文档】**：docs/ 下**完全没有任何**关于 pendingReplay、重放失败语义、合并语义、以及「降级期的删除/重置不可表达（我实测 b3：kA/kB 会复活）」的记录——这些只写在 lib/store.js 的代码注释里。合并语义与失败语义是运维/后续维护者会踩的地方，建议补进 docs/notes/t2-t3-choices.md（或 design 文档）。
4. **【建议/信息】bridge.dispatch('registrations.list') 仍别名注册默认值对象**（lib/resolve.js:196-224 的 default: item.default）：HTTP 路径立即 JSON.stringify，浏览器不可达；但进程内直接调用 dispatch 的消费者会永久改掉注册默认值。若要保持「四个出口都不别名」的一致性，可在 serializeRegistration 里也 cloneJson；不做也说得过去，建议在注释里说明。
5. **【信息】service.set() 不拷贝入参**（lib/resolve.js:324-332）：调用方 set 后再改自己的对象，域内记录会跟着变（实测 999），重载/重启后复原。既有行为，非本次修复引入，记录备查。

---

## 4. 我认为修复者夸大或遗漏的点

**夸大：无。** 我逐条对照了 F1/F2 的全部主张（§2 的 10 条），没有发现任何「说了但做不到」的宣称——A/B/C、冲突优先、耐久键保留、clone 两条路径、F2 三档回退与整体转发，全部在真实产品代码上跑通。反事实检验也证明他们的回归用例不是空跑。

**遗漏（3 条）：**

1. **重放失败后的生命周期完全没有被处理/说明**：他们实现了「失败就留下并打 error」，但没发现自己承诺的「下一次 attach 重试」在 isDurable() 短路下不可能发生，也没写清留下来的值对消费者不可见。这是本次复核里唯一「声称与实测有出入」的地方。
2. **「内存优先」的前提在失败路径上失效**（R2-02）。他们的注释把「内存更新」当成公理，没讨论重放失败后这条公理还成不成立。
3. **docs/ 层面零记录**：合并/失败/pendingReplay 只活在代码注释里。

**另外值得一提（不是他们的问题）**：tests/store.spec.mjs 的 B 与 C 两条用例内容高度重叠（都断言「有耐久记录时合并」），只是 C 额外断言了 put===0 / update===1。不算冗余，但 C 的增量价值主要在计数器断言上；真正把「跳过分支」钉死的是 C + host 层那条 B。

---

## 5. 我无法验证的点（如实写明）

1. **真实 DSH 里 storageDomain 是否真的会晚于本插件挂载**。硬性禁令 + 不能启动 profile，我只能确认代码与注释支持该顺序（lib/index.js:281-287）。这决定 F1 三段 A/B 的**实际可达性**；机制与修复效果我已用真实 lib/store.js 实测。
2. **真实右栏页面的 DOM / 视觉表现**（F2 的观感、E3/E4/E5 在真浏览器的样子）。硬性禁令：未开浏览器、未用任何浏览器工具。我的结论基于自写 mini-React 渲染的元素树与 hook 序列，真 React 的渲染细节（样式、滚动、真实 useSyncExternalStore 行为）未验。
3. **真实 dsh-storage-json 后端的落盘行为**。项目 node_modules 未安装该包，我用的是照官方 KvTable 语义自写的桩（读同步 / 写先耐久后内存 / missing-key）。因此「重放失败分支在真实 schema 下近乎不可达」是我的**静态推断**（依据 sessionRecordSchema 与 invalidRecords:'backup-and-skip'），没有跑真后端证伪。
4. **真 React 的 hook 规则抛错**。错序在真 React 下会抛 "Rendered more hooks than during the previous render"；我的 mini-React 只能观察到 hook 序列长度差异，不能复现真 React 的报错文本。
5. **修复者本人跑过什么**。我只复核产品行为与我自己写的夹具，没有、也不引用他们的中间输出或脚本。
6. **跨进程并发写同一 storages 根**（无 CAS）。未测，与 R1/V1 的声明一致。

---

## 6. 复现命令清单

    # 我的夹具（全部只读产品代码）
    node D:/projects/tmp/v2-harness/store-probes.mjs        # A/B/C + 边界 a + 边界 b + 边界 c + 陈旧内存
    node D:/projects/tmp/v2-harness/extra-probes.mjs        # 两个额外时序边界
    node D:/projects/tmp/v2-harness/clone-probes.mjs        # clone：默认/覆盖 + get/getItem/snapshot/桥 + 循环/性能
    node D:/projects/tmp/v2-harness/client-probes.mjs       # F2：三档回退 + title 属性 + 整体转发 + hook 顺序
    node D:/projects/tmp/v2-harness/http-fence-probe.mjs    # 上一轮假警报抽查（真 HTTP + 裸 socket）

    # 反事实检验（副本，产品目录不参与）
    cf/ 目录：两次改回旧行为后各跑一次 node --test tests/   # 见 §1.5

    # 产品目录内只读命令
    cd D:/projects/dsh-plugins/dsh-session-settings
    node --check lib/bridge.js lib/client.js lib/index.js lib/resolve.js lib/store.js lib/trust-fence.js
    node --test tests/
    node --test
    Get-ChildItem lib/*.js, tests/*, package.json | Get-FileHash -Algorithm SHA256

**我未修改任何产品文件**；本轮只写入了 docs/reviews/fix-verification.md（本文件）与 D:/projects/tmp/v2-harness/ 下的夹具。
