# 多用户并发：10 Principal 压测与准入拐点

本项验证 browser-native PoC 在多用户同时使用时是否仍成立：10 个 principal 各持有 2 个真实 Session、20 个 Dedicated Worker 同时提交 turn，其中 1 个 turn 走审批卡、1 个 Session 共享给另一个 principal 只读协作；同时探测挂载上限。所有状态均从 backend 的 `/session/read` 与 `/admission` 采样，页面不暴露 owner token。

## 压测设计

脚本 [`multi-principal-load.e2e.mjs`](tests/multi-principal-load.e2e.mjs) 使用真实 preview UI 与真实 composer：

- 每个 principal 通过一次 `/workspace/identity` 取得身份 cookie；同 principal 的第二个 Session 在独立 `BrowserContext` 中复用该 cookie，避免同标签页后台节流。
- 基线组 5 principal × 2 Session = 10 turn，压力组 10 principal × 2 Session = 20 turn，都在同一 backend、同一 `maxConcurrentTurns: 8`、`maxMountedSessions: 24` 下运行。
- scripted 模型对每个 turn 持有 3,000 ms，确保错峰到达的模型请求能真实占满 8 个 turn 槽；这是准入队列能稳定出现的前提。
- 审批 turn 先切到 Read Only，再通过真实 `[data-approval-key]` 卡片点击 `Allow once`。
- 协作：principal 0 的 Session 共享给 principal 1；加载期间 principal 1 读取 Session，并尝试 `open('write')`。
- 挂载探测在负载页面关闭后创建新 Session，直到 `429 SESSION_MOUNT_LIMIT`。

## 结果

| 指标 | 基线 10 Session | 压力 20 Session |
| --- | --- | --- |
| turn 中位数 | 3,469 ms | 7,963 ms |
| turn p95 | 6,385 ms | 10,883 ms |
| turn 最大 | 6,385 ms | 10,956 ms |
| 吞吐 | 1.55 turn/s | 1.82 turn/s |
| admission active 峰值 | 8 | 8 |
| admission queued 峰值 | 5 | 26 |
| 浏览器 CPU | 1.11 核 | 2.87 核 |
| 单页堆中位数 | 46.4 MB | 46.4 MB |
| 错误率 | 0/10 | 0/20 |

- 准入上限仍成立：两组 active 峰值都等于配置的 8，没有超额；20 Session 组有 26 个模型请求排队，全部完成。
- 压力拐点在 8 个 turn 槽：Session 从 10 增到 20，中位延迟升到 2.3 倍，吞吐只提高 17%，新增容量全部转化为排队。继续增加 principal 不会增加吞吐。
- 浏览器端先于后端成为瓶颈的条件也存在：把模型持有时间缩短到 350 ms 后，20 个窗口的请求启动错峰超过持有时长，active 峰值只有 6、队列为空，而中位延迟仍为 4.8 秒、CPU 3.1 核。也就是说，如果没有足够的模型持有时长，Chrome 主线程/进程调度会先于准入槽限制并发；此时有效上限是浏览器 CPU，而不是 8 个槽。
- 内存不是上限：20 个页面堆仍在 46 MB 量级，与 10 页一致。
- 审批与协作在负载中成立：审批 turn 产生 1 条 `approval/decided` 并完成；共享 viewer 打开返回 200、读到 3 条事件，`open('write')` 返回 403 `SESSION_READ_ONLY`。
- 挂载上限仍成立：配置 24 时，第 25 个 `session/create` 返回 429 `SESSION_MOUNT_LIMIT`，`mounted=24`。
- 无页面异常、无跨源请求；20 个 turn 均以 `completed` 结束。

## 结论与限制

生效上限：

- 同时执行的模型 turn：8（配置值），第 9 个起排队；本压测没有观测到超限。
- 同时挂载的 Session：24（配置值），第 25 个拒绝挂载。
- 单浏览器进程的可用并发受 CPU 限制：20 个 Session 在 3 秒模型持有下消耗约 2.9 核，延迟随 Session 数增长；在这台测试机上，8 个 turn 槽已是吞吐平台。

未覆盖：

- 真实模型 provider 延迟与限流；本项使用 scripted 模型固定持有时长。
- 多浏览器进程、多机器或网络分区下的 principal 分布。
- 审批拒绝、协作写权限或共享撤销在负载下的竞争；本项只验证允许一次与只读拒绝。

复跑：

```sh
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/multi-principal-load.e2e.mjs
```

可用 `DSH_POC_PRINCIPAL_COUNT`、`DSH_POC_PRINCIPAL_SESSIONS`、`DSH_POC_PRINCIPAL_TURN_SLOTS`、`DSH_POC_PRINCIPAL_MOUNT_SLOTS`、`DSH_POC_PRINCIPAL_LLM_MS` 调整规模。测试输出完整 JSON，包含两组延迟分布、admission 采样、CPU/堆、审批与协作结果、挂载探测和 `kneepoint`。
