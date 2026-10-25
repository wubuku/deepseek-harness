---
description: "记录 OPFS 外置大文件经 DSH read、grep、edit、Workspace commit 和刷新恢复的实施证据。"
---

# OPFS 外置文件的 DSH 工具闭环进度

## 当前状态

状态：本批验证完成。开始时 `research` 与 `origin/research` 同步，工作区干净且仅有主 worktree。本记录只描述当前 checkout 的 PoC，不代表已发布能力。

| 验证面 | 状态 | 证据 | 限制 |
|---|---|---|---|
| 冷 hydrate 后由 DSH `read`、`grep` 访问大文件 | Chrome Worker 已执行（scripted 工具选择） | 真实 DSH Host 对 12 MiB 外置文件运行 `read → grep → edit → read`；`read` 仅返回目标行，Browser-native `grep` fallback 返回唯一 marker，Agent Loop 继续完成后续工具。 | fallback 不是完整 ripgrep 语法或任意容量搜索；本次没有验证真实模型会自行选择该序列。 |
| DSH `edit` materialize、Workspace commit 与 receipt | Chrome Worker 已执行（scripted 工具选择） | 编辑时 VFS `residentBytes` 从冷态约 34.5 MB 升至约 47.1 MB；仅有一个 edit receipt 和一次 Workspace commit，manifest 只包含目标文件，atomic-write staging 未进入 manifest。 | `edit` 会完整 materialize 文件，不是零拷贝或块级编辑。 |
| 编辑后刷新、cold hydrate 与同 Session 读取 | Chrome Worker 已执行（scripted 工具选择） | 刷新后 `residentBytes` 回到约 34.5 MB；相同 Session 的 DSH `read` 读到新 marker，未重放 edit、未增加 Workspace revision。manifest blob 的 SHA-256 与字节数一致。 | 仅验证单 Chrome、单文件和该 PoC backend。 |
| 文件内容不进入模型请求或 Session | Chrome Worker 已执行（scripted 工具选择） | 12 MiB 内容只经 Workspace blob 路径传输；最大观测 LLM request 约 13.1 KB、Session append 约 33.6 KB，Session 和模型请求不含文件重复内容。 | 这些值是本样本的观测值，不是协议上限或容量承诺。 |
| 真实模型、真实 DSH 工具和 Durable Workspace | Chrome + 真实 LLM 已执行 | `runtime-validation.e2e.mjs` 使用真实 `gpt-5.6-sol`、同源代理和 Browser-specific validation roster，完成 `read → write → read`；刷新后同一 Session 保留记忆，DSH `read` 从重启后的 Worker/VFS 找回文件。8 个 LLM 请求均 HTTP 200，Session 59 个事件全部 durable，Workspace 有两次成功 commit。 | 真实模型验收使用普通大小文件，不是本批 12 MiB 样本；不据此宣称模型能稳定执行本批完整 `read → grep → edit → read` 故事。 |

## 实施记录

- M0：确认 `research` 与 `origin/research` 同步，工作区干净，仅一个 worktree。
- M1：核对大文件传输、OPFS range backing、Agent edit receipt、Agent Loop 调度及 `tool-fs` 的 read/grep/edit 实现；选定冷 hydrate 大文件上的真实 DSH 工具路径作为本批重点。
- M2：新增 Worker 内 12 MiB UTF-8、多行文件生成能力和 backend scripted 工具序列。测试端口拒绝缺少 `lineBytes` 的 marker 请求，且在 VFS 写入前返回错误。脚本只固定工具选择，不模拟 DSH Host、工具执行、Session、Workspace 或浏览器存储。
- M3：真实 Chrome E2E 通过冷 hydrate 后的 `read → grep → edit → read`、提交暂停时 materialization 观测、单次 receipt、staging 过滤、载荷上限、刷新和同 Session 读取。两次 Workspace commit 包含初始 seed 和一次 Agent edit，最终 revision 为 2。
- M4：真实 Chrome/真实 LLM 独立复验 `read → write → read`、刷新后 Session 记忆与 DSH 文件读取。该测试证明真实模型闭环存在，但不替代 12 MiB scripted 工具序列的确定性验证。

## 实际验证

本批模型无关的大文件验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts \
  packages/experimental/webworker-runtime/tests/storage/tar.spec.ts
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
```

结果：preview build 通过；backend tests 17/17、Workspace/Durable Workspace Vitest 23/23、MemoryVfs/diff Vitest 34/34；12 MiB Chrome E2E 在补入 malformed marker 负向用例后通过，无页面错误、Worker 错误或跨源请求。初始驻留为 47,082,051 bytes，冷 hydrate 后为 34,493,823，edit materialize 时为 47,081,924，刷新恢复后回到 34,493,823；最大 LLM body 为 13,099 bytes，最大 Session append 为 33,574 bytes。测试脚本将大文件内容在 Worker 中生成，模型只接触有界工具参数和结果。

真实模型验收命令：

```sh
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 \
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
DSH_POC_TURN_TIMEOUT_MS=600000 \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

结果：真实 `gpt-5.6-sol`、真实 Chrome 和同源 LLM proxy 通过；真实 DSH 工具序列为 `read → write → read`，8 个 LLM HTTP 200，刷新后同一 Session 的文件读取成功，59 个 Session events 全部 durable，两个 Workspace commits 均 HTTP 200。页面无 `pageerror`，浏览器 LLM 请求只发往同源 backend，凭据未出现在浏览器请求。preview 缺少的 `/open-in-app/apps`、`/api/changes.summary` 和 `/api/present.host` 返回 404；测试按既有 PoC 行为允许这些请求，不能将其表述为所有 preview API 完整可用。

## 发现与未完成项

- Browser profile 原先暴露的 `grep` 依赖不可执行的 ripgrep 子进程；本批在 PoC provider 的 `tools/execute` 中加入有界 JavaScript fallback，并用真实 Chrome Worker 验证标准 `tool/call`/`tool/result`、匹配结果和失败后继续。它只覆盖 `/dsh/home/workspace`，使用 JavaScript regex 和有限 glob 语义，仍受扫描字节、文件数、匹配数和行长限制。
- `edit` 仍可能把外置文件完整读入 VFS。一个 10 MiB 单行文件的 edit 曾导致 Session 请求体超过 backend 上限，工具结果无法结算；当前 70 KiB 单行 chunk-backed edit 已通过，但 64 KiB 是搜索行上限而不是任意 edit 的容量保证。不能据此宣称任意超大单行可编辑。
- 本批的 12 MiB 文件由 scripted LLM 固定工具选择；真实模型 E2E 使用普通大小文件。没有真实模型选择 `grep`、对超大文件自主编辑或生成大型 tool arguments 的证据。
- 不覆盖真实模型自主选择 Browser-native 搜索、多文件工作集的 heap 峰值 SLA、二进制/非法 UTF-8/CRLF 的完整工具语义、自然 eviction、浏览器进程崩溃、Safari/WebKit、生产对象存储或多实例 backend。

## 下一步

下一步优先评估 Browser-native 搜索 fallback 的性能、Unicode/二进制语义和真实模型工具选择，再为大文件 `edit` 决定是否需要逐块编辑协议。保持“真实 LLM 一般工具闭环”和“scripted 大文件运行时语义”两类证据分开报告。
