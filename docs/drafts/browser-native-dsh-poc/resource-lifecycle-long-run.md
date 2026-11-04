---
description: "浏览器原生 PoC 的 16 Session、100+ turn 挂载/切换长跑：Worker 数量、全局监听、短时定时器、页面与 Worker 堆在强制 GC 后的收敛证据，以及 mount coordinator 的 unmount 修复。"
---

# 资源与内存泄漏长跑

## Summary

本项验证 16 个 Session 在 7 轮中反复挂载、切换并完成 113 个真实 Agent turn 后，Dedicated Worker 数量、页面全局事件监听、60 秒内的页面定时器、页面与 Worker JavaScript 堆是否收敛。结论通过：Worker 始终为 1 个；页面全局监听与短时定时器增长为 0；Worker 监听和定时器在第一轮增加 15 后保持不变；强制 GC 后页面堆增长 10.28 MiB、Worker 堆增长 3.85 MiB，均低于 64 MiB / 48 MiB 预算。长跑使用 scripted LLM，不测 provider 延迟或生产容量。

## 验证方法

`tests/resource-lifecycle-long-run.e2e.mjs` 先让 preview 自己的 Session 完成一次真实 turn，再通过同源 Session API 写入 15 个已关闭的持久 Session；页面侧共 16 个 Session，正好占满 backend 的 16 个 mounted-Session 槽位。随后 7 轮中每轮依次打开并切换到全部 16 个 Session，各发起一个 scripted Agent turn。

每个检查点先用 `HeapProfiler.collectGarbage` 强制 GC，再读取页面 `Performance.getMetrics` 的 `JSHeapUsedSize` 和每个 Worker target 的 `Runtime.getHeapUsage`，同时读取页面与 Worker 的资源计数。检查点前等待 1 秒，让防抖 `setTimeout` 落地，避免把尚未触发的短任务算成泄漏。

页面只统计 `window`/`document` 上的监听，元素监听随 DOM 子树回收，不能代表跨 Session 泄漏。Worker 通过 `browser-native-resource-metrics.ts` 在 Node timer shim 之后包装 `EventTarget`、`setTimeout`、`setInterval` 与清理函数，经 `resource-stats` 测试动作读取；`once` 与 `AbortSignal` 监听在触发或 abort 时递减。页面定时器区分 `liveShort`（延迟小于 60 秒）与总 `live`，因为消息行按本地午夜调度的定时器会随当前 transcript 行数增长，并在行卸载时清理。

## 实测结果

| 指标 | 基线 | 最后一轮 | 增长 | 预算 |
| --- | --- | --- | --- | --- |
| Dedicated Worker | 1 | 1 | 0 | 必须为 1 |
| 页面全局监听 | 50 | 50 | 0 | 64 |
| 页面短时定时器 | 0 | 0 | 0 | 16 |
| Worker 监听 | 18 | 33 | 15 | 64 |
| Worker 定时器 | 2 | 17 | 15 | 16 |
| 页面 JS 堆 | — | — | 10.28 MiB | 64 MiB |
| Worker JS 堆 | — | — | 3.85 MiB | 48 MiB |

页面总定时器最终为 15，全部是当前打开 Session 的本地午夜定时器，不进入短时收敛断言。Worker 监听与定时器在第一轮后保持 18→33 和 2→17，不再随 100+ turn 增长；它们对应仍然挂载、尚未关闭的 Session 资源，关闭与删除后的释放由 Session 关闭回收验证覆盖。

## 发现与修复

`BrowserNativeSessionMountCoordinator` 只有 `mount` 与 `dispose`，没有移除空闲投影的入口；反复挂载不同 Session 时 `mounts` 会无界增长，且 `dispose` 后仍保留 detached 快照。新增 `unmount(sessionId)`：空闲 mount 直接删除，active 指向它时清空 active；仍有 `running`、`waiting` 或 `unknown` execution 时以 `SESSION_EXECUTION_ACTIVE` 拒绝，避免卸载隐藏未结算工作。单测覆盖拒绝、成功删除、active 清除、未挂载返回 `false` 与全部删除后快照为空。

## 边界与未验证项

- 只测 scripted LLM 下的 Agent turn；真实 provider 延迟、流式长尾和 token 成本不在本项。
- 堆是强制 GC 后的 JavaScript 堆，不是 OS RSS、GPU 或原生内存；Chromium 之外的浏览器未验证。
- 页面监听计数只覆盖 `window`/`document`；元素监听随 DOM 卸载回收。Worker `live` 对 `once`/`AbortSignal` 仍是上界。
- 16 是 backend 当前的 mounted-Session 上限；本轮正好占满，不证明更高并发或生产容量。
- 本轮不关闭或删除 Session；关闭后的 Worker、订阅、附件句柄与审计句柄回收另行验证。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/resource-lifecycle-long-run.e2e.mjs
```

预算可用 `DSH_POC_RESOURCE_PAGE_HEAP_BUDGET_MB`、`DSH_POC_RESOURCE_WORKER_HEAP_BUDGET_MB`、`DSH_POC_RESOURCE_LISTENER_GROWTH`、`DSH_POC_RESOURCE_TIMER_GROWTH` 调整；调试轮数用 `DSH_POC_RESOURCE_CYCLES`。默认轮数固定为 7。
