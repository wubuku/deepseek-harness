# 浏览器支持矩阵

试点结论：产品默认执行路径是 durable 服务端 host；本矩阵只判定浏览器 Worker 降级/离线路径的支持边界。Worker + OPFS 的完整 Harness 只支持 **Chromium 桌面**（Chrome、Edge、Chromium）；Safari、iOS/iPadOS 与移动浏览器继续被 Worker 启动门禁拒绝。移动端另有一条 **server-host + UI-only** 路径：页面不启动 Worker、不使用 OPFS，由服务端 durable host 执行 turn，WebKit 的 iPhone 13 描述符已跑通（见[移动端 UI-only 策略](mobile-ui-only.md)）。两条路径的判定互不替代：UI-only 可用不代表 Worker 路径可用。

## 矩阵

| 平台 | Worker + OPFS | server-host UI-only | 依据 |
| --- | --- | --- | --- |
| Chrome / Edge / Chromium 桌面（macOS、Linux、Windows） | 支持（试点） | 支持 | 唯一有自动化 E2E 与真实 Chrome 证据的组合；Dedicated Worker、MessageChannel、OPFS、IndexedDB、SubtleCrypto 均可用 |
| Safari 桌面 | 不支持 | 支持（WebKit 26.4） | Worker 路径的 OPFS 不可用（见[替代路径评估](#webkit-替代路径评估结论)）；`/mobile` 页面在 WebKit 完成服务端 turn |
| Firefox 桌面 | 不支持 | 未验证 | 无 E2E；OPFS 与持久化行为未验证，UI-only 也未跑过 |
| iOS / iPadOS 上的所有浏览器 | 不支持 | 支持（WebKit iPhone 13 描述符） | Worker 外壳受 WebKit 限制且 OPFS 不可用；UI-only 不依赖 Worker 存储，已在 390×664 视口完成 turn，真实设备未验证 |
| Android Chrome 等移动 Chromium | 不支持 | 未单独验证 | 移动视口、软键盘、后台回收与 OPFS 配额未覆盖；UI-only 只在 WebKit 描述符上跑过 |

“支持”只表示本目录记录的脚本化与真实 LLM E2E 路径可运行，不是生产兼容承诺；具体能力仍以运行时探测结果为准，UA 判定不是安全边界。

## 运行时门禁

[browser-native-support.ts](../../../apps/web/src/browser-native-support.ts) 的 `browserNativeSupportIssue` 按固定顺序判定：先看 UA 是否为非移动的 Chromium（`Chrome/`、`Chromium/` 或 `Edg/`，且不含 `Android`、`iPhone`、`iPad`、`iPod`、`Mobile`），再依次检查 Dedicated Worker、MessageChannel、OPFS（`navigator.storage.getDirectory`）、IndexedDB 与 SubtleCrypto。任一缺失返回首个问题码，不继续探测后续能力。

[preview.ts](../../../apps/web/src/preview.ts) 只在浏览器原生模式（`?browser-native=1`）下执行该门禁；不通过时渲染 `[data-browser-native-unsupported]`（`role="alert"`，本地化原因），不创建 Worker、不连接 Session、不显示 composer 与导出按钮。通过时行为与本轮之前一致：先选 host source，再创建 Worker、连接页面控制通道并挂载 UI。

`/mobile` 的 UI-only 页面不经过该门禁，也不创建 Worker：它只需要 fetch、`ReadableStream` 与 DOM，由 backend 按 principal cookie 授权。门禁仍只约束 Worker + OPFS 的全功能路径。

## 证据

- 单测：`pnpm exec vitest run apps/web/tests/browser-native-support.spec.ts`，3 项通过，覆盖 Chromium 桌面通过、Safari/Firefox/移动 UA 拒绝、五个能力码按序返回。
- E2E：`node docs/drafts/browser-native-dsh-poc/tests/browser-support-gate.e2e.mjs`，用 Safari 18 桌面 UA 打开 preview，断言只看得到门禁提示、没有 Workspace 状态条/composer/导出按钮；Chrome 156 输出 `{"result":"passed","unsupportedState":"NON_CHROMIUM_DESKTOP","workerBooted":false}`。
- 支持路径回归：`product-visibility.e2e.mjs` 在同一个构建上仍通过，证明门禁没有拦截 Chrome 桌面。
- UI-only 移动路径：`node docs/drafts/browser-native-dsh-poc/tests/mobile-ui-only.e2e.mjs`，WebKit 26.4 的 iPhone 13 描述符在移除 `navigator.storage` 后完成服务端 turn，`Worker` 构造 0 次，见[移动端 UI-only 策略](mobile-ui-only.md)。
- 替代路径：`node docs/drafts/browser-native-dsh-poc/tests/webkit-alternative-path.e2e.mjs`，Playwright WebKit 26.4 上 OPFS 不可用；伪造成 Chromium UA 后启动仍停在 `OPFS_SYNC_ACCESS_UNAVAILABLE`，见下一节。

## 缺口与重访条件

- 门禁依赖 UA 字符串；Chromium 内嵌 webview、企业策略改写的 UA 可能误判。能力探测只覆盖本 PoC 直接使用的 API，不覆盖配额、驱逐或性能差异。
- 没有真实 Safari 自动化；Playwright WebKit 已用于替代路径评估（见下一节），但它不是 Safari 本身。
- 若要把 iOS 纳入 Worker 目标，必须先完成：真实 iOS 设备上的 OPFS 可用性/配额/回收验证，Worker 内存与崩溃行为，Safari E2E 接入，以及确认“客户端执行、服务端权威”在 WebKit 下仍成立；在此之前 UI-only 仍是最小移动路径，不宣称 Worker 兼容。
- UI-only 只用 WebKit 移动描述符验证，不是 iOS 真机；真实设备的软键盘、后台回收、网络切换与主屏幕 Web App 行为未覆盖。
- 版本下限未定义：只验证当前 Chrome 稳定版；旧版 Chromium 可能在 OPFS 或 Worker 行为上不同。

## WebKit 替代路径评估结论

本轮用 Playwright WebKit 26.4（macOS headless）完成一次能力探测与启动尝试，结论是**不为 Safari/iOS 实现替代路径**，保留现有 UA 门禁。运行 `node docs/drafts/browser-native-dsh-poc/tests/webkit-alternative-path.e2e.mjs` 输出：

```json
{"result":"passed","webkitVersion":"26.4",
 "capabilities":{"dedicatedWorker":true,"messageChannel":true,"indexedDb":true,"subtleCrypto":true,
  "sharedArrayBuffer":false,"crossOriginIsolated":false,
  "opfsDirectory":false,"opfsWrite":false,
  "opfsError":"UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).",
  "workerStorage":{"directory":false,"syncAccessHandle":false,
   "error":"UnknownError: The operation failed for an unknown transient reason (e.g. out of memory)."}},
 "gate":{"state":"NON_CHROMIUM_DESKTOP","composer":0,"workerBooted":false},
 "spoofedChromium":{"outcome":"failed","consoleErrors":["Error: browser-native startup blocked: OPFS_SYNC_ACCESS_UNAVAILABLE"]}}
```

- WebKit 具备 Dedicated Worker、MessageChannel、IndexedDB 与 SubtleCrypto，但 `navigator.storage.getDirectory()` 在页面与 Worker 中都抛 `UnknownError`，OPFS 读写与 `createSyncAccessHandle` 均不可用。
- 把 UA 改成 Chromium 桌面绕过门禁后，页面继续启动，但 Workspace 初始化在 `OPFS_SYNC_ACCESS_UNAVAILABLE` 处中断，composer 未出现，且没有任何测试端口；说明门禁之外还有 OPFS 同步访问句柄的硬依赖。
- 备选路径逐一评估：把 VFS 换成 IndexedDB backing 需要重写镜像、租约与 durable snapshot 的同步语义，并长期维护双实现；纯内存 VFS 失去刷新恢复与跨标签一致；去掉 Worker 直接在主线程执行会破坏页面响应性与故障隔离。三条路径的收益只覆盖不在试点目标的 WebKit，因此不做。
- Playwright WebKit 不是 Safari 本身，真实 Safari 26 的 OPFS 行为可能不同；本结论只主张“本批没有可验证的 WebKit 运行路径”，不主张 Safari 永远不可用。若 Apple 后续提供可用的 OPFS 同步访问，重访需真实 Safari 设备 E2E、配额与 durable 证据。
