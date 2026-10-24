---
description: "记录 Browser-Native DSH 文件工具下一批验证的实现、测试证据和未完成边界。"
---

# Browser-Native DSH 文件工具下一批验证进度

## 当前状态

本批次已完成实现和首轮验证。Browser Worker 的 `grep` 现在通过 `MemoryVfs.openFileSync().read()` 分块读取，目录遍历使用显式栈，`glob` 有独立结果上限，搜索 pattern 有大小和复杂度防护，非法 UTF-8/NUL 文件不会静默作为文本处理。PoC 仍不提供完整 ripgrep、完整正则复杂度保证或块级编辑。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0 候选盘点与范围冻结 | 已完成 | 见[验证计划](browser-file-tools-next-validation-plan.md)；不引入第三方 Shell/WASI runtime |
| M1 文件工具边界实现 | 已完成 | 显式栈遍历、glob 结果上限、pattern/brace 预算、正则防护、二进制拒绝和显式文件工具名称表已实现 |
| M2 分块搜索单测 | 已完成 | `browser-native-file-tools.spec.ts` 6/6；覆盖跨 64 KiB chunk 的 UTF-8 行、二进制、复杂 pattern、pattern 超限、glob overflow 和既有取消/编辑边界 |
| M3 真实 Chrome Worker 验收 | 已完成 | 文件边界、取消后续 turn、12 MiB OPFS 外置文件闭环均通过；无 page/Worker error 或跨源请求 |
| M4 真实 LLM 回归 | 已完成（普通文件闭环） | 真实 Chrome + 真实 `gpt-5.6-sol` 完成 `read → write → read`、刷新后同 Session read 和流式响应；不把它外推为真实模型会主动选择大文件 fallback |
| M5 文档、门禁、提交和推送 | 已完成 | 计划、进度、README、兼容矩阵、事实核查注解和 change ledger 已更新；针对性测试、真实 Chrome/LLM 回归、文档门禁和 typecheck 已执行 |

## 实际证据

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts` | 6/6 通过 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留既有平台与 chunk size warning |
| `DSH_POC_BROWSER=chrome ... node tests/browser-native-file-tools.e2e.mjs` | 通过；真实 Chrome `grep → invalid regex → binary grep`，错误码分别为 `SEARCH_INVALID_PATTERN`、`SEARCH_BINARY_FILE`，失败后 turn 继续 |
| `DSH_POC_BROWSER=chrome ... node tests/browser-native-file-tools-cancel.e2e.mjs` | 通过；真实 Worker 取消慢搜索，后续 DSH turn 成功 |
| `DSH_POC_BROWSER=chrome ... node tests/opfs-agent-file-tools.e2e.mjs` | 通过；12 MiB cold OPFS backing 上执行 `read → grep → edit → read`，刷新后继续读取，Workspace revision `2` |
| `DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node --use-env-proxy tests/runtime-validation.e2e.mjs` | 通过；真实 `gpt-5.6-sol`、Chrome、8 个 HTTP 200、57 个 Session events、`read → write → read`、刷新后 Session read 和可观察流式 text chunks；页面无 page error，预期的服务端 404/请求中止已由脚本记录 |
| `pnpm run lint` | 未通过；扫描在本批未修改的 `apps/web/src/browser-native-page-control.ts:404` 和 `packages/core/tools/tests/json-schema.spec.ts:251` 报既存错误，另有未使用 oxlint disable warning；本批文件工具与文档文件未被报告 |

真实 LLM 回归的 validation roster 包含 `read_image`，因此它证明的是该独立 validation roster 的普通文件闭环，不是 Browser profile 所有文件工具均已由模型自主选择。普通浏览器请求只访问同源地址，模型凭据只由 Node backend 从 `docs/drafts/.env` 读取。

## 首次失败与修正

第一次运行 `browser-native-file-tools.e2e.mjs` 失败：搜索 workspace 中的 `*.txt` 时，新的实现对一个不匹配的 70 KiB 长行提前返回 `SEARCH_LINE_TOO_LONG`。这把“命中的结果行上限”错误扩大成“所有输入行上限”，破坏了既有搜索行为。

修正后，搜索只在正则命中后检查 `MAX_MATCHED_LINE_BYTES`；不匹配的长行仍受整个调用的 `MAX_SEARCH_BYTES` 限制，不进入结果。修正后重新构建 preview，并重新运行文件边界、取消和 OPFS 三项 Chrome E2E，全部通过。

## 已实现的边界

- `grep` 不再先把所有文件路径放入数组，而是边遍历边计数、检查取消并读取文件。
- `grep` 通过同步 range read 和流式 UTF-8 decoder 处理跨 chunk 的多字节字符与换行。
- `glob` 超过 5,000 个结果返回 `SEARCH_RESULT_OVERFLOW`，不返回部分结果冒充完整结果。
- 搜索 pattern 和 `include` glob 最大 4 KiB；brace expansion 最大 128 个分支；反向引用和检测到的嵌套量词返回 `SEARCH_PATTERN_TOO_COMPLEX`。
- NUL 或非法 UTF-8 文件返回 `SEARCH_BINARY_FILE`；编辑同类文件返回 `EDIT_BINARY_FILE`。
- provider 使用 `browser-native-capabilities.ts` 的显式文件工具名称表，而不是在 waterfall 中重复内联名称数组。

## 未完成边界

JavaScript `RegExp` 的有限启发式检查不是形式化 ReDoS 保证；尚未引入 RE2/WASM 或独立搜索 Worker。`edit` 仍会完整 materialize 文件，搜索只证明读取路径可分块。完整 ripgrep 语义、任意容量文件、块级 delta、跨文件事务、自然 storage eviction、OS crash、生产对象存储、多实例 backend 和 Browser-specific 正式 preset 仍未验证。真实 LLM 回归没有证明模型会主动选择本批 fallback，也没有覆盖大型 tool arguments。

## 经验教训

VFS、结构化文件工具和 Shell/WASI runtime 必须分别验收。浏览器中最重要的不是让 `grep` 看起来像 Unix，而是让每个工具都拥有可取消、可限制、可解释的资源与错误语义。任何新增上限都必须测试“相关超限输入”和“无关超限输入”，否则安全边界可能变成不必要的功能回归。

## Dev Note

本文件记录当前 checkout 实际运行过的命令。只有真实模型脚本输出完整成功 JSON，才把真实 LLM 结果写为通过；scripted tool selection 只证明确定性协议和 Worker 执行路径。
