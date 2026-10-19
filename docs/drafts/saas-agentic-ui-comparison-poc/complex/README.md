# 客户续约：复杂 SaaS Agentic UI 实验

## 摘要

本实验模拟已有工单、客户、报价编辑器和业务 API 的 React SaaS，为它加入助手。用户可以跨页面操作、与 Agent 协同编辑、在聊天里使用原有报价组件、拒绝或批准后继续执行。DSH 原生 UI、assistant-ui 与 CopilotKit 使用同一业务故事、后端、模型和默认 DSH Agent Loop，但不再强制共用全部聊天交互实现。

与[第一轮同口径实验](../README.md)不同，CopilotKit 路线使用真正的 `useFrontendTool` handler、`useHumanInTheLoop` respond 和 `useAgentContext`，不只是 `useRenderTool`。分段 AG-UI run 让原 DSH 工具等待页面结果时，CopilotKit 能执行自己的工具调度；续接仍属于原 DSH turn。是否更省总工程量，需要结合[评估](design-and-assessment.md)判断，不能仅由功能跑通推定。

CopilotKit 是本轮的主验收路线，另外两条保留可运行对照，不继续进行等量框架优化。新入口独立于父实验，未改动原 Browser-Native DSH 和 assistant-ui PoC。用户手动切换业务页面；本实验不提供 Agent 自动导航、任意 JSX 生成或生产多租户认证。

## 导读

- [实施计划](implementation-plan.md)：研究问题、故障矩阵和控制变量。
- [设计与评估](design-and-assessment.md)：责任、分段时序、状态所有权及路线差异。
- [手动验收](manual-acceptance.md)：用户可直接照做的输入、操作和成功凭据。
- [测试记录](test-results.md)：实际命令、证据、失败和未执行项。
- [进度](progress.md)：本机服务 URL、数据、日志与停止方式。
- [变更清单](change-ledger.md)：修改范围、复用和上游重放说明。

## 安装与构建

从父 PoC 目录执行，沿用其固定版本和 lockfile。首次环境需要先完成[父目录的 preview/VFS 构建](../README.md#安装和构建)，不需要清理共享缓存。

```sh
cd docs/drafts/saas-agentic-ui-comparison-poc
npm ci
npm run build
npm test
npm run test:complex
npm run check:complex
```

`check:complex` 对 domain、桥和分段适配器执行 strict 检查，消费已构建的 DSH 类型声明；它不是整个 GUI 或整个仓库的 typecheck。此次本机复用相同 checkpoint 的忽略构建产物与已有局部依赖，未重新执行 `npm ci` 或全仓 `pnpm run build`。

## 启动与测试

无凭据 scripted 模式：

```sh
npm run start:complex -- --port 0 --data-dir /tmp/dsh-complex-manual-scripted
```

真实模型只由 backend 读取主工作区的 `docs/drafts/.env`。不要把该文件复制到实验目录或浏览器。代理只用于 backend 的外网模型请求。

```sh
export https_proxy=http://127.0.0.1:9981
export http_proxy=http://127.0.0.1:9981
export all_proxy=socks5://127.0.0.1:9981
export NO_PROXY=127.0.0.1,localhost,::1
export NODE_OPTIONS=--use-env-proxy
npm run start:complex -- --port 0 --llm real \
  --env-file /Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env \
  --data-dir /tmp/dsh-complex-manual-real
```

终端输出实际端口，入口为 `/saas-agentic-ui-comparison-poc/complex/index.html?ui=copilot`；将 `ui` 改成 `assistant` 或 `native` 可比较另外两条路线。页面头部也能切换。`workspace=manual-01` 提供独立业务数据，建议每条路线使用不同名称；不指定 Session 时，本机记忆键按路线与 workspace 隔离。URL 中显式的 `sessionId` 指定已有对话，不是租户授权机制。

```sh
npm run test:complex:e2e
npm run test:complex:e2e -- --webkit
npm run test:complex:lifecycle
npm run test:complex:lifecycle -- --webkit
HTTPS_PROXY=http://127.0.0.1:9981 HTTP_PROXY=http://127.0.0.1:9981 NO_PROXY=127.0.0.1,localhost,::1 \
  node --use-env-proxy --import tsx complex/tests/experiment.e2e.mjs --real
```

追加 `--ui=copilot` 或 `--ui=assistant,native` 可限定路线；追加 `--webkit` 使用 Playwright WebKit，不代表 Safari.app 已通过。测试分配临时数据目录和动态端口，保留截图、请求地址、工具身份、业务凭据与结果 JSON。自动化使用本机 Playwright，默认安装路径沿用父目录，也可设置 `DSH_POC_PLAYWRIGHT_MODULE`。

## 限制

Mock 角色不是生产认证，JSON 文件不是事务数据库。批准、权限、版本与幂等属于业务 API，不由聊天框架自动提供。等待审核时暂不允许切换页面、客户、角色；选择变化与陈旧版本仍由命令和 API 检查。

刷新恢复已记录事实，不恢复旧 React waiter，也不自动批准。DSH 恢复时产生的中断工具结果仍是权威；缺少已结算结果的历史调用只作中断展示，不重放 handler。停止不是回滚已提交的业务操作。页面关闭会结束 Dedicated Worker，不是持续运行的后台 Agent。

CopilotKit 仍使用开发期 `agents__unsafe_dev_only`，生产注入尚未验证。此实验没有验证 A2UI、远程多 Agent、完整离线能力、生产包体/性能或总开发工时。两条第三方路线都未启用额外模型循环，CopilotKit 云不是运行前提；实际网络检查见测试记录。
