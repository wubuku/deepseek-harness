# Browser-Native DSH 权限与审批生命周期验证规划

## 目标

本批验证 Browser Worker 中的 DSH 权限预设、沙箱模式、审批策略和 Session 恢复是否仍由正式 DSH 服务共同决定。重点不是增加一个“YOLO”开关，而是证明权限选择、工具执行、审批结果和刷新恢复不会形成第二套事实源。

## 背景与依据

正式 `dsh-permission-presets` 把 `read-only`、`workspace-write`、`danger-full-access` 映射到沙箱模式和审批策略；`dsh-user-approval` 对 `ask`、`never`、`allowed-once`、`rejected`、`cancelled`、`unavailable` 定义了可回放的 Session 事件。当前 Browser-Native profile 的 Worker 镜像已经包含这些包，但 PoC 尚未证明它们在 Worker 中可加载、可观察并与浏览器 Workspace writer/capability publication 一致。

## 候选范围

| 候选点 | 价值 | 本批决定 |
|---|---|---|
| 正式权限包在 Worker 镜像中的加载与 service 注入 | 发现依赖闭包和启动失败 | 纳入 |
| 三种权限模式的实际 VFS 工具行为 | 区分只读、工作区写入和全权限，不把 UI 选项当能力 | 纳入 |
| `ask` 审批的 allow/reject/cancel/unavailable | 验证 fail-closed 与 Session 审计 | 纳入 |
| `never`/YOLO 的显式选择与恢复 | 防止模型或刷新隐式升级权限 | 纳入 |
| 运行中模式切换 | 验证只影响后续工具调用 | 纳入 |
| 刷新、Worker 强杀后的权限重建 | 证明状态来自 Session replay | 纳入 |
| 跨设备账号撤销、生产认证、多实例审批投递 | 需要产品身份与部署协议 | 延后 |
| 恶意同源脚本绕过页面控件 | 需要独立浏览器安全模型 | 延后 |
| OS 级崩溃和自然 eviction 后的授权恢复 | 由存储/崩溃实验批次负责 | 延后 |

## 实施设计

1. 在 PoC 的静态模块表中加入一个只读 permission probe。probe 只回读当前 Session 的 `permissionPresets.current()`、`sandboxPolicy.resolve()`、审批策略和目录，不改变权限，也不绕过正式 setter。
2. 在 Worker test channel 增加 `permission-state` 请求，返回经过边界验证的权限快照；它只用于测试证据，不进入模型工具目录。
3. 使用现有预览页面的 Access mode 控件和正式 `/permission` 路径选择模式。测试从 Session 事件、实际文件结果、`approval/asked`/`approval/decided` 和 Workspace manifest 同时判断，不以 Agent 文本作为唯一证据。
4. 使用确定性 scripted LLM 覆盖审批等待、允许一次、拒绝、取消、无 answerer 和 `never` 自动拒绝。取消和刷新不得重放原工具调用或扩大权限。
5. 使用真实 Chrome 验证 Worker、Web UI、OPFS/IndexedDB、Session backend 的组合；使用真实 LLM 只做默认 `workspace-write` 的一次短 smoke，不把模型不稳定误报为权限故障证据。

本批的确定性审批验收选择 `ask` 下的拒绝路径和无 justification 的参数拒绝路径；普通 `workspace-write` 写入覆盖允许路径，`danger-full-access` 覆盖显式风险确认和 `never` 无审批路径。`allowed-once`、超时取消和无 answerer 的独立矩阵保留为后续审批专题，不因本批未覆盖而写成已验证。

## 通过标准

- Worker 启动能加载正式权限服务；权限快照和 Session 投影一致。
- `read-only` 不产生 Workspace 写入；`workspace-write` 只写授权 Workspace；`danger-full-access` 只扩大 Worker VFS 权限，不获得宿主机、Node、子进程或后台 Agent 能力。
- `ask` 没有 answerer、answerer 抛错或取消时均不执行被保护副作用；只有 `allowed-once` 才允许当前调用。
- `never` 只由用户明确选择或已持久化的同一 Session 状态产生，且审批请求自动得到 `rejected`；刷新不会把其他 Session 的权限带入。
- 模式切换记录在同一 Session；当前工具调用使用开始时的权限，后续调用读取最新权限。
- Worker 强杀/刷新后从 Session 事件恢复权限；不恢复已终止的审批 Promise，不重复 prompt、tool call 或副作用。

本批只将 Worker test channel 的只读权限快照和同一 Session 的模式切换作为恢复前置证据；未新增 Worker 强杀后恢复权限的独立 E2E，因此该项仍属于后续验收，不计入本批通过范围。

## 非目标

本批不把 Browser-Native Worker 变成宿主机 sandbox，不实现任意“跳过审批”的隐藏参数，不修改正式权限包，不证明生产认证、多租户授权、跨主机 fencing 或页面关闭后的后台执行。
