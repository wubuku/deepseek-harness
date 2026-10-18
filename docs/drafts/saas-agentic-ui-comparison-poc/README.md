# 成熟 React SaaS：三路线 Agentic UI 对照实验

## 摘要

这个增量实验回答：**已有业务 GUI 和业务 API、但没有聊天层的 React SaaS，如何让助手复用现有交互，而不是重新写一套业务产品？** 左侧是独立可操作的 mock SaaS 工作台，右侧每次只挂载一种聊天层：DSH 原生 Web UI、assistant-ui 或 CopilotKit。三条路线共用真实 Browser-Native DSH Worker、默认 `ctx.agentLoop`、Session、模型代理、工具、表单和业务 API；不使用第二个模型循环。

这里模拟的是“已有资产”：先有可手动操作的任务、工单、账单表单和后端 API，再将**同一 React 组件、同一提交函数**挂入各聊天层。它比三个互不相同的 demo 更接近公平比较，但仍不是把某个真实成熟 SaaS 的复杂组件全部迁入，因此不能把结果外推成生产实施成本定论。

## 导读

- [实施计划](implementation-plan.md)：题设、相同业务故事与控制变量。
- [设计与评估](design-and-assessment.md)：共用部分、三路接线、实际成本与限制。
- [手动验收](manual-acceptance.md)：可直接操作的输入、预期变化和失败判断。
- [测试记录](test-results.md)：实际执行情况、证据目录、失败与修复。
- [进度](progress.md)、[变更清单](change-ledger.md)：实施状态与目录外变动。
- [研究总入口](../README.md)、[选型结论 owner](../dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)。原三份 PoC 保留不替换：[原生](../browser-native-dsh-poc/README.md)、[assistant-ui](../assistant-ui-browser-native-dsh-poc/README.md)、[CopilotKit](../copilotkit-browser-native-dsh-poc/README.md)。

## 安装和构建

要求 Node.js 24+、仓库 pnpm 依赖和 Browser-Native preview/VFS 产物；实验使用独立 npm package 与 lockfile。真实凭据保留在主 worktree 的 `docs/drafts/.env`，不要复制到实验目录。

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
cd docs/drafts/saas-agentic-ui-comparison-poc
npm ci
npm run build
npm test
```

本轮隔离 worktree 首次构建复用了相同 HEAD 的忽略产物，见[变更清单](change-ledger.md)；完整干净构建路径沿用原 PoC 文档，未在本轮重新执行全仓 `pnpm run build`。不需要删除共享缓存。

## 启动

在本目录执行 scripted 模式，不需要凭据：

```sh
npm start -- --port 4207 --data-dir /tmp/dsh-saas-comparison-scripted
```

真实模型模式：

```sh
export https_proxy=http://127.0.0.1:9981
export http_proxy=http://127.0.0.1:9981
export all_proxy=socks5://127.0.0.1:9981
export NO_PROXY=127.0.0.1,localhost
npm start -- --port 4207 --llm real \
  --env-file /Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env \
  --data-dir /tmp/dsh-saas-comparison-manual
```

若指定端口已占用，改用 `--port 0`，以启动输出的实际端口为准。`run.mjs` 在当前 Node 支持时自动为真实模式启用环境代理；凭据只由 backend 读取。退出使用 `Ctrl-C`。

同一个服务提供三种入口，默认各用隔离的业务 workspace 和 Session：

- `http://127.0.0.1:4207/saas-agentic-ui-comparison-poc/index.html?ui=native`
- `http://127.0.0.1:4207/saas-agentic-ui-comparison-poc/index.html?ui=assistant`
- `http://127.0.0.1:4207/saas-agentic-ui-comparison-poc/index.html?ui=copilot`

页面顶部可以切换路线。`workspace` 参数可创建独立验收数据，例如 `&workspace=manual-native-01`；不要故意让三个顺序测试共用已经修改的数据后再比较。`sessionId` 由 URL 记录，刷新恢复同一 Session；“新会话”只重建对话，不清空业务数据。

本次已启动服务的实际端口、PID、日志和停止方式见[验收运行记录](progress.md#2026-10-19验收服务与交付检查)；示例中的 `4207` 不表示该端口当前一定运行本服务。

## 自动化验收

使用本机 Playwright，可通过 `DSH_POC_PLAYWRIGHT_MODULE` 指向其他安装路径。每次测试监听动态端口、创建独立数据目录，结束时关闭浏览器与服务，保留脱敏证据：

```sh
npm run check:core
npm run test:e2e
npm run test:e2e -- --webkit
npm run test:e2e:lifecycle
HTTPS_PROXY=http://127.0.0.1:9981 HTTP_PROXY=http://127.0.0.1:9981 NO_PROXY=127.0.0.1,localhost \
  node --use-env-proxy --import tsx tests/comparison.e2e.mjs --real
```

追加 `--webkit` 使用 Playwright WebKit，追加 `--ui=assistant` 等只测一条路线。WebKit 不等于 Safari.app；未经 Safari.app 实测不能宣称 Safari 已通过。Scripted 只验证协议、投影与业务闭环，不能替代真实 LLM 的自然语言理解和记忆验收。

## 已知限制

- CopilotKit 仍使用 `agents__unsafe_dev_only` 和 `useRenderTool` 加自有 Worker 桥；没有把本实验当成原生 `useFrontendTool`/`useHumanInTheLoop` 调度已验收。
- 账单确认是共同的业务工具等待和人工提交，不等于已验证全部 DSH 审批/晚到问答语义。默认工具列表包含 `ask_user_question`，本轮主要业务故事不依赖它。
- 只读角色来自明确标注的 mock 请求头，不是生产认证；业务 JSON 的原子替换和 receipt 不是生产事务数据库、跨进程幂等或多租户授权。
- 刷新恢复已落盘对话、工具结果及业务列表，不自动恢复正在等待的表单。页面关闭会终止 Dedicated Worker；未知提交可查询 receipt，但尚未实现自动对账并补写 DSH 工具结果。
- 三种 UI 同包构建只为实验方便，未以包大小、首屏性能或生产 bundling 作比较。正式产品只保留选定的一种聊天层。
