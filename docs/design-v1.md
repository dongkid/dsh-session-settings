# dsh-session-settings 设计稿 v1

> 基于 DSH 0.2.0-rc.2 实测契约写成；每条关键结论都来自本机运行时或已发布包的真实代码。
> 状态：待确认（第 10 节的待定项确认后开工）。

## 0. 一句话

一个「每会话配置」的基础设施插件：宿主半持有唯一真身并提供注册/读写/订阅 API，客户端半提供一个右侧栏原生 tab 作为配置页面；消费插件注册声明式选项，用户在本会话页面里改的值只对这一会话生效。

## 1. 定位与范围

做什么：

1. 替其他插件保存「每个会话不同」的配置（稀疏覆盖）。
2. 对外提供 API：注册选项、按会话读取解析后的完整值、写入与恢复、订阅变更。
3. 提供一个右侧栏页面，把各插件注册的选项按分组渲染并允许修改。

不做什么：

1. 不维护「全局默认值」这一层——默认值的真源归消费插件自己（注册时提供）。
2. 不写会话事件日志、不写会话数据、不写 profile 的 cordis.patch.yml。
3. 不引入新进程或新服务；只用宿主已挂载的官方能力。

## 2. 形态与承载

- 包名 dsh-session-settings；目录 D:/projects/dsh-plugins/dsh-session-settings。
- 宿主半 lib/index.js：普通 Cordis 插件，provide 服务 sessionSettings。
- 客户端半 lib/client.js：经 dsh.client 声明由 web 端加载，provide 同名服务 sessionSettings。
- 承载面（官方途径）：右侧栏原生 tab。
    - sidebarRightTabs.register({ id: 'session-settings', kind: 'session-settings', title, guide: [{ id: 'open', order: 25, title, description, icon }] })
    - 页面体注册进 sidebar.right.pane.tab（key 必须是 definition.id）；标题注册进 sidebar.right.pane.tab.title（这样才跟随语言）。
    - 该承载槽是 session 作用域，页面组件直接拿到 sessionId——「改的是哪个会话」无需猜测。
- cordis.patch.yml 插入一行：id/name = session-settings / dsh-session-settings。

## 3. 数据模型

### 3.1 两层解析（唯一规则）

    解析后的值 = 注册时提供的默认值  ->  该会话的覆盖值

没有第三层。默认值的真源是消费插件的注册声明；我们只保存「被改过且不同于默认」的那部分。

### 3.2 存储介质：官方 storageDomain

- inject: storageDomain（宿主组合已挂载 storage + storage-json + storage-domain）。
- 落盘：<DSH_HOME>/storages/session_settings/sessions/<sessionId>.json（per-record，一会话一文档）。
- 域声明：name session_settings、version 1、layout per-record、invalidRecords backup-and-skip。
- 记录形状：

    {
      sessionId: string,
      profile?: string,                                // 诊断与将来清理用
      updatedAt: number,
      values: { [pluginId]: { [itemKey]: unknown } }   // 只存覆盖
    }

- 写路径用 table.update(key, fn) 做原子读改写，避免并发丢更新。
- 稀疏维护：值等于默认值就删该键；某插件的 map 空了就删它；文档 values 空了就删整条记录。
- 注意：storages 根是全 DSH_HOME 共享（非 profile 级），但 sessionId 全局唯一，按会话分键不会撞；记录里带 profile 便于将来清理。

## 4. 对外 API（两侧同名服务）

消费插件按自己所在的一侧 inject；两侧看到的是同一份值的两个面。

### 4.1 注册

    register(registration): () => void

    interface SessionSettingsRegistration {
      pluginId: string                  // 消费方标识，显式声明（推荐反向域名或包名）
      title: string | (() => string)    // 页面里的分组标题
      order?: number
      items: SessionSettingItem[]
      locale?: { zh?: Record<string, string>; en?: Record<string, string> }
    }

    interface SessionSettingItem {
      key: string                       // 该 pluginId 内唯一
      type: 'switch' | 'text' | 'number' | 'select' | 'stringList'
      title: string | (() => string)
      description?: string | (() => string)
      default: unknown                  // 两层解析的第一层
      min?: number; max?: number; step?: number; unit?: string; placeholder?: string
      options?: { value: string | number | boolean; title: string | (() => string) }[]
    }

注册归属（已确认）：声明式项只能由消费插件的宿主半注册——宿主在任何时候（包括没有任何页面打开时）都必须能解析出默认值，这是本插件立身之本。客户端半不注册声明式项，它只提供两件事：可选的渲染组件 registerRenderer(pluginId, itemKey, Component)，以及 get / subscribe 读取。

规则：同一 pluginId 重复注册抛错并点名占位者；返回的 disposer 撤销该次注册。

### 4.2 读取

    get(pluginId, sessionId): Record<string, unknown> | undefined    // 完整解析值
    getItem(pluginId, itemKey, sessionId): unknown                   // 单项便捷读

读取是同步的（宿主半读内存表）。第一版不返回「哪一层赢」的元信息；需要时第二版加 getOverrides 看覆盖差异。

### 4.3 写入与恢复

    set(pluginId, itemKey, sessionId, value): Promise<void>     // 等于默认值 -> 自动删覆盖
    reset(pluginId, sessionId, itemKey?): Promise<void>         // 省略 itemKey = 该插件在本会话全恢复
    resetSession(sessionId): Promise<void>                      // 清空本会话全部覆盖

### 4.4 订阅与枚举

    subscribe(listener): () => void     // 变更通知（会话、插件、键）
    listRegistrations(): readonly SessionSettingsRegistration[]

宿主半的订阅在宿主进程内直接生效；客户端半的订阅由桥推送 + 本地写入后回读。

## 5. 桥（宿主 <-> 浏览器）

事实结论：静态安装的插件用不了 typert Remote（客户端 $mount 硬要求生成器产出的 strict codec，而生成器未发布），也用不了 host.call（动态包专属形参）。静态插件的正路是自建 HTTP 路由。

- 宿主半 ctx.webServer.register({ kind: 'prefix', path: '/session-settings/api' })：只接受 POST，JSON 派发，方法名用 Object.hasOwn 严格查表。
- 每个 handler 第一行做 fence：本插件自带一份 isTrustedApiRequest 实现（官方包不导出该 helper），信任列表取 ctx.webStartup.trustedHosts（0.2.1+；与 /api 网关同源；0.2.0 回退 ctx.webRuntime.trustedHosts），按请求现读。
- 未过 fence -> 403；方法不存在 -> 404；非 POST -> 405；宿主能力缺失 -> 503（页面显示只读，而不是假装能写）。
- 所有注册包在 ctx.effect(() => ..., '说明') 里，保证卸载与 HMR 回收。
- 客户端调用自家前缀不要硬写前导斜杠（反代子路径会丢前缀），需要一个自己的 hostRouteUrl 等价物。
- 变更推送：第一版 = 写入后回读 + 页面重新聚焦时刷新；第二版再加一条 WebSocket（registerUpgrade，未过 fence 直接 destroy）做广播。

桥的方法集（第一版）：

    values.get         { sessionId }
    values.set         { sessionId, pluginId, itemKey, value }
    values.reset       { sessionId, pluginId?, itemKey? }
    registrations.list {}                      // 页面渲染前拉取宿主的注册项集合（协议 v1 只有四个方法；注册渲染组件是纯浏览器进程内 API，不过桥）

## 6. 页面（右侧栏 tab）

结构：

1. 头部：当前会话标识（标题或 cwd）+「本会话已改 N 项」+「全部恢复默认」。
2. 主体：按消费插件分组的卡片，每组 = 插件标题 + 它的选项行。
3. 选项行：标题、说明、控件；被覆盖时显示「已覆盖」标记 + 单项恢复；整组被改过时给整组恢复。
4. 空态：没有任何插件注册时说明「当前没有插件注册会话设置」。
5. 错误态：桥不可用或存储不可用 -> 顶部错误条 + 只读。

约束：

- 样式只用宿主主题 token（--dsw-alias-*），不 import 任何 Harness 客户端包；react 从模块表取。
- 文案走消费方字典 + 我们自己的 zh/en 字典，跟随宿主语言。
- 纯 UI 状态（分组展开、搜索词）留在浏览器本地，不进存储。

## 7. 生命周期、容错与回收

- 消费方未装本插件：可选 peerDependency + 运行时探测，安全跳过。
- 本插件拿不到 storageDomain 时（Lead 裁定，2026-10-13）：注册表仍可用（进程内存即可），但**所有值读写返回 503（storage-unavailable）并带明确文案**，页面呈现只读态。刻意**不做**「看起来能改、重启即丢」的内存值——那等于静默丢失用户改动。取舍与备选记于 docs/notes/t2-t3-choices.md。
- 会话回收：session/disposed 只在会话离开内存时触发（切会话、重启都会触发），绝不能用来删数据。回收改为对账——插件启动时 + 低频（页面打开且距上次超过 N 分钟）用 ctx.sessionPersistence.list() 取现存会话集合，删除已不存在的记录；归档的会话仍然存在，配置保留。
- 并发：宿主侧写入走 table.update 原子读改写；客户端侧写入用一条 promise 队列串行化，失败不毒化队列、不做乐观翻转。
- 冲突：同 pluginId 重复注册抛错；插件卸载时 disposer 撤销注册（已保存的值保留，便于重装后继续用）。

## 8. 版本与兼容

- peerDependencies：@deepseek-ai/cordis、@deepseek-ai/dsh-storage-domain、@deepseek-ai/dsh-host-webserver、@deepseek-ai/dsh-client-ui-sidebar-right。
- dependencies：zod（域记录 schema 需要）。
- 域版本 version 1；将来结构变化用 compatibleVersions 容忍旧文档。
- 客户端 bundle 形态：window.__ModuleLoader__.load({ id: 'dsh-session-settings', factory }) 包裹，导出 { name, inject, apply }。

## 9. 实现任务拆解（第一批）

T1 骨架与挂载：package.json、cordis.patch.yml、宿主半 provide 空服务、客户端半注册右栏 tab 并渲染空页面 -> 源码 link 装进 web profile，确认页面出现且无报错。
T2 存储层：域声明 + 读写 + 两层解析 + 稀疏维护 + 变更通知（宿主半单测）。
T3 桥：POST 路由 + fence + 客户端 api 模块 + 错误码映射。
T4 注册 API（宿主半）+ 页面渲染声明式控件 + 覆盖与恢复交互。
T5 客户端半：值读取、自定义渲染组件挂载、订阅刷新（声明式项不上行同步）。
T6 回收对账 + 降级路径 + 一个示范消费插件（端到端验收）。

验收判据（每条都要实测）：

1. 会话 A 改值后，宿主半消费方在会话 A 读到新值；会话 B 仍读到默认值。
2. 切走再切回会话 A，值仍在；DSH 重启后仍在。
3. 点「恢复默认」后，磁盘上的覆盖键消失，读回默认值。
4. 未过 fence 的请求被 403 拒绝；页面在只读态显示错误条。
5. 人工删掉一个会话后，对账把该记录清掉；归档的会话不被清。

## 10. 待确认项

1. 已确认：声明式项只由消费插件的宿主半注册；客户端半只挂自定义渲染组件与读取值。（原第 2 条随之解决：不需要客户端注册项上行同步。）
3. 页面变更推送：第一版只做「写入后回读 + 聚焦刷新」，还是直接上 WebSocket。
4. 域名 session_settings、version 1 是否接受（storages 根跨 profile 共享，但按 sessionId 分键不冲突）。
5. 控件集合 switch / text / number / select / stringList 是否够用。
6. 恢复粒度三档（单项 / 整插件 / 整会话）是否都要。
7. 是否额外在 DSH 官方设置页留一个只读入口（此前悬而未决）。
8. 第一批任务是否包含一个示范消费插件（用于端到端验收）。
9. 命名与目录确认：包名 dsh-session-settings、服务名 sessionSettings、tab 的 id 与 kind session-settings、目录 D:/projects/dsh-plugins/dsh-session-settings。
