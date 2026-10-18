# CopilotKit + Browser-Native DSH PoC 实施计划

## 目标

验证 CopilotKit 作为唯一可见聊天和 Agentic UI 交互层时，既有 SaaS Web GUI 的业务数据、表单字段与操作是否能通过 Browser-Native DSH 进入同一自然语言工作流；真实 DSH Cordis Host、插件系统、`ctx.agentLoop` 和 Session 仍在 Dedicated Worker/同源 backend 运行。不能以独立聊天 demo 或仅展示工具卡片代替闭环。

## 实施阶段

1. **基线核查**：固定 CopilotKit 1.79.1、AG-UI 1.0.2；检查 Provider、AbstractAgent、连接/停止、前端工具和渲染路径，并阅读现有两个 Browser-Native PoC。
2. **聊天投影**：复用 v2 Worker bootstrap 与同源 LLM/Session backend，将 DSH Session 投影为 AG-UI/CopilotKit transcript；保持 DSH Loop 和 Session 唯一权威。
3. **既有 SaaS GUI 样例**：提供项目/工作项业务工作台；通过 DSH 页面工具读取工作台数据；在聊天中以可编辑表单呈现原有业务操作字段。
4. **真实前端操作续接**：确认后由页面执行业务状态操作，通过原工具 call id 返回 DSH `tool/result`；拒绝/取消不产生业务副作用，并能在同一 Session 后续对话。
5. **持久化与生命周期**：覆盖会话 hydration、真实多轮记忆、业务 mock 刷新、stop、失败后继续、backend restart/flush、双标签写权冲突，并明确页面关闭时 Worker 终止。
6. **验收与交付**：补充单测、scripted 与真实 LLM Playwright E2E、截图和脱敏事件；维护中文 README、设计、进度、变更清单、测试记录及已知限制。

## 约束

- 复用 DSH Loop，不另启 CopilotKit BuiltInAgent 模型循环，不维护第二份模型历史。
- 模型凭据只留在 backend 读取的本机环境文件，不复制到前端、日志、Session 或 Git。
- 生产 SaaS 接入要替换 PoC mock，沿用真实认证/授权、审计、事务和服务端幂等；浏览器 Worker 不是后台 Agent。
- 代码、测试、配置和中文文档留在本目录；目录外修改需先说明并在 `change-ledger.md` 记录。
