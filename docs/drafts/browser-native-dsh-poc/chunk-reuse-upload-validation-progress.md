---
description: "记录 Browser-Native Workspace 分块复用上传的实施、真实验证和限制。"
---

# Workspace 分块复用上传实施进度

## 基线与范围

在主工作区 `research` 实施，开始时与远端同步且工作区干净，无隔离 worktree。规划见[验证计划](chunk-reuse-upload-validation-plan.md)。本批仅修改 docs-owned PoC，不改变正式 Agent Loop 或 Session 格式；Chrome 为浏览器目标，Safari 暂停。

## 里程碑

| 阶段 | 状态 | 证据 |
|---|---|---|
| M0：现状核查与规划 | 完成 | 现有 upload 为完整文件分块上传；标准 external edit 已有 copy-on-write，不能把 VFS residentBytes 当作总内存。 |
| M1：复用协议与客户端接线 | 完成 | `reuse` plan 先持久化；复用来源必须是该 principal 的当前 manifest entry；upload chunk metadata 以 `null` 持久表示洞；重试沿稳定 operationId/hash 续传。 |
| M2：恢复与完整性单测 | 完成 | backend 56/56、Workspace/chunk-editor/durable-store Vitest 44/44；覆盖非顺序块、损坏 staging、重启、跨身份拒绝、来源 blob GC、错误整体 hash 和 upload response 重放。 |
| M3：Chrome 标准工具成本 | 完成 | 64 MiB 标准 edit 上行 1 MiB；4×16 MiB 工作集的单文件 edit 上行 1 MiB；commit unknown 与 reuse-response-loss 后刷新及 backend 重启均恢复。禁用复用的负对照如预期在 12 MiB 上行断言失败。 |
| M4：真实 LLM、文档、提交与推送 | 验证完成 | 真实 `gpt-5.6-sol` 普通文件 read/write/read、Session 记忆和刷新恢复通过；`test:docs` 21/21、`doc-sync` 43/43、Markdown wrap/link、preview 和类型检查通过。最终提交/推送状态以 Git branch 和 remote ref 为准。 |

## 实际验证

| 场景 | 结果 |
|---|---|
| Backend upload/reuse | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 56/56。非顺序缺块在 JSON 持久化后以 `null` 保留；损坏分块重新报告 missing；reuse plan 在来源当前 manifest 授权内固定；同 Workspace 不可达 blob、跨 Workspace 来源、变化 plan、冲突 chunk、损坏来源和错误全文件 hash 均拒绝。复用写入 staging 后即使来源被删除并 GC，upload 仍可完成。 |
| Workspace client | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts` 44/44。失去 reuse 响应后，不触发 Workspace commit；retry 保留 upload operationId 和 chunk hashes，只 PUT 一个变化块，再提交一次正确的完整文件 hash。 |
| Chrome 64 MiB 标准 `edit` | `DSH_POC_OPFS_ENVELOPE_SCENARIO=64m` 真实 Chrome Worker/DSH Host 经 `read → edit → read` 后刷新同 Session `read` 成功。63 个 1 MiB 块从已提交同路径版本复用，只有 chunk 0 上行：64 MiB 降至 1 MiB（98.4375% 上行减少）；复用报告为来源完整 hash 校验读取 64 MiB、逐块比较读取 64 MiB、staging 复制 63 MiB，reuse route 约 1.50 s。最终完整 blob SHA-256 与 manifest 一致，revision 只增加一次，Session 只有一个 edit receipt，页面/Worker error 和跨源请求为零。 |
| Chrome 4×16 MiB 工作集 | `DSH_POC_OPFS_ENVELOPE_SCENARIO=workset` 通过；单文件等长编辑上行 1 MiB、同路径 15 MiB 块复用，其他三文件 hash 不变。刷新后逐项 hash 和 manifest revision 一致。 |
| 复用响应丢失 | `DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 DSH_POC_EXTERNAL_EDIT_CRASH_STAGE=reuse` 通过。服务端复用 63 个块后浏览器 Worker 被终止、backend 使用同一 dataDir 重启；刷新从稳定 upload 状态补传变化 chunk，完整文件提交一次。DSH edit call 一条，receipt 一条，以 `TOOL_OUTCOME_UNKNOWN` 结算；没有重发 LLM prompt 或执行原 edit。最终 64 MiB blob hash 正确，revision 为 2。 |
| commit 响应丢失 | 64 MiB edit 提交后丢弃响应、终止 Worker、重启 backend 并刷新通过。同 operationId 重试只产生一个新 Workspace revision、一条 DSH edit call 和一条 receipt；只上行一个 1 MiB chunk。 |
| 负对照 | 设置 `DSH_POC_DISABLE_CHUNK_REUSE=1` 后，12 MiB Chrome 场景在“只上行一个 1 MiB chunk”断言处以实际 12,582,912 bytes 失败。该命令失败是预期控制结果，证明流量断言能识别退回完整文件上传。 |
| 真实 LLM | `DSH_POC_LLM=real`、Chrome、`original` roster 和 backend-only `docs/drafts/.env` 通过普通文件 `read → write → read`、多轮 Session memory 与刷新恢复；`gpt-5.6-sol`，60 Session events、`durableThroughSeq=59`、8 个 LLM HTTP 200、2 次 Workspace commit，无页面异常，模型请求只发往同源 backend。出现非致命 context-capacity warning、可选 preview API 404 和刷新中止请求；未影响闭环。本测试不宣称模型自主操作 64 MiB 文件。 |
| Preview/类型/文档 | preview build、`pnpm exec tsc --noEmit -p apps/web/tsconfig.json`、`pnpm run verify-md-wrap`（2,210 文件）、`pnpm run verify-md-links`（2,173 文件）通过；`test:docs` 21/21、`doc-sync` 43/43 通过。全仓 `pnpm run lint` 被未修改文件中的三个错误阻断，详情见下文。 |

实际 Chrome 输出、脱敏模型日志、复用负对照日志和临时验收截图保存在 `/tmp/dsh-chunk-reuse-validation-AZNNZj/`，不进入 Git。真实模型密钥只由 backend 从 `docs/drafts/.env` 读取，未输出或复制到浏览器。

本批执行的主要命令：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts
pnpm exec tsc --noEmit -p apps/web/tsconfig.json
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=64m node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=workset node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 DSH_POC_EXTERNAL_EDIT_CRASH_STAGE=reuse node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
pnpm run test:docs
pnpm run doc-sync
pnpm run verify-md-wrap
pnpm run verify-md-links
pnpm run lint
```

## 用户验收服务

- URL：`http://127.0.0.1:57843/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`；Chrome 页面已加载、Workspace `synced` 且 composer 可见。
- worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness`，分支 `research`；没有隔离 worktree。
- 服务 PID：`62098`；停止命令：`kill -TERM 62098`。
- backend 数据目录：`/tmp/dsh-chunk-reuse-validation-AZNNZj/acceptance-data`；日志：`/tmp/dsh-chunk-reuse-validation-AZNNZj/acceptance-server.log`；启动记录：`/tmp/dsh-chunk-reuse-validation-AZNNZj/acceptance.json`；截图：`/tmp/dsh-chunk-reuse-validation-AZNNZj/acceptance-chrome.png`。
- 服务由独立的原始 `original` overlay 和真实模型 backend 启动；backend 只从 `docs/drafts/.env` 读取密钥，数据和日志留在本机临时目录。

## 发现与下一步

固定偏移复用显著降低网络上行，但有明确的计算/存储交换：本机 64 MiB 样本读取来源两遍（完整 SHA-256 校验加逐块比较），复制 63 MiB 到 upload staging，最后仍组装完整 blob；这不是总 I/O 改善、内容定义分块、byte delta 或块级对象存储。文件头插入会使大量后续偏移块不匹配；不要承诺任意编辑都只传变化字节。

服务端与 Worker 协议必须一起部署；旧 backend 不认识 `/reuse` 时，新的 Worker 不会默默退回完整上传。当前证据来自单进程本地 PoC backend 和 Chrome，不代表生产对象存储、多实例一致性或跨设备能力。

下一项高价值验证候选是比较固定偏移与 content-defined chunking 在编辑插入/删除、真实源码/文本文件、多文件重复内容下的上行、客户端 hash CPU、服务端读取/写入与索引空间成本。只有 benchmark 说明固定偏移不足且净收益覆盖索引复杂度时，才实现内容定义分块；不要仅凭 append 友好情形外推。

`pnpm run lint` 未通过：`packages/core/tools/tests/json-schema.spec.ts:251` 的 unbound method，`apps/web/src/browser-native-recovery.ts:62` 的 unsafe assignment 和 `:252` 的 unnecessary condition；另有 `packages/experimental/client-ui-cot-translation/src/index.ts:82` 的 unused disable warning。本批未改这些文件，未将全仓 lint 记为通过。
