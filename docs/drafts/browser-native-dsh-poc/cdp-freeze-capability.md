---
description: "记录 Chrome 156 自动化环境能否通过 CDP 制造页面隐藏或冻结，以及这些结果对后台标签 lease 结论的影响。"
---

# CDP 页面隐藏/冻结能力结论

## Summary

Chrome 156.0.8078.79 的 Playwright 自动化页面无法通过 CDP 制造后台标签的 hidden 或 frozen 状态。[cdp-freeze-capability.e2e.mjs](tests/cdp-freeze-capability.e2e.mjs) 逐项探测后给出 `cdp-page-freeze-unavailable`，因此 A 的“用 CDP 模拟后台节流”替代路径不成立；后台标签自然节流仍只有环境阻塞结论，不能写成通过。

## 判定标准

一次运行满足以下全部条件才记录该结论：

- `Emulation.setPageVisibilityOverride` 不存在或调用失败；
- `Page.setWebLifecycleState({ state: 'frozen' })` 被接受，但不产生 `frozen` lifecycle event，`document.visibilityState` 仍为 `visible`；
- freeze 窗口内 Dedicated Worker 的 workspace lease 仍至少续租一次；
- `Emulation.setVirtualTimePolicy({ policy: 'pause' })` 能停页面定时器，`advance` 后恢复，但 `visibilityState` 仍为 `visible`；
- 页面无 error，无跨源请求。

任一条件在未来 Chrome 版本改变时，harness 的断言失败，而不是继续沿用旧结论。

## 证据

运行命令：

```sh
node docs/drafts/browser-native-dsh-poc/tests/cdp-freeze-capability.e2e.mjs
```

Chrome 156.0.8078.79（headless）输出摘要：

```json
{"browser":"chrome","browserVersion":"156.0.8078.79","verdict":"cdp-page-freeze-unavailable",
 "excluded":{
  "visibilityOverride":"Protocol error (Emulation.setPageVisibilityOverride): 'Emulation.setPageVisibilityOverride' wasn't found",
  "pageSetWebLifecycleState":{"commandAccepted":true,"lifecycleEvents":["commit","DOMContentLoaded","load","networkAlmostIdle","networkIdle"],"visibility":"visible","mainThreadTicks":24,"leaseRenewalsDuringFreeze":1},
  "virtualTimePolicy":{"commandAccepted":true,"visibilityWhilePaused":"visible","pageTicksWhilePaused":25,"pageTicksAfterAdvance":35,"renewalsWhileVirtualPaused":0}},
 "pageErrors":[]}
```

- `Emulation.setPageVisibilityOverride` 在该 Chrome 构建中不存在。
- `Page.setWebLifecycleState('frozen')` 只返回命令成功；没有 `frozen` lifecycle event，页面主线程定时器继续，Worker lease 继续续租。该命令只改变浏览器内部 lifecycle 标签，不改变页面可见性或调度。
- `Emulation.setVirtualTimePolicy({ policy: 'pause' })` 暂停页面定时器与 Worker 心跳（`renewalsWhileVirtualPaused=0`），`advance` 后恢复页面定时器；它控制虚拟时钟，不改变 `visibilityState`，也无法把页面切回真实时间执行。

## 对 A 的影响

[候选盘点与选取](next-batch-inventory-and-selection.md)中 A 的自然节流实验仍然 `blocked`：自动化 Chrome 始终把页面报告为 `visible`。[background-tab-lease.e2e.mjs](tests/background-tab-lease.e2e.mjs) 的旧 note 把 `Page.setWebLifecycleState` freeze 当作“唯一 lease 续租证据”，本结论撤回该表述；该命令不制造冻结。

已有的页面冻结 lease 续租证据只说明“CDP 命令被接受时 Worker 心跳不变”，不能推导后台标签、OS 级挂起或页面被浏览器节流时 lease 仍可维持。

## 未验证

- 真实用户把标签切到后台、Chrome intensive throttling、tab discard 与 BFCache。
- OS 睡眠、系统级进程挂起、浏览器崩溃或网络中断。
- 其他 Chrome 版本、Safari/WebKit、Firefox 和未来的 CDP 能力。
- 后台标签的 Workspace append、turn 终态和 lease 失配恢复。

本结论只覆盖当前 checkout、Chrome 156 的自动化会话。
