---
description: "记录 Browser-Native DSH 多 backend 共享 authority 验证的实现、测试证据和限制。"
---

# Browser-Native DSH 多 backend 共享权威验证进度

## 当前状态

状态：实现和验证完成，已知限制已记录。

基线：本批在 `research` 主 worktree 实施，Chrome 是唯一浏览器目标，Safari/WebKit 暂停。共享 authority 仍使用单机 PoC JSON durability store；本批只证明两个 backend 可以把 Session、Workspace 和 LLM owner 校验委托给同一个事实源，不把结果外推为生产 HA。

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：候选评估与计划 | `complete` | 基于 DSH-TUI 的执行者/观察者/事实源纪律，选择共享 authority、round-robin、重启/unknown 和真实模型四个交付面 | 实现 authority 转发 seam |
| M1：共享 authority seam | `complete` | backend 将 Session、Workspace 和 operation 请求转发到共享 authority；LLM owner 校验也回到 authority；内部 token 不暴露给浏览器 | 继续运行双实例 Chrome 矩阵 |
| M2：多实例 Chrome 路由 | `complete` | round-robin proxy 让同一页面的静态资源、Session、Workspace 和 LLM 请求命中两个 backend；两者均参与同一 Session | 继续运行重启和 response-loss 矩阵 |
| M3：重启与未知结果 | `complete` | backend 和 authority 均重启后恢复 Session；Workspace commit 响应丢失后 operation 查询只保留一个 revision、一个 operationId 和一条 receipt；最终 Session `eventCount=35`、`durableThroughSeq=34` | 运行真实模型 smoke，区分模型工具选择与 scripted 工具证据 |
| M4：真实 LLM smoke | `complete-with-limitations` | Chrome/真实 provider 完成两轮模型流、刷新和双进程重启；`eventCount=28`、`durableThroughSeq=27`、`llmRequestCount=3`、页面错误为 0，但本轮 `toolCallCount=0`，不证明真实模型完成 `write/read` | 仅将 scripted 工具闭环作为本批 Workspace 证据；真实模型工具选择另行验证 |
| M5：文档与交付 | `complete` | 已更新 PoC README、兼容矩阵、drafts 索引和 change ledger，并记录命令、指标及限制 | 提交、推送并确认远端与工作区一致 |

## 证据纪律

- 共享 authority 的 JSON 文件和进程锁只证明单机 PoC 的串行事实源，不证明生产数据库或跨主机 HA。
- scripted LLM 用于固定路由、工具调用和 response-loss 顺序；真实 LLM 只证明模型流、刷新和多实例重启 smoke，本轮没有工具调用，不能写成真实模型文件闭环。
- 任何 authority 或 backend response loss 都必须通过 durable query、seq 或 operation receipt 对账；不能把 HTTP 503 当作副作用没有发生。
- 记录每个请求命中的 backend、authority 重启次数、Session event seq、Workspace revision、operationId、业务 effect count 和重复模型请求数，但不记录 bearer、API key 或完整大 payload。

## 已执行命令

```sh
node --check docs/drafts/browser-native-dsh-poc/backend-v2.mjs
node --check docs/drafts/browser-native-dsh-poc/run-v2.mjs
node --check docs/drafts/browser-native-dsh-poc/tests/shared-state-authority.test.mjs
node --check docs/drafts/browser-native-dsh-poc/tests/multi-instance-backend.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/shared-state-authority.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/multi-instance-backend.e2e.mjs
DSH_POC_LLM_MODE=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/multi-instance-backend.e2e.mjs
```

Node 合同测试为 `57/57`。首次 scripted Chrome 运行只暴露测试断言把计数值 `1` 与布尔值 `true` 比较的问题；修正后 scripted E2E 通过，并记录 `eventCount=35`、`durableThroughSeq=34`、`llmRequestCount=4`、`toolCallCount=1`、`uniqueWorkspaceOperationIds=1`、`workspaceCommitStatuses=[503]`、双 backend 命中、authority/backend 均重启和页面错误为 0。真实 Chrome/LLM E2E 通过，记录 `eventCount=28`、`durableThroughSeq=27`、`llmRequestCount=3`、双 backend 命中、authority/backend 均重启和页面错误为 0；模型没有产生工具调用，因此 `workspaceCommitStatuses=[]`、`toolCallCount=0`、`uniqueWorkspaceOperationIds=0`。

Preview build 通过；仅出现已有的非当前平台 native package warning、tsdown deprecation warning 和大 chunk warning。测试没有打印模型凭据，也没有把 `docs/drafts/.env` 写入产物或日志。

## 实施调整与经验

- backend 不能把本地 Session store 当作共享 owner 校验源；当配置了 authority 时，Session、Workspace、ledger 路径必须统一转发，LLM 请求也必须在同一 authority 上验证 owner epoch。
- HTTP response loss 只能通过 durable operation 查询结算；workspace commit 返回连接关闭不等于 commit 未发生，不能按失败重新生成 operationId。
- E2E 断言必须比较与被测量类型相同的值；计数断言使用整数，存在性断言使用布尔条件，避免把真实闭环误判为失败或相反。
- 共享 authority 的单机 JSON store 只证明 PoC 的单一事实源和重启恢复，不证明生产数据库事务、跨主机 fencing、跨区域复制、exactly-once 或 RPO/RTO。

## 限制

本批不覆盖真实多主机网络分区、生产对象存储、数据库事务、跨区域复制、自然 eviction、OS/磁盘 crash、Cloud Durable Worker、跨设备身份或 Safari/WebKit。真实模型没有触发工具，因此真实 `write/read`、大型 tool args 和真实业务副作用仍未验证。共享 authority 在本机双 backend 下保持唯一 operation，但不提供生产 HA 或 exactly-once 保证。
