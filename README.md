# dsh-session-settings

Per-session settings infrastructure for DeepSeek Harness.

- **Host half** owns the per-session configuration truth and exposes the `sessionSettings` service
  (register / get / set / reset / subscribe). Declarative items are registered from consumer host halves.
- **Browser half** registers one native right-sidebar tab (id and kind: `session-settings`) that renders
  every registered plugin's options for the session the tab belongs to.
- Overrides are stored per session through the official storage domain
  (`<DSH_HOME>/storages/session_settings/`); nothing is written into session logs or the profile patch.

Design: [docs/design-v1.md](docs/design-v1.md).

Status: 可用（宿主服务 + 浏览器页面 + 存储 + 桥接 + 界面）。依赖与升级对照见 [docs/dsh-dependencies.md](docs/dsh-dependencies.md)。
