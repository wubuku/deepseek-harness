# Browser-Native DSH 权限与审批生命周期验证进度

## 状态

本批实现和 Chrome 验证完成，结论为 `complete-with-limitations`。正式权限服务已在 Dedicated Worker 中加载；三种权限预设、实际文件工具结果、审批拒绝、Full access 风险确认、Session 权限事件和真实模型普通 smoke 已观察到。`allowed-once`、answerer 取消/超时、无 answerer 独立矩阵以及 Worker 强杀后的权限专门恢复仍未验证。

## 版本与范围

- 分支：`research`
- 当前基线：本批开始时的 `research` checkout；工作区干净且只有主 worktree。
- 目标浏览器：Chrome；Safari/WebKit 本批暂停。
- 模型：故障和审批时序使用 scripted LLM；完成后至少运行一次真实 LLM 短 smoke。
- 正式包：只复用当前 checkout 中的 `dsh-permission-presets`、`dsh-user-approval`、`dsh-sandbox-policy`，不修改其源码。

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | Worker 依赖闭包和正式权限 service 探针 | 完成 |
| M1 | 三种模式、审批拒绝与 Session 事件闭环 | 完成；`allowed-once` 等路径未覆盖 |
| M2 | 模式切换、Full access 风险确认和 fail-closed 参数拒绝 | 完成；强杀后权限恢复未覆盖 |
| M3 | Chrome scripted E2E、真实 LLM smoke、文档和门禁 | 完成 |

## 命令与证据

本文件只登记本批实际执行的命令和结果。未执行的检查保持未执行，不以既有批次结果代替本批证据。

| 命令 | 结果 |
|---|---|
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；重建 Worker、preview 和 profile VFS image。保留 native package 的平台 warning 与 Vite 大 chunk warning。 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过。 |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_DATA_DIR=<temporary> node tests/permission-approval-lifecycle.e2e.mjs` | 通过；Chrome `156.0.8078.48`，三种 preset，`permissionEventCount=10`，10 次 scripted LLM request，页面/Worker error 为 0，跨源请求为 0。 |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node tests/browser-native-v2.e2e.mjs` | 通过；真实 `gpt-5.6-sol` 完成 3 turns、5 次 HTTP 200、`eventCount=41`、`durableThroughSeq=40`、多轮记忆和 todo 持久化。页面记录已有 `/open-in-app/apps` 404，不影响本闭环。凭据未打印。 |

权限 E2E 的证据不是只看 assistant marker：它从 `tool/result.data.message.isError`、实际 VFS 文件、`approval/asked`/`approval/decided`、权限快照和 Session 事件共同断言。此前脚本只检查顶层 `isError`，并把旧 Session marker 误用于新 turn；本批修复了测试 responder 的错误字段读取和当前 prompt 选择。审批工具参数还补充了正式 DSH 要求的 `justification`，否则请求会在审批服务之前 fail closed。

## 阻塞与限制

当前没有阻塞。真实模型只作为正常 `workspace-write` Browser-Native smoke；它不证明真实模型会自主选择权限预设、触发审批或处理拒绝。`allowed-once`、取消、超时、无 answerer、跨标签/跨设备授权、生产认证和 Worker 强杀后专门恢复尚未验证。`danger-full-access` 仅改变 Worker 内 DSH VFS/工具策略和审批配置，不代表宿主机、Node、子进程或页面关闭后的后台权限。

## 下一步

若继续本主题，优先增加 `allowed-once`、answerer cancel/timeout/unavailable 与 Worker terminate 后 Session replay 的确定性 Chrome 矩阵；不要把本批的 scripted 结果升级为生产授权或 exactly-once 审批结论。
