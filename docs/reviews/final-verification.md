# V3 最终复核：F3 修复验证 + 对抗性找茬（verifier-3）

- 复核者：verifier-3（全新代理，无前序记忆，只依据文件与实测；不修改任何产品文件）
- 时间：2026-10-13 01:31 – 01:45（Asia/Shanghai）
- 项目：D:/projects/dsh-plugins/dsh-session-settings
- 夹具：D:/projects/tmp/v3-harness/（fakes.mjs、store-claims.mjs、host-claims.mjs、prior-rounds.mjs、client-header.mjs）
- 被复核对象：task-10（F3）的 (a)–(g) 七条主张 + 全插件对抗性检查
- 未使用任何浏览器工具 / chrome-devtools MCP；未运行 plugin_manager；未写 ~/.dsh

## 0. 一句话结论

**成立 6 条 / 部分成立 1 条 / 不成立 0 条；另外发现 2 条【一般】级残余问题（同一个根因的两个面）+ 2 条【建议】级文档问题。目前仍然存在【一般及以上】的问题。**

---

## 1. 环境与基线复跑

环境：Node v24.12.0，Windows。

### 1.1 node --check 六个 lib 文件

命令：

```
cd D:/projects/dsh-plugins/dsh-session-settings
node --check lib/index.js ; node --check lib/store.js ; node --check lib/resolve.js
node --check lib/bridge.js ; node --check lib/trust-fence.js ; node --check lib/client.js
```

结果（逐个执行）：`index.js OK / store.js OK / resolve.js OK / bridge.js OK / trust-fence.js OK / client.js OK`，6/6 通过。

### 1.2 node --test tests/

命令：`node --test tests/`

结果尾部（实测）：

```
ℹ tests 89
ℹ suites 0
ℹ pass 89
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1239.1164
```

结论：89/89 全绿，与 task-10 声称一致。

### 1.3 裸 node --test

命令：`node --test`

结果：

```
ℹ tests 0
ℹ suites 0
ℹ pass 0
ℹ fail 0
... 
EXIT=0
```

结论：0 测试、exit 0，与 tests/index.js:12-14 的注释一致（注释已说明裸跑是假绿）。

### 1.4 产品文件未被本轮改动

本轮开始时间 01:31:55。产品文件最后修改时间全部早于该时刻（lib/*.js 最晚 01:29:10，tests 最晚 01:30:00，docs/notes 最晚 01:30:18，见 `Get-ChildItem lib\*.js, docs\reviews\*.md, docs\notes\*.md, tests\*.mjs | Select LastWriteTime`）。本轮只写了 D:/projects/tmp/v3-harness/ 与本报告。

---

## 2. F3 七条主张逐条复核（全部亲手复现，不引用修复者输出）

夹具与命令：`cd D:/projects/tmp/v3-harness && node store-claims.mjs`、`node host-claims.mjs`、`node prior-rounds.mjs`、`node client-header.mjs`

### (a) pending 值叠加可见 —— **成立**

主张：readValues 把 pending 叠在耐久之上，get/getItem/snapshot/桥 全部受益，listSessionIds 并入 pending 会话。

实测（host-claims.mjs H1；store-claims.mjs C12/C13）：

- 构造 pending：先无 storageDomain 时 `service.set('p','enabled','s1',true)`，再让 storageDomain 到达且第一次 update 失败（真实 lib/index.js + lib/store.js）。
- `service.get('p','s1')` → `{ enabled: true, mode: 'manual', label: 'x' }`（pending 覆盖叠在耐久 mode=manual 之上）
- `service.getItem(...)` → `true`；`service.snapshot('s1').overrides` → `{ p: { enabled: true, mode: 'manual' } }`
- 桥 `POST /session-settings/api/values.get` → 200，resolved 与进程内 `service.get` **逐字段相等**
- C12：`listSessionIds()` 在 pending 期返回 `['durable-2','pending-1']`（pending 会话确实并入了）
- C13：pending 键与耐久键同键冲突时 pending 赢（`shared: 'pending'`）

判定：成立。但这份可见性没有写回路径的对称语义，见 §4 的 V3-01。

### (b) 真重试：attach 后 + 30 秒定时器 —— **成立**

实测（store-claims.mjs C1–C5）：

- C1：`RETRY_INTERVAL_MS === 30000`、`RETRY_LOG_INTERVAL_MS === 30000`
- C2：无 pending 时定时器数量 0、ctx.effect 数量 0；出现 pending 后恰好 1 个定时器、间隔 30000ms、`unref()` 被调用、ctx.effect 恰好 1 条；连续 retryPending 后仍只有 1 个（不叠加）
- C3：pending 清零后 `retryScheduled=false` 且活动定时器 0
- C4：手动调用 ctx.effect 的 disposer（模拟插件卸载）后活动定时器 0
- C5：模拟两个插件实例（重载）时为 2 个；旧实例 disposer+close 后恰好剩 1 个新实例定时器，没有泄漏也没有重复

判定：成立。

### (c) 失败日志节流（首条即时，之后每 30 秒或每 10 次尝试）—— **成立**

实测（store-claims.mjs C6，注入 now + 受控 Date.now，永久失败的 replay）：

- 第 1 次：立刻 1 条 error，文案含 `attempt 1`
- 第 2–9 次：仍然只有 1 条
- 第 10 次：出现第 2 条，文案含 `attempt 10`（次数边界）
- 第 11 次：不新增
- 时钟 +30000ms 后第 12 次：出现第 3 条，文案含 `attempt 12`（时间边界）
- 第 13 次：不新增

判定：成立，两条边界都在。

### (d) R2-02 合并时耐久 updatedAt 更新则成功后打 warn 并点名被覆盖键 —— **成立**

实测（store-claims.mjs C7–C11）：

- C7：耐久 updatedAt 500 / pending 100，冲突键 p/k → update 成功后才 warn，1 条，含 `overwrites overrides that the durable record changed later`、`p/k`、`500 > pending 100`
- C8：两侧值相同（jsonEqual）→ 0 条 warn
- C9：pending 更新（updatedAt 100 > 耐久 1）→ 0 条 warn
- C10：update 永久失败 → 0 条 warn，pending 仍为 1，error 1 条（**不误报**，也证实“成功后才 warn”）
- C11：耐久有 `extra` 键而内存没碰它、内存有 `brandNew` 新键 → warn 只点名 p/k，不含 extra/brandNew

判定：成立，且“只在真的覆盖时报、失败时不报”两条对抗性要求均满足。

### (e) R2-04 序列化 default 拷贝 —— **成立**

实测（host-claims.mjs H2；prior-rounds.mjs P-clone-5；lib/resolve.js:208 `default: cloneJson(item.default)`）：

- `bridge.dispatch('registrations.list')` 返回的 `items[0].default.nested.n` 改为 999 后，注册对象仍是 `{ nested: { n: 1 } }`，`service.get` 也不受影响；第二次 dispatch 仍干净

判定：成立。

### (f) R2-05 set 入参拷贝 —— **成立**

实测（host-claims.mjs H3；lib/resolve.js:333 `group[itemKey] = cloneJson(value)`）：

- `service.set('r205','obj','s1',{nested:{n:2}})` 后把入参改成 999，耐久记录与 get 都仍是 `{ nested: { n: 2 } }`；再从 getItem 拿到结果就地改也不回流

判定：成立。

### (g) docs/notes/t2-t3-choices.md 第 13 节文档准确 —— **部分成立**

逐条对照（正文 §5）：

| 文档句 | 实测 |
|---|---|
| 13.1 pendingReplay=条目数、retryScheduled=定时器在跑、桥不暴露 | 准确（store.js:159-160；桥四个方法响应无此字段） |
| 13.1 readValues 叠加 pending，get/getItem/snapshot/桥都能读回 | 准确（H1/C13） |
| 13.2 attach 后立刻重放 + 30s 定时器、仅 pending>0、ctx.effect、unref | 准确（C1–C5） |
| 13.2 失败不丢、继续可见、下次 tick 再试 | 准确（C3/C6） |
| 13.2 节流：首条即时，之后 30s 或每 10 次 | 准确（C6） |
| **13.2 “没有可用 ctx.effect 时定时器不安装……这种情况会在日志里说明”** | **不准确**：store.js:245-246 在 `typeof ctx?.effect !== 'function'` 时直接 `return`，**没有任何日志**；只有 ctx.effect 存在但抛异常时才走 catch 打 warn。实测 C14：无 ctx 的 store 在 pending 状态下 `retryScheduled=false`、日志里 0 条 “cannot schedule” |
| 13.3 合并优先级、前提、成功后才 warn、示例文案 | 准确（C7–C11，文案逐字一致） |
| 13.4 降级期“删除”不可表达、写入==默认值会让内存记录消失 | 准确（store.js:490-494、task-7 的 B/C） |
| 13.5 多实例写同一 storages 根的风险 | 与本轮无关，未见反证 |

另外，第 13 节**没有**记录“pending 冻结了该键的写路径”这一后果（见 V3-01/V3-04），而 design-v1.md:173 的验收判据 3（“点恢复默认后……读回默认值”）在该状态下不成立。

判定：部分成立（6 条子句准确，1 条子句与实现不符，1 处应记而未记）。

---

## 3. 对抗性找茬（重点）结果一览

| 对抗问题 | 结论 | 证据 |
|---|---|---|
| pending 期间 reset 一个键会怎样？ | **失效**：reset 返回后该键仍读回 pending 旧值 | H6 |
| pending 期间写到“等于默认值”还删得掉覆盖吗？ | **删不掉**：稀疏删除规则在 pending 键上不成立，耐久记录未被触碰，桥返回旧值 | H4 |
| pending 期间 resetSession（全部恢复默认）会怎样？ | **被重放撤销**：耐久记录删掉了，但值仍可读，且定时器重放把记录又建回来 | H7 |
| pending 期间再写一个更新的值会怎样？ | **读回旧值**；重放时旧 pending 值反过来覆盖这个更新的耐久写入（有 warn，但用户已看不到自己写的值） | H5 |
| pending 会话进 listSessionIds 后对账会误删吗？ | 活跃会话**不会**误删（H9 通过） | H9 |
| 对账会漏删吗？ | **会**：已删除会话的 pending 记录被“删除”后仍可读，并被重放复活 | H8 |
| 定时器在卸载/重载下泄漏或重复吗？ | 不泄漏、不重复 | C2–C5 |
| 节流第 10 次 / 30 秒两条边界 | 都在 | C6 |
| merge warn 只在真覆盖时报？失败时误报？ | 只在真覆盖且 update 成功后报，失败不报 | C7–C11 |
| 桥读与进程内服务读到的 pending 一致吗？ | pending 且 durable 时逐字段一致；非 durable 时桥按协议返回 503（有意设计） | H1 |

---

## 4. 残余问题清单（按级别）

### V3-01【一般】pending 叠加是只读的：写路径（set / reset / resetSession）不认 pending，用户的显式写入/恢复默认会静默失效

- 位置：lib/store.js:427-435（readValues 叠加）、lib/store.js:485-518（mutateNow 耐久分支只读 table.get，不看 memory）、lib/store.js:533-536（dropNow 耐久分支只删耐久，不清 memory）；lib/index.js:186-225 组装的写路径。
- 现象：当某会话有 pending 条目、域已打开时，凡是对该会话的写都只作用在耐久记录上，而读取又始终叠着 pending，于是：
  1. 把某键写回默认值（协议 2.3 的稀疏删除）删不掉 pending 覆盖，读回仍是 pending 旧值；
  2. reset(plugin,item) 同样无效；
  3. resetSession / 整组 reset 删掉了耐久记录，但值仍可读，且定时器重放会把记录重建（“恢复默认”被撤销）；
  4. 用户写入一个更新的值时，读回的是旧 pending 值；等重放成功，旧值还会覆盖这个更新的耐久写入（有 warn，但读路径已经骗过用户）。
- 复现（夹具 host-claims.mjs，H4/H5/H6/H7；均为真实 lib/index.js + lib/store.js + lib/bridge.js）：

```
node host-claims.mjs
PASS  H4 BUG probe: "set to default removes the override" fails while the key is pending
   observed getItem after set-to-default: true
   bridge values.set resolved: {"enabled":true,"mode":"manual","label":"x"}
PASS  H5 BUG probe: a later durable write is shadowed by the older pending value, then reverted by the replay
   after the user wrote "newer-user": getItem="pending-old", durable="newer-user"
   after the replay: durable="pending-old", warns=[... keys: p/label ...]
PASS  H6 BUG probe: reset(plugin, item) cannot clear a pending-only key
   observed getItem after reset(item): true
PASS  H7 BUG probe: resetSession is undone by the replay (record resurrects)
   after resetSession: durable record gone, getItem=true
   resurrected durable record: {"p":{"enabled":true}}
```

  最小复现步骤：会话 s1 在耐久里已有 `{p:{mode:'manual'}}` → 存储降级期间 `set(p, enabled, s1, true)` 进内存 → storageDomain 到达且第一次 replay 的 update 失败（pending=1）→ `set(p, enabled, s1, false)`（等于默认）→ `getItem` 返回 `true`（应为 false），桥 values.set 的响应同样是 `enabled:true`。
- 影响面：只在“重放失败、条目滞留 pending”窗口内出现；此时 durable=true，页面不是只读态，用户可点“恢复默认”。pending 期间写入的新值不会丢数据，但**显式恢复默认会被静默忽略且随后被复活**。
- 与既有决定的关系：R2-02 的“内存优先 + warn”是 Lead 明确裁定的取舍，本条不是反对它；本条说的是写路径（set/reset/drop）没有把 pending 叠加纳为自己的当前状态，导致读取与写入自相矛盾。notes 13.4 只写了“降级期（域还关着）删除不可表达”，没有覆盖“域已打开、但条目仍 pending”这一段。
- 建议方向（不由我修改）：写路径应先在 pending+耐久叠加态上做 transform，或至少让 reset/drop 同时清理（或重基线）该会话的 pending 条目。

### V3-02【一般】对账无法真正回收 pending 会话：日志说“已删除”，值仍可读，重放还会把记录复活

- 位置：lib/index.js:332-333（`store.drop(id)`）、lib/store.js:533-536（dropNow 耐久分支不碰 memory）、lib/store.js:442-447（listSessionIds 并入 pending）。
- 现象：被删除会话的记录处于 pending 时，对账能识别出 stale 并打 info `reconciliation removed 1 record(s)`，耐久文件确实被删，但：`readValues/service.get` 仍返回 pending 值；下一次 tick 重放发现耐久记录不存在，于是 `table.put` 把它**重新写回磁盘**（会话已删，配置却复活）。
- 复现（host-claims.mjs H8，sessionPersistence.list() 返回空）：

```
node host-claims.mjs
PASS  H8 BUG probe: reconciliation "removes" a pending stale record, which stays readable and returns
   after reconciliation: durable gone, getItem=true
   resurrected durable record: {"p":{"enabled":true}}
```

- 对照：活跃的 pending 会话不会被误删（H9 通过），所以“误删”没有发生；问题是**漏删 + 复活**。
- 级别说明：只有在 pending 窗口内才会发生；真实触发条件是重放失败（瞬时后端错误 / 不可合并的耐久记录）。数据不会丢，但“回收”语义不成立，且违反 notes 13.5“对账只按差集删记录”的承诺（它删了、但没删干净）。

### V3-03【建议】notes 13.2 关于“没有 ctx.effect 时会记日志”的说法与实现不符

- 位置：docs/notes/t2-t3-choices.md:172-173 对 lib/store.js:245-246。
- 实测（store-claims.mjs C14，无 ctx 的 store + pending）：`retryScheduled=false`，日志里 0 条 “cannot schedule”；代码在 `typeof ctx?.effect !== 'function'` 时直接 return，不打日志。只有 ctx.effect 存在但抛异常才走 lib/store.js:250-252 的 warn。
- 建议：要么补一条 warn，要么把文档改成“没有可用 ctx.effect 时静默不安装定时器”（二选一，别让文档说错）。

### V3-04【建议】文档没写“pending 会冻结写路径”这一后果，且与 design 的验收判据冲突

- 位置：docs/notes/t2-t3-choices.md 第 13 节（尤其 13.1 的可见性段落与 13.4）；docs/design-v1.md:100-102（写入与恢复）、design-v1.md:173（验收判据 3：点“恢复默认”后读回默认值）。
- 现象：13.1 说 pending 优先且“都能读回”，但没写“同一窗口内的 set/reset 因此不生效并被重放撤销”；design 的验收判据 3 在该窗口内不成立。文档与实现的口径需要补齐（这是 V3-01 的文档面）。

---

## 5. 前三轮关键结论抽查（仍成立）

夹具 prior-rounds.mjs / client-header.mjs，命令与结果：

```
node prior-rounds.mjs
PASS  P-A replay: degraded write survives a durable write racing the replay put
PASS  P-B replay: a degraded write merges into an existing durable record
PASS  P-C regression guard: an existing durable record is updated, never replaced by a put
PASS  P-clone-1 get() ...    PASS P-clone-2 getItem() ...   PASS P-clone-3 snapshot() ...
PASS  P-clone-4 bridge dispatch ...    PASS P-clone-5 defaults in the wire listing ...
PASS  P-proto: only the four frozen methods dispatch; prototype names are refused
--- prior-rounds: 9 pass / 0 fail ---

node client-header.mjs
PASS  F2-1 header prefers the session title
PASS  F2-2 header falls back to cwd when there is no title
PASS  F2-3 header falls back to the truncated id without a kit
PASS  F2-4 header falls back to the truncated id with a kit that has no summary
PASS  F2-5 the title attribute keeps the whole sessionId in every tier
--- client-header: 5 pass / 0 fail ---
```

- A/B/C 三段：A（无既存记录 + replay put 在飞时并发耐久写）两键都保留、put=1/update=1/pending=0；B（有既存记录）合并成功、profile 保留；C（回归护栏）put=0/update=1。
- clone 四个出口：get / getItem / snapshot（resolved+overrides）/ 桥 dispatch 都是独立拷贝，注册对象不被污染。
- F2 头部：title → cwd → 截断 id 三档回退成立，title 属性始终是完整 sessionId（本轮用自写的 mini React 运行时独立复现，未复用 tests/client.spec.mjs 的渲染器）。

---

## 6. 文档与实现一致性小结

1. notes 13.2 最后一条 → V3-03（不准确）。
2. notes 第 13 节缺少 pending 对写路径的影响 → V3-04；design 验收判据 3 在该窗口不成立。
3. 其余对照通过：notes 13.1/13.3/13.4/13.5 与实现一致；protocol-v1.md §1 能力表、§2 四个方法、§6 错误码与 bridge.js/index.js 一致；protocol §3 附加方法 snapshot/storageStatus 存在。
4. 不计为问题的观察：design-v1.md:100-101 只说“写路径用 table.update 原子读改写”，省略了“新记录先 put”的分支（notes 第 5 节已准确记录实际实现），属于设计稿的简写，不构成误导。

---

## 7. 我无法验证的点

1. **真实 Cordis / DSH 运行时**：不允许写 profile、不允许浏览器工具，因此 storage-json 真实落盘、invalidRecords: backup-and-skip、真实 ctx.effect 在 fiber 卸载/HMR 时的行为、真实 sessionPersistence.list() 的返回，都是用等价假件建模的。V3-01/V3-02 依赖的语义（table.get/put/update/delete、ctx.effect disposer、listSessionIds）在假件与产品代码之间是直连的，但“真实域失败模式有多常见”我无法量化。
2. **真实 HTTP / webServer 注册**：桥是通过 handler + 合成请求驱动的，没有监听真实端口；fence 的真实 Host/Origin 组合只覆盖了回环 Host 这一条路径。
3. **真实 UI 交互**：没有点击“恢复默认”按钮走完整前端链路（V3-01 在前端就是“点了没反应”），桥响应与 service 状态已证明，但页面观感未实测。
4. **磁盘残留**：没有检查真实 storages 根下是否已有 pending 会话的残留文件。
5. **多进程并发写同一 storages 根（notes 13.5）**：未做双进程实验。

---

## 8. 最终回答

**是：目前仍然存在【一般及以上】的问题。**

清单：V3-01【一般】pending 叠加与写路径不同步（set 写默认值删不掉覆盖 / reset 无效 / resetSession 被重放撤销 / 更新的写入读回旧值）；V3-02【一般】对账无法真正回收 pending 会话（日志称已删除、值仍可读、重放复活记录）。两者同根：pending 内存条目只被读路径使用（lib/store.js:427-435），不被写路径与删除路径处理（lib/store.js:485-518、533-536）。另有 V3-03、V3-04 两条【建议】级文档问题。
