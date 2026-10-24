# 对 DSH 的依赖与变更对照

这份文档只服务一件事：**DSH 升级时，能快速判断这个插件会不会坏、坏在哪、要改哪一行。**
它是"基础设施"插件：既自己依赖 DSH，也给别的插件提供契约，所以两类都要对照。

- 对照基线（本文档写就时实测通过的版本）：**@deepseek-ai/dsh 0.2.1-rc.2**，安装路径 `C:\Users\dongkid\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`。
- 插件的定位：**增量插件 + 契约提供者**。不修改 DSH 的任何文件，但会在宿主里注册服务、路由、存储域、侧边栏标签与插槽席位。

## 一、依赖的 DSH 能力

### 宿主半边（lib/index.js）

| # | 依赖 | 用到的具体接口 | 失效时表现 |
|---|---|---|---|
| 1 | cordis 4.0.4 | `Service` / `ctx.effect` / `ctx.inject` / `ctx.get` / `ctx.provide` / `ctx.logger` / `ctx.loader.await` | **硬失败**，整个插件不激活 |
| 2 | **dsh-storage-domain**（唯一被 import 的 DSH 包） | `import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'`；`ctx.inject(['storageDomain'])` → `storageDomain.open(spec)` | **降级**：退回内存存储并告警；值在重启后丢失（`backend: 'memory'`），桥接层对读写返回 503 |
| 3 | dsh-host-webserver | `ctx.webServer.register({ kind: 'prefix', path: '/session-settings/api', handler })`，包在 `ctx.effect` 里 | **硬失败（页面侧）**：没有路由，浏览器读不到也写不了，页面进入只读 |
| 4 | dsh-webStartup（0.2.1+，可选；0.2.0 对应 dsh-webRuntime） | `ctx.get('webStartup').trustedHosts`（每次请求重新读取；缺失时回退 `ctx.get('webRuntime').trustedHosts`） | **降级**：信任闸门退回"仅回环地址"规则——通过反向代理/局域网域名访问时页面报"信任校验未通过 (forbidden)" |
| 5 | dsh-session-persistence（可选） | `ctx.get('sessionPersistence').list()`，用于把已不存在的会话的记录对账清掉 | **降级**：对账被禁用并告警；已删会话的残留记录不会被清理 |
| 6 | profileContext（可选） | `ctx.get('profileContext')`，写进记录里的 `profile` 字段（诊断用） | **降级**：字段缺失 |

### 浏览器半边（lib/client.js）

| # | 依赖 | 用到的具体接口 | 失效时表现 |
|---|---|---|---|
| 7 | dsh-client-modules | `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 只允许基线模块（本插件只用 `react`） | **硬失败**：模块装不上，右侧栏看不到本页 |
| 8 | dsh-client-ui-sidebar-right | `ctx.inject(['sidebarRightTabs'])` → `sidebarRightTabs.register({ id, kind, title: (address) => string, guide: [{ id, order, title, description }] })` | **硬失败**：没有标签类型，页签不出现 |
| 9 | dsh-client-ui-slots | `ctx.slots.inject(name, factory)` + `ctx.slots.register({ name, key }, Component)`，用的 slot 名是 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title`，key = 类型 id | **硬失败**：标签在但没有内容（界面显示"这类内容还没有可用的查看方式"） |
| 10 | dsh-client-locale（可选） | `ctx.get('locale').getLocale().active`、`locale.subscribe(listener)` | **降级**：按 `navigator.language` 回退 |
| 11 | 视觉主题 | 只用 `var(--dsw-alias-*, fallback)` 语义令牌 | **外观**：令牌改名会退化成 fallback 颜色 |

## 二、它对外提供的契约（别的插件依赖这些）

| 契约 | 形式 | 由谁消费 |
|---|---|---|
| 宿主服务 `ctx.sessionSettings` | `register(registration)` / `listRegistrations()` / `get(pluginId, sessionId)` / `getItem(pluginId, itemKey, sessionId)`（同步） / `set(...)` / `reset(...)` / `resetSession(sessionId)` / `subscribe(listener)` | 任何想加会话级选项的插件（当前：`dsh-extra-workspaces`） |
| 浏览器服务 `sessionSettings` | `registerRenderer(pluginId, itemKey, Component)` / `getResolved(...)` / `subscribe(...)` / `listRegistrations()` / `setValue(...)` / `reset(...)` / `refresh(...)` | 同上（浏览器半边） |
| HTTP 协议 v1 | `POST /session-settings/api/{registrations.list, values.get, values.set, values.reset}`，信封 `{ok, value}` / `{ok:false, error:{code,message}}` | 本插件的浏览器半边；见 `docs/protocol-v1.md` |
| 值形状 | 声明项必须给 `default`（任意 JSON）；**写入接受任意 JSON 值** | 消费方可以借此在一个声明的 `stringList` 项里存对象数组（`dsh-extra-workspaces` 就是这么做的） |
| 存储域 | `session_settings` v1，每记录一条，键 = sessionId，落盘 `<DSH_HOME>/storages/session_settings/sessions/<sessionId>.json` | 本插件自有；删除对账只按 `sessionPersistence.list()` 差集 |

五种声明控件类型：`switch` / `text` / `number` / `select` / `stringList`（列表见 `lib/resolve.js` 的 `ITEM_TYPES`）。

## 三、对 DSH 做出的变更

**DSH 本体：零改动。** 这个插件只做**增量注册**：

| 注册了什么 | 通过什么 | 注意 |
|---|---|---|
| 宿主服务 `sessionSettings` | cordis Service | 名字是全局契约，改名会打断所有消费方 |
| HTTP 前缀路由 `/session-settings/api` | `ctx.webServer.register({kind:'prefix'})` | 只接受 POST；信任闸门只防 DNS 重绑定/跨站，不是身份认证 |
| 存储域 `session_settings` | `storageDomain.open(...)` | 数据由本插件拥有，不写进会话日志 |
| 右侧栏标签类型 `session-settings` + 两条插槽席位 | `sidebarRightTabs.register` / `slots.register` | 席位 key 必须等于类型 id |
| 浏览器服务 `sessionSettings` | `ctx.provide('sessionSettings', service)` | 同上，名字是契约 |

**DSH 周边只有 profile**：`dependencies` 里一条 `link:` + `dsh.profile.bundles` 里一条名字。

### 本仓库自身的行为变更记录（与本仓库历史版本对照用）

1. **窄面板排版**：`rowMain` 加 `flexWrap`、`rowText` 给最小宽度、`rowControl` 改为可收缩。原因：第一个"很宽"的自定义控件（`dsh-extra-workspaces` 的列表）暴露了旧布局会把说明文字压成一字一行的缺陷。
2. **不破坏不可表达的值**：新增 `builtinRepresentable(item, value)`。当某个声明项当前存的值不是它声明类型的内置控件能表达的形式（例如 `stringList` 里存的是对象数组）时，内置控件只读、条目/整组的"恢复默认"一并禁用，避免把值 stringify 成 `[object Object]` 或直接清掉。**会话级"全部恢复默认"仍保持可用**（它是显式、两步确认的整会话重置，也是值卡死时唯一的恢复出口），`lib/client.js` 里对此有注释说明。
3. **2026-10-24：信任列表改读 `webStartup`**。DSH 0.2.1 删除了 `webRuntime` 服务，`--trusted-host` 的 authority 改由 `ctx.webStartup.trustedHosts` 携带（与 connection 行同源）。本插件改为优先读 `webStartup`、缺失时回退 `webRuntime`，因此通过反向代理/域名访问会话设置不再报 403。宿主半代码变更后需要重启 DSH（或由 Plugin Manager 触发重新组合）才生效。

## 四、升级 DSH 后要跑的核对清单

1. `node --test "tests/**/*.spec.mjs"`（当前 105 例；注意 Node 24 下 `node --test tests/` 会把目录当模块解析而失败）。
2. 活体确认桥接可用（需要 DSH 在跑）：
   ```powershell
   (Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/session-settings/api/registrations.list' -Body '{}' -ContentType 'application/json') | ConvertTo-Json -Depth 6
   ```
   期望 `ok: true`；再对某个真实会话调 `values.get`，期望 `resolved` 里能看到消费方注册的项。
3. 界面里打开右侧栏的"会话设置"：应能渲染消费方注册的项；若显示"这类内容还没有可用的查看方式"，先 **Ctrl+Shift+R** 硬刷新（客户端模块换版本号后普通刷新可能拿旧清单）。
4. 逐行对照第一节：`storageDomain.open` 的域规格 API、`webServer.register` 的 `kind`/`path` 语义、`webStartup.trustedHosts`（0.2.0 回退 `webRuntime.trustedHosts`）、`sessionPersistence.list()`、`sidebarRightTabs.register` 的字段（尤其 `title` 是**函数**、`guide[].order` 必填）、两条 slot 名与 key 规则。
5. 消费方回归：`dsh-extra-workspaces` 的注册项能出现、能写、能在重启后读回。

## 五、已知脆弱点（升级时优先看）

1. **两处字符串契约**：宿主服务名 `sessionSettings`、浏览器服务名 `sessionSettings`，以及 slot 名 `sidebar.right.pane.tab` / `.title`——官方改名不会有编译期报错，只会静默失效。
2. **`ITEM_TYPES` 是写死的五种**：官方若新增控件类型，需要在这里补并补渲染分支。
3. **值的宽容性是有意的**：值可以是任意 JSON，靠消费方自己保证形状；页面端靠 `builtinRepresentable` 兜底，不假设声明类型能表达当前值。
4. **信任闸门不是认证**：它只按 Host/Origin/Sec-Fetch-Site 判断，部署到非回环地址时要配置 `webStartup.trustedHosts`（0.2.0 为 `webRuntime.trustedHosts`）；信任列表若读不到，页面会显示"信任校验未通过 (forbidden)"。
5. **对账依赖 `sessionPersistence.list()`**：会话被归档仍会保留记录（这是有意的），只有真正不在列表里的记录才会被清。
