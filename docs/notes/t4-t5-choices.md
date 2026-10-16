# T4/T5 客户端半：方案对比与取舍

> 范围：`lib/client.js`（浏览器半）与它的设计选择。协议见 `docs/protocol-v1.md`（已冻结），页面结构见 `docs/design-v1.md` 第 4、6 节。
> 结论先行：**单个激活级 store（自研、约 80 行）+ React 订阅（useSyncExternalStore）+ 手写 JS（React.createElement，零构建）**。

## 0. 硬约束（先摆清楚，后面所有取舍都在这个框里做）

1. 客户端产物必须是 `window.__ModuleLoader__.load({ id, factory })` 的懒工厂，`react` 只能从 factory 的 `require('react')` 取（模块表已内置 React 18）。
2. 本版零构建、单文件自包含：不引入 tsdown/tsx/打包器，不 import 任何 Harness 客户端包。
3. 与宿主只有四个 POST 方法：`registrations.list` / `values.get` / `values.set` / `values.reset`（协议第 2 节）。
4. 承载面是原生右栏 tab（`sidebar.right.pane.tab`，session 作用域），页面组件从标准 props 拿 `sessionId`。

## 1. 决策一：状态放在哪儿 —— 单组件自管 vs store + 订阅

### 方案 A：一个组件里 `useState` + `useEffect` 全自管

写法最短：组件挂载时拉 `registrations.list` + `values.get`，写入成功后就地 `setState`，一份 state 收全场。

- 优点：文件最短，没有间接层；一个人看一遍就懂。
- 缺点（决定性的）：这个页面的消费者**不止一个**。
  1. tab 页签体要重渲染；
  2. tab 标题（`sidebar.right.pane.tab.title`，另一个注册点、另一个组件）要跟随语言；
  3. 契约要求对外提供 `ctx.sessionSettings.subscribe(listener)`——如果状态锁在一个组件里，这个 API 只能是个空壳或者去猜组件内部结构；
  4. 写入必须串行化并"写完后用宿主返回的状态覆盖本地"（不做乐观翻转）。串行队列如果长在组件里，组件一卸载（切会话、收折右栏）队列的落地状态就没人接了，回读结果无处存放。
- 还有 React 的坑：`setState` 在异步回调里对已卸载组件是 no-op（React 18 不再警告，但状态确实丢了）；重新挂载要重拉一遍，闪烁不可避免。

### 方案 B：激活级 store + 订阅 + 选择器（最终选择）

`apply(ctx)` 里创建一个 store（**不是模块级单例**，遵循官方 `createXXXStore()` 的"每次激活一个实例"规则），它持有：注册表、每个会话的 `{overrides, resolved, status, error, notice, busy}`、写入队列、自定义渲染组件表、当前语言；对外是 `getRevision()/snapshot(sessionId)/subscribe(listener)` 三元组。

组件侧用 `React.useSyncExternalStore(subscribe, () => store.snapshot(sessionId))` 订阅，快照按 (sessionId, revision) 缓存，保证"没变就不重渲染"（uSES 要求 getSnapshot 返回稳定引用，否则会死循环）。

- 优点：一个真相源；写入队列的生命周期跟插件激活绑定，不跟某个组件实例绑定；`ctx.sessionSettings.subscribe` 真能通知到人；tab 体、tab 标题、未来的第三方消费者各拿各的快照，互不干扰；每个会话一份状态，切会话不会串味。
- 代价：多约 80 行缓存/订阅/队列代码；要自己保证"快照引用稳定"（已用 revision 缓存兜住）。
- 为什么不用现成状态库：`@deepseek-ai/dsh-client-store` 之类的 Harness 客户端包一旦 import 就破坏"单文件自包含 + 零构建"（协议允许从模块表取，但那条路要靠 `dsh.client.external` 声明与构建期解析，本版不做）。自研 80 行比引入一条依赖链便宜。

**结论：方案 B（轻量版）。**

## 2. 决策二：手写 JS vs 引入 tsdown/tsx 构建链

### 方案 A：TypeScript + tsdown/tsx 构建

- 换来类型检查、JSX 可读性、未来可拆文件。
- 代价：`package.json` 要加 scripts（Lead 独占，本版不许改）；DSH 只服务**已构建**的 `lib/client.js`（client-modules README 明确要求 "pnpm run build 必须已经产出 lib/client.js"），于是每次改源码都要重跑构建，HMR 观察窗也得挂在构建产物上；产物与源码两份真相，评审要同时对两处；宿主半本来就是手写 ESM 无构建，两侧风格会分裂。

### 方案 B：手写 JS（React.createElement），零构建

- 唯一外部请求是模块表里的 `react`；改完立即生效，评审看的就是运行的代码。
- 代价：没有类型检查，靠 `node --check` + 一个 Node 侧桩测试（见第 5 节）+ 评审兜底；`createElement` hyperscript 冗长，用局部 `h` 与小组件拆分缓解。

**结论：方案 B。** 本版单文件约 800 行、控件形态固定（5 种），类型收益不抵构建链成本。

## 3. 决策三：其余取舍（逐条）

| 题目 | 选择 | 理由 |
| --- | --- | --- |
| URL 构造 | 自带 `routeUrl`：相对 `document.baseURI`（无 DOM 时退 `__DSH_TRANSPORT__.streamBaseUrl`），**剥掉前导斜杠**后再 resolve | 抄 `DSH-better-sidebar/src/client/host-route-url.ts` 的成熟做法：硬写前导斜杠会把请求钉在源站根，反代子路径下丢前缀（404）。HTTP 走页面 base，不走注入的 transport origin（桌面壳 `dsh-app://app` 由壳同源转发） |
| 写入 | 一条 promise 队列；`queue = result.then(noop, noop)`，失败不毒化；不做乐观翻转；每次写完用宿主返回的 `{overrides, resolved}` 整体覆盖；写入在飞时整页控件禁用 | 协议第 2.3 节的响应就是最新状态（"写入后回读"由机制保证，不靠再发一次 get）；本地永不先行改值，失败时界面不会显示一个宿主上没有的值；整页禁用是为了不让用户在一秒内排出一串互相覆盖的写入，串行队列保证顺序但仍然会让用户困惑 |
| 写冲突（409） | 记一条 notice（可关闭的提示条）并后台重取一次最新值 | 冲突的语义是"别人改过"，重取才对；不用错误条压成只读态 |
| 错误码 | 协议第 6 节八个码 + `network`/`http` 兜底，映射成中英文人话 | `forbidden`/`unknown-method`/`storage-unavailable`/`network`/`method-not-allowed` 同时把页面切只读（桥或存储不可用时"假装能写"比报错更坏） |
| 刷新时机 | 挂载 + `window focus` + `visibilitychange→visible` 重取；第一版不做 WebSocket | 协议第 5 节与设计第 7 节明确定的第一版范围 |
| 文案 | 注册方 locale 字典优先：`dict[text] ?? text`；插件自带 zh/en 字典跟随 `ctx.locale` 的 active（拿不到时用 `navigator.language`），并订阅 locale 变化重渲染 | 协议第 2.1 节"要跟随浏览器语言请用 locale 字典"；设计第 6 节约束 |
| stringList 控件 | `textarea`，每行一项，`blur` 提交，提交前 trim+去空行 | 逐键写入会打满队列，且半截输入（空行、逗号）会写出无意义的值；`blur` 提交语义清晰 |
| text/number 控件 | 本地 draft，`blur`/`Enter` 提交 | 同上：避免逐键写；外部值变化（宿主规范化后回读）时 draft 自动跟随 |
| 自定义渲染 | `registerRenderer(pluginId, itemKey, Component)`，组件收到 `{pluginId, sessionId, item, registration, value, defaultValue, overridden, disabled, setValue, reset, t}` | 设计第 4.1 节要求客户端半能挂自定义渲染；props 里给足读写能力，写入仍然走同一条队列 |
| 批量恢复 | 两步内联确认：第一次点击把按钮变成「确认全部恢复？/确认整组恢复？」（红色描边），再点一次才执行，3 秒无操作自动还原；**单项恢复保持一步到位** | 会话级/整组级恢复一次抹掉多份配置，误点代价高；不用 `window.confirm`（阻塞页面、样式与宿主无关），内联确认还能顺带说明"这一下会恢复哪些" |
| 单击目标 | switch 用原生 checkbox（`accent-color` 走 token），select 用原生 select | 少造轮子、可键盘操作；宿主主题靠 token 着色 |
| 控件可访问性 | 每个控件都有 `id` 与同值 `name`：`session-settings-<tabId>-<pluginId>-<itemKey>`，三段各自做单射转义（安全字符集 `[A-Za-z0-9_]`，其余字符转成 `-<hex>`，因此 '-' 只会是转义标记或分隔符，不同的 (tabId,pluginId,itemKey) 三元组不可能撞 id）；默认控件的行标题是 `<label htmlFor>`，点标题即可聚焦/切换 | DevTools 报 `A form field element should have an id or name attribute`；转义是为了让任何 tab id / 插件 id / 键名都能安全变成 DOM id。自定义渲染器自己负责标注，所以那一行不挂 `label`（否则会指向不存在的 id） |
| 控件 id 的分栏隔离 | id 的第一段是 **tab 实例身份**（`useTabInfo().tab.id`，这个席位自己的 slot 级 hook context，官方 FilesBody 用的同一个）；拿不到就退到常量 `pane` | 同一页面可以在两个分栏里同时打开，若 id 只由 (pluginId,itemKey) 决定，DOM 里就会出现重复 id（严格 a11y 检查会报 duplicate-id）。tab id 在分栏存活期间稳定，所以同一分栏的重渲染/刷新复用同一批 id；`useTabInfo` 的存在性同样在挂载时冻结，hook 顺序不变 |
| 会话标识 | 头部**优先显示会话标题**，没有标题用 **cwd**，两者都没有才回退截断 id（`shortSession`）；完整 sessionId 始终在 `title` 属性里 | 设计第 6 节要求"标题或 cwd"（R1-05）。字段来自 session 作用域标准 prop `useSessions`（`GlobalStandardProps`）：`SessionListState.byId[sessionId]` 是官方 `SessionSummary`，取 `title?: string` 与 `cwd?: string`；官方同级实现 `dsh-client-ui-sidebar-files/lib/client.js:605` 就是这么读的（`useSessions(s => s.byId[sessionId]?.cwd)`）。`useSessions` 的"存在性"在挂载时冻结（`useRef`），因此即使将来某个组合没装标准套件，hook 顺序也不会变，页面只是退化成截断 id |

## 4. 页面结构（对应设计第 6 节）

```
头部：标题 + 只读徽标 | 会话标识行 | 「本会话已改 N 项」+「全部恢复默认」（两步确认）
提示条：上次写入失败的人话（可关闭）
错误条：读/写不可用时的原因 + 重试
主体：按 order→pluginId 排序的卡片
  卡片头：插件标题 + 「已改 N 项」+「整组恢复」（两步确认）
  行：标题/说明/默认值 ··· 控件；被覆盖时「已覆盖」徽标 + 「恢复默认」（一步）
空态：没有任何插件注册
错误态：桥/存储不可用 → 错误条 + 只读
```

## 5. 验证方式与结果

### 5.1 跑过的东西（2026-10-13）

| 命令 | 结果 |
| --- | --- |
| `node --check lib/client.js` | 通过（exit 0） |
| `node --test tests/`（仓库内：客户端半 23 项 + 宿主半 77 项） | **100 项全过（0 失败）** |
| `grep` 方法名 | 协议四个方法名只出现在文件头注释与四个常量定义处 |
| `grep ^import / require(` | 只有 `var React = require('react')` 一处 |

### 5.2 客户端测试 `tests/client.spec.mjs`

它桩掉 `window.__ModuleLoader__` / `require('react')` / Cordis ctx / `fetch`，并自带一个约 100 行的 mini-React（按组件路径保存 hook 状态、支持同步重渲染、实现 `getDerivedStateFromError` 错误边界），所以断言跑在**真实元素树**上，而不是对着源码猜。覆盖：

- 工厂 id 与 `{name, inject, apply}` 形态；tab 类型与两个 keyed 席位保持 T1 的 id/kind/key。
- 反代前缀下的 URL；全部 POST + JSON；方法名只可能是协议那四个。
- 读透缓存（非强制不重复请求）、强制刷新才重取。
- 写入严格串行（maxInFlight=1）、提交顺序、失败带 wire code 拒绝且不毒化队列、写入用宿主响应整体覆盖（不做乐观翻转）。
- 三档恢复的请求体逐字段比对。
- 页面：五种控件、注册方 zh 字典、已改项数、覆盖徽标、空态、503 只读态（且不渲染任何可写控件）、404 unknown-method 的版本不匹配文案、checkbox 反映 resolved 值。
- 自定义渲染器命中 / 收到完整 props / 注销后回退默认控件；渲染器抛错时错误边界接住并显示原因（tab 不被清空）。
- 批量恢复的两步确认：第一次点击不发请求且文案变成确认态，第二次才发；单项恢复一次点击即发。
- 会话标识三种情况：有标题（标题赢过 cwd）、只有 cwd、两者皆无（截断 id，且完整 id 仍在 `title` 属性）；外加"标准套件整个缺席"不崩。
- 控件可访问性：6 个字段（开关/数字/文本/下拉/多行/带怪字符键的文本）各自 id===name、id 唯一且只含 `[A-Za-z0-9_-]`、怪键被确定性转义（`weird key/@#` → `-weird-20key-2f-40-23`）、每个默认控件都有一个 `htmlFor` 指向它的 `<label>`，而自定义渲染器那一行不会留下悬空 label。
- 控件 id 的分栏隔离：同一个 harness 两次渲染 → id 完全相同；两个 tab 身份 → id 不同且互不泄漏；非 DOM 安全的 tab id（`tab/1`）被转义成 `tab-2f1`；完全拿不到 `useTabInfo` 时退到 `pane` 且仍然合法；`label htmlFor` 与 `name` 都跟着同一个分栏 id 走。

### 5.3 测试抓到的真 bug（修前修后）

1. 封套解析里把 `noop` 当恒等函数用（`Promise.resolve(json).then(noop, ...)`），导致 `body` 恒为 `undefined`，任何成功响应都会被判成 `http` 错误。桩测试第一次跑就炸出来了，已改为显式恒等函数。
2. （F2/R1-05）tab 席位的包装组件只把 `sessionId` 和 `store` 转发给页面，**把标准套件整个丢了**——页面因此在真实 GUI 里也永远拿不到 `useSessions`。补三种会话标识用例时先失败后修复：包装器改为 `Object.assign({}, props, { store, sessionId })` 整体转发。这条正好说明"测试用真的元素树"比"对着源码读"多值。
