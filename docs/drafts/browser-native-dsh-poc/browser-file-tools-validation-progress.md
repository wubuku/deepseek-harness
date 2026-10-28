# Browser-Native 文件工具可用性与载荷安全验证进度

## 当前状态

本批次实现并验证了 Browser Worker 内置的有界 `grep`/`glob` fallback、文件搜索和编辑载荷限制，以及取消 helper 后的后续工具可用性。规划开始时 `research` 与 `origin/research` 同步且工作区干净，当前 checkout 另有一份未纳入本批实现的 `dsh-browser-native-vfs-cli-fact-check.md` 草稿。上一批真实 Chrome 已验证 OPFS 外置文件的 `read → write → read`，本批补上了标准搜索工具对主机 ripgrep 依赖的 Browser-native 替代路径。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0 候选盘点和范围冻结 | 已完成 | 见 `browser-file-tools-validation-plan.md` |
| M1 标准 middleware 小实验 | 已完成 | `tools/execute` fallback 返回 canonical value，真实 DSH registry 继续执行 schema、render、post-execute 和 Session result；Chrome E2E 核对标准 tool call/result |
| M2 Worker-native grep 与边界 | 已完成 | 真实 Chrome 覆盖 include、path、JavaScript regex、无匹配、匹配上限、非法 regex、扫描边界和失败后继续；`glob` 共用 Worker VFS 遍历并覆盖结果 |
| M3 edit 载荷安全 | 已完成 | 超长目标行和大参数在写入前 fail closed；拒绝路径不产生 Workspace commit，后续同 Session turn 可继续 |
| M4 取消、背压和资源释放 | 已完成（模型无关） | 真实 Chrome Worker 取消慢搜索 helper，随后真实 DSH `grep` turn 成功；既有 `runtime-lifecycle.e2e.mjs` 继续承担 UI stop 的 canonical aborted 证据 |
| M5 Browser roster 真实 LLM 闭环 | 未宣称通过 | 本批 scripted tool selection 只验证确定性工具协议；真实 LLM 普通文件闭环是独立既有证据，没有把本批搜索选择写成真实模型能力 |
| M6 文档、门禁、提交和推送 | 已完成 | focused tests、preview build、类型检查和 `doc-sync` 均通过；本记录随本批提交并推送 |

## 工作记录

| 日期 | 命令或动作 | 结果 | 备注 |
|---|---|---|---|
| 2026-10-24 | `git status --short --branch`、`git log -1`、`git worktree list` | 通过 | `research` 与 `origin/research` 在本批开始时同步，仅主 worktree，工作区干净 |
| 2026-10-24 | 核对 `tool-fs-search`、`ToolRuntime`、Worker VFS 和 Browser provider | 完成 | `tools/execute` 返回 canonical `value` 后仍进入标准 registry finalize/post-execute 流程 |
| 2026-10-24 | 新增 `browser-native-file-tools.ts`、Worker provider fallback 和边界测试 | 完成 | `grep`/`glob` 不再依赖 Worker 中不存在的 ripgrep 子进程；搜索、编辑和路径均有 PoC 上限 |
| 2026-10-24 | `DSH_POC_BROWSER=chrome ... browser-native-file-tools-cancel.e2e.mjs` | 通过 | 真实 Chrome Worker 取消慢搜索，随后真实 DSH `grep` turn 完成；无 page error、Worker error 或跨源请求 |
| 2026-10-24 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts` | 通过 | 4/4 helper tests |
| 2026-10-24 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 通过 | 17/17 backend contract tests |
| 2026-10-24 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 通过 | 23/23 Workspace/Durable Workspace tests |
| 2026-10-24 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过 | preview build 完成；仅有既有平台与 chunk size warning |
| 2026-10-24 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.e2e.mjs` | 通过 | 真实 Chrome `grep → grep` 边界调用、非法 regex、65,536-byte 行限制和失败后继续；无 page/Worker error 或跨源请求 |
| 2026-10-24 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools-cancel.e2e.mjs` | 通过 | 真实 Chrome Worker cancellation 后继续 DSH turn；无 page/Worker error 或跨源请求 |
| 2026-10-24 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs` | 通过 | 12 MiB OPFS-backed `read → grep → edit → read`、两次 Workspace commit、刷新恢复和有界载荷均通过 |
| 2026-10-24 | `pnpm run typecheck` | 通过 | 5/5 typecheck gates |
| 2026-10-24 | `pnpm run doc-sync` | 通过 | 43/43 documentation gates |
| 2026-10-24 | `git diff --check`、`git worktree list` | 通过 | 无 whitespace error；仅主 worktree，提交前未创建隔离 worktree |

## 证据约束

Browser-native `grep`/`glob` 现在仅能写入“有界 fallback 已在真实 Chrome Worker 验证”的列表，不能写成完整 ripgrep、任意容量搜索或生产工具兼容。真实 Browser roster 的模型能力仍未由本批证明；scripted LLM 只能证明确定性状态机、故障注入和 Worker 生命周期，不证明模型自主选择工具。当前标准 `edit` 已接入 OPFS copy-on-write，后续[资源包络进度](opfs-standard-tool-envelope-validation-progress.md)记录 64 MiB 验收；它仍不提供块级云端 delta。
