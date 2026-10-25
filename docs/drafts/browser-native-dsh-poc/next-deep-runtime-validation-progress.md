---
description: "记录 Browser-Native DSH 深度运行时验证的实施进度、证据和限制。"
---

# Browser-Native DSH 下一批深度运行时验证进度

## 当前状态

状态：四个交付面已实施或复用既有实现并完成 Chrome 验证，文档和 focused 门禁待收尾。

本批基线为 `research` 分支在 2026-10-25 的干净 checkout，开始时没有隔离 worktree。四个交付面是长 Session 冷 hydrate、并行只读工具 fan-out/fan-in、`assistant/attempt` 失败收束、大文件写入边界。Safari、自然 eviction、OS/断电崩溃、生产 HA 和真实供应商自然断流不属于本批通过范围。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选审查和规划 | `complete` | `next-deep-runtime-validation-plan.md` 已写入候选范围、取舍、矩阵和限制 | 固定 scripted backend 场景 |
| M1：长 Session 冷 hydrate | `complete` | `tests/long-session-hydrate.e2e.mjs`，真实 Chrome、24 轮、刷新后无重复模型请求 | 当前 `open/read` 仍返回全量事件，后续需要分页或 compaction 设计 |
| M2：并行工具 fan-out/fan-in | `complete` | `tests/parallel-tool-fanout.e2e.mjs`，同一 turn 两个 read call 重叠、按模型顺序结算、部分失败后继续 | 只证明声明为只读的 read 调用；不外推为并发写安全 |
| M3：attempt 失败收束 | `complete` | `tests/attempt-settlement-failure.e2e.mjs`，第一次 `assistant/attempt` append 返回 503 后有限重试成功，turn 为 error，刷新不重发，显式新 turn 成功 | 永久 append 故障、跨进程恢复和真实供应商自然断流仍未验证 |
| M4：大文件写入边界 | `complete` | `tests/opfs-vfs-residency.e2e.mjs` 与 `tests/reference-backed-edit.e2e.mjs`，真实 Chrome 8 MiB 标准写入、外部 range backing、append materialize、16 MiB copy-on-write 及六个失败点 | 这是 PoC storage/editor 原型；标准 DSH `edit` 仍会 materialize，非零拷贝或块级 delta |
| M5：文档、门禁和提交 | `complete` | README、索引、账本已更新；`test:docs` 21/21、`doc-sync` 43/43、focused tests 和 typecheck 通过 | 提交并推送 `research` |

## 实施变更

- `backend-v2.mjs` 增加并行只读 scripted tool calls 和 Session append 503 注入；这些只控制 DSH Loop 时序，不替代真实模型。
- `browser-native-providers.ts` 为 live Session events 增加有限重试，并在 `SEQ_CONFLICT` 后按事件内容对账；相同事件已由 backend 接受时不重复写入。
- 三个新增 Chrome E2E 分别证明长 Session hydrate、同 turn 并行 read 和失败 attempt 收束。M4 复用既有 OPFS residency 与 reference-backed edit 实现，避免重复造测试接口。
- 失败收束测试首次超时的原因是测试错误地要求 `turn/start` 位于 `user/message` 之后；DSH 实际顺序是 turn 开始事件先于用户事件。修正观测逻辑后测试通过，不能把首次超时归因于运行时失败。

## 实际证据

- 长 Session：`DSH_POC_LONG_SESSION_TURNS=24 node tests/long-session-hydrate.e2e.mjs` 通过；刷新前 202 个事件，刷新后只新增一个 `session/end-seed`，LLM 请求计数 `25 -> 25`，hydrate 约 1982 ms，刷新后继续成功。
- 并行工具：`node tests/parallel-tool-fanout.e2e.mjs` 通过；真实 Chrome/Worker/DSH Loop 中两个 read call 同一 assistant message 发出，正常 turn 约 659 ms，成功与失败混合场景都完成，0 page error。
- 失败收束：`node tests/attempt-settlement-failure.e2e.mjs` 通过；注入一次 503，`attemptAppendFailures=1`，失败 turn 为 error，失败 prompt 的 LLM 请求数为 1，刷新后同一 attempt 只有一条，第二 turn 完成。
- 大文件：`opfs-vfs-residency.e2e.mjs` 以 8 MiB 通过；刷新后 `logicalBytes` 约 42.88 MiB、`residentBytes` 约 34.49 MiB，append 后文件重新 materialize。`reference-backed-edit.e2e.mjs` 以 16 MiB/1 MiB chunk 通过；六个 copy-on-write 故障点均保持源 hash，正常路径产生一个 revision 并刷新恢复。
- 收尾门禁：`node --test tests/backend-v2.test.mjs` 为 23/23，Browser-Native Workspace Vitest 为 24/24，`tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json` 通过，`pnpm run test:docs` 为 21/21，`pnpm run doc-sync` 为 43/43。

## 未验证和限制

本批没有证明全量 Session 的长期性能、compaction、分页读取、永久 Session append 故障的用户呈现、自然浏览器 eviction、OS/磁盘崩溃、多实例 backend、生产对象存储、Safari/WebKit 或真实 LLM 生成大型 tool args。标准 VFS 写入和 DSH `edit` 仍可能完整驻留文件；external range backing 与可写 chunk editor 只是 docs-owned 原型。live event retry 达到上限后保留 pending events 并报告错误，不应被描述成已解决的离线队列或跨存储事务。

## 证据规则

- 每项记录实际运行的命令、浏览器通道、backend 模式和临时数据目录。
- scripted LLM 只证明 DSH loop 和协议时序；真实 LLM 只作为普通回归，不作为注入故障的必要条件。
- 任何失败都记录为失败或未验证，不改写成“部分通过”的成功结论。
- 不记录 API key、完整大 tool args、完整用户 prompt 或未脱敏响应体。
