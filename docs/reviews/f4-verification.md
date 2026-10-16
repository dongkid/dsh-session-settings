# V4 复核：F4 修复验证 + 对抗性找茬（verifier-4）

- 复核者：verifier-4（全新代理，无前序共享记忆，只依据文件与本次实测；不修改任何产品文件）
- 时间：2026-10-13 01:46 – 02:0x（Asia/Shanghai）
- 项目：D:/projects/dsh-plugins/dsh-session-settings
- 夹具：D:/projects/tmp/v4-harness/（fakes.mjs、f4-store.mjs、f4-host.mjs、counterfactual.mjs、prior-rounds.mjs、client-header.mjs）
- 被复核对象：task-12（F4）的六条主张 + F4 引入路径的对抗性检查
- 未使用任何浏览器工具 / chrome-devtools MCP；未运行 plugin_manager；未写 ~/.dsh；未修改任何产品文件

## 0. 一句话结论

**六条主张全部成立（6 成立 / 0 部分成立 / 0 不成立）。对抗性检查 (a)–(g) 全部未能击穿 F4。共有 176 项独立检查全绿。没有发现【一般及以上】的问题；只有 3 条【建议】级残余 + 若干观察。最终回答见 §8：不存在一般及以上问题。**

---

## 1. 环境与基线复跑

Node v24.12.0（Windows）。产品文件在本轮开始（01:46:36）之前最后一次修改是 docs/notes/t2-t3-choices.md 01:45:27，其后没有任何产品文件被改动（§1.4）。

### 1.1 node --check 六个 lib

命令与结果：

```
cd D:/projects/dsh-plugins/dsh-session-settings
foreach ($f in `('index','store','resolve','bridge','trust-fence','client')) { node --check "lib/$f.js" }
-> checked_ok=6/6
```

### 1.2 node --test tests/

```
node --test tests/
ℹ tests 96   ℹ pass 96   ℹ fail 0   exit=0
```

与任务书"应 96 全绿"一致。

### 1.3 裸 node --test

```
node --test
ℹ tests 0    ℹ pass 0    ℹ fail 0    exit=0
```

0 测试、exit 0，与 tests/index.js 的注释（裸跑是假绿，入口靠目录参数解析）一致。

### 1.4 产品文件未被本轮改动

```
Get-ChildItem lib/*.js, tests/*.mjs, docs/notes/*.md, docs/*.md | Sort LastWriteTime -Desc
t2-t3-choices.md 2026/10/13 1:45:27   host.spec.mjs 1:44:57   store.spec.mjs 1:44:18
store.js 1:43:16   resolve.js 1:27:48   ...
```

本轮开始时间 01:46:36，上述全部早于该时刻。本轮只新增 D:/projects/tmp/v4-harness/ 与本报告。

### 1.5 我自己的夹具

所有夹具都在 D:/projects/tmp/v4-harness/ 内独立编写。假表**逐条对照官方实现**写成（node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js:241-296）：get/keys/size 是 records map 的同步读；put/update/delete 经域写链，**耐久（unit 调用）成功之后才改内存**；delete 缺键返回 false（不抛）；update 缺键抛 DomainError('missing-key')。counterfactual.mjs 里的"修复前"副本由当前产品文件按 F4 diff 反向做**行级还原**生成，只落在夹具目录。

---

## 2. 六条 F4 主张逐条复核（全部亲手复现）

命令：`cd D:/projects/tmp/v4-harness && node f4-store.mjs`、`node f4-host.mjs`。下面每条只引用我自己的输出。

### (1) 写路径基于"有效记录 = 耐久 + pending（pending 优先）"执行稀疏规则；写成功后退役 pending —— **成立**

证据（f4-store / f4-host）：

```
PASS  C1.1 set-to-default deletes the pending key from the durable record
PASS  C1.1 read after the write
PASS  C1.1 the pending copy retires (pendingReplay 0, timer stops)
PASS  H-C1.1 set-to-default clears the pending override
PASS  H-C1.1 the durable record holds only the untouched override
PASS  H-C1.1 pending retired, timer stopped
PASS  H-G2 the bridge write response reflects the sparse delete
PASS  H-G2 the durable record agrees with the response
```

具体：耐久 `{p:{kA:11}}`、pending `{p:{kC:300}}`，调用"把 kC 写回默认值"后耐久变成 `{p:{kA:11}}`、pendingReplay 0、retryScheduled false、读回与耐久一致；桥的 values.set 响应与耐久记录逐字段一致。退役的前提（identity 检查）见 §3 (f)。

### (2) dropNow 先耐久删除成功再清 pending；失败保留 pending；有 pending 补一条 info —— **成立**

```
PASS  C2.1 drop reports a removal
PASS  C2.1 durable record really gone
PASS  C2.1 pending cleared and timer stopped
PASS  C2.1 the pending clearance is logged honestly
PASS  C2.2 drop rejects when the durable delete fails
PASS  C2.2 the pending copy is preserved
PASS  C2.2 the pending value stays readable
PASS  C2.2 the retry timer is still armed
PASS  C2.2 the durable record was not deleted either
PASS  C2.2 no "dropped" info line was claimed
PASS  C2.2 a later drop succeeds once deletes work again
PASS  C2.3 drop of a pending-only session reports true
PASS  C2.3 the info line is emitted even without a durable record
```

顺序确实是"耐久先、pending 后"：注入耐久 delete 失败时 drop 直接 reject，pending 仍是 1、仍可读、定时器仍在、且**没有**打出"已删除"的 info；失败清除后再次 drop 才真正清掉两者。无 pending 时不会打这条 info（H-G3）。文案问题见 §6 V4-01。

### (3) resetSession 与对账都走 drop，因此真正回收、不复活；对账日志名副其实 —— **成立**

```
PASS  H-C3.1 resetSession clears the pending copy
PASS  H-C3.1 the durable record is gone
PASS  H-C3.1 nothing is left to replay
PASS  H-C3.1 the store says so in the log
PASS  H-C3.1 the record does not come back
PASS  H-C3.2 reconciliation removed the durable record
PASS  H-C3.2 the pending value is not readable any more
PASS  H-C3.2 both log lines are present
PASS  H-C3.2 no revival
```

对账（sessionPersistence.list() 返回空）打出的两行是 `reconciliation removed 1 record(s)` + `dropped 1 pending override set ... together with its record`；同时直接查夹具表确认耐久记录真的不存在、读回是默认值、等待后不复活（不是只信文案）。代码路径 `lib/index.js:333` 用 `store.drop(id)` 也核对过。

### (4) 无 ctx.effect 时补一次性 warn —— **成立**

```
PASS  C4.1 pending held, no timer without ctx.effect
PASS  C4.1 exactly one "no ctx.effect" warn
PASS  C4.1 the warn stays one-shot across later passes
PASS  C4.2 with ctx.effect the timer is armed and no warn is printed
```

没有 ctx.effect 时 pending 保持 1、retryScheduled 恒为 false、warn 恰好一条且再次 attach/retryPending 不重复；有 ctx.effect 时无此 warn、定时器恰好一个、ctx.effect 只注册一条。V3-03 的不一致已消除，notes 13.2 最后一条现在准确。

### (5) notes 13.6 记录五项规则；域未就绪行为不变 —— **成立**

13.6 的 1/2/3/4 四点与 §2(1)(2)(3) 的实测逐条吻合；第 5 点（域未就绪行为不变）与 notes 13.6"仍未解决"段：

```
PASS  H-C5 registrations.list still answers 200 while degraded
PASS  H-C5 values.get is 503 storage-unavailable while degraded
PASS  H-C5 values.set is 503 too
PASS  H-C5 the in-process service still accepts and reads back degraded writes
PASS  H-134 CONFIRMED (documented 13.4 gap): the durable override survives the degraded reset
PASS  H-134b CONFIRMED (documented 13.4 gap): the durable override survives the degraded sparse delete
```

即：降级期桥的 values.* 仍是 503、registrations.list 仍 200、进程内服务仍写内存并读回——与协议 v1.1 §1 和 notes 13.6 第 5 点一致；13.4 的降级期删除不可表达**确实仍然存在**（notes 13.6 已如实声明"仍未解决"），F4 没有把它改坏也没有假装解决。

### (6) 用时间证明 + 反事实对照证明"不复活" —— **成立**

我用自己的时间证明：把重试间隔缩到 10ms，drop 后等 70ms（≈7 个 tick）：

```
PASS  C2.1 no revival after 7 retry ticks
PASS  B1 no revival over 6 ticks
PASS  B2 no revival over 6 ticks
PASS  B3 no revival over 6 ticks
PASS  B4 no revival over 6 ticks
```

并且做了**反事实对照**证明这套测试不是空洞的（node counterfactual.mjs）：把 F4 的两处改动分别行级还原成修复前行为：

```
COUNTERFACTUAL: without the F4 drop fix the record IS resurrected by the timer
COUNTERFACTUAL: without the F4 write fix, set-to-default does NOT clear the pending key
COUNTERFACTUAL: without the F4 write fix the write starts from an empty base and drops kA
CONTROL product store: no revival inside the same window
CONTROL product store: set-to-default clears the pending key
CONTROL product store: the pending-only key survives the write
--- counterfactual: 12 pass / 0 fail ---
```

同一个 10ms×7 tick 窗口里，修复前的 drop 路径**会**复活记录，修复后的不会；修复前的写路径**会**复现 V3-01 的三个症状，修复后的不会。所以"时间证明 + 反事实对照"这一主张本身成立，且不是靠文案。

---

## 3. 对抗性找茬（重点）

命令：`node f4-store.mjs`、`node f4-host.mjs`。

| 对抗问题 | 结论 | 关键证据 |
|---|---|---|
| (a) 退役 pending 会丢掉"没被写进去"的 pending 键吗？ | **不会**（5 种变体全部保留） | C1.2 C1.3 C1.4 C1.5 C1.6 |
| (b) 重放进行中并发 mutate/drop（含 drop 与 attach 同 tick） | 正确，无复活、无丢失 | B1 B2 B3 B4 B5 |
| (c) 耐久写失败时 pending 是否保留、是否被误退役 | 保留且不退役（replay 写失败 / 重试耗尽 / drop 的 delete 失败 / 空记录的 delete 失败） | C4.1 C2.2 D3 D4 |
| (d) 读-改-写之间记录被删（missing-key）且存在 pending | 正确：重建含 pending 键，pending 退役 | D1 D2 D3 |
| (e) resetSession 与并发写交错；活跃会话被对账误删？ | 交错后读/盘一致；在 list() 里的活跃会话不被删 | H-E1 H-E2 H-E3 E-boundary |
| (f) identity 检查能否被击败 | **不可**（构造性论证 + 代码证据） | §3(f) |
| (g) 桥与进程内读一致性、日志如实性 | 一致且如实；1 条文案级瑕疵 | H-G1 H-G2 H-G3 V4-01 |

### (a) pending 有多个键、只写其中一个

四种变体，全部保留未写键：

- `C1.3 writing A keeps B durably` + `C1.3 read agrees with the durable record` + `C1.3 pending retired without losing B`
  （耐久 `{p:{}}`、pending `p.A='a1', p.B='b1'`，只写 A → 耐久 `{p:{A:'a2',B:'b1'}}`）
- `C1.4 sparse-deleting A keeps pending B durably`（把 A 写回默认值触发稀疏删除，B 仍在）
- `C1.5 reset(group p) keeps pending group q durably`（跨插件组：reset p 后 q 仍耐久）
- `C1.2 the pending-only key kA survives next to the new kC`（连耐久记录都没有时，写路径从 pending 起算而不是空起算）
- `C1.6 writing s1 retires only s1` + `C1.6 s2 keeps its pending value readable` + `C1.6 the timer stays armed for s2`（退役只作用于本会话；另一个会话的 pending 不受影响）

因此"退役会丢键"不成立。唯一会让键消失的情形是 transform 自己删除它（用户显式写默认值 / reset），那是协议 §2.3 的预期语义。

### (b) 重放与 drop/mutate 并发

```
PASS  B1 drop during the replay put reports a removal
PASS  B1 nothing is left: no durable record, no pending
PASS  B2 drop+attach same tick: drop reports a removal
PASS  B2 no pending, no durable record          (drop 在仍降级时发出，attach 同 tick)
PASS  B3 attach+drop same tick: drop reports a removal
PASS  B4 the racing write and the replayed key both land
PASS  B4 the later drop removes everything
PASS  B5 the interleaved batch settles without an unhandled rejection
PASS  B5 the read agrees with the durable record after the batch
PASS  B5 the post-batch state stays stable over 6 ticks
```

B1 是"重放 put 在飞行中时 drop 入队"（用真实耐久屏障卡住），结果：put 落地后被同一个队列槽里的 drop 删掉，最终既无耐久记录也无 pending，7 个 tick 不复活。B2/B3 覆盖 drop 与 attach 的两种同 tick 顺序。B5 是 `Promise.allSettled([drop, mutate, drop])` 的三方交错，最终读与盘一致且跨 tick 稳定。

### (c) 耐久写失败时 pending 是否保留

四种失败模式全部保留 pending 且不误退役：

- `C4.1 pending held, no timer without ctx.effect`（replay update 失败）
- `D3 the pending entry is preserved` / `D3 the pending value is still readable` / `D3 the timer is still armed`（连 3 次 missing-key 重试耗尽后写 reject，pending 仍在）
- `C2.2 the pending copy is preserved`（drop 的耐久删除失败）
- `D4 pending is kept after the failure`（更新成空记录后，紧随的 table.delete 失败）

### (d) missing-key 重试 + pending

```
PASS  D1 the retry recreates the record without losing the pending key (kC + kD)
PASS  D1 read agrees
PASS  D1 pending retired after the successful retry
PASS  D2 reset through the missing-key retry leaves no durable record
PASS  D3 exactly three update attempts were made
```

D1：pending 存在、update 抛 missing-key 且记录在窗口内真的消失 → 重试改走 put，从有效状态（含 pending 键）重建，pending 键不丢、新写落地、pending 退役。D2：同样的窗口里做整会话 reset → 耐久记录保持不存在、读回空、pending 退役。D3：记录始终存在但 update 恒抛 missing-key → 恰好 3 次后 reject、pending 保留。
一个语义说明（不是缺陷）：D1 里被并发删掉的耐久键不会回来——那是"另一个 actor 显式删了整条记录"的语义，符合协议差集/删除语义，我把它记为预期行为而非丢失。

### (e) resetSession 与并发写；对账与活跃会话

```
PASS  H-E2 the service read agrees with the durable record after the interleave
PASS  H-E2 no pending leftovers
PASS  H-E3 the reverse interleave is equally consistent
PASS  H-E1 an active pending session keeps its durable record
PASS  H-E1 the pending value is untouched
PASS  H-E1 no removal was logged
PASS  E-boundary[active-but-unlisted]: a session missing from persistence.list() IS reclaimed
```

H-E1：sessionPersistence.list() 含 s1 时，活跃的 pending 会话不会被回收，也不打"removed"日志。
E-boundary 是我主动划的边界：**对账完全信任 list()**——list() 里没有的会话会被回收（这正是协议第 102 行的差集规则）。真实 list() 会不会漏掉一个刚创建的活跃会话，我无法在本层验证（§7 第 6 点）。这不是 F4 引入的行为。

### (f) identity 检查能否被击败

结论：**在进程内不可击败**，而且它是纵深防御而非唯一防线。证据：

```
store.js:  memory.set( 只出现在 521 行（mutateNow 的 !isDurable() 分支）
           memory.delete( 出现在 341（replay 收尾）、520、552（retire）、583/585（dropNow）
           memory.get( 出现在 313/340/438/519/531/551
```

唯一写入 memory 的语句（521）位于该会话写队列槽内（`enqueueWrite`）；其他对 memory 的写都只是 delete。因此从 `pendingBefore = memory.get(sessionId)`（531）到退役检查（551）之间，该键只可能是"同一条记录"或"已被删掉"（341 的 replay 收尾是本进程唯一可能在 await 期间跑的非队列操作，方向是删除），**不可能变成另一条记录**。检查失败的方向只是"不退役"，不会误删别的 pending。我的探针里没有任何一条能让 memory 在该窗口被替换：要么被队列挡住（同会话的第二次 mutate 必然排在后面），要么只是被删除。

因此"identity 检查被击败导致误退役/丢数据"不成立；C1.6/F1/F2 也各自验证了并发下不丢键。

### (g) 桥与进程内服务读一致性、日志如实性

```
PASS  H-G1 bridge resolved === in-process resolved
PASS  H-G1 bridge overrides === in-process overrides
PASS  H-G1 the durable record really lacks the pending key
PASS  H-G1 ...yet every reader reports it
PASS  H-G2 pending retired by the bridge write
PASS  H-G2 the next bridge read still matches the service
PASS  H-G2 no bogus drop log line
PASS  H-G3 a durable-only drop does not claim a pending drop
PASS  H-C5 values.get is 503 storage-unavailable while degraded
```

我核对了"字节级真相"而不只是文案：pending 窗口内桥与进程内读到的 resolved/overrides 逐字段相等，同时直接查夹具表确认耐久记录**确实还没有那个键**；桥写之后响应、进程内读、耐久记录三者一致；没有 pending 的 drop 不会打出"dropped 1 pending override set"。降级期桥按协议返回 503（不是假装能写）。唯一瑕疵是 §6 V4-01 的文案。

---

## 4. 前三轮关键结论抽查（仍然成立）

命令：`node prior-rounds.mjs`、`node client-header.mjs`

```
PASS  A: both keys survive / A: exactly one put and one update / A: pending drained
PASS  B: the merge kept every key / B: the durable record itself / B: profile preserved
PASS  C: regression guard - no put, exactly one update
PASS  clone-1 get(): later reads are unaffected
PASS  clone-2 getItem(): later reads are unaffected
PASS  clone-3 snapshot(): later reads are unaffected
PASS  clone-4 registrations.list: the registration default is untouched
PASS  set-copy: the caller keeps ownership of its object
PASS  protocol: prototype/unknown names never dispatch
--- prior-rounds: 19 pass / 0 fail ---

PASS  F2-1 the header prefers the session title
PASS  F2-2 the header falls back to cwd when the title is blank
PASS  F2-3 without a session kit the header falls back to the truncated id
PASS  F2-4 a kit without title/cwd falls back to the truncated id
PASS  F2-5 the title attribute keeps the whole sessionId in every tier
--- client-header: 9 pass / 0 fail ---
```

- A/B/C 三段：A（无既存记录 + replay put 在飞行中并发耐久写）put=1/update=1/两键都在/pending=0；B（有既存记录）合并成功、profile 保留；C（回归护栏）put=0/update=1。
- clone 出口：get / getItem / snapshot / registrations.list 默认值 四个出口都是独立拷贝，set 的入参拷贝也成立，注册对象不被污染；协议面上 `constructor/toString/__proto__/hasOwnProperty/values.drop` 全部 404。
- F2 头部：用我自己写的迷你 React 运行时（含 Component/useState/useEffect/useRef/useCallback/useSyncExternalStore）从真实的 `window.__ModuleLoader__` 入口加载 client.js，走真实的 slots 注册回调渲染，title → cwd → 截断 id 三档回退成立，title 属性三档都保留完整 sessionId。

---

## 5. 文档与实现一致性

| 文档 | 结论 |
|---|---|
| notes 13.2（重试策略/节流/无 ctx.effect 要说明） | **准确**（V3-03 已修：C4.1 真的打一条 warn；节流边界属 V3 已验证范围，本轮未变） |
| notes 13.6 第 1/2/3/4/5 点 | **准确**：1→§2(1)、2→C1.x/C1.6、3→§2(2)、4→H-C3.2（两行日志与"耐久+pending 一起清"的实测吻合）、5→H-C5 |
| notes 13.6"仍未解决（13.4）" | **准确**：H-134 / H-134b 复现了降级期 reset/写默认值被耐久旧覆盖"复活"的文档化缺口 |
| notes 13.6"怎么证明不复活"指向的两个测试文件 | 文件存在且非空洞（counterfactual 反证） |
| design-v1.md:58 稀疏维护 / :100-102 写与恢复 | 与实现一致；V3-04 指出的"验收判据 3 在 pending 窗口不成立"现已成立（C1.1/H-C1.1） |
| design-v1.md:57"写路径用 table.update 原子读改写" | 仍是简写（省略了"新记录先 put"和 F4 的"有效记录"规则）；notes 13.6 承载完整契约，不构成误导 |
| design-v1.md:96 / :148 | 与实现一致（读同步；降级时桥 503 只读，H-C5 实测） |
| protocol-v1.md:20/113（values.* 需耐久，否则 503） | 一致（H-C5） |
| protocol-v1.md:58/65（稀疏规则） | 一致，且 F4 后对 pending 键也成立 |
| protocol-v1.md:102（对账只按 list() 差集） | 一致（E-boundary 就是这条规则的另一面） |

未发现文档与实现相矛盾的陈述。

---

## 6. 残余问题清单（按级别）

**【严重】：无。**
**【一般】：无。**

### 【建议】级（3 条）

#### V4-01【建议·日志文案】只有 pending、没有耐久记录时，drop 仍说 "together with its record"
- 位置：lib/store.js:586-589（dropNow 的 info 文案）。
- 复现：`node f4-store.mjs`，`PASS C2.3 the info line is emitted even without a durable record`（夹具表里耐久记录不存在、table.delete 返回 false，但日志仍说 "dropped 1 pending override set of session ... together with its record"）。
- 影响：日志读者会以为同时删掉了一行耐久记录。对账场景同样可打印这一行（H-C3.2 里耐久确实存在，所以那一次是真的；C2.3 那一次不是）。
- 建议方向：仅在 `removedDurable` 为 true 时加 "together with its record"，否则说 "dropped 1 pending override set of session ... (no durable record existed)"。不影响任何数据路径。

#### V4-02【建议·失败后再重放】"更新成空记录"之后紧接的 delete 失败，会让下一次重放把 reset 撤销
- 位置：lib/store.js:542-553（isEmptyRecord(next) → table.delete → 失败则跳过退役并抛出）。
- 复现：`node f4-store.mjs`，观察行：
```
D4 observation: read={"p":{"kC":300}} disk={"p":{"kC":300}} pending=0
```
  即：写入已经 reject（不静默），但 pending 被保留（这是 claim(2)"删除失败宁可重试也不丢"的对称后果），下一次重放把旧 pending 合并回耐久记录，用户刚做的 reset 被撤销。
- 影响面：需要耐久 delete 失败（与 claim(2) 覆盖的是同一类故障）。写法本身是"失败要报错"的，不是静默；但"reset 被下一个 tick 撤销"这一结果值得在 notes 13.6 里点明一句（现在只写了 drop 的失败保留，没有写 mutate 空记录路径的同一后果）。
- 我无法量化真实 delete 失败频率（§7 第 1 点）。

#### V4-03【建议·可观测性】退役路径把 pending 值变耐久时，若覆盖了更新的耐久值，不打 warn
- 位置：lib/store.js:548-554（退役）对比 lib/store.js:320-328（replay 的 overwritten warn）。
- 复现：`node f4-store.mjs`：
```
C1.7 the durable record now carries the OLD pending value
C1.7 observation: warnings during the retire = 0 (the replay path would have warned about overwriting the newer durable value)
```
  构造：耐久 updatedAt=500 值为 'newer-durable'，pending updatedAt=100 值为 'from-degraded-window'（这就是 R2-02 定义的那种"pending 是旧快照"的条目），随后任一写触发退役 → 耐久变成旧值，0 条 warn；同样的覆盖若发生在 replay 路径却会 warn 并点名键。
- 影响：用户看到的值前后一致（退役前 pending 已经赢），所以不是静默丢失；但"更新的耐久写入被旧快照覆盖"这件事在写路径上没有留下痕迹，运维口径与 replay 路径不对称。
- 建议方向：把 replay 里那段 superseded 检测复用到退役时（比较 durable.updatedAt > pending.updatedAt），或至少在 notes 13.6 里写明这个不对称。

### 观察（不计为问题）

1. lib/store.js:566-569 的 JSDoc 仍写 drop "`returns whether a record existed"，而 F4 后返回值语义是"耐久记录被删 **或** pending 条目被清"。调用方（index.js 对账）不使用返回值，无实际影响，措辞可再精确。
2. D1 的语义：missing-key 窗口里如果另一个 actor 删掉了整条耐久记录，那条记录上的旧键不会随 put 重建（只有 pending 键 + 新写会回来）。这是"别人显式删除"的正确语义，我按预期行为记录。
3. note 13.5 的多进程并发写同一 storages 根仍未解决（本轮未做双进程实验，见 §7 第 5 点）。

---

## 7. 我无法验证的点

1. **真实 Cordis / DSH 运行时**：不允许写 profile，所以 storage-json 真实落盘、`invalidRecords: backup-and-skip` 的真实搬运、真实 `ctx.effect` 在 fiber 卸载/HMR 时的行为、真实 `sessionPersistence.list()` 的返回与时延，都是用与官方 KvTable 源码逐条对齐的假件建模的。真实后端 put/update/delete 失败的频率与形态我也无法量化，因此 V4-02 的实际触发概率未知。
2. **真实 HTTP / webServer**：桥是用合成 request/response 直接驱动 handler，没有监听真实端口；fence 只覆盖了回环 Host 这一条路径（Host/Origin 的组合矩阵属前三轮范围，本轮未扩展）。
3. **真实 UI 交互**：禁止浏览器工具，所以"点恢复默认/全部恢复默认"的完整前端链路没有实测；我验证到桥响应 + 进程内服务 + 耐久记录三者一致，页面观感与真实点击未验证。
4. **真实磁盘残留**：没有检查真实 storages 根下是否已有 pending 会话的残留文件。
5. **多进程并发写同一 storages 根（notes 13.5）**：未做双进程实验。
6. **sessionPersistence.list() 是否会漏掉刚创建的活跃会话**：我只能在夹具里证明"list() 缺谁就回收谁"（E-boundary），无法证明真实 list() 会不会缺。
7. **identity 检查不可击败**的结论来自"所有 memory.set 都在该会话写队列槽内"这一代码证据 + 探针，不是形式化证明；我未能在公开 API 上构造出内存在该窗口被替换的可达状态——这本身就是结论的一部分。

---

## 8. 最终回答

**否：目前不存在【一般及以上】的问题。**

- 六条 F4 主张：**成立 6 / 部分成立 0 / 不成立 0**。
- 对抗性 (a)–(g)：全部未能击穿 F4；退役不丢键、并发 drop/mutate 不复活、失败不误退役、missing-key 重试不丢 pending、活跃会话不被误删、identity 检查不可击败、桥与进程内读一致且日志如实（除 V4-01 的文案）。
- 基线：node --check 6/6；node --test tests/ 96/96 全绿；裸 node --test 0 测试 exit 0；前三轮 A/B/C、clone 四出口、F2 头部三档全部复现成立。
- 残余：3 条【建议】（V4-01 日志文案、V4-02 delete 失败后 reset 被重放撤销、V4-03 退役覆盖无 warn）+ 3 条观察。都不影响数据正确性，也不改变"降级期删除不可表达（13.4）"这一已文档化的缺口。
