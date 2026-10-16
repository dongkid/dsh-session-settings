# V1 独立复核报告（task-4）

> 复核对象：`docs/reviews/r1-review.md`（R1 正式审核，task-3）。
> 复核者：verifier-1（全新独立代理，未参与 T2–T6 的写作，也未参与 R1）。
> 复核方式：**不引用 R1 的任何输出当证据**。每条都自己打开文件、自己写夹具、自己跑命令。
> 我自己的夹具全部放在 `D:/projects/tmp/v1-harness/`，产品文件一个字节未改。

## 0. 复核基线与冻结校验

R1 声明冻结在 2026-10-13 00:43。我开工时实测的写入时间与 SHA256(前 16 位)：

| 文件 | 最后写入 | SHA256/16 |
|---|---|---|
| lib/bridge.js | 2026-10-13 00:31:57 | A53F889FE6E4456E |
| lib/client.js | 2026-10-13 00:37:30 | 63E99ECAD43A7528 |
| lib/index.js | 2026-10-13 00:42:27 | A6E38F98561BB060 |
| lib/resolve.js | 2026-10-13 00:30:57 | B4C3F0332135F94F |
| lib/store.js | 2026-10-13 00:42:15 | E5411A07ED2ADB92 |
| lib/trust-fence.js | 2026-10-13 00:31:32 | D03C9FD4FB0061FF |
| tests/* | 00:33–00:43 | — |
| package.json | 2026-10-13 00:27:43 | F14983C98AAD292F |

与 R1 第 5 节声明的冻结点一致，**我复核的是同一份代码**，期间文件未被改动。

### 0.1 我的夹具（都是我自己写的，脚本清单见 §9）

- `v1-harness/ctx.mjs`：最小 Cordis ctx 替身（provide/get/effect/**reactive inject**/logger/loader），用来把**真实的** `lib/index.js` 挂起来。
- `v1-harness/domain.mjs`：域桩。语义不是我拍的，是照**已发布实现**抄的：
  - `dsh-storage-domain/lib/types/domain.d.ts:1-8`：「Reads are synchronous from memory; every write queues on the chain, **awaits backend durability FIRST, then mutates memory**」；
  - `dsh-storage-domain/lib/index.js:257-263`（put：`await unit.putRecord(...)` **之后**才 `records.set`）、`:278-287`（update 同序）、`:221-226`（单条 per-domain 写链）。
- 我用的是**真实产品代码**（`lib/index.js` / `lib/store.js` / `lib/bridge.js` / `lib/resolve.js`），不是复制品。

## 1. R1-01 ~ R1-05 逐条复核

### 1.1 R1-01（R1 定级：严重）降级期写入在存储恢复窗口被并发持久写覆盖

**我的结论：成立（定级「严重」我同意；但触发条件的描述不完整，见 §4.1）**

我实际跑的命令与输出（`node D:/projects/tmp/v1-harness/probe-r101.mjs`，A 段）：

```
A status while degraded: {"durable":false,"backend":"memory","reason":"storageDomain service is not available"}
A write log at race point: ["put:race-s1"]        <- 重放的 put 已在飞
A durable record: {"sessionId":"race-s1","updatedAt":...,"values":{"race.consumer":{"kB":200}}}
A kA after replay = 0 | kB = 200                  <- kA 永久丢失
A write log: ["put:race-s1","put:race-s1"]        <- 第二次写走的是 put 分支，证明它读到的 get() 仍是 undefined
```

判断依据（我自己读的代码，不是 R1 的转述）：

1. `lib/store.js:143-150` 的 `replayMemory()` 直接 `await table.put(...)`，**没有**走 `enqueueWrite`；而 `mutate`（:239-242）与 `drop`（:286-290）都走 `enqueueWrite`。三者不在同一条 per-session 队列上 → 机制存在。
2. `lib/store.js:169-172`：`table = opened.table(TABLE_NAME)` 在 `await replayMemory()` **之前**，所以在重放的 put 落盘前，`isDurable()` 已经是 true，宿主侧写入会走持久分支。
3. 官方域「先耐久、后改内存」（上面 0.1 的两处原件）→ 在重放 put 挂起期间，`table.get(sessionId)` 仍返回 `undefined`，第二次写于是走 `put` 分支、基于空记录构造整份文档，后写覆盖先写。我的写日志出现两次 `put`，正是这一步的直接证据。
4. 触发条件 R1 描述的两条我逐条核对为真：① `lib/index.js:281-287` 注释明确承认 storageDomain 可能晚于本插件挂载，且 `ctx.inject(['storageDomain'], …)` 是等到服务才回调；② 宿主侧 `ctx.sessionSettings.set()` 在降级期确实被接受（`probe-r101.mjs` A 段第一步返回成功、状态 `durable:false`）。浏览器路径被 `lib/bridge.js:120-128` 的 `requireDurable()` 挡成 503，我实测确认（`probe-bridge.mjs` 降级段：values.get/set → 503），所以「不是页面触发、是宿主侧触发」也成立。

**定级：我判「严重」，与 R1 一致。** 理由：这是**已被接受（promise fulfilled）的用户写入静默消失**，与 Lead 已判严重的 X1 同类；不是显示问题。R1 在 §5.5 把它标为「待复核（级别）」是恰当的谨慎，但按影响类别，「严重」不算夸大。窗口确实比 X1 窄，R1 也如实写了。

**分歧：无（结论与级别都同意）。但它对触发条件的描述漏了一种更宽的路径 → §4.1。**

### 1.2 R1-02（R1 定级：建议）默认值层没有防御性拷贝

**我的结论：成立（定级「建议」恰当，不夸大）**

命令与输出（`node D:/projects/tmp/v1-harness/probe-r102.mjs`，驱动**真实服务**）：

```
identity: resolved.obj === registration default ? true
identity: resolved.list === registration default ? true
sess-b obj after mutating sess-a result: {"nested":999}
sess-b list after mutating sess-a result: ["a","b","C"]
registered default object now: {"nested":999}
getItem(sess-b, obj): {"nested":999}
snapshot(sess-b): {"alias.consumer":{"obj":{"nested":999},"list":["a","b","C"]}}
over the wire, default is a copy ? true
```

判断依据：`lib/resolve.js:247-257` 的 `resolved[item.key] = applied ? overrides[item.key] : item.default` 直接引用注册项本体；`lib/store.js:195-202` 的 `readValues` 对覆盖值做了 `clone()`。两处防护不一致属实。

**范围限定（我补的，R1 没写全）**：走桥的路径**不受影响**——`lib/bridge.js:79` 的 `JSON.stringify` 在传输时天然拷贝（我实测 `default` 过了 wire 就不是同一引用）。受影响的是**宿主进程内消费者**直接读 `ctx.sessionSettings.get()/getItem()/snapshot()` 后就地改。R1 的「建议」级与这个范围相称。

### 1.3 R1-03（R1 定级：一般）裸 `node --test` 假绿 + 注释不实

**我的结论：成立**

命令与输出（`D:/projects/dsh-plugins/dsh-session-settings`）：

```
$ node --test
exit=0
ℹ tests 0 / pass 0 / fail 0

$ node --test tests/
ℹ tests 72 / pass 72 / fail 0

$ node --test "tests/*.spec.mjs"        ℹ tests 72 / pass 72 / fail 0
$ node --test "tests/**/*.spec.mjs"     ℹ tests 72 / pass 72 / fail 0
$ node --check lib/{bridge,client,index,resolve,store,trust-fence}.js   → 6/6 exit 0
```

判断依据：

1. `tests/index.js:8` 的注释原文第一行就是 `node --test                 (from the package root)`，正文说三种写法都能用 → **注释确实不实**（R1 引用的行号 6-14 准确）。
2. `package.json` 无 `scripts.test`（我通读了 45 行）。
3. R1 说「错的是 tests/index.js 的注释，不是 `docs/notes/t2-t3-choices.md`」——我核对 `docs/notes/t2-t3-choices.md:120-126`，它只声称 `node --test tests/`、`"tests/*.spec.mjs"`、`"tests/**/*.spec.mjs"` 三种，**没有**声称裸 `node --test`。R1 这个区分是对的。
4. R1 的成因解释我也独立验了：我在 `v1-harness/discovery/` 造了 `a.test.mjs` / `a.spec.mjs` / `test/d.test.mjs` / `tests/c.spec.mjs`，裸 `node --test` 只发现了 `a.test.mjs` 与 `test/d.test.mjs`（2 条），`*.spec.mjs` 与复数目录 `tests/` 都不在默认发现规则内 → 与 R1 的解释一致。

**影响判断同意 R1**：比失败更危险（静默绿）。级别「一般」合理。

### 1.4 R1-04（R1 定级：建议）协议 §6 的 conflict/409 没有触发路径

**我的结论：部分成立**——「事实」成立，「协议与实现不一致」的定性偏重。

命令与输出：

```
$ Select-String -Path lib/*.js -Pattern 'conflict'
lib/resolve.js:23:  conflict: 409,
lib/client.js:113:  conflict: ['写入冲突：宿主上的值已被改动，已重新读取最新值。', ...],
lib/client.js:369:  if (entry.notice.code === 'conflict' || isReadOnlyCode(entry.notice.code)) {

（全仓库含 tests/docs 的检索另见 tests/resolve.spec.mjs:59 只断言映射；docs/notes/t2-t3-choices.md:100-101）
```

- **成立的部分**：全仓库确实没有任何 `throw new SessionSettingsError('conflict', …)`；四个方法的请求体只读 `sessionId/pluginId/itemKey/value`（我通读 `lib/bridge.js` 全文），没有版本/栅栏字段 → 409 在本实现里不可达。这一点我实测也确认：我用 `probe-bridge.mjs` 遍历了方法/错误码，没有任何路径能产出 409。
- **我认为偏重的部分**：`lib/resolve.js:16-26` 只是**错误码 → 状态码的映射表**，它把 `conflict` 映射成协议 §6 写的 409，**映射本身与协议完全一致**；协议 §6 是「错误码表」（预留词表），并不要求 v1 存在产生它的机制。而且 `docs/notes/t2-t3-choices.md:100-101` 已经**显式写明**「conflict(409) 保留在映射表里，但 v1 客户端不提交版本栅栏，客观上不可达——不编造一个假的 409 出来」。所以「协议与实现不一致」这个说法把「预留」说成了「冲突」。
- **级别**：建议（甚至可视作信息级），我同意它自己给的级别。客户端 369 行的分支是防御性代码，不是缺陷。

### 1.5 R1-05（R1 定级：建议）头部用截断 sessionId 代替「标题或 cwd」

**我的结论：成立**

- 代码：`lib/client.js:947-948` 渲染 `ownT('sessionLabel') + ' · ' + shortSession(sessionId)`；`lib/client.js:1031-1034` 的 `shortSession` 返回 `slice(0,8)+'…'+slice(-3)`（`159b040f…d38` 那种）。设计稿 `docs/design-v1.md:133` 写的是「头部：当前会话标识（标题或 cwd）」。现象属实。
- 建议修的可行性我也独立验了（**这一点 R1 只说对了方向，没说清为什么不违反 E4**）：session 作用域的 slot 组件拿到的是**标准 prop** `useSessions`/`useSession`（`dsh-client-ui-session/lib/types/client/index.d.ts:71-79` 的 `GlobalStandardProps`/`SessionStandardProps`），官方 FilesBody 就是这么用的（`dsh-client-ui-sidebar-files/lib/client.js:595,605`：`function FilesBody({ useTabInfo, sessionId, useSessions, ... })` 与 `useSessions(s => s.byId[sessionId]?.cwd)`）；`SessionSummary` 有 `title?` 与 `cwd?`（`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:18-22,43-47`）。**这些是通过 props 注入的，不需要 import 任何 Harness 客户端包**，所以设计 §6 的 E4 约束拦不住这个修法。R1 的建议因此是可行建议，不是空话。
- 限度：DOM 层我没验（硬性禁令），这一点与 R1 的 §5.6 声明一致。

## 2. 对 R1「已修复项 X1–X4 复核通过」的复核

**结论：4/4 的「通过」属实，没有自说自话。**

### X1 并发首写丢更新（原严重）
我的命令：`node D:/projects/tmp/v1-harness/probe-x1.mjs`（8 个不同 itemKey 并发 `service.set`，域桩带 5ms 耐久屏障）：
```
settled: fulfilled ×8
survived overrides: 8 ["k0".."k7"]
domain write log: ["put:conc-s1","update:conc-s1" ×7]
durable record values: {"conc.consumer":{"k0":100,...,"k7":107}}
```
8/8 存活、0 丢失、写日志呈 put→update×7 的串行特征（若两次写都基于空记录，日志会出现两次 put 并丢 7 个）。**通过属实。**
我另做 V7 等价物（`probe-interleave.mjs`，调用顺序即入队顺序 k0,k1,resetSession,k2,k3）：
```
settled: fulfilled ×5
final resolved: {"k0":0,"k1":0,"k2":12,"k3":13,...}      <- 只有 reset 之后的 k2/k3 存活，无撕裂
domain log: ["put","update","delete","put","update"]     <- 与调用顺序严格一致
after a later sequential write: k7=17 生效               <- 队列未被毒化
```
「串行化正确、无撕裂、队列仍可用」三点属实。**通过属实。**

### X2 对账跳过必须留痕
我的命令：`node D:/projects/tmp/v1-harness/probe-reconcile.mjs`：
```
(a) warns: 1  [reconciliation skipped: reconciliation was not assembled at mount because sessionPersistence is not mounted]
(b) warns: 1  [reconciliation skipped: storage is running in memory (storageDomain is unavailable)]
(c) warns: 0 | assembled info: 1
(d) warns after 50 requests: 1        <- 节流有效，不刷屏
(e) keys after reconcile: ["sess-a","archived-b"]（gone-1 被清） + info "reconciliation removed 1 record(s)"
```
R1 的 (a)(b)(c)(d) 四条子结论逐条属实，正向路径（验收判据 5）也实测成立。**通过属实。**

### X3 协议 §1 能力表（v1.1）
我的命令：`node D:/projects/tmp/v1-harness/probe-x3.mjs`（storageDomain 正常、**只缺 sessionPersistence**）：
```
registrations.list -> 200
values.get         -> 200
values.set         -> 200
```
`probe-bridge.mjs` 降级段（缺 storageDomain）：
```
values.get -> 503 storage-unavailable ; values.set -> 503 ; registrations.list -> 200
```
与 v1.1「按方法实际所需能力」完全一致。**「符合 v1.1、不是缺陷」属实。**

### X4 首写 missing-key
`probe-x1.mjs` 的 X4 段：新会话两次写 → `["put:fresh-1","update:fresh-1"]`，值正确；`tests/store.spec.mjs:216-240` 覆盖了 missing-key 重试。R1 说 `store.js:277` 的兜底 return「经推演不可达」，我独立推演同样结论（循环 3 次，每次要么 return、要么 continue、要么 throw；`continue` 需 attempt<2，故 3 次后必 throw 或已 return），是无害死代码。**通过属实。**

## 3. 抽样复核「已排除的假警报」

R1 列了 6 条，我抽了 4 条，全部自证反证成立，**没有拿「夹具问题」糊真问题**：

1. **无 Host 请求返回 400**（R1 说不是产品问题）——成立。我用裸 socket 实测：
   ```
   HTTP/1.1 不带 Host -> "HTTP/1.1 400 Bad Request"   （Node 自带解析器，未进 handler）
   HTTP/1.0 不带 Host -> "HTTP/1.1 403"               （fence 正常拒绝）
   Host: not a host   -> 403
   ```
   产品侧 `lib/trust-fence.js:74-75` 对缺失/不可解析 Host 直接 false，与 R1 的描述一致。
2. **`values.set` 不带 `value` 返回 400**——成立。`probe-bridge.mjs`：`POST values.set {sessionId,pluginId,itemKey}` → 400；`lib/bridge.js:148-150` 用 `Object.hasOwn(payload,'value')` 判定，协议 §2.3 的请求体确实含 `value`。R1 承认「是我的预期写错了」，属实。
3. **`session/disposed` 被用于删除**——成立。`lib/*.js` 全文只有 `lib/index.js:290` 的**注释**命中，无监听、无删除路径。
4. **`serializeRegistration` 未带 locale / 函数求值**——成立。`probe-bridge.mjs`：`registrations.list` 返回的 `title` 是字符串（thunk 已在宿主侧求值），`locale` 字典原样传输（`docs/protocol-v1.md:51`）。

（另两条——「trustedHosts 夹具缺陷」、「V7 的 ops 字符串」——是 R1 自己夹具内部的事，我无法复现其内部行为；但产品侧性质我独立验了：`probe-bridge.mjs` 证明 trustedHosts 是**按请求现读**的（apply 之后才加白名单 → 立刻 200），`probe-interleave.mjs` 证明串行化性质成立。所以无论它的夹具曾经怎样，结论本身站得住。）

## 4. R1 的虚报 / 夸大 / 漏报专节

**先说结论：我没有发现任何「虚报」（编造事实、伪造输出、行号错指）。** 我逐条核对了 R1 引用的全部行号（store.js:143-150/169-172/219-228、resolve.js:247-257/16-26、client.js:947-948/1031-1034/113/369、tests/index.js:6-14、design-v1.md:133、protocol-v1.md:16,112 等），**全部准确**；它引用的官方原件位置（domain.d.ts:1-8、lib/index.js:257-287 的耐久序）我也逐条打开核对，准确。

但它有 **1 处实质性漏报** 与 **1 处措辞夸大**：

### 4.1 【漏报，最重要】重放路径还有一条**不需要并发**的静默丢失，R1 没发现

- **R1 的原结论**：R1-01 的触发条件「需要 ① storageDomain 晚于本插件挂载；② 一条宿主侧写入落在 attach→重放的窗口内（与另一条持久写并发）」。
- **我的反证**（`node D:/projects/tmp/v1-harness/probe-r101.mjs`，B 段，真实 `lib/store.js`）：
  ```
  B status while degraded: {"durable":false,"backend":"memory",...}
  B durable record after attach: {"sessionId":"pre-s1","profile":"web","updatedAt":5,"values":{"race.consumer":{"kA":11}}}
  B write log: []                      <- 重放一次 put 都没发
  B kC after attach = 0 (expected 300) <- 降级期的写入 kC 被静默丢弃
  B logs: [host half mounted, reconciliation skipped..., per-session overrides stored in domain]
  ```
  对照 C 段（同一会话**没有**既存耐久记录时）`kC = 300` 正常重放。
- **机制**：`lib/store.js:145-149` `const existing = table.get(sessionId); if (existing === undefined) await table.put(...)` —— 只要该会话**已经有耐久记录**（例如上一次 DSH 运行留下的覆盖，这是极常见的情形），重放就整条跳过，随后 :149 `memory.clear()` 把内存里那份**唯一的**拷贝抹掉，不合并、不报错、不打日志。
- **为什么这比 R1-01 更值得写**：它**不需要任何并发窗口**，只需要「storageDomain 晚到 + 一条宿主侧写入 + 该会话以前改过设置」。触发面比 R1-01 描述的更宽。
- **R1 错在哪**：它把 `replayMemory` 的缺陷只归因为「没走 enqueueWrite 的竞态」，没有读 `if (existing === undefined)` 这个**丢弃分支**。事实与 R1-01 不冲突（同一个函数、同一种修法），但 R1-01 的「触发条件（如实说明）」因此是**不完整**的，其分级统计也少算了一条同源的静默丢失路径。
- 附带观察（同源）：降级期该会话的 `get()` 也读不到既存耐久值（内存为空 → 返回默认），消费者在窗口内看到的是错值并据此写入。

### 4.2 【措辞夸大】R1-04 把「协议预留的错误码」说成「协议与实现不一致」

详见 §1.4：映射表与协议 §6 完全一致，且 `docs/notes/t2-t3-choices.md:100-101` 已显式声明 409 保留不可达。事实（无触发路径）成立，定性偏重。级别仍是建议，不影响统计。

### 4.3 【顺带】R1 没提协议自身的内部矛盾（文档级）

协议 v1.1 在 §1（`docs/protocol-v1.md:20-21`）写「sessionPersistence 缺失**不影响任何方法的状态码**」，但同文件 §6（`:113`）的 `storage-unavailable` 释义仍写「storageDomain / **sessionPersistence** / webServer 不可用」。R1 在 §3.6 曾按 §6 的字面提过疑问、§5.2 又按 v1.1 判为实现符合，但没有指出**协议 file 内部这两处仍然互相打脸**。这是文档级建议（见 §7）。

## 5. R1 的 A–G 不变量结论（抽查）

R1 声明 A–G 全部符合。我用自己写的 60 条独立断言（`probe-bridge.mjs` 45/45 + `probe-service.mjs` 15/15）抽样覆盖了 A（路由/POST/fence 各分支/封套）、B（四方法、own-property 派发、`renderers.put` 404、稀疏、三档 reset）、C（参数顺序、重复注册点名、disposer、订阅健壮性、未注册返回 undefined）、D（域声明、稀疏三档、per-record 键、对账）、F（`ctx.effect` 包裹路由与域 handle）的主要断言，**全部通过**，未发现 R1 的 A–G 结论有夸大。

我没能独立覆盖的：E 的 DOM 层行为（禁止浏览器）、F3 真实 HMR/重复 apply 幂等性（需要真 Cordis 装载器）、C12–C15 的真实 slot 注册（需要真实客户端运行时）。

## 6. 三分类统计

| 分类 | 条目 | 数 |
|---|---|---|
| **成立** | R1-01（严重）、R1-02（建议）、R1-03（一般）、R1-05（建议） | 4 |
| **部分成立** | R1-04（事实成立；「协议与实现不一致」的定性偏重） | 1 |
| **不成立** | — | 0 |
| 已修复项复核通过 | X1、X2、X3、X4（4/4 通过属实） | 4 |
| 假警报抽样 | 抽 4 条，反证全部成立 | 4 |
| R1 虚报 | 0（行号与原件引用全部准确） | 0 |
| R1 实质漏报 | 1（§4.1，重放路径的无并发静默丢失） | 1 |
| R1 措辞夸大 | 1（§4.2） | 1 |

## 7. 我认为必须修复的清单（按级别排序）

1. **【严重】重放路径的两条静默丢失一起修**（R1-01 + 我发现的 §4.1）：
   `lib/store.js` 的 `replayMemory()` 必须
   (a) 把每条重放放进 `enqueueWrite(sessionId, …)`，与 `mutate`/`drop` 共用同一条 per-session 队列；
   (b) **先取队列槽、再重新 `table.get`**：有既存记录时做 **merge**（把内存覆盖合并进耐久记录后 update），没有才 put——现在的 `if (existing === undefined)` 会直接丢弃内存那份唯一拷贝；
   (c) 无法合并时至少要 **报错/打日志**，不能静默 `memory.clear()`。
   验收：`probe-r101.mjs` 的 A 段要 `kA=100 且 kB=200`；B 段要 `kC=300` 而不是 0。
2. **【一般】`tests/index.js:6-14` 的注释不实**（裸 `node --test` 跑 0 条却 exit 0）：删掉第 8 行那种写法，或加 `package.json` 的 `scripts.test`（如 `"test": "node --test tests/"`），二者取一。
3. **【建议】`lib/resolve.js:247-257` 默认值层返回 `clone(item.default)`**（与存储层 :195-202 的防护对齐），或注册时 `Object.freeze` 默认值。
4. **【建议】`lib/client.js:947-948` 用 slot 标准 prop `useSessions` 取 `title`/`label`/`cwd`，取不到再回退 `shortSession`**（不需要 import Harness 包，见 §1.5）。
5. **【建议/文档】409 的「保留不可达」在协议侧也标一句**（`docs/protocol-v1.md:112` 或 `lib/resolve.js:23` 注释）；同时修协议 §6 `:113` 与 §1 `:20-21` 关于 `sessionPersistence` 的自相矛盾（§4.3）。

## 8. 我无法验证的点（如实写明）

1. **真实 DSH 里 storageDomain 是否真的晚于本插件挂载**。全环境禁令（不得启动 profile），我只能确认代码与注释支持该顺序（`lib/index.js:281-287`）。这直接影响 R1-01/§4.1 的**实际可达性**——机制与丢失我已用真实产品代码实测。
2. **真右栏页面的 DOM 表现**（R1-05 的表现层、E3/E4/E5 的观感）：硬性禁令，未开浏览器。
3. **真实官方 json 后端的落盘行为**：我用的是严格照官方 KvTable 语义建模的域桩（依据 `dsh-storage-domain/lib/index.js:257-287` 与 `domain.d.ts:1-8`），没有跑真实 `dsh-storage-json`（项目 node_modules 未安装该包）。竞态的存在只取决于「先耐久、后改内存」的次序，而该次序已由官方源码确认。
4. **R1 自己夹具内部的细节**（「trustedHosts 夹具缺陷」「V7 的 ops 字符串 put,u,u,u,delete,put,u,u,u」「V9 的具体输出」）：我无法复现它夹具的内部行为，只独立复核了产品侧性质。
5. **跨进程并发写同一 `storages` 根**（无 CAS）：未测，与 R1 的 §5.6-3 一致。
6. **F3 真实 HMR/重复 apply 幂等性**、C12–C15 真实 slot 注册：没有真 Cordis 装载器与浏览器运行时。

## 9. 我的复现脚本与命令清单

脚本（全部在 `D:/projects/tmp/v1-harness/`，非项目文件）：

```powershell
node D:/projects/tmp/v1-harness/probe-r101.mjs        # R1-01 + §4.1（A/B/C 三段）
node D:/projects/tmp/v1-harness/probe-r102.mjs        # R1-02
node D:/projects/tmp/v1-harness/probe-x1.mjs          # X1 + X4
node D:/projects/tmp/v1-harness/probe-interleave.mjs  # X1 的 V7 等价物
node D:/projects/tmp/v1-harness/probe-reconcile.mjs   # X2 (a)(b)(c)(d)(e)
node D:/projects/tmp/v1-harness/probe-bridge.mjs      # 45 条桥检查（A/B/D + fence + 降级）
node D:/projects/tmp/v1-harness/probe-service.mjs     # 15 条服务 API 检查（C1-C6 + 深比较）
node D:/projects/tmp/v1-harness/probe-x3.mjs          # X3 状态码口径
```

项目内只读命令：

```powershell
cd D:/projects/dsh-plugins/dsh-session-settings
node --check lib/bridge.js lib/client.js lib/index.js lib/resolve.js lib/store.js lib/trust-fence.js
node --test
node --test tests/
node --test "tests/*.spec.mjs"
node --test "tests/**/*.spec.mjs"
Get-ChildItem lib/*.js, tests/*, package.json | Get-FileHash -Algorithm SHA256
```

我未修改任何产品文件；只写入了 `docs/reviews/r1-verification.md`（本文件）与 `D:/projects/tmp/v1-harness/` 下的复核脚本。
