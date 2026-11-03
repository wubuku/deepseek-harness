# 浏览器端工具能力矩阵与降级策略

本矩阵回答产品问题：`fs`、`shell`、`web`、`subagent`、`browser-use` 在 Browser-Native Worker 里哪些可用、受什么限制、不可用时模型看到什么。原则来自[工具清单与配置裁剪调研](browser-native-tool-roster-and-configuration-research.md)：不属于该执行位置的能力必须在模型请求前裁掉，而不是注册后再返回“命令找不到”。

## 矩阵

| 能力 | Worker 可用性 | 模型可见 | 限制 | 不可用或失败时的降级 | 证据 |
|---|---|---|---|---|---|
| `fs`（read/write/edit/glob/grep） | 可用，操作 Worker VFS | 是 | 只允许 `/dsh/home` 下的路径；`read_image` 因未声明图像 modality 不注册；grep 对二进制文件返回 `SEARCH_BINARY_FILE`，非法正则返回 `SEARCH_INVALID_PATTERN` | 越界路径由路径策略拒绝；文件不存在返回工具错误，模型可改路径或结束 | [文件工具边界](tests/browser-native-file-tools.e2e.mjs)、[工具能力矩阵 E2E](tests/tool-capability-matrix.e2e.mjs) |
| `shell`（bash） | 仅产品 profile（`browser-native-profile`）可用；验证 roster 不注册 | 产品 profile 是，验证 roster 否 | 固定命令表就是 Worker 的 `/bin`；无宿主二进制、无 Node 脚本、无后台进程、无网络；支持管道与重定向，只写 VFS | 未列出的命令返回 `command not found` 且不产生 Workspace commit；验证 roster 中调用 `bash` 得到 `unknown tool "bash"` | [默认 profile 能力](tests/default-profile-capabilities.e2e.mjs)、[工具能力矩阵 E2E](tests/tool-capability-matrix.e2e.mjs) |
| `web`（search/fetch） | 不可用 | 否 | 没有 Worker 内 provider；`tool-web` 不在任何 Browser preset 中 | 模型请求不含 `web_search`/`web_fetch`；异常兜底为 `unknown tool`，不是“网络超时” | [工具能力矩阵 E2E](tests/tool-capability-matrix.e2e.mjs) |
| `subagent` | 仅 `browser-subagent` 验证 roster 可用 | 该 roster 是；其余 roster 否 | `spawn` provider、`maxDepth: 1`；嵌套 subagent 被拒绝；子 Agent 共享 Worker 文件与 Session backend | 未在该 roster 时不出现在 schema；超出深度返回工具错误并保留父 turn | [In-Worker subagent](tests/in-worker-subagent.e2e.mjs)、[子 Agent 停止传播](tests/real-subagent-cancel.e2e.mjs) |
| `browser-use` | 不可用 | 否 | 该能力需要 Node/Chromium/MCP 主体操作另一个浏览器；Worker 内没有 CDP、Playwright 或 MCP 连接 | 模型请求不含任何 `browser_*` 工具；不存在“退化为当前页面 DOM 操作”的隐式路径 | [工具能力矩阵 E2E](tests/tool-capability-matrix.e2e.mjs)、[工具清单调研](browser-native-tool-roster-and-configuration-research.md) |
| `memory` | 仅 `memory-isolation` 验证 roster 可用 | 仅该 roster | OPFS 文件按 `(workspaceId, sessionId)` 隔离；schema 不暴露 scope | 产品 profile 不注册；未发布时请求生成失败而不是静默跳过 | [Worker 内记忆](browser-native-memory.md) |
| `todo` / `working_directory` / `ask_user` | 可用 | 是 | todo 只写 Session；`working_directory` 只切 VFS 工作目录；`ask_user` 通过 Main Thread UI | 取消或超时由交互工具自己的错误结果表达 | [产品可见性](product-visibility.md)、[默认 profile 能力](tests/default-profile-capabilities.e2e.mjs) |

## 降级分类

DSH 对“工具不存在”和“工具执行失败”给出不同结果，矩阵按三种情况区分：

1. **能力不存在**：不在 preset 中注册。模型请求的 `tools` 数组没有该 schema；正常模型不会生成调用。
2. **异常兜底**：模型仍生成了未注册工具调用。执行管线返回 `unknown tool "<name>"`，`isError: true`，不执行、不写 Workspace；turn 继续，模型可解释限制或结束。
3. **能力存在但本次失败**：工具已注册，执行返回结构化错误（如 `SEARCH_INVALID_PATTERN`、`command not found`）；模型可重试、改参数或停止。

验证用脚本模型显式调用验证 roster 中不存在的 `bash`，得到第 2 类结果：

```json
{"result":"passed","browser":"chrome","roster":["edit","glob","grep","read","todo_write","working_directory","write"],"absentTool":{"name":"bash","isError":true,"result":"Error: unknown tool \"bash\""},"presentTool":{"name":"read","isError":false},"workspaceCommitsFromAbsentCall":0,"pageErrors":[]}
```

同一轮里 `read` 读回 `/dsh/home/browser-validation/input.txt` 的 `VFS_INPUT_READY`，证明文件工具在 Worker 内真实可用；`workspaceCommitsFromAbsentCall` 为 0，证明未注册工具不会产生副作用。

## 产品可用性结论

- **文件类工作流可以完整支持**：读、写、编辑、搜索都在 Worker VFS 内执行，刷新与导出走既有 Workspace/Session 通道。
- **shell 只能作为受限计算器**：固定命令表能完成文本处理和 VFS 内重定向，不适合编译、安装依赖、访问网络或长期进程。
- **web 与 browser-use 必须更换执行位置**：需要实时网页数据或页面自动化时，应提供同源 backend capability 或把任务交给 Host/Chromium 侧 Agent，而不是在 Worker 里恢复 Node provider。
- **subagent 是实验能力**：只在专用 roster 验证到 `maxDepth: 1` 的派生与取消，未进入产品 profile，也没有多轮子 Agent 的成本与配额结论。
- **降级必须显式**：矩阵中每一行的“不可用”都表现为 schema 缺失；唯一的运行时兜底是 `unknown tool`，不会伪装成超时或权限错误。

## 验证

```sh
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/tool-capability-matrix.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/in-worker-subagent.e2e.mjs
```

## 缺口

- 矩阵的“不可用”来自 schema 缺失与代码位置，不是负面能力协商；没有运行时 capability manifest 可供 UI 展示。
- `shell` 只验证了 `printf`、管道、重定向和 unsupported command 的负向路径，没有系统枚举命令表覆盖度。
- `subagent` 只有 `spawn` + `maxDepth: 1` 的 Chrome 验证，没有并发多个子 Agent、配额、失败重试与跨浏览器结论。
- `browser-use` 的不可用结论基于 Worker 没有 CDP/Playwright 主体；若要提供页面能力，需要新的 Main Thread bridge 设计，而不是复用该包。
- 没有真实模型在“缺少能力”场景下的产品文案快照；脚本模型只验证了执行管线分类。
