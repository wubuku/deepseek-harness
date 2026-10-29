---
description: "记录 Browser-Native DSH 多 backend 共享 authority 并发、业务幂等和失联恢复的实现与证据。"
---

# Browser-Native DSH 共享 authority 并发与恢复验证进度

## 当前状态

状态：实施、验证、提交与推送完成。

基线：本批在 `research` 主 worktree 实施；没有隔离 worktree。只运行 Chrome，不运行 Safari/WebKit。新增证据补足两个 backend 并发请求、双页面 claim、业务 effect 去重和 authority 服务不可用恢复；authority 仍为单机 PoC JSON 服务。

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：候选评估与计划 | `complete` | 评估并选择 authority 并发、业务幂等、主体隔离、失联恢复和真实模型冒烟；滚动升级、blob GC 与生产 HA 另列后续 | 完成文档门禁并交付 |
| M1：Session/Workspace 并发与主体隔离 | `complete` | 双 backend 同时竞争 Session create/open/append、Workspace claim/operation/CAS；验证唯一 seq/revision、fencing 和跨 principal 拒绝 | 保留当前合同测试为回归 |
| M2：跨 backend 业务幂等 | `complete` | 两 backend 同时提交相同 business operation 只产生一个 effect；response loss、authority 重建后通过同 operation 查询恢复，effect count 仍为 1 | 保留现有 external business 测试为回归 |
| M3：Chrome 双页面与 authority 故障恢复 | `complete` | Chrome 156.0.8078.48；两个页面的 Session/Workspace claim 各为一胜一败；authority outage 的 Session/manifest/LLM 请求均 503；不同 principal 得到 403/404；同 `dataDir` 重建后 Worker 读回本地文件和远端 blob。最终 35 events、`durableThroughSeq=34`、5 model requests、revision/operation 各 1、无页面错误 | 另行验证两个并行 Agent Loop 和 authority OS 进程强杀 |
| M4：真实 LLM smoke 与文档 | `complete-with-limitations` | 真实 Chrome 多 backend 两轮对话和服务实例重建通过；28 events、`durableThroughSeq=27`、3 LLM requests、双 backend 命中、0 tool calls、无页面错误 | 不声称真实模型工具闭环 |
| M5：交付检查、提交和推送 | `complete` | 21/21 doc-quick 与 43/43 doc-sync gates 通过；staged whitespace 和 change-scope 检查通过；本批已提交并推送到 `research` | 无 |

## 证据纪律

- scripted LLM 固定并发与故障切点；不把它当作模型决策证据。
- 外部 business service 的 effect count 必须以业务服务 durable record 为准；DSH ledger receipt 单独核对。
- HTTP 超时/503 不代表 operation 未执行；只能以原 operationId 查询后结算。
- authority unavailable 时不允许 fallback 到 backend 本地 Session/Workspace store。
- 记录 backend 命中、principal 归属、Session seq/durable watermark、owner epoch、Workspace fencing/revision、operationId、业务 effect count、模型请求数和页面错误；不记录 secret 或完整大 payload。

## 已执行命令

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --check docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.test.mjs
node --check docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/shared-state-authority.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.e2e.mjs
DSH_POC_LLM_MODE=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome DSH_POC_TURN_TIMEOUT_MS=600000 \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/multi-instance-backend.e2e.mjs
pnpm run test:docs
pnpm run doc-sync
git diff --check
```

Preview build 通过，只有既有 native platform、tsdown deprecation 和大 chunk 警告。四个 backend/authority/业务服务 Node 测试文件共 64/64 通过。Chrome 156.0.8078.48 scripted E2E 通过：Session 和 Workspace claim 均只有一个成功者；authority 停机时 Session read、Workspace manifest 和 LLM owner 授权均返回 `SHARED_STATE_UNAVAILABLE`/503；两个 backend 的本地 Session/Workspace store 保持空；重建 authority 后真实 Worker 与远端 blob 读回 `BROWSER_NATIVE_WORKSPACE_TOOL_OK`，原 Session 共 35 events、durable watermark 34、一个工具调用、一个 Workspace revision/operation。

真实 LLM Chrome 多 backend smoke 通过两轮流式对话、刷新和 backend/authority 服务实例重建：28 events、watermark 27、3 次 LLM 请求、两个 backend 均命中、无页面错误；模型没有调用工具，故不构成真实模型文件工具证据。authority 故障 E2E 关闭并重建同一 Node 进程中的服务对象，不等于独立进程强杀测试。第一次 E2E 运行漏带启用 PoC test port 的 URL 参数，之后补上参数并通过；最终脚本以完整 teardown 正常退出。

`pnpm run test:docs` 的 21 个 quick gates 全部通过；`pnpm run doc-sync` 的 43 个 gates 全部通过；`git diff --check` 无输出并返回成功。

- 两页通过 Playwright route barrier 同时到达 claim endpoint，避免用顺序请求冒充竞争；这只验证 HTTP claim 并发，不运行两个并行 DSH Agent Loop。
- 真实 Worker 在停 authority 前释放 Session 和 Workspace 写权；恢复后重新 hydrate，并从本地 OPFS 与服务端 blob 分别读回相同内容。

## 限制

真实多主机网络分区、生产数据库事务、跨区域 HA、自然 eviction、OS/磁盘 crash、authority OS 进程强杀、两个并行 Agent Loop、多 Agent 工具写冲突、Cloud Durable Worker、生产多租户授权、对象存储多副本和 Safari/WebKit 均不在本批可证明范围。真实 LLM 未产生 DSH tool call，模型自主文件读写闭环保持未验证。
