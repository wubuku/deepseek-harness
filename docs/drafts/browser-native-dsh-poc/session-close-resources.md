---
description: "验证 Browser-Native DSH PoC 在 Session 关闭或失去写租约后，Worker 句柄、写租约、持久化 flusher 与续租定时器是否被释放。"
---

# Session 关闭后的资源回收

`tests/session-owner-handoff.e2e.mjs` 在真实 Chrome 里创建 Session、完成一轮真实模型往返，再把写所有权 handoff 给第二个通道。Worker 的下一次续租会得到 `SESSION_OWNERSHIP_LOST`；此时必须释放该 Session 的全部 Worker 侧资源，而不是继续保留一个已失效的写句柄。

## 每 Session 的资源

- 写句柄与写租约：`handles`、`owners`。
- 持久化收尾（审计/落盘）闭包：`flushers`，捕获 owner、workspace 与 publication。
- 续租与 live 重试定时器；关闭时 `clearTimeout`。
- 挂载订阅由页面侧 ResourceMetrics 统计，长跑测试已单独验证收敛。

`browserNativeSessionResourceStats()` 暴露前三个计数，Worker 的 `resource-stats` 测试通道把它们作为 `sessionResources` 返回。

## 修复

- 续租返回 `SESSION_OWNERSHIP_LOST` 后，原先只广播冲突并继续排下一次续租，句柄、租约与 flusher 永久留在 Worker。现在立即 `close()`，释放三者并清掉续租定时器。
- 打开 Session 时 `flushers` 在成为 writer 之前就已登记；若随后 `recoverOutbox` 失败触发释放，`untrack()` 因 `writers` 无条目而跳过删除，留下闭包。现在 writer 为空时也按关联释放，writer 已被更新句柄替换时不动新条目。

## 验证

- handoff 前：`sessionResources` 为 `handles > 0`、`owners > 0`、`flushers > 0`（真实 turn 建立的写句柄）。
- handoff 后轮询至 `{handles: 0, owners: 0, flushers: 0}`，随后原 Session 仍可由新 owner 继续 append，证明回收不影响数据。
- 16 Session、113 turn 长跑回归仍收敛：页面监听、短时定时器为首尾持平，Worker 监听与定时器在首轮后持平。

## 边界

- 本 PoC 没有删除 Session 的界面或后端操作；删除属于持久化存储清理，未在此范围实现。页面关闭的回收路径由 `runtime-lifecycle.e2e.mjs` 覆盖：Worker 终止后租约到期可被重新 claim，随后 `close` 成功。
- Worker 侧的 outbox IndexedDB 连接与附件模块按页面共享，不随单个 Session 创建，因此不在每 Session 回收范围内；它们在页面销毁时随 Worker 释放。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/resource-lifecycle-long-run.e2e.mjs
```
