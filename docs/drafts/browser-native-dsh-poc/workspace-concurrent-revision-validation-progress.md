---
description: "记录 Browser-Native Workspace 并发 revision 验证的实际进度、命令、结果和限制。"
---

# Browser-Native Workspace 并发 revision 验证进度

## 当前状态

状态：本批实现、测试、Chrome 验收、真实 LLM smoke 和文档门禁均完成。基线为 2026-10-28 与 `origin/research` 同步的 `research` 分支；起始工作区干净且只有主 worktree。浏览器目标为 Chrome，Safari/WebKit 暂停。验收范围见[验证计划](workspace-concurrent-revision-validation-plan.md)。

## 里程碑

| 里程碑 | 状态 | 结果/证据 | 下一步 |
|---|---|---|---|
| M0：源码与基线核对 | `passed` | 核实 observer 仅在工具开始前读取完整 manifest revision；读、搜索和 OPFS copy-on-write edit 可在异步执行中跨越远端更新。现有 backend `sendJson()` 提供 `Cache-Control: no-store`，Workspace manifest 与 writer lease 均按 PoC principal 校验。 | 已进入 revision API 与工具时序改造。 |
| M1：revision 传输核算 | `passed` | 新增 `GET /api/browser-native/workspace/revision`，响应只含 `protocolVersion`、`workspaceId`、`revision`。backend 测试比较 1,000 个目录项的 manifest 与 revision JSON，断言 revision 响应小至少 100 倍；同时验证空 revision、无缓存、未认证、跨身份和协议版本拒绝。 | 用 revision-only route 替代 observer 的完整 manifest 下载。 |
| M2：Observer 读取一致性 | `passed` | 当前 observer 开放的 `read`、`grep`、`glob` 在成功后再次读取权威 revision；变化或完成检查失败时结果不会返回给 DSH，Workspace 转为 `stale` 并撤销文件工具。较早的并发预检响应在其他调用标记 stale 后也会被拒绝。当前 Browser profile 禁用 `read_image`，本批未扩大其 observer 能力。 | 通过真实双页面时序检查工具结果和后续模型请求。 |
| M3：真实 Chrome 读写竞态 | `passed` | `shared-workspace-observer.e2e.mjs` 在 observer 延迟 read 后让 owner 提交 revision 2。当前 read 以 stale 错误结算；owner 新内容未出现在 tool result 或后续模型输入；observer 工具被撤销，显式刷新后取得 fencing token 2。E2E 记录 4 次 revision 请求，每个 JSON 响应 87 字节，本机请求至响应头 0.11–0.50 ms；这是单次本地观察值，不是 SLA。共 12 个模型请求，最终 Workspace revision 3，0 页面错误、0 跨源请求。 |
| M4：OPFS 长编辑与 lease fencing | `passed` | Chrome E2E：旧 Worker 对 32 MiB OPFS 文件执行 chunk edit 并停在 `copy-prefix`；释放 token 1 后，新 Worker 以 token 2 读取同一路径并提交新内容。旧 edit 在 VFS 发布前因 lease 已释放而失败；Session 保留完整 tool-call 参数，单次显式错误结算且无 receipt/云端覆盖。尚未发布的 OPFS staging 被丢弃，刷新后需显式重试。最终 manifest revision 2，两个成功 commit，0 页面错误、0 跨源请求。另验证另一 Worker 占用 staging directory 时启动清理会保留目录并继续启动。 |
| M5：真实 LLM、回归、文档与交付 | `passed` | 最新真实 `gpt-5.6-sol` Chrome smoke 完成 `read → write → read` 与刷新后同一 Session/Workspace 恢复；59 个 Session event、`durableThroughSeq=58`、8/8 LLM HTTP 200、只有同源请求且无页面错误。Stop-edit、crash-edit Chrome E2E 分别通过（Stop-to-terminal 149 ms；Worker 中断后明确为 `interrupted`）。Workspace/file-tools/chunk-editor Vitest 35/35、backend tests 48/48、Web TypeScript、preview build、test:docs 21/21 和 doc-sync 43/43 均通过。预览构建有已有平台、tsdown 弃用和大 chunk 警告；真实 smoke 日志有非致命 compaction context-capacity warning，turn 仍正常完成。 | 按计划提交并推送 `research`，核实远端 ref、干净工作区和 worktree 列表。 |

## 已核对的基线

- `browser-native-workspace.ts` 为 observer 工具分别执行开始和完成 revision 查询；本次授权 revision 留在单个工具调用的局部变量中。
- `browser-native-providers.ts` 对 observer 开放的 `read`、`grep`、`glob` 成功结果执行完成校验；`read_image` 不属于当前 observer allowlist，当前 Browser profile 也禁用该工具。`edit` 在 OPFS staging 发布到 VFS 前重新确认 writer lease，lease 失效时不发布临时 edit 结果。
- backend revision route 与 manifest 使用相同 PoC principal 校验，并继承 `sendJson()` 的 `no-store` 缓存策略；1000-entry 响应大小差异由 backend contract test 覆盖。
- 新增 Chrome E2E 分别验证延迟 observer read 与 32 MiB OPFS edit；它们不改变 Session/Workspace 非原子关系，也不验证跨 backend lease。
- DSH-TUI 备忘建议维持多观察者、单写者、状态连续性和取消/销毁不确定语义；本批只把这些当作设计启发，不将 TUI 协议视为 Browser-Native 现成实现。

## 实际检查

| 命令或检查 | 结果 |
|---|---|
| `git status --short --branch`、`git worktree list --porcelain`、`git rev-parse HEAD`、`git rev-parse origin/research` | 起始状态干净；唯一 worktree 是主目录；本地 `research` 与 `origin/research` 同步。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts` | 35/35 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 48/48 通过。 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；有已存在的 unsupported native platform、tsdown/Vite 插件弃用和 Vite 大 chunk 警告。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs` | 真实 Chrome 双页面、两个 Session 通过；延迟读取遇到 owner commit 后 fail closed，旧内容未进入工具结果或后续模型输入，刷新接管正常。存在预期的 commit 503/lease 409 fault injection 与 preview 可选 route 404；无 page error 或跨源请求。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/workspace-lease-edit-race.e2e.mjs` | 真实 Chrome Worker/OPFS 通过；token 1→2，successor 产生 receipt 并提交 revision 2，旧 edit 无 VFS publish/receipt/远端覆盖。预览的可选 route 返回 404；无 page error 或跨源请求。 |
| `DSH_POC_BROWSER=chrome DSH_POC_TOOL_CANCELLATION_SCENARIO=stop-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs` | Chrome Stop 在 OPFS `copy-prefix` 阶段结束 turn 为 `aborted`，源文件和 revision 不变，同 Session 可继续；无 page error、Worker error 或跨源请求。 |
| `DSH_POC_BROWSER=chrome DSH_POC_TOOL_CANCELLATION_SCENARIO=crash-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs` | Chrome 终止编辑 Worker 后刷新将旧 turn 标为 `interrupted`，不自动重发旧模型请求，后续显式 turn 可继续；源文件和 Workspace revision 保持原值，无 page error、Worker error 或跨源请求。 |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ROSTER=browser DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 `gpt-5.6-sol` Chrome smoke 通过：`read → write → read`、59 个 Session events、`durableThroughSeq=58`、刷新后同一 Session 回忆和 Workspace 文件读取、8/8 LLM HTTP 200、仅同源模型请求且无页面错误。凭据由 backend 读取，没有打印或进入浏览器。日志出现非致命 `compaction-basic` context-capacity warning，turn 继续完成；刷新时中止的请求由页面导航触发。 |
| `pnpm run test:docs` | 21/21 文档 quick gates 通过。 |
| `pnpm run doc-sync` | 43/43 文档同步与网站检查通过。 |
| `pnpm --silent run change-scope --base origin/research` | 所有 16 个变更路径均位于 `docs/drafts/`；没有 staged 文件或已提交差异。 |
| `git diff --check` | 通过。 |
| `docs/drafts/browser-native-dsh-poc/tests/workspace-lease-edit-race.e2e.mjs` 初始 scripted 调试 | 两次 harness 失败分别暴露缺少 DSH read-before-write 前置调用，以及 `read.offset` 使用 0 而非 1-based 正整数；修正 scripted 场景后最终 E2E 通过。这些不是生产代码故障。 |

## 限制

本批验证只覆盖同一 Chrome BrowserContext、两个页面、两个 Session 和单一 PoC backend。开始与完成 revision 相同，表示只读工具可线性化在该 revision 检查点；它不提供跨工具/跨 Session 原子快照，也不锁住完成检查后的 backend 更新。writer lease 检查发生在 edit staging publish 前，但 VFS、Workspace 和 Session 仍没有跨存储原子事务。lease 失效会丢弃尚未发布的临时 edit bytes；Session 保存 tool-call 参数，PoC 不自动重试。当前 observer allowlist 不含 `read_image`，也未测试专用真实图像模型调用。本批未验证多个 backend、跨设备身份、生产授权/对象存储、自然 eviction、OS crash、Safari/WebKit 或多 writer merge。真实 LLM smoke 只回归普通文件工作流，不是对抗竞态测试。
