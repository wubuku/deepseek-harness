# 成熟 React SaaS：三路线同口径实验计划

## 摘要

题设是已有业务页面、组件和 API，但没有聊天层的 React SaaS。本实验比较扩展 DSH 原生 Web UI、assistant-ui、CopilotKit 的实际接入成本，而不是比较聊天气泡。三条路线共用 Browser-Native DSH Worker、默认 agent loop、模型代理、业务工具、业务 API、可编辑表单及测试故事；只更换聊天投影和工具卡挂载方式。实验从已推送的 CopilotKit PoC 分支 checkpoint 开始，分支为 `poc/saas-agentic-ui-comparison`，不修改其他 worktree 的未跟踪截图。

## 场景与验收

1. 项目任务：在既有工作台创建任务；助手读取业务数据，复用同一任务表单，用户修改标题和负责人后确认；列表与聊天结果一致。
2. 支持工单：读取工单，修改负责人、优先级和状态；手动 GUI 与助手调用同一 API，过期版本提交必须明确失败。
3. 账单审批：展示账单、金额和确认表单；批准产生审计凭据，拒绝不产生副作用；模拟只读角色由 API 拒绝。
4. 恢复与安全：稳定 operation id 防止重复提交，查询 receipt 处理响应丢失；Stop 取消等待，晚到结果不能结算其他调用；刷新重放历史不重复执行业务操作。

## 实施顺序

1. 建立共享实验目录、版本锁定与启动入口，先验证原生 UI 的真实挂载，避免用自写聊天框代替 DSH UI。
2. 实现可独立使用的 SaaS GUI、持久化 mock API、角色与版本校验、幂等账本及领域单测。
3. 共用 Worker 工具插件与精确 call id 桥；分别挂接原生工具 slot、assistant-ui tool renderer、CopilotKit render tool。
4. Scripted 浏览器测试控制工具调用和错误；真实 LLM 测试核查多轮、流式、业务工具及同一 DSH turn 的续接。
5. 保存可复现脚本、截图、Session/API 脱敏证据，记录未通过项目、接入成本和选型结论，不预设胜出者。

## 变量控制与限制

- 三路线使用相同模型、工具说明、初始业务数据、提示词和验收故事；各自隔离 workspace/Session，避免交叉污染。
- 模型凭据仅由 backend 读取主 worktree 的 `docs/drafts/.env`；浏览器不持有凭据，不连接 CopilotKit 云。
- 模拟角色不是生产认证；mock API 不代表生产事务、多租户隔离与安全审计已经完成。
- Dedicated Worker 随页面终止，不是页面关闭后持续运行的后台 Agent。
- 所有新代码优先留在本目录；目录外变动在变更清单解释。测试通过前不宣称完整成功。
