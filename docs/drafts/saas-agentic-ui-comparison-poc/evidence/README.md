# 验收证据

本目录保存 2026-10-19 同口径实验的脱敏摘要和真实浏览器截图，作为[测试记录](../test-results.md)的持久证据；完整 Session 和服务数据只留在该记录列出的本机临时目录。JSON 由实际运行产物生成，不含模型凭据。

## 真实模型

- [Chrome 汇总](real-chrome.json)、[WebKit 汇总](real-webkit.json)：各三路线、每路线十条用户消息；记录 Session id、工具调用/结果数、业务 receipt 数、模型请求数、流式长度样本和浏览器错误。
- Chrome 表单：[DSH 原生](real-chrome-native-task-form.png)、[assistant-ui](real-chrome-assistant-task-form.png)、[CopilotKit](real-chrome-copilot-task-form.png)。
- WebKit 表单：[DSH 原生](real-webkit-native-task-form.png)、[assistant-ui](real-webkit-assistant-task-form.png)、[CopilotKit](real-webkit-copilot-task-form.png)。

三条路线都显示同一个 `BusinessForm`。截图截取创建任务的人工修改阶段，不代表业务已提交；业务成功由后续 API receipt、工作台变化和 DSH `tool/result` 共同断言。长对话需滚动到卡片底部确认；截图中 composer 下方不可见的表单控件不等于不能操作，自动化逐一点击并核验业务结果。Playwright WebKit 不是 Safari.app。

## 无密钥回归

- [Chrome scripted](scripted-chrome.json)、[WebKit scripted](scripted-webkit.json)：最终十轮 UI/协议回归；模拟流先等待页面呈现首片段，再放行剩余内容，避免短流被 UI 批处理导致不稳定的长度采样。不作为真实模型理解和记忆的证据。
- [生命周期](lifecycle.json)：三路线的双标签写权冲突、显式 flush 后 backend 重启、等待表单时刷新后继续对话。`pendingRefreshContinues` 不表示旧表单或旧 waiter 可恢复。

本实验不按真实模型的读取工具次数或 DOM 更新次数给框架排名；模型有选择自由，UI 的批处理也会影响长度采样。没有测量生产包大小或对接真实 SaaS 的总工程成本。
