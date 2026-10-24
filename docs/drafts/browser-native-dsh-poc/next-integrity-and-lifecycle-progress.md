---
description: "记录 Browser-Native DSH 完整性与生命周期验证批次的实施进度、证据和限制。"
---

# Browser-Native DSH 完整性与生命周期验证进度

## 当前状态

状态：I1-I4 已完成实现并通过真实 Chrome 的模型无关验收；M6 的 focused 回归与文档门禁已通过，提交和推送随本批收尾完成。范围、候选优先级和退出条件见[验证计划](next-integrity-and-lifecycle-plan.md)。本批直接在 `research` 主工作区进行；没有创建隔离 worktree。

## 里程碑

| 里程碑 | 状态 | 证据 | 结果与阻塞 |
|---|---|---|---|
| M0：基线与候选盘点 | `complete` | `git status --short --branch`、`git worktree list`、历次 Workspace/恢复/容量计划与测试 | 已确认上一批 OPFS 外部 backing 和 backend 单写者已通过；冷 hydrate、orphan、pagehide barrier 和组合恢复仍是高价值缺口。 |
| M1：计划与测试协议 | `complete` | [验证计划](next-integrity-and-lifecycle-plan.md) | 选择 I1-I4 四个交付面；真实 LLM、Safari、自然 eviction、OS crash 和 HA 延后。 |
| M2：冷 hydrate 与增量 hash | `complete` | `browser-native-sha256.spec.ts`；`cold-hydrate-integrity.e2e.mjs` | 3,145,765 字节文件冷启动分 5 块下载，最大响应 1 MiB；外部 backing 的 `residentBytes` 未增加完整文件大小；篡改块进入 `error`。这不是浏览器 heap SLA。 |
| M3：orphan reconciliation | `complete` | `orphan-blob-reconciliation.e2e.mjs` | IndexedDB 事务 abort 产生的未引用 blob 被删除；manifest 引用保留；删除 metadata 后状态为 `local-corrupt`，孤儿不被清理。 |
| M4：pagehide 本地屏障 | `complete` | `pagehide-local-barrier.e2e.mjs`；`runtime-lifecycle.e2e.mjs` | durable pagehide 先等待 Worker 本地 flush，再等待 ack 或超时后终止；BFCache `persisted=true` 保留 Worker。该屏障不等待云端 commit、Session flush 或模型。 |
| M5：组合恢复矩阵 | `complete` | `agent-workspace-receipt-recovery.e2e.mjs`；`agent-workspace-unknown-commit-recovery.e2e.mjs`；`workspace-writer-expiry.e2e.mjs` | receipt outbox 恢复只追加一条 Session receipt；未知 commit 在 backend 重启后只有一个 revision；旧 fencing token 的 resume、renew、commit 和 release 均被拒绝。三格分别运行，不是跨服务原子事务证明。 |
| M6：回归、文档、提交和推送 | `complete` | focused tests、TypeScript、preview build、Chrome E2E、`test:docs`、`doc-sync` 和 `git diff --check` 已通过 | 真实模型、Safari、自然 eviction、OS/磁盘崩溃、跨主机 HA、生产云服务和跨存储原子事务仍不在本批证据内。 |

## 记录规则

- 真实 Chrome E2E 必须使用 Dedicated Worker、OPFS、IndexedDB 和同源 backend；scripted LLM 只证明 DSH 接线和故障时序。
- I1 同时记录 chunk 数量、每块大小、最终 hash、VFS `logicalBytes/residentBytes` 和 page errors；不把 `residentBytes` 写成浏览器 heap SLA。
- I2 记录保留 hash、删除 hash、删除字节数和 metadata 信任状态；metadata 缺失或版本未知时记录“未回收”而不是“清理成功”。
- I3 记录 pagehide 的 `persisted`、ack 类型、超时、Worker terminate 和刷新后的 operationId；不把页面离开后的任何执行描述为后台运行。
- I4 每个状态至少核对一次 Session event、Workspace manifest/operation、IndexedDB snapshot 和 lease token；未知结果只能查询稳定 operationId，不能自动重放副作用。
- 未实际运行的 Safari、真实模型、自然 eviction、OS crash、跨主机 backend 和生产云服务继续标为未验证。

## 已执行命令

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-sha256.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-lifecycle.e2e.mjs
pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json
pnpm exec tsc --noEmit -p apps/web/tsconfig.json
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm run verify-md-wrap
pnpm run verify-md-links
pnpm run doc-typecheck
pnpm run test:docs
pnpm run doc-sync
pnpm run change-scope --base origin/research
git diff --check
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/cold-hydrate-integrity.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/orphan-blob-reconciliation.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/pagehide-local-barrier.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-unknown-commit-recovery.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs
```

以上 Chrome 证据使用 scripted backend/LLM 和真实 Dedicated Worker、OPFS、IndexedDB、同源 backend；没有把 scripted 结果写成真实模型通过。尚未覆盖 Safari、自然 eviction、OS/磁盘崩溃、跨主机 HA、生产对象存储、可写 chunk-backed VFS 或云端原子事务。
