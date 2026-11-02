---
description: "记录跨标签审批归属与拥有者退出后恢复投影的双页 E2E 证据。"
---

# 跨标签审批归属实施进度

## Summary

双页 harness 已通过。并发标签在拥有者持锁时进入 `recovery-conflict`，不触达后端、不显示审批卡片；拥有者拒绝使审批恰好结算一次；拥有者关闭后克隆标签接管同一 Session，待决审批结算为 `TOOL_OUTCOME_UNKNOWN`，不重问、不重放，后续 prompt 正常完成。

## 实现

| 位置 | 变更 |
| --- | --- |
| [cross-tab-approval.e2e.mjs](tests/cross-tab-approval.e2e.mjs) | 新增双页 harness：`window.open` 克隆标签、并发冲突断言、单次结算、关闭拥有者后的接管与恢复投影。 |

未修改产品代码；本批只验证既有单写者与审批结算语义，并将其记录为决策。

## 证据

- `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/cross-tab-approval.e2e.mjs`：Chrome `156.0.8078.79` 通过。
- 并发阶段：`concurrentTabState = recovery-conflict`，克隆标签后端请求数 0，审批卡片数 0。
- 拥有者拒绝：`approval/asked = 1`、`approval/decided = 1`、工具结果 1。
- 拥有者关闭后接管：`tool/result.error.code = TOOL_OUTCOME_UNKNOWN`，审批卡片 0，`approval/asked = 2`、`approval/decided = 1`，模型请求数不变，审批文件未生成，随后 prompt 完成且计数不变。
- 页面错误、Worker 错误、跨源请求均为 0。

## 限制

仅覆盖 Chrome 156 同 BrowserContext 的 `window.open` 克隆标签、durable Session 与 scripted 审批。未覆盖 Workspace lease 同时开启的交接、真实模型审批、只读观察者标签、跨设备接管、Safari/WebKit 和浏览器崩溃。
