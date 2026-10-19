# 实验验收证据索引

记录日期为 2026-10-19，固定版本和文件 SHA-256 见 [manifest.json](manifest.json)。JSON 保留测试捕获的调用身份、业务凭据、网络地址和计数，不包含模型密钥、Cookie 或完整环境文件。临时服务地址和 Session id 仅用于定位当次本机实验，不是可公开复用的服务。

| 文件 | 实际含义 |
|---|---|
| [copilot-scripted-chrome.json](copilot-scripted-chrome.json) / [WebKit](copilot-scripted-webkit.json) | CopilotKit 原生完整故事与故障注入，非真实模型 |
| [copilot-real-chrome.json](copilot-real-chrome.json) / [WebKit](copilot-real-webkit.json) | 两种浏览器分别访问真实后端模型的完整故事，含模型请求与 DSH step 对照 |
| [copilot-real-complex-chrome-20261019.json](copilot-real-complex-chrome-20261019.json) / [WebKit](copilot-real-complex-webkit-20261019.json) | 本轮修正脚本后的 CopilotKit 真实模型复杂故事；包含可见流式文本、Session chunk、工具/HITL、业务 receipt 和模型请求归属 |
| [assistant-real-complex-chrome-20261019.json](assistant-real-complex-chrome-20261019.json) / [WebKit](assistant-real-complex-webkit-20261019.json) | 本轮修正脚本后的 assistant-ui 真实模型复杂故事；WebKit 记录了一次安全停止后重新读取并发送的续接 |
| [real-complex-retries-20261019.json](real-complex-retries-20261019.json) | 没有计为通过的真实模型重试：空回复和审批版本不一致后的安全停止；用于说明测试没有吞掉失败 |
| [copilot-real-lifecycle-chrome.json](copilot-real-lifecycle-chrome.json) / [WebKit](copilot-real-lifecycle-webkit.json) | 真实模型、非空业务数据及 Session 重启、双标签写权、审批中刷新后继续 |
| [assistant-scripted-chrome.json](assistant-scripted-chrome.json) / [native-scripted-chrome.json](native-scripted-chrome.json) | 最近一次复杂故事 scripted 对照证据；三路线各 11 条用户消息和 13 个检查点 |
| [CopilotKit scripted Chrome 截图](copilot-complex-scripted-chrome.png)、[assistant-ui](assistant-complex-scripted-chrome.png)、[DSH 原生](native-complex-scripted-chrome.png) | 同次运行三条路线的完成界面；用于观察聊天布局和 SaaS 业务页面协作 |
| [CopilotKit 真实 Chrome 截图](copilot-complex-real-chrome.png) / [Playwright WebKit](copilot-complex-real-webkit.png) | 真实模型复杂故事完成界面；WebKit 不是 Safari.app |
| [copilot-scripted-lifecycle-chrome.json](copilot-scripted-lifecycle-chrome.json) / [WebKit](copilot-scripted-lifecycle-webkit.json) | 加入数据库快照校验后的 scripted 非空数据重启回归 |
| [Chrome 审核图](shared-form-real-chrome.png) / [WebKit 审核图](shared-form-real-webkit.png) | 用户可见的共享报价编辑器及批准/拒绝按钮 |
| [controls-real-webkit-summary.json](controls-real-webkit-summary.json) | 较早三路线真实 WebKit 对照全部通过，不等于其他路线已经运行最后新增的所有观测断言 |
| [controls-real-chrome-partial-summary.json](controls-real-chrome-partial-summary.json) | 较早真实 Chrome 对照：CopilotKit、assistant-ui 通过；原生在视口检查失败 |
| [native-layout-recheck-chrome.json](native-layout-recheck-chrome.json) | scoped 留白修正后原生 Chrome scripted 全故事通过，不冒充真实模型重测 |
| [controls-scripted-chrome-summary.json](controls-scripted-chrome-summary.json) | 默认复杂实验命令的三路线回归，包含模型请求归属断言 |
| [parent-regression-chrome.txt](parent-regression-chrome.txt) | 父实验原入口三路线回归，不是新复杂故事 |
| [acceptance-server-smoke.json](acceptance-server-smoke.json) | 最终真实服务三轮浏览器自检的结果，以及 backend 重启后保留的事实 |

自动化脚本还在各自临时数据目录保留 Session 原始日志、业务 JSON 与更多截图。提交候选材料只保留这里有明确用途的脱敏子集，完整范围与未执行项见[测试记录](../test-results.md)。
