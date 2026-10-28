---
description: "独立业务 API 幂等与未知副作用验证的实施进度、故障证据和未验证边界。"
---

# 独立业务 API 幂等与未知副作用验证进度

## 当前状态

规划已完成，实施尚未开始。主工作区为 `research`，无隔离 worktree。目标、验收矩阵和限制见[验证计划](external-business-idempotency-validation-plan.md)。

| 里程碑 | 状态 | 结果要求 |
| --- | --- | --- |
| M0：事实和协议冻结 | complete | 独立业务 receipt、DSH ledger、Workspace receipt 和 Session receipt 的字段及状态已定义 |
| M1：独立业务服务 | complete | 独立 HTTP 服务和 JSON durable store 支持 intent/effect/query；相同 `(principalId, operationId, payloadDigest)` 并发 effect 只产生一个 receipt；服务重启后 receipt 保留；payload/principal 冲突返回 409 |
| M2：DSH backend adapter | complete | backend 在配置独立业务服务时转发 intent/effect，并把外部 receipt 写入自身 ledger；查询可补齐 ledger receipt；业务 effect 已提交但 DSH ledger 尚未写入时不重复执行 |
| M3：真实 Chrome 恢复矩阵 | complete | Chrome Dedicated Worker/OPFS/IndexedDB 已验证业务响应丢失、业务服务重启、DSH ledger 缺口、查询不可用时保持 unknown、并发幂等和 payload 冲突 |
| M4：真实模型 smoke 与交付 | complete | 真实 LLM 普通 smoke、文档门禁和相关回归均通过；commit/push 属于本批交付动作 |

## 执行记录

本节只记录本批实际运行过的命令、结果和故障，不复制上一批证据。

- `node --check docs/drafts/browser-native-dsh-poc/external-business-service.mjs docs/drafts/browser-native-dsh-poc/backend-v2.mjs docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.test.mjs docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.e2e.mjs`：通过。
- `node --test docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.test.mjs`：4/4 通过，覆盖并发 effect、服务重启、身份/payload 冲突和 backend 重启后的 ledger 补齐。
- `node docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.e2e.mjs`：Chrome 通过，覆盖响应丢失、业务服务重启、DSH ledger 缺口、查询不可用保持未确认和 payload 冲突；effect count 均为 1，无页面错误。
- `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`：通过；构建输出包含 Browser Worker 和 vfs image。仅有既有 unsupported native platform、tsdown deprecation 和大 chunk 警告。
- `DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`：真实 `gpt-5.6-sol` Chrome smoke 通过；3 turns、59 events、`durableThroughSeq=58`、`read → write → read`、刷新后文件恢复、2 次 Workspace commit、8/8 LLM HTTP 200、无 page error。日志包含既有 compaction capacity warning 和 preview 辅助 API 404；未影响断言，也不是本批 external business adapter 的失败。
- backend 全量回归与 Workspace/Session focused tests：60/60 Node tests、21/21 focused Vitest 通过；preview build 通过。
- `pnpm run verify-md-wrap`、`pnpm run verify-md-links`、`pnpm run doc-typecheck`、`pnpm run test:docs`：通过；分别检查 2230/2193 文件、100 个 type blocks、21 个 doc-quick gates。
- `pnpm run doc-sync`：43/43 gates 通过。
- push 前增量 typecheck、`git diff --check` 和最终 clean checkout 将在提交/推送后确认。

## 经验教训与限制

当前 cross-store ledger 把业务 effect 记录在 DSH backend 内，不能单独证明外部 SaaS API 的幂等性。即使本批 mock 通过，也只能得到“业务服务明确提供 durable idempotency record 时可查询恢复”的结论；没有该能力时，未知副作用不能安全自动重试。

本批进一步证明：DSH ledger receipt 缺失不等于外部业务 effect 未发生；恢复顺序必须先查询外部业务服务，再将已确认的外部 receipt 写入 DSH ledger。查询不可用时，Chrome Worker 保留 unknown，不追加 Session 成功 receipt，也不自动重放 effect。独立服务使用 PoC JSON store 和进程内 operation lock，尚未验证生产数据库事务、跨主机并发、业务数据提交与幂等记录的同事务关系、receipt TTL/GC 或真实 SaaS API。
