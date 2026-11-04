---
description: "验证移动端策略：iOS 无 OPFS 时由服务端 Host 执行 turn，浏览器只渲染 UI，不启动 Worker 也不依赖 Worker 存储。"
---

# 移动端 UI-only 策略

## 结论

**iOS/Safari 走“服务端 Host 执行 + 浏览器只做 UI”这一条路径可用；它不启动 Worker，也不依赖 OPFS 或 IndexedDB。** Playwright WebKit 26.4 的 iPhone 13 描述符（390×664）在页面脚本运行前移除 `navigator.storage`，仍完成了一次真实服务端 turn：`POST /session/durable` 返回 202，`/session/durable/stream` 返回 200，页面显示助手文本、`Worker` 构造次数为 0、durable 状态为 `completed`、服务端 Session 有 6 条事件。

这不等价于“现有 Browser-Native 全功能在 iOS 可用”。Worker + OPFS 的完整 Harness 仍只在 Chromium 桌面通过；Safari/iOS 的 Worker 路径继续被门禁拒绝。本路径是同一套服务端 Session/durable host 的窄 UI 前端，不是把现有 Web UI 搬进移动浏览器。

## 实现

- 新页面 `mobile-ui-only.html`，由 backend 在 `/mobile` 与 `/mobile.html` 提供。页面只有一个 transcript、composer 和状态行，没有 Worker、OPFS、IndexedDB 或本地缓存写入。
- 提交时调用 `POST /api/browser-native/session/durable`，随后读取 `/api/browser-native/session/durable/stream` 的 NDJSON，按 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 与 `settled` 渲染。
- Session、事件序列、owner 租约与 durable 运行记录都在 backend；刷新或换标签不依赖浏览器存储。
- `durable-host-v2.mjs` 新增可选 `authToken`，内部模型请求带 `x-browser-native-auth`。没有它时 durable host 在自己的 LLM proxy 上拿到 401，hosted 的单进程 token 门禁因此无法与 durable turn 同用。
- 页面把 `window.__DSH_MOBILE_UI_ONLY__`、`window.__DSH_LAST_TURN_ID__` 与 `window.__DSH_WORKER_REQUESTS__` 暴露给测试；`Worker` 被包装成计数并在构造时抛错，任何回退到客户端执行都会让断言失败。

## 验证

```sh
node docs/drafts/browser-native-dsh-poc/tests/mobile-ui-only.e2e.mjs
```

默认 WebKit + iPhone 13；可用 `DSH_POC_BROWSER=chromium` 或 `DSH_POC_DEVICE` 切换。脚本启动 scripted backend、设置本地 auth 与 principal cookie、断言：

| 断言 | 结果 |
| --- | --- |
| 页面在 `navigator.storage === undefined` 下加载 | 通过 |
| 移动视口内 composer 可见、Send 按钮不越界 | 通过（390×664） |
| 提交后出现助手文本并包含 probe | 通过 |
| `Worker` 构造次数 | 0 |
| durable 状态 | `completed` |
| 服务端 Session 事件 | 6 条，含 `assistant/message` |
| 浏览器存储 | 未调用；`storage` API 在启动前已移除 |

## 与现有支持矩阵的关系

- Chromium 桌面：Worker + OPFS 完整 Harness，保持原判定。
- Safari/iOS/移动：只放行 `/mobile` 的 UI-only 路径；`?browser-native=1` 的 Worker 门禁继续拒绝，因为 OPFS 同步访问不可用（见[浏览器支持矩阵](browser-support-matrix.md#webkit-替代路径评估结论)）。
- 本路径不是“纯浏览器零服务端”：它明确依赖同源 backend 的 Session 权威、durable host 与 LLM proxy。

## 边界

- 页面是 PoC 窄 UI，不是正式产品界面；没有会话列表、历史回填、附件、审批卡、导出、重连状态或软键盘专项处理。
- 只验证服务端 durable turn 的文本与工具事件渲染；durable host 的工具 roster 仍是服务端可执行子集，未覆盖浏览器侧全部工具。
- WebKit 移动描述符不是 iOS 真机 Safari；真实设备上的滚动、软键盘、后台回收、网络切换与主屏幕 Web App 行为未验证。
- 未验证多标签并发、跨设备继续同一 Session、推送通知或离线草稿；这些都需要额外的服务端与 UI 能力。
- 认证沿用本地 token + principal cookie；正式身份、租户与权限不在本页范围。
