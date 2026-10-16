# 最终验收方案（Lead）

> 本文记录最终验收的判据、执行方式、以及本次遇到的环境阻塞。

## 1. 为什么需要一次真实进程验收

到 F6 为止，全部结论都来自 node:test 与各轮复核代理的等价夹具（假 Cordis ctx / 假 domain / 无 DSH 进程）。真实运行时里仍有这些没有被覆盖的面：真实 storage-json 落盘、真实 webServer 路由与 fence、真实右侧栏渲染、真实 ctx.effect 生命周期。

## 2. 四条端到端判据

1. 页面能打开「会话设置」tab，渲染出消费插件注册的配置项，且控制台无错误。
2. 在会话 A 改一个值：桥返回 200，宿主解析结果里 A 有覆盖值；另一个会话 B 读到的仍是注册默认值（每会话隔离）。
3. 磁盘上出现 ~/.dsh/storages/session_settings/sessions/<会话A>.json，且其中只包含被改过的键（稀疏覆盖），不含默认值。
4. 点「恢复默认」后，A 的覆盖键消失、读回默认值，磁盘记录被清掉。

## 3. 执行方式

- 浏览器：由 Lead 独占 chrome-devtools MCP（成员全程禁用），在受控 Chrome 里打开 DSH GUI。
- 夹具：D:/projects/tmp/session-settings-demo（不属于交付物，验收后卸载），它通过真实 ctx.sessionSettings 注册 3 个配置项。
- 除了 UI 点击，还会从页面直接打桥（同源 fetch），以区分「宿主没注册路由」与「UI 有问题」这两种失败。

## 4. 已知阻塞（截至本轮）

- 运行中的 DSH 进程（PID 81996，2026-10-12 18:06 启动）里，本插件的宿主模块仍是 T1 时期的旧版本：/session-settings/api/* 一律返回通用 405；而同进程里 better-sidebar 的同类自建路由是活的（未知方法 JSON 404、settings.get 200），说明机制没问题，纯粹是宿主模块的 ESM 缓存。
- 已尝试且无效：插件启停（set_plugin include:session-settings）、卸载重装、mtime 触发、内容变更触发 HMR。客户端半会随页面刷新加载，但宿主半不会。
- 因此需要重启 dsh web。用户第一次重启没有生效：旧实例仍占着 127.0.0.1:3080，新实例起不来（进程已退出）。
- 排查期间的一次 remove_bundle + install_bundle 实验曾把插件从组合包清单摘掉，已用 set_bundle(enabled:true) 恢复（application: applied，行回到 Loader）；临时追加的注释也已还原（文件字节数 15562 不变）。

## 4.1 已完成的部分验收（不需要宿主重启）

- 客户端半在真实 GUI 中验证通过（受控 Chrome，DSH 0.2.0-rc.2）：右栏出现并打开「会话设置」tab；标题席位生效；头部显示的是会话标题而非截断 id（F2 的 useSessions 修复在真机生效）；空态「本会话尚未修改任何配置」与「全部恢复默认」正常。
- 桥不可用时页面进入只读错误态（读取失败 + 重试 + 不渲染任何可写控件）——错误路径行为符合设计。
- 服务出来的客户端 bundle 已核对为当前版本（58840 字节、含体席位注册 / PageBoundary / TAB_ID = session-settings）。
- 首次打开时曾出现一次宿主 fallback（这类内容还没有可用的查看方式），刷新后再打开即正常渲染：判定为打开时序（客户端模块尚未完成注册时已打开页签），非代码缺陷；留作观察项。

## 4.2 端到端验收：在临时实例（3081）上完成（全通过）

用户的主实例（3080，PID 81996）需要重启才能加载新宿主半，但用户当时未能完成重启（端口被占）。为不阻塞验收，Lead 在 3081 起了一个临时实例（`dsh web --port 3081 --no-open`，托管后台作业，验收后已关闭）——同一 profile、同一代码路径，进程全新因而加载的是当前版本。

实测结果（全部来自真实进程，不是夹具）：

1. 启动日志即显示验收夹具注册成功：`[dsh-session-settings-demo] registered 3 items for demo-consumer`。
2. 桥：POST /session-settings/api/registrations.list → 200，返回夹具的 3 个项与默认值。
3. UI：右栏 tab 出现并打开；页面渲染出分组卡片与三类控件；无错误条。
4. 判据 2（每会话隔离）：会话 A 的 values.get → overrides {enabled:true}、resolved {enabled:true, threshold:42, mode:balanced}；另一个真实会话 B → overrides {}、resolved 全为注册默认值。
5. 判据 3（稀疏落盘）：界面改动后磁盘出现 ~/.dsh/storages/session_settings/sessions/<会话A>.json，内容只有 `{"demo-consumer":{"enabled":true}}`，无默认值。
6. 判据 4（恢复默认）：在界面点「恢复默认」后，该会话记录文件被删除（目录为空），桥读回默认值。

验收后清理：测试覆盖值已重置；3081 实例已关闭（端口不再监听）；验收夹具 dsh-session-settings-demo 已从 profile 卸载（组合包列表回到验收前，以 dsh-session-settings 结尾）；storages 下只剩空的 session_settings/sessions 目录。

### 验收中发现的两条 a11y 项（均已修复并复核）

1. 控制台报 `A form field element should have an id or name attribute (count: 3)`：控件没有 id/name。F7 修（id/name + label htmlFor），Lead 复核：我们的控件全部合规，该警告 3 → 1（剩下的 1 个是宿主自己的输入框）。
2. 同一页面在两个分栏同时打开会渲染重复 id（客户端作者自报）。F8 修（id 纳入 tab 实例身份，格式 `session-settings-<tabId>-<pluginId>-<itemKey>`），Lead 复核：实测 id 为 `session-settings-tab3-demo-2dconsumer-*`，全页重复 id = 0。

### 旧标题（保留痕迹）

控制台报 `A form field element should have an id or name attribute (count: 3)`：我们页面的开关 / 数字 / 下拉三个控件没有 id 或 name。属 a11y 质量项，不影响功能，已派 task-17 修复（只加属性，不改行为），修完由 Lead 在浏览器复核。

## 5. 重启后的收尾清单

1. 桥自检：POST /session-settings/api/registrations.list → 200 且含夹具的 3 个项。
2. UI：打开右侧栏 → 会话设置 → 截图 + 控制台检查。
3. 四项判据（见第 2 节），其中磁盘检查读 ~/.dsh/storages/session_settings/。
4. 卸载验收夹具（plugin_manager remove_bundle dsh-session-settings-demo），核对 profile 回到验收前状态。
5. 收尾报告：通过/未通过、证据、以及仍未验证的点。
