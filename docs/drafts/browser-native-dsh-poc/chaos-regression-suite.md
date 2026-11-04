---
description: "把断流、Worker 崩溃、OPFS 配额、durable 重启、lease 丢失与审计截断故障注入收敛为一条命令的回归套件。"
---

# 混沌回归套件

## Summary

`tests/chaos-suite.mjs` 顺序执行六个既有故障注入用例，输出每个用例的 PASS/耗时，或以失败清单和每个失败用例的末尾诊断结束。套件只编排既有测试，不新增故障注入实现；每个用例仍使用自己的临时数据目录和清理逻辑。

## 一条命令

```sh
node docs/drafts/browser-native-dsh-poc/tests/chaos-suite.mjs
```

全绿输出：

```text
chaos: stream-cut PASS in ...
chaos: worker-crash PASS in ...
chaos: opfs-quota PASS in ...
chaos: durable-restart PASS in ...
chaos: lease-loss PASS in ...
chaos: audit-truncation PASS in ...
chaos-suite: PASS 6/6
```

失败输出列出失败用例 id、退出码或超时、耗时，并打印该用例捕获输出的最后 40 行；汇总行为 `chaos-suite: FAIL k/6: <ids>`，进程退出码为 1。`--list` 只列出用例与文件，`--filter <substring>` 只跑匹配用例，便于单项复现。

## 覆盖映射

| 用例 id | 执行的测试 | 注入的故障 | 关键断言 |
| --- | --- | --- | --- |
| `stream-cut` | `llm-stream-failure.e2e.mjs` | 模型流中途断开 | Session 记录失败 turn，页面显示可恢复状态，下一轮可继续 |
| `worker-crash` | `worker-crash-during-tool.e2e.mjs` | 工具执行期间 Worker 崩溃 | 工具结果未知被记录，Session 不重复执行，刷新后可继续 |
| `opfs-quota` | `opfs-quota-tool-failure.e2e.mjs` | OPFS 配额拒绝写入 | 写入失败可见且不被静默吞掉，Agent 后续读写不越过未确认文件 |
| `durable-restart` | `durable-host-restart.test.mjs` | durable host 进程重启 | 已持久化事件可重放，重启后 turn 状态与停止路径正确 |
| `lease-loss` | `page-freeze-lease-fencing.e2e.mjs` | 页面冻结导致 writer lease 丢失 | 竞争者以新 fencing token 接管，旧 writer 的提交被拒绝 |
| `audit-truncation` | `observability-persistence.test.mjs` | 审计日志截断、撕裂行与损坏快照 | 保留最新条目、统计 torn 行并报告 `truncated: true`，不将损坏数据当作完整审计 |

`stream-cut`、`worker-crash`、`opfs-quota`、`lease-loss` 需要 Chromium；套件默认 `DSH_POC_BROWSER=chrome`，并在未设置 `DSH_POC_PLAYWRIGHT_MODULE` 时从本地解析 Playwright。`durable-restart` 与 `audit-truncation` 是 Node 合同测试，使用 `node --test` 启动。六项均使用 scripted 模型或本地进程，不访问外部 provider。

实测结果（2026-11-04，Chrome 156，macOS）：

```text
chaos: stream-cut PASS in 17.3s
chaos: worker-crash PASS in 15.4s
chaos: opfs-quota PASS in 13.7s
chaos: durable-restart PASS in 0.6s
chaos: lease-loss PASS in 8.5s
chaos: audit-truncation PASS in 0.3s
chaos-suite: PASS 6/6
```

## 结论边界

本套件证明这六类故障注入在本次构建上可重复通过，不是完整混沌测试矩阵：不覆盖多主机/多实例、真实 provider 的随机断流、进程级 kill -9、磁盘写满、时钟跳变或审计存储介质损坏。`durable-restart` 只验证单进程 durable host 的持久化重放，不代表跨主机接管。相关边界见[服务端交付边界](server-delivery-boundaries.md)与[多实例 backend authority 验证](multi-instance-backend-authority-validation-progress.md)。
