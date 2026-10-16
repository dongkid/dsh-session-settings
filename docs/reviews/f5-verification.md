# V5 复核：F5 三处建议级修复验证 + 最终确认（verifier-5）

- 复核者：verifier-5（全新代理，无任何前序共享记忆；只依据产品文件与本次亲手实测。不修改任何产品文件）
- 时间：2026-10-13 02:05 – 02:25（Asia/Shanghai）
- 项目：D:/projects/dsh-plugins/dsh-session-settings
- 夹具：D:/projects/tmp/v5-harness/（fakes.mjs、f5-store.mjs、f5-host.mjs、prior-rounds.mjs、client-header.mjs、extra-adversarial.mjs）
- 被复核对象：task-14（F5）对 V4-01 / V4-02 / V4-03 三条建议的修复
- 禁令遵守：未使用任何浏览器工具 / chrome-devtools MCP；未运行 plugin_manager；未写 ~/.dsh；未改任何产品文件（§1.4 用 mtime + SHA-256 佐证）
- 本报告中的每条结论都来自本轮我自己的命令与输出，未引用修复者或任何前序成员的报告作为证据

## 0. 一句话结论

**F5 的三条主张：成立 3 / 部分成立 0 / 不成立 0。基线 6/6 + 98/98 + 裸跑 0；前四轮结论抽验全部复现；对抗性抽查（含要求的三类误报场景）全部未能击穿。本轮共 206 项独立检查全绿。额外发现 3 条【建议】级 + 2 条观察，无【一般】及以上。最终回答见 §8。**

---

## 1. 环境与基线

Node v24.12.0（Windows）。所有命令在 D:/projects/dsh-plugins/dsh-session-settings 下执行。

### 1.1 node --check 六个 lib

命令：

    foreach ($f in @('index','store','resolve','bridge','trust-fence','client')) { node --check "lib/$f.js" }

输出：

    node --check: 6/6

### 1.2 node --test tests/

    node --test tests/
    ℹ tests 98
    ℹ pass 98
    ℹ fail 0

与任务书"应 98 全绿"一致。

### 1.3 裸 node --test

    node --test
    ℹ tests 0
    ℹ pass 0
    ℹ fail 0
    bare node --test exit=0

0 测试、exit 0。

### 1.4 产品文件未被本轮改动

本轮开始前我记录了产品文件的 mtime 与 SHA-256 前 16 位；所有产品文件都停在 02:03:52 之前（F5 的落地时间），远早于本轮开始时间 02:05:32；本轮我只在 D:/projects/tmp/v5-harness/ 与本文件写入。

    bridge.js            10-13 00:31:57  A53F889FE6E4456E  230 lines
    client.js            10-13 01:07:29  CD8F32102B99CBCD  1301
    index.js             10-13 00:42:27  A6E38F98561BB060  351
    resolve.js           10-13 01:27:48  AB7D4158DEB7E842  358
    store.js             10-13 02:03:09  666805112E9E0EA7  611
    trust-fence.js       10-13 00:31:32  D03C9FD4FB0061FF  108
    store.spec.mjs       10-13 02:03:20  31BE96235B6197D7  616
    host.spec.mjs        10-13 02:03:20  BE3C6110C13AD4B6  572
    resolve.spec.mjs     10-13 01:06:52  49604508206B956C  236
    bridge.spec.mjs      10-13 00:36:57  24BA694A1C011C41  238
    client.spec.mjs      10-13 01:06:47  24E150AB04606B93  597
    t2-t3-choices.md     10-13 02:03:52  41BB3EA0ECAF7C58  195

### 1.5 我的夹具（全部独立编写，全部在夹具目录内）

假表逐条对照官方 storage-domain 表契约写成：get/keys/size 是 records map 的同步读；put/update/delete 走写链，**先等耐久屏障再改内存**，所以屏障挂起期间 get() 仍报旧状态；update 缺键抛 DomainError('missing-key')；delete 缺键返回 false 不抛。每个操作都可注入故障（faults.put/update/delete），用来构造"写失败 / delete 失败"。

命令与结果汇总：

    cd D:/projects/tmp/v5-harness
    node f5-store.mjs          -> --- f5-store: 92 pass / 0 fail ---
    node f5-host.mjs           -> --- f5-host: 65 pass / 0 fail ---
    node prior-rounds.mjs      -> --- prior-rounds: 28 pass / 0 fail ---
    node client-header.mjs     -> --- client-header: 12 pass / 0 fail ---
    node extra-adversarial.mjs -> --- extra-adversarial: 9 pass / 0 fail ---

合计 206 项检查。

---

## 2. F5 三条逐条复核

### (1) drop 日志按事实分支 + JSDoc 措辞 —— **成立**

被验代码：lib/store.js:626-637（dropNow）与 :605-625（drop / dropNow 的 JSDoc）。

我用三个独立夹具构造三种事实，并检查**唯一一条** drop info 的措辞：

    node f5-store.mjs
    PASS  A1 pending held after the failed replay put
    PASS  A2 no durable record ever landed
    PASS  A3 drop reports a removal
    PASS  A4 pending cleared
    PASS  A5 retry timer stopped
    PASS  A6 exactly one drop line
    PASS  A7 the line says no durable record existed
    PASS  A8 the line does NOT claim a durable record
    PASS  A9 the line matches the fact-branched template exactly
    PASS  B1 pending held after the failed replay update
    PASS  B2 the durable record really exists
    PASS  B3 drop reports a removal
    PASS  B4 the durable record is gone
    PASS  B5 exactly one drop line
    PASS  B6 the line says together with its durable record
    PASS  B7 the line does NOT say no durable record existed
    PASS  B8 the line matches the fact-branched template exactly
    PASS  C1 nothing is pending
    PASS  C2 drop reports a removal
    PASS  C3 the durable record is gone
    PASS  C4 no extra pending line is printed
    PASS  D1 an empty drop reports false
    PASS  D2 no drop line is printed
    PASS  Q1 no pending survives a pending-only drop

A9/B8 用一条严格模板断言，不允许任何第三种措辞：

    /^\[dsh-session-settings\] dropped 1 pending override set of session "s1" (together with its durable record|\(no durable record existed\))$/

三条事实分别是：(A) 降级写入后重放的 put 失败 → 磁盘从没有记录（`durable.records.has('s1') === false`，drop 返回 true）→ 日志 "…(no durable record existed)"；(B) 磁盘有旧记录 + pending 一条（重放 update 失败）→ 日志 "…together with its durable record"，且磁盘记录确实被删掉；(C) 只有耐久记录、无 pending → drop 返回 true、磁盘记录被删，但**不打**这条 info。另加 (D) 两者都没有 → drop 返回 false 且无日志；(Q) 只删 pending 后等 7 个 10ms tick 不复活，定时器停掉。

JSDoc 措辞（V4 观察 1 的旧措辞已消除）：

    PASS  P1 drop() no longer says "returns whether a record existed"
    PASS  P2 drop() documents the three-way result
    PASS  P3 dropNow() documents the three-way result

现状（lib/store.js:608-610、:624）：drop "@returns whether the session had anything to drop: a durable record, a pending entry, or both."；dropNow "@returns whether a durable record, a pending entry, or both were dropped." 与返回值语义（`return removedDurable || hadPending`）一致。

### (2) superseded 提取 + 重放/退役共用同一检测与模板 + 只在写成功后才 warn —— **成立**

被验代码：lib/store.js:173-187（supersededKeys）、:199-204（warnSuperseded）、:257（重放合并返回 overwritten）、:355-356（写成功后才 warn）、:564-569（退役路径同一检测）、:589-595（写成功并真的退役后才 warn）。

行为证据（replay 与 retire 用**同一组状态**：耐久 updatedAt=500 值 'newer-durable'，pending updatedAt=100 值 'from-degraded'）：

    PASS  E1 the failed replay holds the pending entry
    PASS  E2 a failed replay warns nothing
    PASS  E3 the replay landed
    PASS  E4 the replay path warns exactly once
    PASS  E5 no warn before the retiring write
    PASS  E6 the retire path warns exactly once
    PASS  E7 the retire path uses the same template
    PASS  E8 the replay warn names the superseded key
    PASS  E9 the retire warn names the same superseded key
    PASS  E10 the replay warn carries the same comparison
    PASS  E11 the retire warn carries the same comparison

E7 把两句 warn 的 `replaying the overrides of` / `retiring the pending overrides of` 归一到同一占位符后逐字符相等——即**同一模板**，只有 how 短语不同。E10/E11 都含 `durable updatedAt 500 > pending 100`，E8/E9 都点名 `p/k`。

"只在写成功后才 warn"用失败注入正面验证：

    PASS  F1 pending held
    PASS  F2 the failed replay warned nothing
    PASS  F3 the retiring write rejects
    PASS  F4 a failed retiring write warns nothing
    PASS  F5 the pending entry is preserved
    PASS  F6 the pending value is still readable
    PASS  G1 pending held
    PASS  G2 the replay reported one failure
    PASS  G3 a failed replay warns nothing
    PASS  G4 pending still held

F 是"退役路径的写失败"（update 抛错 → mutate reject → warn 0 条、pending 保留）；G 是"重放路径写失败"（retryPending failed=1 → warn 0 条）。

结构证据（源码文本级，确认"提取"而非复制）：

    PASS  M1 exactly one supersededKeys definition
    PASS  M2 supersededKeys is called from two places
    PASS  M3 exactly one warnSuperseded definition
    PASS  M4 warnSuperseded is called from two places
    PASS  M5 the replay merge uses the shared detector
    PASS  M6 the retire path uses the shared detector
    PASS  M7 the JSDoc of supersededKeys says both paths share it
    PASS  M8 the warn JSDoc admits a failed write would be a false alarm

即：`supersededKeys` 只有一处定义、两处调用（mergeRecords 与 mutateNow）；`warnSuperseded` 只有一处定义、两处调用；两处 JSDoc 都写明了共用与"失败时告警是误报"。

### (3) notes 13.6 补写 V4-02 的对称后果与日志口径 —— **成立**

我先把 notes 描述的后果**在代码里真的复现**，再核对文字：

    node f5-store.mjs
    PASS  N1 the pending entry is held after the failed replay
    PASS  N2 the failure was logged (error log present)
    PASS  N3 the reset write rejects visibly
    PASS  N4 pending is preserved (not silently dropped)
    PASS  N5 the retry timer is still armed
    PASS  N6 the read still serves the pending value
    PASS  N7 the pending entry was replayed
    PASS  N8 the durable record carries the old pending value again (the reset was undone)
    PASS  N9 the read agrees

构造：耐久 `{p:{kA:11}}`、pending `{p:{kC:300}}`（重放失败留在内存）→ 一次把有效记录清空的写会先 update 成空记录、再 delete；注入 delete 失败后：写**reject**（N3，可见不静默）、pending 仍为 1（N4）、定时器仍武装（N5）、读回仍是 pending 值（N6）；下个重放 tick 把旧 pending 合并回耐久（N8/N9），**reset 被撤销**。N2 同时确认那条 error 日志仍在（运维口径：error 日志 + pendingReplay 非零）。

文字核对（notes 13.6，去换行归一后匹配）：

    PASS  O1 13.6 says a failed delete after an empty update makes the write reject
    PASS  O2 13.6 says the pending entry is kept
    PASS  O3 13.6 says the next replay tick may undo the reset
    PASS  O4 13.6 gives the operational signal (error log + non-zero pendingReplay)
    PASS  O5 13.6 records the drop log wording (V4-01)
    PASS  O6 the no-durable-record branch is documented
    PASS  O7 the both-dropped branch is documented
    PASS  O8 the durable-only branch is documented

对应原文即 notes 13.6 的"一个写路径的对称后果（V4-02，必须知道）"段与"日志口径（V4-01）"段。

---

## 3. 对抗性抽查

### 3.1 要求的三种"不得误报"场景（replay 与 retire 两条路径各验一遍）

    PASS  H-replay identical values warn nothing
    PASS  H-retire identical values warn nothing
    PASS  I-replay a NEWER pending warns nothing
    PASS  I-retire a NEWER pending warns nothing
    PASS  J-replay a pending-only key warns nothing
    PASS  J-retire a pending-only key warns nothing
    PASS  K-replay a structurally identical nested value warns nothing
    PASS  K-retire a structurally identical nested value warns nothing
    PASS  L1 the retire path warns once for the differing key
    PASS  L2 it names p/a
    PASS  L3 it does NOT name the equal key p/b

- 值相同（含嵌套数组/对象的结构等价）：jsonEqual 深比较 → 0 条 warn（H、K）。
- 写失败：0 条 warn（F、G）。
- pending 更新（pending 比耐久新）：`durableIsNewer` / `stalePending` 为 false → 0 条 warn（I）。
- 另加：只在 pending 存在的键不算被覆盖（J）；同一组里相等键不被点名、只点名真正不同的键（L）。

### 3.2 drop 日志三分支不串台

A8/A9 与 B7/B8 互斥（一边必须含 X 且不含 Y，另一边反之），C4 与 D2 证明"无 pending"时不打这行。模板正则只允许两种结尾，第三种措辞无法通过。**不串台。**

### 3.3 退役后 pendingReplay 与定时器状态一致

    PASS  R1 two sessions are pending
    PASS  R2 both replays failed and both entries are held
    PASS  R3 the timer is armed
    PASS  R4 retiring s1 leaves one pending entry
    PASS  R5 the timer is still armed for s2
    PASS  R6 s2 is still readable
    PASS  R7 retiring the last entry empties pendingReplay
    PASS  R8 and the timer stops

两个会话 pending（timer armed）→ 写 s1 退役它 → pendingReplay 1、timer 仍 armed、s2 仍可读；写 s2 → pendingReplay 0、timer 停。计数与定时器始终同步（A5、H5、RC3 也从其他入口验证同一性质）。

### 3.4 额外（超出要求三种）：退役 warn 的因果句在"显式覆盖/删除该键"时不准

    node extra-adversarial.mjs
    PASS  X1 the retire path warned
    PASS  X2 the durable record itself is gone (the only key was deleted)
    PASS  X3 the read agrees: nothing is left, the pending value did NOT win
    PASS  X4 yet the warn claims the pending copy wins
    PASS  Y1 the retire path warned
    PASS  Y2 the durable record holds the user value, not the pending one
    PASS  Y3 yet the warn claims the pending copy wins
    PASS  Z1 the retire path warned
    PASS  Z2 the pending value really won

X：退役这一次写把该键写回默认值（稀疏删除）→ 耐久记录被删、pending 被退役，pending 值**没有赢**，但 warn 仍说 "the pending copy wins because it holds writes that were already accepted"。
Y：退役这一次写把该键写成第三个值 'user-typed' → 耐久记录里是用户的新值，pending 值**没有赢**，warn 仍说 pending wins。
Z（对照）：退役这一次写改的是别的键 → pending 值真的赢，warn 完全准确。

即 warn 的主体（"某个更新的耐久值被丢弃" + 键清单）在 X/Y 仍然成立，只有结尾那句因果解释不成立。这是日志措辞问题，不影响数据路径 → 记为【建议】S-03（§6）。

---

## 4. 前四轮结论抽验（全部仍成立）

### 4.1 A/B/C 重放三段

    node prior-rounds.mjs
    PASS  A0 the degraded write is pending
    PASS  A1 the replay put is in flight (not yet durable)
    PASS  A2 exactly one put was issued so far
    PASS  A3 exactly one put in total
    PASS  A4 exactly one update in total
    PASS  A5 both keys survive
    PASS  A6 the pending entry was drained
    PASS  A7 the read agrees with the durable record
    PASS  B1 the replay used update, not put
    PASS  B2 exactly one update
    PASS  B3 every key is kept
    PASS  B4 the profile is preserved
    PASS  B5 pending drained
    PASS  B6 a non-stale replay warns nothing
    PASS  C1 put stays at zero
    PASS  C2 exactly one update
    PASS  C3 the durable keys and the replayed key both survive

A：无既存记录 + 重放 put 停在耐久屏障上时并发一次耐久写 → put=1、update=1、两键都在、pending 清空。B：有既存记录 → 合并、profile 保留、无 warn。C：有既存记录绝不 put 重建、恰好一次 update。

### 4.2 clone 四出口 + set 入参拷贝

    PASS  CL1 get(): later reads are unaffected
    PASS  CL2 getItem(): later reads are unaffected
    PASS  CL3 snapshot(): later reads are unaffected
    PASS  CL4 registrations.list: the registration default is untouched
    PASS  CL5 the service still resolves the original default
    PASS  CL6 set(): the caller keeps ownership of its object
    PASS  CL7 bridge.dispatch refuses constructor / toString / __proto__ / hasOwnProperty / values.drop

四个出口（get / getItem / snapshot / registrations.list 的默认值）都是独立拷贝，调用方改返回值不影响后续读取；set 的入参对象改后不影响已存值。

### 4.3 F2 头部三档

    node client-header.mjs   （用我自己写的迷你 React 从真实 window.__ModuleLoader__ 入口加载 lib/client.js）
    PASS  F2-1 the header prefers the session title
    PASS  F2-2 the header falls back to cwd when the title is blank
    PASS  F2-3 without a session kit the header falls back to the truncated id
    PASS  F2-4 the title attribute keeps the whole sessionId
    PASS  F2-5 a kit without title/cwd falls back to the truncated id
    PASS  F2-6 the title attribute still keeps the whole sessionId
    PASS  F2-7 the title is trimmed
    PASS  F2-8 the title attribute keeps the whole sessionId in the title tier
    PASS  F2-9 a short id is shown as-is

title → cwd → 截断 id 三档成立；三档的 `title` 属性都保留完整 sessionId；title/cwd 先 trim；长度 ≤12 的 id 原样显示。

### 4.4 pending 与写/删除路径一致性（关键用例）

    PASS  H1 the pending value is readable
    PASS  H2 nothing durable carries it yet
    PASS  H3 the override is gone, not shadowed by pending
    PASS  H4 the effective state is durable now
    PASS  H5 the retry timer stopped with it
    PASS  H6 only the untouched override survives
    PASS  H7 the durable record agrees
    PASS  H8 resetSession clears the pending copy
    PASS  H9 the durable record is gone
    PASS  H10 the reclaimed value is not readable
    PASS  H11 the record does not come back

pending 期间"把键写回默认值"真的删掉覆盖（H3-H7）；pending 期间 resetSession 连 pending 一起清、不复活（H8-H11）。

### 4.5 桥四方法与原型名 404 / fence

    PASS  BR1..BR10 四个方法的 HTTP 200 与响应/耐久记录逐字段一致
    PASS  BR11/BR12 constructor, toString, __proto__, hasOwnProperty, values.drop, valueOf -> 404 unknown-method
    PASS  BR13 an empty method is 404
    PASS  BR14 a nested path is 404
    PASS  FE1 无 Host -> 403 forbidden
    PASS  FE3 外部 Host -> 403
    PASS  FE4 cross-site 标记 -> 403
    PASS  FE5 外部 Origin -> 403
    PASS  FE6 同 host Origin 通过
    PASS  FE7 dsh-app://app 通过
    PASS  FE8 非 POST -> 405 method-not-allowed
    PASS  FE11 新加入 trustedHosts 立即生效（不需重启）

四个方法 + 原型名/未知名 own-property 派发 404 全部成立（进程内 `bridge.dispatch` 同样拒绝，见 CL7）。

### 4.6 对账不复活 + 降级行为

    PASS  RC1..RC8  （list() 为空 → 对账把耐久与 pending 一起回收，日志两行，40/60ms 后仍不复活，pendingReplay 0、timer 停）
    PASS  AR1..AR4  （活跃 pending 会话不被对账误删，也不打 removed 日志）
    PASS  DG1..DG7  （降级：registrations.list 200，values.get/set 503 storage-unavailable，进程内服务仍可写可读）

RC5/RC6 同时从宿主入口再次验证了 (1) 的两分支措辞。

---

## 5. 文档与实现一致性

| 文档 | 结论 |
|---|---|
| notes 13.6 第 1/2/3/4/5 点 | 准确（与 §2(1)(2)(3)、§4.4、§4.6 的实测吻合） |
| notes 13.6"一个写路径的对称后果（V4-02）" | **准确**：N1-N9 完整复现 |
| notes 13.6"日志口径（V4-01）" | **准确**：O5-O8 与三分支实测吻合 |
| notes 13.6 第 4 点的引文 | **不准确**：仍写 "…together with its record"，实际报文是 "…together with its durable record"（同一段下方 :259 又是正确写法）→ S-01 |
| notes 13.4 / 13.6"仍未解决" | 仍准确：降级期删除不可表达这一缺口未被 F5 改坏也未假装解决 |
| design-v1.md / protocol-v1.md | 未发现与实现相矛盾之处（F5 未改这两份） |

---

## 6. 残余问题清单（按级别）

**【严重】：无。**
**【一般】：无。**

### 【建议】级（3 条）

#### S-01【建议·文档引文】notes 13.6 规则 4 仍引用 F5 之前的旧报文措辞
- 位置：docs/notes/t2-t3-choices.md:236（"…together with its record"），而同文件 :259 已写正确措辞。
- 复现：`node f5-store.mjs` 的 O6/O7/O8 证明实现是两分支；对源码逐字核对（lib/store.js:633）报文为 `' together with its durable record'`；grep notes 命中 236 行旧措辞。
- 影响：纯文档。读者按规则 4 去日志里找 "together with its record" 会找不到。
- 建议：把 :236 的引文改成 "together with its durable record"，或直接指向同文件下方的"日志口径（V4-01）"段。

#### S-02【建议·重复】"陈旧 pending"的判定条件仍写了两份
- 位置：lib/store.js:240-242（mergeRecords 的 `durableIsNewer`）与 :564-568（mutateNow 的 `stalePending`），两处逻辑字面相同（都是 `durable.updatedAt > pending.updatedAt`），只是被 supersededKeys 的提取留了下来。
- 复现：E7 证明两路径当前的告警逐字符一致（行为无差），源码 grep 可见两处各写一遍。
- 影响：无功能影响；但"共用同一检测"目前只到键级（supersededKeys），时效性门限靠两份相同表达式维持一致，未来只改一处会静默产生不对称。
- 建议：抽一个 `isNewerRecord(durable, pending)` 小函数，两处都调用它。

#### S-03【建议·日志因果】退役路径的 warn 结尾句在"这次写就是显式覆盖/删除该键"时不成立
- 位置：lib/store.js:199-204（warnSuperseded 的固定结尾 "the pending copy wins because it holds writes that were already accepted"）配合 :592-594 的触发条件。
- 复现：`node extra-adversarial.mjs` X1-X4（写默认值 → 键被删、pending 没赢）、Y1-Y3（写成第三个值 → 用户值在、pending 没赢）、Z1-Z2 对照（改别的键时 pending 确实赢）。
- 影响：不改数据；只在"重放失败留下陈旧 pending，随后用户又显式改/删了同一个键"这个较罕见窗口里，日志会给出错误的因果解释（键清单与"更新的耐久值被丢弃"这一事实仍然对）。
- 建议（可选）：退役路径触发时按 transform 之后真正存活的值再判定一次是否真的发生了 pending 覆盖；或把退役时的结尾句改成中性表述（例如 "the pending snapshot was retired by this write"）。

### 观察（不计为问题）

1. drop 的 "(no durable record existed)" 分支依据的是 `table.delete` 的返回值；若记录在本进程队列槽之外被另一个进程先删（notes 13.5 的未解决场景），这句话仍然属实（此刻确实没有耐久记录），不构成误导。
2. V4-02 与 S-03 都只在特定故障/时序下出现；真实后端 delete 失败的频率我无法量化（§7）。
3. notes 13.4（降级期删除不可表达）与 13.5（多进程）仍是已声明未解决，F5 未触及。

---

## 7. 我无法验证的点

1. **真实 Cordis / DSH 运行时**：不允许写 profile，所以真实 storage-json 落盘、`invalidRecords: backup-and-skip` 的真实搬运、真实 `ctx.effect` 在 fiber 卸载/HMR 的行为、真实 `sessionPersistence.list()` 的返回与时延，都是用与官方表契约逐条对齐的假件建模的。真实 put/update/delete 失败频率与形态我也无法量化（S-03、V4-02 的触发概率因此未知）。
2. **真实 HTTP / webServer**：桥是用合成 request/response 直接驱动 handler，没有监听真实端口；fence 只覆盖回环 Host + 少数 Host/Origin 组合。
3. **真实 UI 交互**：禁止浏览器工具，页面观感与真实点击链路未实测；F2 头部与桥响应是间接证明。
4. **多进程并发写同一 storages 根（notes 13.5）**：未做双进程实验。
5. **sessionPersistence.list() 是否会漏掉刚创建的活跃会话**：我只能证明"list() 缺谁就回收谁"（AR/RC 组），无法证明真实 list() 会不会漏。
6. **S-02 的一致性**：我只能证明两处表达式当前字面相同、行为一致（E7），无法证明未来不会漂移。

---

## 8. 最终回答

**否：目前不存在【一般】及以上的问题。**

- F5 三条：**成立 3 / 部分成立 0 / 不成立 0**。
  - (1) drop 日志按事实分三支（只有 pending → "(no durable record existed)"；两者都有 → "together with its durable record"；只删耐久 → 不打这行），JSDoc 措辞已改准。
  - (2) supersededKeys 已提取；重放与退役共用同一键检测、同一 warn 模板，且都在写成功之后才 warn（写失败/值相同/pending 更新三种情况均不误报）。
  - (3) notes 13.6 已补写"空记录 update 后 delete 失败 → pending 保留 → 下个重放 tick 撤销 reset"的对称后果与日志口径，我按该描述逐条复现成功。
- 基线：node --check 6/6；node --test tests/ 98/98 全绿；裸 node --test 0 测试 exit 0；产品文件零改动。
- 前四轮抽验：A/B/C 重放三段、clone 四出口、F2 头部三档、pending 与写/删除一致性、桥四方法与原型名 404、对账不复活、降级 503/200 —— **全部复现成立**。
- 对抗性：要求的三类误报场景全部不误报；drop 三分支不串台；退役后 pendingReplay 与定时器一致。额外发现的 S-03 只是日志因果句措辞。
- **剩余【建议】清单：S-01（notes 13.6 规则 4 的旧引文）、S-02（陈旧判定重复两份）、S-03（退役 warn 的结尾因果句）**，三条都不影响数据正确性、也都不改变"降级期删除不可表达（13.4）/多进程（13.5）"这两个已文档化的缺口。
