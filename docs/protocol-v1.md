# dsh-session-settings 桥协议 v1（已冻结）

> 由 Lead 冻结。宿主半与客户端半必须严格按本文件实现；任何一方要改协议，先给 lead 发消息，不得自行改动实现与协议。
> 修订：v1.1（2026-10-13，Lead）—— §1 的状态码按「方法实际所需能力」判定，不是能力集合一刀切（见 §1 的能力表）。触发原因：reviewer-1 指出 sessionPersistence 缺失时的字面不一致。

## 1. 传输

- 载体：宿主半用 ctx.webServer.register 注册一条 kind=prefix 的路由，路径 /session-settings/api。
- 只接受 POST；其他方法返回 405。
- 方法名取自 pathname 去掉前缀后的剩余部分，必须用 Object.hasOwn 严格查表（防 constructor / toString 之类原型污染命中）。
- 请求体：JSON 对象。响应体统一为：

    成功  200  { ok: true,  value: <payload> }
    失败  4xx/5xx  { ok: false, error: { code: <string>, message: <string> } }

- 状态码映射：未过信任闸门 403；未知方法 404；非 POST 405；请求体不合法 400；写冲突 409；其他异常 500。
- 能力与状态码（v1.1：按**方法实际所需能力**判定，不是能力集合一刀切）：

    registrations.list        只需要进程内注册表 → 永远 200（存储不可用时页面仍要能渲染注册项与只读态）
    values.get/set/reset      需要可用的耐久存储（storageDomain 存在且 open 成功）→ 否则 503（code: storage-unavailable）
    sessionPersistence 缺失   不影响任何方法的状态码；只让后台对账被跳过（必须记日志），数据面照常
    webServer 不可用          插件不注册路由，不产生状态码
- 信任闸门：每个 handler 第一行执行。规则与官方 isTrustedApiRequest 一致（Host 必须是回环或命中 ctx.webRuntime.trustedHosts；sec-fetch-site: cross-site 拒绝；Origin 必须同 hostname，或等于桌面壳的 dsh-app://app）。官方包不导出该 helper，本插件自带一份实现，信任列表按请求现读 ctx.webRuntime.trustedHosts。
- 客户端调用自家前缀时不得硬写前导斜杠（反代子路径会丢前缀），必须走一个前缀安全的 URL 构造器。

## 2. 方法表（v1 只有四个）

### 2.1 registrations.list

    请求  {}
    响应  { registrations: SerializedRegistration[] }

    SerializedRegistration {
      pluginId: string
      title: string
      order?: number
      locale?: { zh?: Record<string,string>; en?: Record<string,string> }
      items: SerializedItem[]
    }

    SerializedItem {
      key: string
      type: 'switch' | 'text' | 'number' | 'select' | 'stringList'
      title: string
      description?: string
      default: unknown
      min?: number; max?: number; step?: number; unit?: string; placeholder?: string
      options?: { value: string|number|boolean; title: string; description?: string }[]
    }

    序列化规则：注册时 title/description 允许是字符串或函数；跨进程时函数在宿主侧求值一次，传输求值后的字符串。要跟随浏览器语言请用 locale 字典：客户端渲染时执行 dict[文本] ?? 文本。

### 2.2 values.get

    请求  { sessionId: string }
    响应  { sessionId, overrides: { [pluginId]: { [itemKey]: unknown } }, resolved: { [pluginId]: { [itemKey]: unknown } } }

    overrides 只含被改过且不同于默认值的项；resolved 是解析后的完整值（默认 + 覆盖）。

### 2.3 values.set

    请求  { sessionId: string, pluginId: string, itemKey: string, value: unknown }
    响应  与 values.get 相同的形状（写入后的最新状态）

    规则：写入值等于该项默认值时，删除该覆盖（稀疏）。未知 pluginId 或 itemKey 返回 400（code: unknown-plugin / unknown-item）。

### 2.4 values.reset

    请求  { sessionId: string, pluginId?: string, itemKey?: string }
    响应  与 values.get 相同的形状

    省略 pluginId = 清空该会话全部覆盖；给 pluginId 不给 itemKey = 该插件在本会话全部恢复；两个都给 = 单项恢复。

## 3. 宿主进程内服务 API（ctx.sessionSettings，宿主半）

    register(registration): () => void            // 声明式项只能由宿主半注册
    listRegistrations(): registration[]
    get(pluginId, sessionId): Record<string, unknown> | undefined
    getItem(pluginId, itemKey, sessionId): unknown
    set(pluginId, itemKey, sessionId, value): Promise<void>
    reset(pluginId, sessionId, itemKey?): Promise<void>
    resetSession(sessionId): Promise<void>
    subscribe(listener): () => void

    变更通知 change：{ kind: 'registered' | 'unregistered' | 'values', pluginId?, sessionId?, itemKey? }

    实现可在此基础上提供附加方法（当前有 snapshot(sessionId) → { overrides, resolved } 与 storageStatus() → 耐久性状态），
    供桥与诊断使用；对消费方的承诺以本表为准，附加方法不承诺兼容。

## 4. 浏览器进程内服务 API（ctx.sessionSettings，客户端半）

    registerRenderer(pluginId, itemKey, Component): () => void
    getResolved(pluginId, sessionId): Promise<Record<string, unknown>>
    subscribe(listener): () => void

## 5. 存储记录（宿主半，官方 storageDomain）

- 域：session_settings，version 1，layout per-record，invalidRecords backup-and-skip，表 sessions，key = sessionId。
- 记录：{ sessionId, profile?, updatedAt, values: { [pluginId]: { [itemKey]: unknown } } }，values 只存覆盖。
- 写路径：table.update(sessionId, fn) 原子读改写；读取走 table.get。
- 清空：某插件 map 空 → 删该键；values 空 → table.delete(sessionId)。
- 对账：仅用 ctx.sessionPersistence.list() 得到现存会话集合做差集清理；禁止用 session/disposed 触发删除。

## 6. 错误码表

    forbidden            403  未过信任闸门
    method-not-allowed   405  非 POST
    unknown-method       404  方法名不在表内
    bad-request          400  请求体不合法 / 缺字段
    unknown-plugin       400  pluginId 未注册
    unknown-item         400  itemKey 不在该插件注册项内
    conflict             409  预留给将来的写栅栏（修订：当前实现没有任何触发路径，也不伪造 409；客户端文案保留）
    storage-unavailable  503  仅按 v1.1 §1 的能力表：需要耐久存储的方法（values.*）在 storageDomain 缺失/不可持久时返回；sessionPersistence 缺失不影响状态码
    internal             500  未预期异常
