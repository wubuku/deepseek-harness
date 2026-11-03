# 冷启动镜像下载可靠性

## 现象

16 路并发冷启动 preview 时，首次启动常出现 2–8 个页面报 `web-preview tunnel: boot payload failed with HTTP 503: TypeError: Failed to fetch`，页面没有 crash，Worker 仍在运行；同一浏览器后续轮次、或系统预热后全部成功。

## 证据与定位

服务端临时探针（已移除）显示失败请求 `static-close finished=false destroyed=true`，写入报 `ECONNRESET`/`EPIPE`，socket 已写出约 10.5 MB（镜像文件 9,841,578 bytes）；成功请求 `finished=true`。这说明服务端未写完，客户端先行断开，而不是服务端读文件失败或超时（`readFile` 101–515 ms）。

浏览器侧 `requestfailed` 为 `/preview/vfs-image.tar.gz net::ERR_ABORTED`，部分为 `net::ERR_INVALID_CHUNKED_ENCODING`。Worker 内临时探针（已移除）把失败定位到 `inflateImageStream` 读取响应 body 的阶段：`fetch` 已返回 200，读取在 56–316 ms 后抛 `TypeError: Failed to fetch`，因此排除了 gzip/DecompressionStream 实现问题。

对照组（同一 backend、16 路、冷启动）：

| 实验 | 结果 |
| --- | --- |
| 页面内 `fetch('/preview/vfs-image.tar.gz')` + `arrayBuffer()`，2 轮 | 32/32 成功，服务端 `finished=true` |
| Worker 内 raw `new Response(body).arrayBuffer()`，首轮 | 6/16 失败 |
| 同上，Worker 创建后延迟 1.5 s 再 fetch | 16/16 成功 |
| Worker 内 fetch 小文件 `/api/browser-native/health` | 16/16 成功 |
| 系统与浏览器预热后 16 路、32 Worker | 全部成功 |

结论：不是服务端竞态、超时或 gzip 管线问题，而是 Chromium 在“冷启动 + 同时多 Worker + 大响应体”时取消 worker 发起的下载；取消以客户端 RST 表现，服务端写入随之 `ECONNRESET`，Worker 读到截断的 body。具体触发 Chrome 内部哪条资源上限或调度规则未能进一步定位，列入残余缺口。

## 修复

`packages/experimental/webworker-runtime/src/storage/image-fetch.ts` 把镜像下载从 `worker-host.ts` 抽出并加有界重试：

- 镜像 GET 幂等，每次重试都重新读取完整响应，不拼接断开的旧 body。
- 最多 3 次尝试；只对 `TypeError`（`fetch` 拒绝或 body 读取失败）与 408/429/5xx 重试。
- 退避为 250 ms × 尝试序号 + 0–250 ms 随机抖动：冷启动时失败的 Worker 同时重试会再次形成同样的瞬时压力，抖动将它们摊开。
- 4xx 与非 gzip 响应立即失败，避免把错误配置报告成网络抖动。
- 懒加载归档同样经 `readImage`，共享该重试。

## 可判定证据

- `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/image-fetch.spec.ts` 5/5：完整响应 1 次即成功；首个响应 body 截断 → 2 次并成功；503 → 2 次并成功；404 → 1 次并失败；持续截断 → 3 次后失败。
- `DSH_POC_COLD_FAULT=1 DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/cold-start.e2e.mjs`：16 路 × 2 轮，每轮 `routedImageRequests=32`（每个 Worker 的首次镜像请求被注入 abort，重试被放行），`failures=0`，单轮 7.9/8.6 s、最慢页面 6.8/7.2 s。
- 同脚本不带故障注入，16 路 × 3 轮 = 48/48 成功，单轮 wall 7.8–8.8 s。
- `pnpm run build:artifacts` 7/7、`pnpm run build:check` 2/2。

## 残余缺口

- 未定位 Chromium 内部的具体取消来源；修复保证“失败可恢复”，不保证“失败不发生”。
- 失败路径下一次冷启动最多增加约 0.5 s 退避加抖动；持续 5xx 的部署要耗尽 3 次尝试才报错。
- 镜像仍是单文件 chunked 传输，没有分块校验、断点续传或服务端并发整形。
- 未在 Windows、Safari/WebKit 复测该重试路径。
