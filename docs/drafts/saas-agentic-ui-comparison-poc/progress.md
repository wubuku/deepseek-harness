# 实施进度

## 2026-10-19：checkpoint 与实验准备

- 已确认原 CopilotKit worktree 的文档重评 checkpoint 已推送且工作区干净；精确提交通过本分支 Git 历史核查。
- 新 worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-saas-comparison`；分支 `poc/saas-agentic-ui-comparison` 已推送，起点干净。
- 主 worktree `research` 的 `copilotkit-poc-before.png` 是已有未跟踪文件，保持原样；不据此宣称所有 worktree 都干净。
- 已阅读文档规范、架构、生命周期规则及三份 PoC。先验证原生 UI 的嵌入点，再实现共用 API 和业务组件。
- 待执行：依赖安装与构建、领域单测、三路线 scripted/真实模型浏览器验收；当前尚未声称任何新增业务场景通过。

## 2026-10-19：同口径业务闭环

- 已实现任务创建、支持工单更新、账单审批三类 mock SaaS GUI/API；三路线复用同一表单、API、版本校验、角色拒绝和 operation receipt。
- 已实现精确 DSH `toolCallId` 页面桥、取消/卸载保护、历史只读重放，以及 Browser-specific preset；没有 bash、文件和 web 工具。
- 已通过 9 项单测、Chrome/WebKit scripted、Chrome/WebKit 真实 LLM、三路线生命周期测试；证据、限制和具体命令见 `test-results.md`。
- 真实模型首轮发现并修复共用 LLM proxy 对“先文本后工具”和多工具碎片的处理缺陷；修复和回归已记录在 `change-ledger.md`。
- 已更新 `docs/drafts/README.md` 与选型报告：同口径结果不再支持仅因旧 CopilotKit PoC 先做过业务 demo 就把 CopilotKit 自动排首位；当前 assistant-ui 是轻量接入基线，CopilotKit 是强候选，DSH 原生适合接受其装配体系的产品。

## 2026-10-19：验收服务与交付检查

- 真实模型服务监听 `127.0.0.1:4217`；三入口为 `http://127.0.0.1:4217/saas-agentic-ui-comparison-poc/index.html?ui=native`、`?ui=assistant`、`?ui=copilot`。同一个页面顶部可切换路线；原有 `4197` 服务未改动。
- 启动 worktree 和分支见本文开头；Node PID `95762`，日志 `/tmp/dsh-saas-comparison-manual-4217.log`，数据 `/tmp/dsh-saas-comparison-manual-4217`。凭据仅 backend 读取主 worktree 的 `docs/drafts/.env`。PID 是本次运行记录，重启后以新进程为准。
- 停止本次服务：先用 `ps -p 95762 -o pid,command` 确认仍是本 PoC，再执行 `kill -TERM 95762`；复现启动命令见 [README](README.md#启动)，端口改为 `4217`，数据目录使用上述路径。
- Chrome/WebKit 真实模型最新运行都返回退出码 0；每路线十条用户消息，无浏览器错误，业务 receipt 各 4。脱敏汇总与六张表单截图保存在 [evidence](evidence/README.md)。
- `4217` 供手动验收的真实服务另经安装版 Chrome 三入口冒烟，均完成 GUI 保存和模型回复；日志 `/tmp/dsh-saas-manual-service-verified.log`。首次原生预览确认的说明见[测试记录](test-results.md#启动检查的注意事项)。
- 已通过 `pnpm run test:docs`（21 项）和 `pnpm run doc-sync`（43 项）；聚焦源码 lint、共享核心严格类型检查及 lockfile 固定依赖核对通过。最终补充文档仅再执行对应链接、排版和引用检查；这些检查不表示全前端适配器均已通过严格类型检查。
- 已补齐最后一轮 Chrome/WebKit scripted 十轮证据，修正快速模拟流与 DOM 批处理的时序假设；三路线均通过，9 项单测再次通过。故障、首片段可观察门控与实际证据见[测试记录](test-results.md#启动检查的注意事项)。
