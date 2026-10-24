---
description: "记录 Browser-Native DSH Workspace 元数据校验、远端 blob 回收和断点上传生命周期验证进度。"
---

# Browser-Native DSH 持久化元数据与 blob 生命周期验证进度

## 当前状态

状态：M0-M4 已完成。本批在 `research` 主工作区实施，没有创建隔离 worktree。代码和结论属于当前 checkout 的 PoC，不是已发布能力或生产存储承诺。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：候选审查与基线 | `complete` | 选择 Workspace metadata 冷加载拒绝、远端 blob GC、未提交上传保护和 S3-compatible 对照；自然 eviction、多实例存储和生产云权限不纳入本批。 |
| M1：严格 metadata validator | `complete` | 冷启动校验 Workspace/identity schema、exact keys、UUID、manifest path/tree、file hash/bytes、operation receipt、pending hash/timestamp 和 writer epoch。未知字段、缺失父目录、错误引用和不一致 identity 在启动前拒绝；旧 Workspace 缺少 `uploadedAt` 时仍保守保留 pending hash。 |
| M2：blob store list/delete 与 Workspace GC | `complete` | 文件与 S3 adapter 支持列举/删除；GC 保留所有已加载 Workspace 的 manifest 引用及未过期 pending blob，立即回收无受保护引用的完成 blob。续传与清理共用 staging schema 校验；坏 staging 不可续传，只删除 metadata 可验证且已过期的目录，未知 metadata 保留并计数。操作 receipt 和 manifest revision 不因 GC 改变。 |
| M3：重试、重启和对象存储对照 | `complete` | 本地 backend contract tests 与 Chrome/MinIO E2E 通过；MinIO 对象 outage、已上传对象丢失、刷新重传、Range 读取、GC orphan 删除和 backend 重启读回均观察到预期结果。 |
| M4：回归、文档与交付 | `complete` | Backend/Workspace tests、Worker runtime typecheck、preview build、Chrome unknown-commit recovery、Chrome/MinIO E2E、`test:docs` 21/21、`doc-sync` 43/43 和 `git diff --check` 通过。 |

## 实现语义

- Metadata validator 只接受当前 version 1 的明确定义字段；旧的可选字段可缺省，但未知字段不会被投影丢弃后继续启动。
- Startup metadata 校验完成后才清除过期分块 staging，避免损坏 metadata 导致 backend 拒绝启动前先删除待恢复数据。
- GC 通过单 backend 进程的 `blob-lifecycle` lock 串行化上传、提交、列举、删除和 blob 读取；它不为共享 S3 bucket 的多个 backend 提供 fencing。
- GC 扫描所有已加载 Workspace，而不是只扫描调用方 Workspace；manifest 当前引用始终优先于 pending upload 到期时间。
- 新 pending upload 写入服务器时间戳。没有 timestamp 的旧 pending hash 永久保留，避免迁移时按猜测期限删除可恢复数据。
- 没有受保护引用的完成 blob 可立即回收；TTL 保护已登记的 pending hash，不是所有孤儿对象的最短保留期。
- Upload staging 只有在目录 ID、metadata schema、Workspace/operation/hash 对应关系和时间戳均有效后才按期限删除。缺失或损坏的 metadata 不会让 staging 被清理，GC 会返回 `preservedUnrecognizedUploads` 计数。
- S3 删除逐对象执行。MinIO 测试中的 `DeleteObjects` 不可用，因此 adapter 使用 `DeleteObject`；对象列表之外的 key 不会因 GC 被推断为可删除。

## 实际验证

环境：Node `v24.6.0`、Google Chrome `155.0.8059.85`、MinIO `RELEASE.2023-03-20T20-16-18Z`，镜像 ID `sha256:fb4e814a3183f5f7b193377fccda08504f3d9284466d6f5a41c84cfd031637f7`。

| 命令或实验 | 结果 |
|---|---|
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 21/21 通过。覆盖坏 metadata fail-closed、未知字段、非法路径/文件引用、pending timestamp 兼容、GC 保留/过期与 staging 清理。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 24/24 通过。 |
| `pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json` | 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留既有 native platform、tsdown deprecation 和 Vite 大 chunk warnings。 |
| `DSH_POC_BROWSER=chrome ... node docs/drafts/browser-native-dsh-poc/tests/workspace-s3-minio.e2e.mjs` | Chrome/MinIO 最终连续两次通过：2,097,189-byte 对象、1 MiB Range、orphan GC 删除、outage 503、backend 重启、manifest revision 2 恢复；刷新后重新上传缺失对象并恢复 revision 3。修复前一次 restart 失败显示 HTTP health readiness 早于认证 S3 API 可用；E2E 现轮询真实签名 `HeadBucket/CreateBucket` 成功后才启动 backend。浏览器未直连 MinIO，页面无错误。 |
| `DSH_POC_BROWSER=chrome ... node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-unknown-commit-recovery.e2e.mjs` | 首次尝试在 commit 响应丢弃时遇到 Playwright `Execution context was destroyed`；之后三次复跑通过。每次通过均观察到一个 DSH `write` call、一条 receipt、一个 manifest revision，tool result 为 `TOOL_OUTCOME_UNKNOWN`，无页面错误或跨源请求。 |
| `pnpm run test:docs`、`pnpm run doc-sync`、`git diff --check` | 分别为 21/21 gates、43/43 gates、无 whitespace errors。 |

Chrome 命令使用 `DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js`；运行时清除了本机 HTTP/SOCKS proxy 环境变量。MinIO E2E 使用本地 Docker，不访问生产 bucket。

复跑命令：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/workspace-s3-minio.e2e.mjs
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-unknown-commit-recovery.e2e.mjs
```

## 限制与后续验证

- GC 只在一个 backend 进程、一个 `WorkspaceStore` metadata 视图和当前 PoC writer 锁范围内安全；没有验证共享 S3 bucket 的多个 backend、跨主机 fencing、对象版本控制、删除保护或生产 IAM。
- GC 不验证每个已存在对象的完整 hash；commit 检查 blob 存在、大小与 hash，读取路径也会校验 hash。Startup metadata 校验不能代替对象完整性扫描。
- 文件 store 和 MinIO 的 list/delete 结果不证明 AWS、GCS、Azure 或生产对象生命周期规则一致；对象存储 list 延迟、批量删除失败与部分页错误恢复未验证。
- `uploadedAt` 缺失的旧 pending blob 会永久保留，正确性优先于存储回收；需要单独设计可审计的迁移/清理流程。
- 当前 operation receipts、Workspace metadata 与 Session 数据仍由 PoC 本地 JSON/dataDir 持有；GC 不提供跨存储事务、备份、灾备或多实例 metadata consistency。
- Chrome unknown-commit 测试首轮出现一次 page context 销毁后复跑通过；这个偶发失败已记录，不能把单次通过解读为 E2E 稳定性证明。
- 自然 OPFS eviction、操作系统/磁盘崩溃、生产对象存储、Safari/WebKit 和真实模型大型工具参数仍未在本批执行。

## Dev Note

本批计划与证据详见[验证计划](durable-metadata-and-blob-lifecycle-validation-plan.md)。后续若实现跨实例 GC，必须先引入服务器权威 metadata transaction 或等价 fencing；不得通过延长本地 pending TTL 来掩盖 unknown commit。
