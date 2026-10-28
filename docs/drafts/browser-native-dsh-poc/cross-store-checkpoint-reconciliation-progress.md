---
description: "跨存储 checkpoint/receipt 对账验证的实施、故障证据、真实模型与限制记录。"
---

# 跨存储 checkpoint 与 receipt 对账验证进度

## 当前状态

本批已完成。主工作区为 `research`，没有隔离 worktree。候选范围、协议分层和验收矩阵见[验证计划](cross-store-checkpoint-reconciliation-plan.md)；实现证据只适用于当前 checkout 的 PoC，不是正式跨存储事务实现。

| 里程碑 | 状态 | 验收要求 |
| --- | --- | --- |
| M0：事实与协议定义 | complete | 核对 DSH Session、Workspace、handoff 和既有 reconciliation helper；冻结状态分类与稳定身份 |
| M1：backend operation ledger | complete | principal/owner 保护、幂等摘要、冲突拒绝、状态查询和 backend 重启保留 |
| M2：Worker/Session 故障矩阵 | complete | Worker 实际写入 OPFS/IndexedDB、Workspace commit、业务 receipt、Session receipt 和未知响应恢复 |
| M3：Chrome 与真实模型 | complete-with-scope | Chrome scripted 对账 E2E 通过；另完成真实 LLM 普通文件 smoke；真实模型未被用于确定性故障注入 |
| M4：文档与交付 | complete | 文档和变更账本已更新；定向测试、Web typecheck、preview build、doc-quick/doc-sync 和 `git diff --check` 通过；本批待提交并推送 |

## 基线事实

当前已有 `workspace-session-reconciliation.mjs` 纯函数和测试，但它只分类传入的状态，没有连接实际 Session event、Workspace retry 或业务副作用 ledger。已有 handoff 已验证 Session 安全点和 owner fencing；上一批已验证 Workspace 恢复不会混合 revision。它们都不能证明跨存储原子提交。

## 执行记录

以下结果均为本批实际执行；未把既有批次结果复制为本批证据。

| 命令 | 结果与证据 |
| --- | --- |
| `node --test docs/drafts/browser-native-dsh-poc/tests/cross-store-operation-ledger.test.mjs docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs` | 通过，8/8；ledger 记录 `pending/unknown/committed`，拒绝身份和 payload 重用，backend 重启后可查询并完成对账。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts` | 通过，8/8；Browser profile 静态 roster 为 9 个工具，不含 `read_image`。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；仅有既有 unsupported native platform、tsdown deprecated option 和 chunk-size warning。 |
| `DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome ... node tests/browser-native-v2.e2e.mjs` | 通过；Chrome scripted 1 turn、19 events、Session durable watermark 18、LLM 2/2 HTTP 200；模型 roster 不含 `read_image`。 |
| `DSH_POC_BROWSER=chrome ... node tests/cross-store-reconciliation.e2e.mjs` | 通过；真实 Chrome Dedicated Worker/OPFS/IndexedDB，Workspace revision `1`、Session seq `0`、business effect count `1`、business response recovery `true`、decision `reconciled`、Workspace commit count `1`、page errors `0`。 |
| `env -u HTTPS_PROXY ... DSH_POC_LLM=real DSH_POC_BROWSER=chrome ... node tests/browser-native-v2.e2e.mjs` | 通过；`gpt-5.6-sol` 3 turns、41 events、durable watermark 40、5/5 LLM HTTP 200、同 Session memory `true`、todo persistence `true`、page errors `0`。这是正常文件/Session smoke，不是故障注入后的真实模型证据。 |

首次 Chrome 启动暴露 profile overlay 归档为 macOS Pax 扩展格式，Worker tar parser 拒绝 `home/PaxHeader/*`；随后新增 `build-profile-overlay.mjs`，使用 `ustar`、禁用 xattrs 和 `COPYFILE_DISABLE=1` 重新生成 overlay，重建 preview 后通过。此前真实模型 smoke 的 `read_image` publication 错误来自 checked-in overlay 仍是旧 YAML；当前 overlay 已验证 `readImage: false` 和 `inject: [llm]`。

## 限制与下一步

当前 backend 使用 PoC `dataDir` 和单进程 per-operation queue；多实例、生产数据库、对象存储、真实租户授权和自然 eviction 不在本批通过条件。ledger 的本地 JSON 持久化不是跨进程锁，也不是 Session、Workspace 和业务 API 的原子事务。真实业务副作用在本批由同源 mock endpoint 的 operation ledger 计数，不代表生产 SaaS API 的幂等或事务保证。

本批没有使用真实 LLM 来触发可重复的 partial-success 故障；真实 LLM 只完成普通 Browser-Native 文件/Session smoke。页面关闭不会让 Worker、模型流或业务 Promise 继续执行；`unknown` 仍必须查询原 operation，不能自动重放未知副作用。后续若实现正式版本，应优先把 ledger 替换为具备唯一约束、条件更新和状态查询的服务端存储，并为业务 API 明确 idempotency key、重试窗口、过期和人工对账界面。

交付前门禁：`node --check docs/drafts/browser-native-dsh-poc/build-profile-overlay.mjs`、`pnpm exec tsc --noEmit -p apps/web/tsconfig.json`、`pnpm run verify-md-wrap`、`pnpm run verify-md-links`、`pnpm run doc-typecheck`、`pnpm run test:docs`（21/21）、`pnpm run doc-sync`（43/43）和 `git diff --check` 均通过。尚未把这些结果写成远端状态；commit、push 和最终 clean checkout 是本批最后步骤。
