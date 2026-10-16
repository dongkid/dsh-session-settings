# R1 独立代码审核（task-3）

> 审核对象：dsh-session-settings 的 T2/T3（宿主半：存储 + 桥）与 T4/T5（客户端半：右栏页面）。
> 只允许写的文件：本文件。下面第 0 节是开工前的底稿；正式发现从第 5 节开始，等 task-1/task-2 完成后逐条补齐。

## 0. 状态与纪律

- **task-3 当前被 task-1、task-2 阻塞**（`team_task_list` 实测：`blockedBy=["task-1","task-2"]`、`ready=false`），尚未 claim，未开写审核结论。
- 本节内容是开工前准备：冻结协议/设计稿的**不变量清单** + **真实契约基线**（全部来自本机官方包与参考实现的原文，附行号），以及若干**待核对的预备风险**（明确标注为待核对，不是最终结论）。
- 冻结输入：`docs/protocol-v1.md`（104 行）、`docs/design-v1.md`（187 行）。协议已冻结，审核只做「实现是否符合协议」，不改协议、不改产品代码。
- 审核纪律（自律，也是给复核者的口径）：
  1. 每条发现必须给：**文件 + 行号**、**现象**、**判断依据**（官方原件位置与行号，或可复现步骤）、**严重级别**（阻断/严重/一般/建议）、**一条可复现验证方式**。
  2. 不写无依据的推测；不确定的标 `待复核`，不写成确定结论。
  3. 不为了凑数夸大级别；同一根因只计一条。
  4. 结论必须来自**真读代码 + 真跑命令**（`node --check`、`node --test`、必要时最小复现），不能只读设计稿。

### 0.1 官方包的确切路径

- 官方安装：`C:/Users/dongkid/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<包名>/`
- 另一份解析源（profile 祖先目录）：`C:/Users/dongkid/.dsh/profiles/node_modules/@deepseek-ai/<包名>/`
- 第三方参考：`C:/Users/dongkid/.dsh/profiles/web/node_modules/dsh-context/`、`D:/projects/dsh-plugins/DSH-better-sidebar/src/`

## 1. 真实契约基线（审核的判断尺子）

| # | 结论 | 原件位置（含行号） |
|---|---|---|
| C1 | 官方信任闸门 `isTrustedApiRequest`：Host 缺失→拒；Host 不可解析→拒；非回环且不匹配 trustedHosts→拒；`sec-fetch-site: cross-site`→拒；**Origin 缺失→通过**；否则比较 `new URL(origin).host === hostUrl.host` | `dsh-client-connection/lib/index.js:205-219`（回环判定 :121-125，header 取值 :142-146，authority 解析 :147-154，trustedHosts 匹配 :181-198） |
| C2 | 官方闸门**没有** `dsh-app://app` 特例；协议 §1 的这一条是**有意扩展**（桌面壳页面 origin 与宿主 authority 构造上不可能相等） | 官方 :205-219 无该分支；扩展的成熟实现见 `DSH-better-sidebar/src/trust-fence.ts:37,120` |
| C3 | 参考实现对 Origin 用 **hostname** 比较（不是 host，理由：部分 Chromium 对非默认端口回环页序列化 Origin 时会丢端口），并在 Host 闸门之后才放行 `dsh-app://app` | `DSH-better-sidebar/src/trust-fence.ts:109-126` |
| C4 | `ctx.webRuntime.trustedHosts` 由 web-app 行提供：`ctx.provide('webRuntime', { lanAddresses, trustedHosts })` | `dsh-web-app/lib/index.js:173-175`、`dsh-web-app/lib/types/index.d.ts:36-42`、`dsh-web-app/cordis.patch.yml:216-223`（连接行 `inject: [webRuntime]`） |
| C5 | `webServer.register`：`kind:'exact'|'prefix'`，prefix 匹配 `p` 与 `p/<anything>`；path 为绝对路径且**不许尾斜杠**；重复 (kind,path) 抛错；前缀表最长匹配优先 | `dsh-host-webserver/lib/types/index.d.ts:30-39, 84-90, 117` |
| C6 | 存储域：`table.get/entries/keys/size/put/delete/update`；**`update(key, fn)` 在 key 不存在时以 `missing-key` 拒绝** | `dsh-storage-domain/lib/types/domain.d.ts:36-78`（update 注释 :71-77）、`lib/index.js:280`、`lib/types/error.d.ts:6` |
| C7 | 域声明字段：`name`/`version`/`layout:'per-record'`/`invalidRecords:'backup-and-skip'`/`tables`；名字必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` | `dsh-storage-domain/lib/types/spec.d.ts:31-68`、`dsh-storage/lib/index.js:80` |
| C8 | json 后端的 per-record 布局：单元是目录，**记录键成为路径段**，必须匹配 `SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/`，否则写入抛错、加载时静默跳过；落盘文件是「版本戳 + 记录值」的包装 | `dsh-storage-json/lib/index.js:302, 416, 506-520, 533-536` |
| C9 | web 组合里 storage-domain 默认后端 `json`，storage-json 的 root 是 `dshHomePath('storages')` → 设计稿 §3.2 的落盘路径 `<DSH_HOME>/storages/session_settings/sessions/<sessionId>.json` 与真实布局一致（同类先例 `storages/session_projcache/sessions/*.json` 实测存在） | `dsh-base/cordis.patch.yml:165-176`、`dsh-storage-json/lib/index.js:506-520`、实测目录 `C:/Users/dongkid/.dsh/storages/session_projcache/sessions/` |
| C10 | 真实 sessionId 形如 UUID（`159b040f-…`）或 `session-<uuid>`，均满足 SAFE_KEY_RE（实测会话目录与 projcache 文件名） | `C:/Users/dongkid/.dsh/sessions/**`、`C:/Users/dongkid/.dsh/storages/session_projcache/sessions/*.json` |
| C11 | `ctx.sessionPersistence.list()` 异步返回 `SessionPersistenceSnapshot[]`，每项含 `header`（`header.id` 即现存会话 id）——对账的唯一合法来源 | `dsh-session-persistence/lib/types/index.d.ts:17-31, 151-157` |
| C12 | 右栏 tab 类型注册：定义必须给 `id`、`kind`、**`title: (address: string) => string`（函数，不是字符串）**；`guide` 每项必须有 `id`、**`order: number`（必填）**、`title: () => string`；`register` 返回 disposer，id 重复或同 band 的 kind 冲突会抛错 | `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:46-67, 75-120, 141-164` |
| C13 | `sidebar.right.pane.tab` / `.title` 是 `scope:'session'` 的 keyed seat，**键 = 类型定义的 `id`**；服务名是 `sidebarRightTabs`（注册）与 `sidebarRight`（导航） | `dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts:46-72`、`lib/types/client/index.d.ts:20-27` |
| C14 | 严格 session 作用域的 slot 组件会拿到框架解析好的 **`sessionId` 标准 prop**（实证：官方 FilesBody 的形参就有 `sessionId`，并用 `useSessions`） | `dsh-client-ui-slots/lib/types/index.d.ts:477-485`、`dsh-client-ui-sidebar-files/lib/client.js:595-605` |
| C15 | 反代子路径安全的前缀构造：**剥掉前导斜杠**，再对「目录型 base」解析；HTTP 用页面 base（`document.baseURI`）而非注入的 stream base | `DSH-better-sidebar/src/client/host-route-url.ts:37-69` |
| C16 | 浏览器半的加载形态：`window.__ModuleLoader__.load({ id: '<包名>', factory })`，`factory(require)` 里 `require('react')`；导出 `{ name, inject, apply }` | 设计稿 §8；现网先例 `dsh-context/lib/client.js`（打包产物，无裸 import） |
| C17 | 静态插件的 `package.json` 需要 `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client` 声明平台与注入的客户端包名 | `dsh-context/package.json:54-75`、`dsh-context/cordis.patch.yml:4-6` |

## 2. 不变量清单（逐条核对表）

> 编号规则：`A`=桥与传输、`B`=方法表、`C`=宿主服务 API、`D`=存储、`E`=客户端半与页面、`F`=生命周期与卸载、`G`=协议与官方契约的偏差。每条都要在正式审核里给出「符合 / 不符合 / 待复核」+ 证据。

### A. 桥与传输（协议 §1）
- [ ] A1 prefix 路由：`kind:'prefix'`、`path === '/session-settings/api'`、无尾斜杠（依据 P1 + C5）。
- [ ] A2 只接受 POST；其它方法 405 + `method-not-allowed`（P1、P6）。
- [ ] A3 方法名 = pathname 去前缀后的剩余部分；**必须 `Object.hasOwn` 严格查表**，`constructor`/`toString`/`__proto__` 不得命中（P1）。
- [ ] A4 响应体统一：成功 `200 {ok:true,value}`；失败 `4xx/5xx {ok:false,error:{code,message}}`（P1）。
- [ ] A5 状态码映射逐条：403/404/405/400/409/503/500（P1、P6）。
- [ ] A6 fence 是每个 handler 的**第一行**；Host 回环或命中 trustedHosts；`sec-fetch-site: cross-site` 拒；Origin 缺失放行；Origin 同 hostname 或 `dsh-app://app`（P1 + C1/C2/C3）。
- [ ] A7 trustedHosts **按请求现读** `ctx.webRuntime.trustedHosts`（不得在 apply 时快照；webRuntime 可能晚于本插件挂载，C4）。
- [ ] A8 宿主能力缺失（storageDomain / sessionPersistence / webServer 任一）→ 503 `storage-unavailable`，页面进只读态、不假装能写（P1、D§5、D§7）。
- [ ] A9 请求体解析：非法 JSON / 非对象 / 缺字段 → 400 `bad-request`（P1、P6）。
- [ ] A10 客户端调用自家前缀**不硬写前导斜杠**，走前缀安全构造器（P1 + C15）。

### B. 方法表（协议 §2）
- [ ] B1 `registrations.list`：请求 `{}` → `{registrations: SerializedRegistration[]}`；字段集与 `SerializedItem` 的 `type` 枚举、可选字段（min/max/step/unit/placeholder/options）齐全；`title/description` 若为函数在**宿主侧求值一次**后传字符串（P2.1）。
- [ ] B2 序列化带 `locale` 字典；客户端渲染走 `dict[文本] ?? 文本`（P2.1 + D§6）。
- [ ] B3 `values.get {sessionId}` → `{sessionId, overrides, resolved}`；`overrides` **只含被改过且不同于默认值**的项；`resolved` 是完整解析值（P2.2）。
- [ ] B4 `values.set {sessionId,pluginId,itemKey,value}` → 与 get 同形；写入值 == 默认值 → **删除覆盖**（稀疏）；未知 pluginId → 400 `unknown-plugin`；未知 itemKey → 400 `unknown-item`（P2.3）。
- [ ] B5 `values.reset {sessionId,pluginId?,itemKey?}` → 同形；三档语义（省略 pluginId=清整会话；给 pluginId 不给 itemKey=整插件；都给=单项）（P2.4）。
- [ ] B6 **v1 只有四个方法**：任何第五个方法（尤其设计稿 §5 提到的 `renderers.put`）都不在冻结协议内；若客户端调用它 → 404 `unknown-method`（P§2 对照 D§5，见第 3.3 节）。

### C. 宿主进程内服务 API（协议 §3、设计稿 §4）
- [ ] C1 八个方法齐全且**参数顺序**与协议一致：`register(registration)`、`listRegistrations()`、`get(pluginId, sessionId)`、`getItem(pluginId, itemKey, sessionId)`、`set(pluginId, itemKey, sessionId, value)`、`reset(pluginId, sessionId, itemKey?)`、`resetSession(sessionId)`、`subscribe(listener)`（P§3；易错点：`set` 是 pluginId→itemKey→sessionId，而 `get` 是 pluginId→sessionId）。
- [ ] C2 change 形状 `{kind:'registered'|'unregistered'|'values', pluginId?, sessionId?, itemKey?}`，三档语义与触发时机（P§3）。
- [ ] C3 同一 pluginId 重复注册**抛错并点名占位者**；返回的 disposer 只撤销自己那次注册（不得误删后来者）（D§4.1）。
- [ ] C4 卸载后已保存值保留，重装可继续用（D§7）。
- [ ] C5 `get/getItem` 同步、未注册 pluginId 返回 `undefined`；默认值真源是注册声明，不落盘（P§3、D§3.1）。
- [ ] C6 订阅者抛错不打断其他订阅者/不影响写入结果（实现健壮性，与 T1 骨架已有 try/catch 一致）。

### D. 存储（协议 §5、设计稿 §3）
- [ ] D1 域声明：`name:'session_settings'`、`version:1`、`layout:'per-record'`、`invalidRecords:'backup-and-skip'`、表 `sessions`、key=sessionId（P§5 + C7）。
- [ ] D2 记录形状 `{sessionId, profile?, updatedAt, values}`；`values` 只存覆盖；`updatedAt` 每次写更新（P§5、D§3.2）。
- [ ] D3 写路径原子读改写用 `table.update`；**但 `update` 对不存在的 key 抛 `missing-key`**，首写必须先 `put` 或捕获该错误后补 `put`（P§5 + C6；见第 3.1 节）。
- [ ] D4 稀疏三档：值==默认值→删项；插件 map 空→删插件键；`values` 空→`table.delete(sessionId)`（P§5）。
- [ ] D5 「等于默认值」的判定：`stringList`/对象/数组必须**深比较**；用 `===` 会把「设回默认数组」误存成覆盖（P2.3 的语义要求，属实现正确性）。
- [ ] D6 对账只用 `ctx.sessionPersistence.list()` 差集清理；**禁止**用 `session/disposed` 触发删除；归档会话保留（P§5、D§7 + C11）。
- [ ] D7 对账时机：启动时 + 低频（页面打开且距上次 > N 分钟）（D§7）。
- [ ] D8 拿不到 storageDomain → 内存降级 + 日志与页面明示「重启即丢」，不得静默成功（D§7）。
- [ ] D9 非法 sessionId（不满足 SAFE_KEY_RE）应给出可诊断错误，而不是把后端的裸错误直接透出为 500（P§6 的 `internal` 定位 + C8，属健壮性，级别视实现而定）。
- [ ] D10 `invalidRecords: 'backup-and-skip'` 生效需要后端支持 `backupRecord`；json per-record 支持（C7、C8）。

### E. 客户端半与页面（协议 §4、设计稿 §4.1/§6）
- [ ] E1 客户端服务三方法：`registerRenderer(pluginId, itemKey, Component)`、`getResolved(pluginId, sessionId)`、`subscribe(listener)`（P§4）。
- [ ] E2 客户端半**不注册声明式项**（声明式只能在宿主半）（D§4.1）。
- [ ] E3 页面结构：头部（会话标识 + 已改 N 项 + 全部恢复）/ 分组卡片 / 选项行（覆盖标记 + 单项恢复，整组恢复）/ 空态 / 错误态只读（D§6）。
- [ ] E4 样式只用 `--dsw-alias-*` token；不 import 任何 Harness 客户端包；react 从模块表 `require('react')` 取（D§6 + C16）。
- [ ] E5 文案走 zh/en 字典跟随宿主语言；消费方注册文本用 `dict[文本] ?? 文本`（P2.1、D§6）。
- [ ] E6 纯 UI 状态（展开、搜索词）留在浏览器本地，不进存储（D§6）。
- [ ] E7 写入串行化：一条 promise 队列；失败不毒化队列；**不做乐观翻转**（写入后回读）（D§7、D§5）。
- [ ] E8 tab 注册签名与官方契约一致：`title` 是 `(address)=>string` 函数、`guide[].order` 必填、body/title 注册键 = `'session-settings'`（C12、C13）。
- [ ] E9 页面拿到 `sessionId` 的方式正确（session 作用域标准 prop）（C14）。
- [ ] E10 刷新策略：写入后回读 + 页面重新聚焦刷新（D§5 第一版方案）。
- [ ] E11 零构建风险：客户端 bundle 无裸 import；宿主半裸 import（`zod`、`@deepseek-ai/*`）必须有项目内 `node_modules` 兜底（见 3.2 节）。
- [ ] E12 自定义渲染组件（`registerRenderer`）按 `(pluginId,itemKey)` 命中并渲染；未注册项走声明式控件（P§4、D§4.1）。

### F. 生命周期与卸载
- [ ] F1 所有注册（路由、域、订阅、slot、tab 类型）都包在 `ctx.effect(...)` 或等价 disposer 里，卸载/HMR 可回收（D§5）。
- [ ] F2 存储域 handle 由调用方 `close()`（facility 不接管消费者 fiber）（C6 所在包 `index.d.ts:75-83`）。
- [ ] F3 重复 apply / 热重载后不残留旧注册（id 冲突会抛错，必须幂等释放）。

### G. 协议与官方契约的偏差（只记录，不改协议）
- [ ] G1 Origin 比较口径：官方用 `.host`（C1），协议 §1 写「同 hostname」，参考实现也用 hostname 并有明确理由（C3）→ 实现取 hostname 属**符合协议**；若实现取 `.host` 反而与协议不符。两种都不算致命，但要记录哪种落地。
- [ ] G2 协议 §2 只列四个方法，设计稿 §5 多列 `renderers.put`（P§2 对照 D§5）→ 以协议为准，见 3.3。
- [ ] G3 设计稿 §2 把 tab 的 `title` 写成裸「title」，官方契约要求函数签名（C12）→ 实现必须给函数。
- [ ] G4 设计稿 §3.2 声称落盘文件名是 `<sessionId>.json`：与真实 per-record 布局一致（C9），但文件内容是**版本戳包装**而非裸记录，文档表述可更准确（一般/文档级）。

## 3. 预备发现（待核对，不是最终结论）

> 以下 4 条是开工前已能确认的事实性风险，正式审核时要对着最终代码逐条落成结论（或在代码里证明已规避）。

### 3.1 `table.update` 的 `missing-key` 陷阱（风险等级：潜在阻断）
- 现象/依据：`dsh-storage-domain` 的 `update(key, fn)` 在 key 不存在时抛 `DomainError('missing-key')`（`lib/types/domain.d.ts:71-77`、`lib/index.js:280`、`lib/types/error.d.ts:6`）。协议 §5 又明确写「写路径 `table.update(sessionId, fn)` 原子读改写」。
- 后果：若实现直接 `table.update()` 处理一个还没写过配置的新会话，第一次 `values.set` 会以 `missing-key` 失败 → 映射成 500 `internal`，验收判据 1（会话 A 改值后读到新值）直接不成立。
- 合格实现：先 `get` 判断，缺失则 `put(初始记录)` 后再 `update`；或捕获 `missing-key` 补 `put` 后重试。两种情况都要有并发考虑（同会话并发首写）。
- 复现：`node -e` 起一个域不方便，最小复现改为对该包的单测/桩测：调用 `table.update('nope', v=>v)` 观察 `DomainError.code === 'missing-key'`。

### 3.2 宿主半裸 import 的解析前提（已缓解，须保持）
- 事实（实测）：
  - 项目在 `00:26` 时**没有** `node_modules`：`node --input-type=module -e "await import('zod')"` 在项目目录下报 `ERR_MODULE_NOT_FOUND`；`@deepseek-ai/dsh-storage-domain` 同样失败。
  - 我用 junction 做了最小复现（`D:/projects/tmp/rsym`）：Node 24 的 ESM 会把软链模块解析到**真实路径**，因此软链安装的插件不会继承 profile 的 `node_modules`（错误信息里的 `imported from` 是真实路径）。命令：`node <symlink-dir>/probe.mjs`，报错指名 `D:\projects\tmp\rsym\rl\probe.mjs`。
  - `00:27` writer-storage 在项目内执行了 `pnpm install`：现在项目自己有 `node_modules`（`zod`、`@deepseek-ai/cordis`、`dsh-storage-domain`、`dsh-session-persistence`、`dsh-host-webserver`、`dsh-client-ui-sidebar-right` 的软链），`node tests/_probe2.mjs` 与 `node tests/_probe-zod.mjs` 都成功（实测输出 `zod ok function` / `defineDomain ok: session_settings 1 [ 'sessions' ]`）。
- 需要核对：最终 `package.json` 把用到的包都声明为 dependency/peer（含 `pnpm-lock.yaml` 定格），且宿主半不 import 未安装的东西。若交付时把 `node_modules` 删掉，插件在 DSH 里会加载失败。
- 说明（待复核）：DSH 对「linked root」有运行时解析拦截（`dsh-app-boot/lib/index.js:1351-1500` 的 `ResolutionRouter`、`routeLinked`），理论上可把裸包名路由到 profile 解析；但能否覆盖某个具体包取决于 profile 的 resolution entries，我**无法静态证明**，因此以「项目内有 node_modules」为稳妥前提，不把 DSH 拦截当依赖。

### 3.3 协议与设计稿的方法集不一致（待核对）
- 协议 §2 明确「v1 只有四个」方法；设计稿 §5 的桥方法表多出 `renderers.put {pluginId,itemKey}`。
- 协议 §4 的 `registerRenderer` 本来就是**浏览器进程内**服务，不需要上行桥；因此合格实现不应存在 `renderers.put`，客户端也不应调用它（调了就是 404 `unknown-method`）。
- 核对方式：`grep -n "renderers" lib/index.js lib/client.js`；若出现，判「不符合协议」，级别按是否被调用（被调用=严重；仅死代码=一般）。

### 3.4 测试目录里的探针文件（一般，交付整洁度）
- 现状：`tests/_probe-zod.mjs`、`tests/_probe.spec.mjs`、`tests/_probe2.mjs` 是 writer 的临时探针，且 `_probe.spec.mjs` 名字带 `.spec.mjs`。
- 风险：正式验收若跑 `node --test tests/`，探针可能被当成测试文件执行（`_probe-zod.mjs`/`_probe2.mjs` 顶部有副作用打印，`_probe2.mjs` 依赖裸 import），造成噪声或假失败。需在正式审核时实测 `node --test tests/` 的行为并报告；探针是否保留由 Lead 决定（我只报告，不删别人的文件）。
- 本次准备未运行 `node --test`（避免与正在写入的 writer 抢资源），留到正式审核阶段跑。


### 3.5 复核工具就绪：无 DSH 启动的桥端到端夹具（已可用）

为了让正式审核能真正「跑命令」而不是只读代码，我在自己的工作目录搭了一套夹具（**不在项目里，不碰产品代码**）：

- `D:/projects/tmp/r1-harness/stub-domain.mjs`：忠实复刻官方 `storageDomain` 的语义（含 **`update` 对不存在 key 抛 `missing-key`**、`put/delete/update` 异步、读同步），并记录写操作日志。
- `D:/projects/tmp/r1-harness/run-bridge.mjs`：真 `node:http` 服务器 + 真 HTTP 请求，覆盖 61 条协议检查（方法/状态码/错误码/fence 各分支/稀疏/三档 reset/降级 503/宿主服务 API/重复注册）。
- 用法：`node D:/projects/tmp/r1-harness/run-bridge.mjs`（从项目**真实路径** import 宿主半，从而使用项目自己的 node_modules）。
- 注意：这是审核工具，**不能替代** Lead 在真实 DSH 里的验收（真 webServer/fence/右栏 UI 仍以端到端为准）。

用它在**非最终代码**（lib/ 最后写入时间 00:36）上跑出的结果与结论（仅作准备，冻结后要重跑）：

| 结果 | 项 | 判断 |
|---|---|---|
| 58/61 通过 | 方法表、错误码、fence 各分支、稀疏三档、session 隔离、降级 503、宿主 API | 与我核对的不变量一致 |
| 曾 FAIL 25/30（trustedHosts 不生效） | 我夹具的 `ctx.get()` 没返回 webRuntime → **夹具缺陷**，修好后 PASS | 非产品问题（产品用 `ctx.get('webRuntime')`，见 index.js:267-272） |
| 曾 FAIL 29（无 Host 返回 400） | HTTP/1.1 缺 Host 被 **Node 的 HTTP 解析器**直接 400，请求没进 handler；改用 HTTP/1.0 复测 → **403**，畸形 Host（`Host: not a host`）→ **403** | 非产品问题，fence 正确 |
| 曾 FAIL 37（set 不带 value） | 实现在 bridge.js:148-150 明确要求 own property `value` 否则 400 → 协议 §2.3 请求体含 `value` 字段，400 可辩护 | 非缺陷（我的预期写错了） |
| **仍 FAIL 60/61** | 见 3.6 | **候选发现** |

### 3.6 候选发现（基于 00:36 非最终代码）：`sessionPersistence` 不可用时未按协议返回 503

- **文件 + 行**：`lib/bridge.js:120-128`（`requireDurable()` 只看 `storageStatus()`，即只认 storageDomain 的耐久性）、`lib/index.js:297-301`（`sessionPersistence` 缺失时对账直接 `{skipped}` 返回，请求路径不感知）。
- **现象**：把 `ctx.sessionPersistence` 置为 undefined 后，`values.get` / `values.set` / `values.reset` 仍返回 **200** 并正常读写（夹具 60/61 实测：actual=200，期望 503）。
- **依据**：`docs/protocol-v1.md:15`「状态码映射：…宿主能力缺失（storageDomain / sessionPersistence / webServer 任一不可用）503」；`docs/protocol-v1.md:103` 错误码 `storage-unavailable 503`。协议是冻结的，且明确写了三者任一。
- **级别**：**一般**（协议字面不一致）。不判「严重」的理由：数据面没有损坏——缺 `sessionPersistence` 时只是对账被跳过，读写仍自洽；而且在真实 web profile 里 `sessionPersistence` 必然挂载，当前不可达。需要 Lead 按设计意图（D§5「页面显示只读，而不是假装能写」）裁定是「必须严格 503」还是「只有 storageDomain 缺失才 503」。
- **复现**：`node D:/projects/tmp/r1-harness/run-bridge.mjs` → 看 60/61 两条（夹具用 `ctx.get('sessionPersistence')` 返回 undefined 模拟能力缺失）。
- **关联观察（同源，建议一起裁定）**：storageDomain 缺失时 `registrations.list` 仍返回 200（bridge.js:136-138 未走 `requireDurable`，夹具 59 实测 200）。这按协议字面也不一致，但按设计意图是**合理**的（页面要能渲染出只读态）。两条属同一根因：协议 §1 的「任一不可用 → 503」是按方法实际所需能力落地，还是按能力集合一刀切。

### 3.7 独立复核 Lead 转办的第 1 条（missing-key 首写）
- 夹具在**新会话**上执行 `values.set` 成功（check 18/38 PASS），写日志实测为 `put` → `update`（`["put","update","delete","put","update","delete",…]`，`records left: 0`），说明 writer-storage 已用「先 put 再 update」的方式规避 `missing-key`。
- 这一步只是**预备核对**（代码非最终态）；冻结后我会重跑并把它落成正式结论。


### 3.8 Lead 裁定后的核对（按 v1.1 口径，代码版本 00:36）

> **本节已被 §5.2 取代**：其中「sessionPersistence 缺失无日志」当时成立，task-6 修复后经 V8 复核通过（不计入缺陷）；「503 口径」经 v1.1 澄清为实现符合协议。保留原文以留审计痕迹。

裁定要点（Lead 消息 2026-10-13）：状态码按【方法实际所需能力】判定；`registrations.list` 永远 200；`values.*` 需要耐久存储否则 503；`sessionPersistence` 缺失**不影响状态码**，只让对账跳过，但**必须记日志**；`webServer` 不可用则不注册路由。

据此的三项独立核对结果：

1）**状态码口径：实现符合 v1.1，非缺陷（保留审计痕迹）**
- 依据：`lib/bridge.js:120-128` 的 `requireDurable()` 只 gate `values.*`；`lib/bridge.js:136-138` 的 `registrations.list` 不 gate。
- 实测：storageDomain 缺失时 `registrations.list` → 200，`values.get/set` → 503 `storage-unavailable`（夹具 check 57-59）。协议 v1 第 15 行的「任一不可用 → 503」为字面不清，v1.1 已澄清，实现符合 v1.1。

2）**`sessionPersistence` 缺失时对账跳过：没有任何日志/可观测信号 → 正式发现（一般）**
- 文件 + 行：`lib/index.js:296-301`（`reconcileNow()` 在 `persistence` 缺失时 `return Promise.resolve({ skipped: 'sessionPersistence is not available' })`，**不写日志**）；`lib/index.js:333-335` 用 `ctx.inject(['storageDomain','sessionPersistence'], …)`，缺任一项时回调根本不执行，因此挂载期也不留痕迹。
- 复现命令：`node D:/projects/tmp/r1-harness/probe-reconcile2.mjs`
  实测输出（sessionPersistence 缺失）：
  ```
  (a) with sessionPersistence missing, plugin logs:
       ["PLUGIN-INJECT-SKIPPED","sessionPersistence"]   <- 夹具自己的标记，不是插件日志
       ["info","[dsh-session-settings] host half mounted"]
       ["info","[dsh-session-settings] per-session overrides stored in domain session_settings/sessions"]
  ```
  三条日志里**没有**任何关于「对账因 sessionPersistence 缺失而跳过」的记录。
- 依据：Lead 裁定第 1 条「sessionPersistence 缺失…只让后台对账跳过，但**必须记日志**」。
- 级别：**一般**。数据面无损（对账本就不会删数据），影响是可诊断性：运维看到一个会话的配置不会被回收时，没有任何线索说明原因。
- 建议修法（不写进产品代码，仅建议）：在 `reconcileNow()` 的缺失分支加一条 `logger?.warn?`（一次性即可，避免每 30 分钟刷屏），或在 `ctx.inject` 的缺失路径记一条 info/warn。
- 待复核标注：`lib/index.js:301` 的另一个早退分支「storage is running from memory」也不写日志，但 `store.js:163/177` 在降级时已经 error 记录过一次（实测 (c) 有该日志），因此**不另计一条**，只在报告里提一句来源已覆盖。

3）**对账正向路径：工作正常且可观测（不是发现，是可复现的正面证据）**
- 复现命令同上，实测：预置记录 `sess-a`（persistence.list 里有）与 `gone-1`（没有），挂载后 `table.size === 1`、`keys === ["sess-a"]`，日志 `[info] reconciliation removed 1 record(s) of deleted session(s)`（来源 `lib/index.js:315`）。
- 结论：验收判据 5 的「人工删掉一个会话后对账把该记录清掉」在无 DSH 的夹具层面成立；归档会话保留依赖的是 `sessionPersistence.list()` 仍包含归档会话（`lib/index.js:296-312` 只用 list()，未监听 `session/disposed`，`grep -n "session/disposed" lib/*.js` 无命中）。


### 3.9 并发首写丢更新：独立复现成功（00:41 代码，task-6 修复前基线）

> **本节已被 §5.2 取代**：该缺陷已在 task-6 修复，我用同一脚本（V6）+ 新增交错用例（V7）复核通过，不计入缺陷数。保留原文以留审计痕迹。

- **文件 + 行**：`lib/store.js:230-247`（`mutate()` 的耐久分支：先同步 `table.get(sessionId)` 判断有无记录，再 `await table.put(sessionId, next)`；两次调用之间没有任何 per-session 串行化）。
- **现象**：对一个**全新会话**并发发起 8 个 `values.set`（8 个不同 itemKey），结果只有最后 1 个键存活，7 个覆盖永久丢失：
  ```
  concurrent set() calls: 8 | rejected: 0
  overrides that survived: 1 {"k7":107}
  LOST overrides: 7 ["k0","k1","k2","k3","k4","k5","k6"]
  write log: ["put","put","put","put","put","put","put","put"]
  ```
- **复现命令**：`node D:/projects/tmp/r1-harness/probe-concurrent.mjs`
- **为什么这是真实窗口而不是夹具假象**：官方契约规定「每次写入先等后端耐久，再改内存」（`dsh-storage-domain/lib/types/domain.d.ts:1-8`），因此在 `await table.put()` 挂起期间，第二次调用的同步 `table.get()` 仍然读到「记录不存在」，于是各自基于「空记录」构造整份文档再 `put`，后写覆盖先写。我的夹具按这条契约建模（写入排队 + 耐久屏障后才改内存），复现结果与 writer-storage 自报的窗口一致。
- **级别**：**严重**（数据丢失；不是显示问题）。触发条件宽松：同一会话的两次并发写（两个消费插件同时写、或宿主侧 API 被并发调用）即可命中；浏览器半的串行队列（D§7）只保护页面自身的写入，保护不了宿主侧 API 的并发调用。
- **状态**：Lead 已判定修复（task-6：store 层 per-session 写串行队列 + 并发单测）。冻结后必须用**同一条复现命令**复核，期望 8/8 存活、写日志出现串行特征；未修好则作为正式发现计入第 5 节。

## 4. 复现命令清单（正式审核会用到）

```powershell
# 语法检查
node --check lib/index.js ; node --check lib/client.js
# 测试
cd D:/projects/dsh-plugins/dsh-session-settings ; node --test tests/
# 裸 import 解析前提（项目内 node_modules 是否兜底）
cd D:/projects/dsh-plugins/dsh-session-settings ; node --input-type=module -e "for (const s of ['zod','@deepseek-ai/dsh-storage-domain']) { try { console.log(s, '->', import.meta.resolve(s)) } catch (e) { console.log(s, 'FAIL', e.code) } }"
# 协议关键点的静态检索
grep -n "Object.hasOwn" lib/index.js
grep -n "renderers" lib/index.js lib/client.js
grep -n "session/disposed" lib/index.js
grep -n "dsh-app://app" lib/index.js
grep -n "table.update|missing-key|table.put" lib/index.js
# 软链解析最小复现（Node ESM realpath）
# 见 D:/projects/tmp/rsym（junction：rt/node_modules/linked-probe -> rl；node rt/nested-importer.mjs 报 imported from <真实路径>）
```

## 5. 正式审核发现（冻结代码：2026-10-13 00:43 之后不再变动的版本）

冻结点：task-1/2/5/6 全部 completed；被审文件与写入时间——`lib/bridge.js` 00:31、`lib/client.js` 00:37、`lib/index.js` 00:42、`lib/resolve.js` 00:30、`lib/store.js` 00:42、`lib/trust-fence.js` 00:31、`tests/*` 00:43。审核只读产品代码，未做任何修改。

### 5.0 验证矩阵（本节所有结论都来自这些命令的真跑）

| # | 命令 | 结果 |
|---|---|---|
| V1 | `node --check lib/{bridge,client,index,resolve,store,trust-fence}.js` | 6/6 exit 0 |
| V2 | `node --test tests/` | **72 tests / 0 fail / exit 0** |
| V3 | `node --test`（裸，包根） | **tests 0 / pass 0 / fail 0 / exit 0** → 发现 R1-03 |
| V4 | `node --test "tests/*.spec.mjs"` | 72/0/0 exit 0 |
| V5 | `node D:/projects/tmp/r1-harness/run-bridge.mjs`（真 HTTP，61 条协议检查） | **61/61 通过** |
| V6 | `node D:/projects/tmp/r1-harness/probe-concurrent.mjs`（8 并发首写） | 8/8 存活，写日志 `[put, update×7]` |
| V7 | `node D:/projects/tmp/r1-harness/probe-interleave.mjs`（并发 set+reset） | 串行化正确：只 k4..k7 存活、无撕裂、队列仍可用 |
| V8 | `node D:/projects/tmp/r1-harness/probe-reconcile3.mjs`（对账可观测性） | (a)(b) 各 1 条节流 warn；(c) 0 warn + assembled info；(d) 50 次请求仍 1 条 |
| V9 | `node D:/projects/tmp/r1-harness/probe-replay-race.mjs` | A：默认值别名确认；B：降级期写入丢失确认 → R1-01/R1-02 |
| V10 | 静态检索（`renderers.put`/`session/disposed`/`409`/`Object.hasOwn`） | 见 5.4 节，无未预期命中 |

### 5.1 发现列表

#### R1-01（严重，成立）降级期间被接受的写入，在「存储恢复」窗口内可能被并发持久写覆盖丢失
- **文件 + 行**：`lib/store.js:143-150`（`replayMemory()`）、`lib/store.js:169-172`（先 `table = opened.table(...)` 再 `await replayMemory()`）、`lib/store.js:219-228`（`enqueueWrite` 只被 `mutate`/`drop` 使用），参照 `lib/index.js:281-287`（注释明确承认 storageDomain 可能晚于本插件挂载）。
- **现象**：storageDomain 尚未就绪时写入 kA=100（store 接受进内存并承诺「域打开后补写」）；在 attach 把 `table` 置好后、`replayMemory` 的 `put` 还没落盘的窗口里，再来一次持久写 kB=200；最终持久记录只剩 kB，**kA 永久丢失**。
- **实测输出**（V9 的 B 段）：
  ```
  B degraded write kA=100 accepted; storage status: {"durable":false,"backend":"memory",...}
  B after attach+replay: kA = 0 (expected 100) | kB = 200 (expected 200)
  B durable record: {"sessionId":"race-s1","updatedAt":...,"values":{"race.consumer":{"kB":200}}}
  ```
- **判断依据**：store 自己的承诺与测试「values written while degraded are replayed once the domain opens」（`tests/store.spec.mjs`，V2 通过）在**顺序**场景成立，但 `replayMemory` 没有走 `enqueueWrite`，与 `mutate` 不在同一条 per-session 队列上；官方域写入又是「先耐久、后改内存」（`dsh-storage-domain/lib/types/domain.d.ts:1-8`），所以并发写读不到尚未落盘的重放记录，于是各自构造整份文档互相覆盖。
- **触发条件（如实说明）**：需要 ① storageDomain 晚于本插件挂载（`index.js:281-287` 明确支持该顺序）；② 一条**宿主侧**写入落在 attach→重放的窗口内。浏览器路径被 `bridge.js:120-128` 的 503 挡住，所以不是页面触发；但宿主侧消费插件（`ctx.sessionSettings.set`）会命中。
- **级别理由**：与 Lead 已判「严重」的并发首写丢更新是同一类——**被接受的用户写入静默消失**。窗口比 X1（并发首写）更窄，但影响相同；若 Lead 认为可达性过低，可下调为「一般」，我不反对，只是按影响类别定级。
- **复现**：`node D:/projects/tmp/r1-harness/probe-replay-race.mjs`（B 段）。预期：`kA = 100 且 kB = 200`；实际：`kA = 0`。
- **建议修法**（不代改代码）：把 `replayMemory` 的每条记录放进 `enqueueWrite(sessionId, ...)` 执行（或先取队列槽再 `table.get` 判定），使重放与 `mutate` 串行。

#### R1-02（建议，成立）`ctx.sessionSettings.get()` 返回的默认值层是注册对象本体，没有防御性拷贝
- **文件 + 行**：`lib/resolve.js:247-257`（`resolved[item.key] = item.default` 直接引用），对照 `lib/store.js:195-202`（存储层覆盖值是 `clone()` 深拷贝）。
- **现象**：消费方拿到 `get()` 的结果后就地修改默认值对象，会**永久改掉**该注册项的默认值（影响之后所有会话的解析结果）；而覆盖值那层是安全的。
- **实测输出**（V9 的 A 段）：`first.obj === registration default: true`；改完后再次读取得到 `{"nested":999}`。
- **判断依据**：官方域文档明确记录对象「must not be mutated in place」（`dsh-storage-domain/lib/types/domain.d.ts:31-35`），store 为覆盖值做了拷贝却在默认值这一层漏掉；两处防护不一致。
- **复现**：`node D:/projects/tmp/r1-harness/probe-replay-race.mjs`（A 段）。预期：改动返回值后，后续读取仍为 `{"nested":1}`。
- **建议修法**：`resolveValues` 对非覆盖项返回 `clone(item.default)`（或首次注册时冻结默认值）。

#### R1-03（一般，成立）裸 `node --test` 静默跑 0 个测试却 exit 0，且 `tests/index.js` 的注释声称该写法可用
- **文件 + 行**：`tests/index.js:6-14`（第 8 行注释「`node --test` (from the package root)」，正文声称三种写法都可行），`package.json` 无 `scripts.test`。
- **现象**：在包根执行 `node --test`（不带路径）→ `tests 0 / pass 0 / fail 0`、退出码 0：**假绿**。原因：Node 默认测试发现规则匹配 `**/test/**`（单数目录）与 `*.test.*` 等，`tests/index.js`、`*.spec.mjs` 都不在规则内，而目录名是 `tests`（复数）。
- **判断依据**：实测 V3 与 V2 的对比；`docs/notes/t2-t3-choices.md:120-126` 只声称 `node --test tests/`、`node --test "tests/*.spec.mjs"`、`node --test "tests/**/*.spec.mjs"` 三种全绿（V2/V4 已复现其成立），并没有声称裸 `node --test`；错的是 `tests/index.js` 的注释。
- **影响**：任何用裸 `node --test` 做验收/CI 的调用会静默通过（比失败更危险）。产品代码本身不受影响。
- **复现**：`cd D:/projects/dsh-plugins/dsh-session-settings; node --test`（期望看到 0 测试、exit 0）；对照 `node --test tests/` 的 72/0/0。
- **建议修法**：删掉注释里不成立的那一行，或在 `package.json` 加 `"scripts": {"test": "node --test tests/"}`，或把目录改名 `test/`。

#### R1-04（建议，成立）协议 §6 的 `conflict`/409 没有任何触发路径
- **文件 + 行**：`lib/resolve.js:16-26`（`conflict: 409` 只在映射表里）、`lib/client.js:113`（文案）、`lib/client.js:369`（收到 conflict 就强制回读的分支）。
- **现象**：全仓库没有任何 `throw new SessionSettingsError('conflict', …)`；四个请求体里也没有任何版本/栅栏字段，因此 409 在本实现里不可达。
- **判断依据**：`docs/protocol-v1.md:16,112` 把「写冲突 409」列为状态码与错误码；实现无对应机制（进程内写靠串行队列，跨进程靠 domain，无 CAS）。
- **影响**：无功能影响；但协议与实现不一致，客户端留了一段死代码/死文案，会让后来者以为存在版本栅栏。
- **复现**：`grep -n "conflict" lib/*.js` → 只有映射与客户端文案，无抛出点。
- **建议**：协议 §6 标注 409「保留、当前无触发路径」，或实现里明确注释；二者取一即可，属文档级修整。

#### R1-05（建议，成立）页面头部用截断的 sessionId 代替设计稿要求的「会话标题或 cwd」
- **文件 + 行**：`lib/client.js:947-948` + `lib/client.js:1031-1034`（`shortSession`：`159b040f…d09e`），对照 `docs/design-v1.md:133`「头部：当前会话标识（标题或 cwd）」。
- **现象**：用户看到的是截断 id，而不是可辨识的会话标题或工作目录；多会话时辨识度低。
- **判断依据**：session 作用域 slot 明确提供 `sessionId`，且官方同级实现用 `useSessions` 读到 cwd（`dsh-client-ui-sidebar-files/lib/client.js:595-605`），所以「标题/cwd」是可得的。
- **复现**：静态比对上述两处；DOM 层实测需在真实 GUI 打开右栏 tab（Lead 的验收范围内）。
- **建议**：用 `useSessions` 取标题/cwd，取不到再回退截断 id。

### 5.2 冻结前两条已修复项：独立复核结论（保留审计痕迹，**不计入**缺陷数）

| 项 | 原级别 | 修复 | 我的独立复核 | 结论 |
|---|---|---|---|---|
| X1 并发首写丢更新（原 3.9） | 严重 | store 层 per-session 写队列（`store.js:112-113,219-228,241,289`） | V6：8 并发写 **8 存活、0 丢失**，写日志 `[put, update×7]`（串行）；V7 补测「并发 set+resetSession 交错」：ops 形状 `put,u,u,u,delete,put,u,u,u`，最终只 k4..k7 存活、无撕裂值、无拒绝，之后顺序写仍生效 | **已修复，复核通过** |
| X2 对账跳过无日志（原 3.8） | 一般 | `index.js:296-310`（`warnReconcileDisabled` + 30 分钟节流）、`index.js:354-374`（挂载期 `loader.await` 后检查 `reconcileAssembled`） | V8：(a) sessionPersistence 缺失 → 恰好 1 条 warn 且说明原因；(b) 存储降级 → 1 条 warn；(c) 两者都在 → **0 warn** + 1 条 assembled info（无误报）；(d) 50 次活动请求 → 仍 1 条（不刷屏） | **已修复，复核通过** |
| X3 协议 §1 能力表（v1.1） | 曾疑不一致 | 协议 v1.1 §1 澄清为「按方法实际所需能力」 | V5：storageDomain 缺失时 `registrations.list=200`、`values.*=503 storage-unavailable`（57/58/59）；sessionPersistence 缺失时状态码全部不变（60/61 按 v1.1 期望 200） | **符合 v1.1，不是缺陷** |
| X4 首写 `missing-key` | 潜在阻断 | `store.js:259-277` 先 `get` 判存在、缺失则 `put`，并保留 `missing-key` 重试 | V5/V6：新会话首写 200，域写日志为 `put → update`；`store.js:277` 的兜底 return 经推演不可达（每次迭代要么 return、要么 continue、要么 throw），不是静默失败 | **已修复，复核通过** |

补充说明（同源观察，不单列发现）：design v1.1 §7（`docs/design-v1.md:148`）声明「拿不到 storageDomain 时不做『看起来能改、重启即丢』的内存值」——**桥**遵守了（503），但**宿主服务 API** 仍然把降级期的写入收进内存并承诺重放（`store.js:8-9,142-150`），R1-01 的丢失正是发生在这条重放路径上。若 R1-01 修复，这条观察一并消解。

### 5.3 已排除的假警报（含反证，供复核者对照，避免重复挖）

| 曾经的怀疑 | 反证 | 结论 |
|---|---|---|
| trustedHosts 不生效（我的 check 25/30） | 我的夹具 `ctx.get()` 没暴露 webRuntime；产品用 `ctx.get('webRuntime')`（`index.js:267-272`）。修夹具后 PASS | 夹具缺陷，非产品问题 |
| 无 Host 请求返回 400 而非 403 | HTTP/1.1 缺 Host 被 **Node 自带 HTTP 解析器**直接 400，请求未进 handler；换 HTTP/1.0 复测 → **403**；`Host: not a host` → **403**；且 `trust-fence.js:74-75` 对缺失/不可解析 Host 直接 false | fence 正确 |
| `values.set` 不带 `value` 返回 400 | `bridge.js:148-150` 要求 own property `value`；协议 §2.3 请求体含该字段，400 可辩护 | 非缺陷（我的预期写错） |
| 对账跳过无日志 | 见 X2：加 `ctx.loader.await` 后实测有节流 warn（我最初夹具没有 loader，才误判为无日志） | 已修复 |
| `session/disposed` 被用于删除 | 唯一命中在 `index.js:290` 的**注释**里；无任何监听/删除路径 | 非问题 |
| `serializeRegistration` 未带 locale / 函数求值 | `resolve.js:184-212` 求值一次并带 `locale`；V5 检查 03/04 实测 title 为字符串、locale 为对象 | 符合协议 §2.1 |

### 5.4 不变量逐条结论（A–G）

- **A 桥与传输（协议 §1）A1–A10：全部符合**。prefix 路由 `/session-settings/api` + 无尾斜杠（`bridge.js:15,245`）；非 POST 405（`bridge.js:191-193`）；`Object.hasOwn` 严格派发（`bridge.js:175,214`，V5 的 10/11 用 `constructor`/`__proto__` 实测 404）；成功/失败封套（`bridge.js:93-100`）；状态码映射与 §6 一致（`resolve.js:16-26`）；fence 第一行（`bridge.js:187`）；trustedHosts 每请求现读（`index.js:267-272`，V5 的 30 在 apply 后加白名单仍 200）；能力缺失 503 按 v1.1（V5 的 57-61）；前缀安全 URL（`client.js:167-188`，剥前导斜杠 + 目录型 base + 去 query/hash）。
- **B 方法表（协议 §2）B1–B6：全部符合**。只有四个方法（`bridge.js:18-23`，V10 实测 `renderers.put` 0 命中；`registrations.list` 无 requireDurable（`bridge.js:136-138`）；set 的 `value` own-property 校验（`bridge.js:148-150`）；reset 三档与「itemKey 需要 pluginId」校验（`bridge.js:154-164`）；深比较稀疏（`resolve.js:85-99,309-317`，V5 的 42/43/44）。
- **C 宿主服务 API（协议 §3）C1–C6：全部符合**，含参数顺序（`index.js:159,173,186,202`，V5 的 49-56 用协议顺序实测通过）；change 三档（`index.js:64-73,142,146,194,215,224`）；重复注册点名占位者（`index.js:136-140`）；disposer 只撤自己那次（`index.js:143-147`）；额外方法 `snapshot`/`storageStatus` 已在协议 §3 注记允许。
- **D 存储（协议 §5）D1–D10：符合**（唯一实质问题已单列为 R1-01）。域声明 `resolve.js→store.js:60-66`（name/version/layout/invalidRecords/表 sessions）；记录形状与 `updatedAt`（`store.js:49-54,87-91,215-249`）；稀疏三档（`resolve.js:309-337` + `store.js:266-269`）；per-record 键安全（`store.js:31-42`，与官方 `SAFE_KEY_RE` 一致）；对账只用 `list()`（`index.js:312-347`）。
- **E 客户端（协议 §4、设计 §4.1/§6）E1–E12：符合**，仅 E3 有 R1-05 的表现层偏差。无裸 import（V10：`client.js` 只有 `require('react')`）；三方法齐（`client.js:1262-1284`，另附页面用到的附加方法）；不注册声明式项（只 `registerRenderer`）；五种控件 + 覆盖徽标 + 单项/整组/整会话恢复（`client.js:544-694,747-861,942-1016`）；批量恢复二次确认 + 3 秒自动解除（`client.js:915-925,930-966`）；只读态不渲染可写控件（`client.js:993-1001`）；写队列不毒化不乐观翻转（`client.js:356-390`，且 `ItemRow` 一律 `.catch(noop)`）；写入后回读 + 聚焦/可见性刷新（`client.js:729-745`）；i18n 走宿主 `locale.getLocale().active` + `locale.subscribe`（`client.js:1234-1294`，官方 `dsh-client-locale/lib/types/client/index.d.ts:51,123,144` 确有该 API）且 `subscribe` 缺失时安全降级；纯 UI 状态留在组件内；错误边界保住 tab（`client.js:869-903`）。
- **F 生命周期 F1–F3：符合**。路由包在 `ctx.effect`（`index.js:277-279`）、域 handle 由 store `close()`（`index.js:259`、`store.js:298-305`）、slot 与 tab 注册的 disposer 全部回收且失败回滚（`client.js:1299-1334`）。
- **G 协议偏差 G1–G4**：G1 Origin 用 hostname 比较（`trust-fence.js:107-114`）——与协议 §1 文案一致，且与参考实现 `DSH-better-sidebar/src/trust-fence.ts:109-122` 同口径；G2 设计稿 `renderers.put` 已被 Lead 修正，代码无该实现（V10）；G3 tab `title` 是函数（`client.js:1305,1309`，忽略官方传入的 address 参数，签名兼容）；G4 落盘路径与真实 per-record 布局一致（`<storages>/session_settings/sessions/<sessionId>.json`，同 `session_projcache` 先例），仅文档表述可更准（文件内容是版本戳包装）。

### 5.5 分级统计

- 阻断：**0**
- 严重：**1**（R1-01：降级期写入在存储恢复窗口内丢失）
- 一般：**1**（R1-03：裸 `node --test` 假绿 + 注释不实）
- 建议：**3**（R1-02 默认值别名；R1-04 conflict/409 无触发路径；R1-05 会话标识用截断 id）
- 另：已修复并复核通过 4 项（X1–X4，不计入）；已排除假警报 6 条（见 5.3）
- 待复核：**1**（R1-01 的级别定档：我按「静默丢失已接受的用户写入」定为严重，若 Lead 以可达性为准可视作一般——事实与复现不受影响）

### 5.6 残余不确定（不写成结论）

1. R1-01 的**真实 DSH 环境可达性**未在真机验证（我无法启动 profile 观测 storageDomain 挂载顺序）；窗口与机制已在无 DSH 夹具里复现。
2. 右栏页面在真实浏览器的最终外观未由我验证（硬性禁令：不得使用任何浏览器工具）；E3/E4/E5 的结论基于代码与界面契约（C12–C15），DOM 层验收属 Lead 范围。
3. `ConflictDomain` 之外的跨进程并发（两个 DSH 进程写同一 `storages` 根）无 CAS 原语，writer 已在 `docs/notes/t2-t3-choices.md:137` 记入 v2；本轮未测。
