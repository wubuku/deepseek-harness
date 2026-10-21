---
description: "记录 Browser-Native DSH 高价值验证批次的实施进度、证据和限制。"
---

# Browser-Native DSH 高价值验证进度

## 当前状态

本批次四个验证面已完成首轮实现和验证；Session/Workspace 自动接入仍明确记录为未完成。

| 验证面 | 状态 | 证据 |
|---|---|---|
| 上传失败和 commit unknown | 首轮通过 | `durable-workspace-failure-matrix.e2e.mjs`：真实 Chrome Worker、上传 503、commit 响应断开、operation 查询、无跨源请求 |
| Workspace writer lease 与 fencing | 首轮通过 | `workspace-writer-lease.e2e.mjs` 和 backend contract：双页面 claim 冲突、release/reclaim、旧 token renew 被拒 |
| Session/Workspace receipt 协调 | 协议级通过 | `session-workspace-reconciliation.test.mjs`：receipt 字段、四种状态、Workspace 已提交但 Session 写权失败；尚未接入 Agent Loop |
| DSH 文件能力矩阵 | 首轮通过 | `browser-native-file-matrix.e2e.mjs`：真实 Chrome Worker 中 mkdir/write/append/stat/list/chmod/rename/remove/二进制/Unicode/atomic staging |

## 记录规则

- 只有实际执行过的命令和浏览器证据才写为通过。
- 模型无关测试证明协议和存储语义；真实 LLM 测试只用于证明 DSH Agent Loop 能调用对应能力。
- 如果现有扩展点不能把 Workspace receipt 接回 Session event，记录为架构缺口，不用测试接缝掩盖。

## 经验教训

本批次的第一原则是先证明失败时的状态语义，再增加传输优化。任何“已保存”提示必须对应明确的本地或云端 durability receipt，不能由请求发出或内存 VFS 写入推断。

2026-10-22 的首轮 Chrome 证据为：故障矩阵 `uploadAttempts=3`、`commitAttempts=2`、`operationLookups=2`、revision `0 → 2`；writer lease 的 fencing token 为 `1 → 2`，第二 writer claim 和旧 token renew 均返回 `409`；文件矩阵最终 manifest 只有 `matrix`、二进制文件、重命名文件和最终 `result.txt`，没有 atomic-write staging 目录。所有脚本均无 page error、无跨 origin 请求。

本轮没有验证 OPFS/IndexedDB 被清除后的自动重建、quota/eviction、commit 超时、Safari/WebKit 或页面关闭后的后台执行。真实 LLM 也不是上述协议故障测试的必要前提，因此本轮没有把这些结果写成新的真实模型 E2E。

文档门禁 `pnpm run test:docs` 和 `pnpm run doc-sync` 均通过；`verify-repository-references`、`verify-md-links`、`verify-md-wrap`、`doc-typecheck` 和 `git diff --check` 也通过。测试夹具随后改用随机端口，两个独立 backend contract 进程并发运行均为 `15 passed`，避免固定 `4175` 在并发执行时造成假失败。
