# 实验进度

## 环境

- 日期：2026-10-19。
- worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-saas-complex`。
- 分支：`poc/saas-agentic-ui-complex`，从已提交的同口径实验 checkpoint 创建；其他工作区不作修改。
- 固定依赖：CopilotKit 1.79.1、AG-UI 1.0.2、assistant-ui 0.15.29，沿用父目录 lockfile。

## 当前阶段

实验已实现并完成主路线验收：真实 Worker/Host/默认 Loop、动态页面工具、共享报价编辑器、原生 frontend handler/HITL/Agent context、精确调用结果续接、取消、错误后继续、多轮、刷新和持久化恢复。CopilotKit 只有聊天/交互职责，DSH 与业务 API 继续分别保存执行事实和业务事实。初步路线评估见[设计与评估](design-and-assessment.md#初步路线判断)。

原生与 assistant-ui 对照保留可运行功能，不为等量优化扩大范围。父入口三路线回归通过；原两个 PoC 源码未修改。当前修改留在隔离 worktree，尚未自动 commit/push，也未改变主工作区的 WIP。

## 验证记录

1. 原生调度实验通过：结束 AG-UI 观察段后 framework 执行工具并返回结果，原 DSH turn 继续，不新增用户 prompt。
2. 局部 `npm run build` 通过；父实验 `npm test` 9 个、新实验 `npm run test:complex` 11 个通过；`npm run check:complex` 的限定 strict 检查通过。新增数据库/HTTP 快照校验拒绝坏数据而非静默恢复初始值。
3. 最近一次复杂故事 Chrome scripted 三路线均通过，各 11 条消息、13 个业务检查点，采集真实 DOM 流式变化；CopilotKit Chrome / WebKit 真实模型各 10 条消息、12 个检查点完整通过，Session 模型请求分别为 31/31 与 26/26 DSH step。
4. CopilotKit Chrome / WebKit 真实生命周期重新通过，包含非空业务数据重启、历史恢复、双标签写权和待审批刷新后继续。父原入口的 `npm run test:e2e` 三路线通过。
5. `test:docs` 21 项通过；`doc-sync` 41 项通过、2 项失败。缺少 website 依赖导致的构建失败在连接现有依赖后，单独 `docs:build` 重跑通过；Host 构建缺少其他 workspace 依赖导致的 doc-typecheck 仍未通过，没有改动无关源码。`git diff --check` 通过，详细范围见[测试记录](test-results.md)。

本机检查日志：`/tmp/dsh-complex-doc-quick.log`、`/tmp/dsh-complex-doc-sync.log`、`/tmp/dsh-complex-doc-site-build.log`。完整测试证据已存入本目录 `evidence/`，不依赖临时日志长期存在。只读复用了既有 website/node_modules，没有清理共享缓存。

真实 LLM 验收使用 Node `--use-env-proxy`，并将 `127.0.0.1,localhost,::1` 放入 `NO_PROXY`，使上游模型请求走本机 HTTP 代理而 Playwright 到本机服务保持直连。原生 UI 的流式采样器同时使用 MutationObserver 和 20ms 定时读取，避免错过框架在单次 DOM mutation 中应用的多段文本变化；修正后 Chrome 三路线 scripted 与 CopilotKit 双浏览器真实模型故事通过。

## 本机验收服务

- 入口：`http://127.0.0.1:56935/saas-agentic-ui-comparison-poc/complex/index.html?ui=copilot&workspace=manual-acceptance-01`。
- 模式：真实模型，同源 LLM 代理和 Session/业务持久化；只由 backend 读取主工作区 `docs/drafts/.env`。
- worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-saas-complex`；工作目录为其中的 `docs/drafts/saas-agentic-ui-comparison-poc`。
- PID：`98157`；端口：`56935`；数据目录：`/tmp/dsh-complex-acceptance-20261019-orfm2k`。
- 日志：`/tmp/dsh-complex-acceptance-20261019-orfm2k/server.log`；停止：`kill -TERM 98157`，不是杀掉其他用户服务。
- 手操从[验收说明](manual-acceptance.md)开始。`server-smoke` 是启动自检数据；`manual-acceptance-01` 留给用户，想复测初始报价可换新的 workspace。

旧开发 scripted 服务不作为最终验收入口。页面关闭终止 Worker，不承诺后台持续执行；停止服务后重新启动时应复用数据目录，端口以新终端输出为准。

验收服务以独立 `server-smoke` 业务数据做过真实浏览器三轮自检：记住代号、调用页面工具分配两张工单、再询问代号。三轮均结束，只有一次业务写入和一份 receipt，最后回复银杏海鸥。完成后关闭该页面并重启 backend 载入同一份数据，不占用用户验收 Session。
