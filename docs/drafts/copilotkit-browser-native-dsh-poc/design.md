---
description: "CopilotKit + Browser-Native DSH PoC 的 Agentic UI 验证设计和数据归属。"
---

# Agentic UI 设计说明

## 研究问题

SaaS 已有业务 GUI、业务组件和领域逻辑，但此前没有 AI 聊天层。新增助手的价值在于让用户通过自然语言接触已有业务数据和操作，并在聊天中继续使用熟悉的字段、选择和确认动作，而不是让模型从零重建业务界面或在聊天之外另起一个业务循环。

## 本 PoC 验证的闭环

`Operations workspace` 是既有 SaaS GUI 的最小代表，提供项目、工作项、优先级、负责人和状态。CopilotKit 是唯一可见聊天和交互层。DSH 为该工作区提供 `saas_get_workspace` 与 `saas_create_work_item` 两个工具：前者读取页面上的业务状态；后者启动聊天内表单。用户可修改表单字段，再确认或取消。页面执行领域状态更新后，把真实结果返回等待中的 DSH 工具；DSH 继续原有 Agent Loop，并将 `tool/result` 与后续回复写入同一 Session。

这一验证刻意包含一个“模型建议”和“用户最终提交值”的差异：测试将项目、标题、优先级、负责人全部改成不同于 Agent 初稿的值。前端 tool result 记录最终字段、`userConfirmed` 和 `userEditedFields`，模型据此总结已应用的真实值。取消通过同一个 DSH waiter 返回工具错误，不更新工作区；后续输入仍能进入该 Session。

## 数据所有权

| 数据 | 权威来源 | CopilotKit/页面职责 |
|---|---|---|
| 用户消息、模型输出、工具调用和工具结果 | DSH Session | 作为 AG-UI/CopilotKit transcript 投影，刷新时从 Session 重建 |
| SaaS 模拟项目和工作项 | 页面 `localStorage` 与业务状态模块 | 展示现有 GUI，并将有效业务数据提供给 DSH 工具 |
| 待处理的页面操作 | DSH 正在等待的工具调用和 call id | 渲染可编辑表单，明确批准或取消后将结果回给原调用 |
| LLM 凭据 | Node backend 的本机环境配置 | 浏览器只请求同源 LLM endpoint，不接触凭据 |

页面表单的 React 回调只留在主线程；Worker 收到可序列化的参数，通过 MessagePort 请求页面 handler。`operationId` 来自稳定 DSH tool call id；即便本 PoC 的 mock 不需要网络去重，生产 API 仍必须以此类稳定标识实现幂等。

## 结论边界

本实现从固定 `1.79.1` 包导入 `@copilotkit/react-core/v2`，不是 v1 API。CopilotKit 提供聊天和 `useRenderTool`，业务执行与等待结算由 DSH Worker 和本地 `BrowserNativeFrontendToolBridge` 完成；`useFrontendTool` 只注册了一个 probe，真实模型验收没有覆盖它。当前没有使用原生 `useHumanInTheLoop` 或分段 AG-UI run，因此不能把可运行的业务 UI 闭环等同于 CopilotKit 原生工具调度也已验收。

Provider 的 `agents__unsafe_dev_only` 是实验接入方式；业务结果结算还有按同名工具查找 waiter 的 fallback。生产采用前需要受支持的 Agent 注入方式、精确调用身份和晚到结果测试，而不是简单加 public key 消除告警。路线收益与风险的统一评价见[三份 PoC 重评](../dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)。

实验支持“CopilotKit 可以承载聊天和注册 Agentic UI renderer，同时由 Browser-Native DSH 保留单一 Agent Loop 和 Session”的判断。它也暴露了不可省略的工作：SaaS 需要为页面数据读取、业务动作、表单控件、确认、取消、持久化和权限错误提供明确桥接，单靠聊天组件不会自动带入 SaaS 既有资产。自动化 E2E 覆盖同一 DSH waiter 的 HITL 结算、CopilotKit Stop、失败/取消后继续、单写 owner、flush 和 backend 重启恢复；这些结果说明 adapter 必须显式承担生命周期协调，而非只映射消息与工具卡片。

本 PoC 使用小型模拟工作台，验证的是 UI/工具/执行闭环，不是对复杂真实 SaaS 页面复用成本的广泛评估。生产验证仍需接入真实业务 API、身份与权限、事务边界、重复请求账本、审计日志、用户会话隔离，以及真实浏览器部署环境中的 Safari.app 和服务端恢复故障模式。Playwright WebKit 自动化不等同 Safari.app 手动验收。浏览器 Worker 只在页面生命周期内运行，不是后台 Agent。
