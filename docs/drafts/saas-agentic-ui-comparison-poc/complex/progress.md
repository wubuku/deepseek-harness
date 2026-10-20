# 实验进度

## 2026-10-20 成本对照扩展

执行位置为主工作区 `research`，唯一 worktree。已实现跨客户批量续约、共享报价编辑器、内容绑定审批、旧版本拒绝与重新审核。assistant-ui 和 CopilotKit 在真实 Chrome 及 Playwright WebKit 上均通过同一真实模型故事；每次运行均为 2 个用户 turn、5 个工具调用/结果、4 次业务写入、1 份批量提交 receipt。证据与限制见[测试记录](test-results.md)。

真实模型验收先暴露两处测试/接入缺陷：验收器在成功提交后误判并追加 prompt；`portfolio_apply` 还要求了业务上无意义的 `customerId`。已修正控制流和工具参数，并重跑四项真实浏览器矩阵。旧的失败尝试留在本机临时目录，不列为通过证据；正式证据只收录修正后的运行。

本轮初步成本结论：在“DSH 是唯一 Agent Loop、SaaS 已有 React 业务组件、只增加一个聊天层”的限定下，assistant-ui 的接入总成本更低；复杂 UI 业务本体两路线共用，CopilotKit 的原生工具/HITL 有实际价值，但仍需维护 AG-UI 分段适配，当前实验未证明其节省的自编排成本足以抵消该适配。结论和适用条件见[设计与评估](design-and-assessment.md#相同复杂故事的实测与成本判断)。

## 环境

- 日期：2026-10-20。
- 执行环境：历史隔离 worktree `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-saas-complex`；实验完成后已 fast-forward 合并到 `research`，并移除隔离 worktree 与实验分支。
- 固定依赖：CopilotKit 1.79.1、AG-UI 1.0.2、assistant-ui 0.15.29，沿用父目录 lockfile。

## 当前阶段

实验已实现并完成主路线验收：真实 Worker/Host/默认 Loop、动态页面工具、共享报价编辑器、原生 frontend handler/HITL/Agent context、精确调用结果续接、取消、错误后继续、多轮、刷新和持久化恢复。新增账单争议模块后，assistant-ui 与 CopilotKit 仍复用同一个 DSH 适配器并完成真实 Chrome/WebKit 验收。CopilotKit 只有聊天/交互职责，DSH 与业务 API 继续分别保存执行事实和业务事实。初步路线评估见[设计与评估](design-and-assessment.md#相同复杂故事的实测与成本判断)。

原生与 assistant-ui 对照保留可运行功能，不为等量优化扩大范围。父入口三路线回归通过；原两个 PoC 源码未修改。复杂实验代码和证据已进入 `research`，本进度记录保留隔离执行阶段的历史事实。

## 验证记录

1. 原生调度实验通过：结束 AG-UI 观察段后 framework 执行工具并返回结果，原 DSH turn 继续，不新增用户 prompt。
2. 局部 `npm run build` 通过；父实验 `npm test` 9 个、新实验 `npm run test:complex` 15 个通过；`npm run check:complex` 的限定 strict 检查通过。新增数据库/HTTP 快照校验拒绝坏数据而非静默恢复初始值。
3. 最近一次复杂故事 Chrome scripted 三路线均通过，各 11 条消息、13 个业务检查点，采集真实 DOM 流式变化；本轮修正脚本后 CopilotKit 与 assistant-ui 在 Chrome / Playwright WebKit 的真实模型复杂故事均通过，各 12 个检查点。assistant-ui WebKit 额外验证了审批版本变化后的安全停止、重新读取和发送。
4. CopilotKit Chrome / WebKit 真实生命周期重新通过，包含非空业务数据重启、历史恢复、双标签写权和待审批刷新后继续。父原入口的 `npm run test:e2e` 三路线通过。
5. 隔离 worktree 首轮 `test:docs` 21 项通过；`doc-sync` 曾为 41 项通过、2 项失败，失败原因是隔离环境的 website/Host 依赖缺失，后续单独 `docs:build` 已通过。合并到 `research` 后重新执行的 `test:docs` 为 21/21、`doc-sync` 为 43/43，`git diff --check` 通过；没有改动无关源码，详细范围见[测试记录](test-results.md)。
6. 新增账单模块的 scripted 矩阵、真实 Chrome 矩阵和 Playwright WebKit 矩阵均通过；每条路线均为 1 个 DSH turn、3 个工具调用/结果、2 次业务写入。真实 Chrome 首次因提示歧义在批准后安全停止，未计为通过，修正提示后重跑通过；失败事实和修正已写入[测试记录](test-results.md#第三个业务模块账单争议减免)。

本机检查日志：`/tmp/dsh-complex-doc-quick.log`、`/tmp/dsh-complex-doc-sync.log`、`/tmp/dsh-complex-doc-site-build.log`。完整测试证据已存入本目录 `evidence/`，不依赖临时日志长期存在。只读复用了既有 website/node_modules，没有清理共享缓存。

真实 LLM 验收使用 Node `--use-env-proxy`，并将 `127.0.0.1,localhost,::1` 放入 `NO_PROXY`，使上游模型请求走本机 HTTP 代理而 Playwright 到本机服务保持直连。流式验收同时检查浏览器渐进文本与 DSH Session 的持久化文本 chunk；修正后的 CopilotKit、assistant-ui Chrome 与 Playwright WebKit 真实模型复杂故事和账单模块均通过，assistant-ui WebKit 还覆盖了审批版本变化后的安全停止、重新读取和发送。一次空 `assistant/message` 和一次批准后安全停止被测试拒绝为通过，未被抹平。

## 本机验收服务

- 入口（已停止）：`http://127.0.0.1:56935/saas-agentic-ui-comparison-poc/complex/index.html?ui=copilot&workspace=manual-acceptance-01`。
- 模式：真实模型，同源 LLM 代理和 Session/业务持久化；只由 backend 读取主工作区 `docs/drafts/.env`。
- worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-saas-complex`；工作目录为其中的 `docs/drafts/saas-agentic-ui-comparison-poc`。
- PID：`98157`；端口：`56935`；数据目录：`/tmp/dsh-complex-acceptance-20261019-orfm2k`；实验收尾时已停止服务，数据目录保留。
- 日志：`/tmp/dsh-complex-acceptance-20261019-orfm2k/server.log`；停止：`kill -TERM 98157`，不是杀掉其他用户服务。
- 手操从[验收说明](manual-acceptance.md)开始。`server-smoke` 是启动自检数据；`manual-acceptance-01` 留给用户，想复测初始报价可换新的 workspace。

旧开发 scripted 服务不作为最终验收入口。页面关闭终止 Worker，不承诺后台持续执行；停止服务后重新启动时应复用数据目录，端口以新终端输出为准。

验收服务以独立 `server-smoke` 业务数据做过真实浏览器三轮自检：记住代号、调用页面工具分配两张工单、再询问代号。三轮均结束，只有一次业务写入和一份 receipt，最后回复银杏海鸥。完成后关闭该页面并重启 backend 载入同一份数据，不占用用户验收 Session。
