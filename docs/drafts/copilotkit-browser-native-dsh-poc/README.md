---
description: "CopilotKit 聊天层与 Browser-Native DSH Agentic UI 的增量验证 PoC。"
---

# CopilotKit + Browser-Native DSH PoC

## Summary

本 PoC 验证的不是“把聊天泡泡接到 DSH 上”，而是既有 SaaS 界面如何进入 AI 助手工作流：用户继续看到项目和工作项等熟悉的业务页面；同一工作区中的 CopilotKit 聊天层能够读取这些页面数据、用可编辑的操作卡片呈现业务动作，并在用户确认后更新同一业务列表。DSH Dedicated Worker、Cordis 插件系统、原有 Agent Loop 和持久化 Session 继续负责模型调用与执行事实。

当前业务工作台和创建工作项操作是本地模拟数据，用于验证交互模式，不连接真实 SaaS API。这个 PoC 因此证明了“浏览器页面资产可经由 DSH 前端工具进入聊天、确认动作可回到同一 DSH turn”的技术组合，不证明某个生产 SaaS 的权限、事务、幂等、审计或后端 API 已集成。

## 目录

- [目标与结论](#目标与结论)
- [架构与数据归属](#架构与数据归属)
- [安装和启动](#安装和启动)
- [手动验收](#手动验收)
- [自动化验收](#自动化验收)
- [安全和限制](#安全和限制)
- [相关资料](#相关资料)

## 目标与结论

面向的产品背景是：SaaS 已有业务 GUI、组件和领域操作，但此前没有 AI 聊天层。添加助手时，关键不是另造一套业务 UI，而是让已有业务数据和操作以自然的方式出现在 Agent 界面中。本 PoC 以项目/工作项工作台演示以下路径：

1. 用户在同一个界面向 DSH Agent 询问当前 SaaS 工作区。
2. DSH 工具通过页面桥读取与左侧业务列表相同的状态；模型据此回复。
3. 用户提出创建工作项后，CopilotKit 在聊天中渲染可编辑表单；项目、标题、优先级和负责人沿用 SaaS 工作台中的字段。
4. 用户确认后，页面调用工作台的业务状态操作；实际结果以 DSH `tool/result` 写回原 Agent Loop 和 Session，再由助手总结。
5. 用户可以拒绝该动作；失败/取消结果留在 DSH Session，后续消息仍复用同一个 Session。

因此，CopilotKit 在这里承担唯一可见聊天和 Agentic UI 呈现；DSH 保留 Agent Loop、工具执行、Session 和模型上下文的权威。Agentic UI 的证据是可编辑的业务动作卡片、确认/取消、业务列表同步变化及 durable tool result，而不只是聊天消息。

## 架构与数据归属

- `src/saas-workspace.tsx` 提供模拟的既有 SaaS 工作台、项目/工作项呈现和浏览器本地持久化；`Reset demo` 清除这份演示数据。
- `src/saas-workspace-model.ts` 实现工作项创建的领域状态变更；未知项目在变更前失败。
- `src/copilotkit-browser-native-tools.ts` 在 Worker 侧注册 `saas_get_workspace` 与 `saas_create_work_item` DSH 工具。调用通过 MessagePort 到页面，由 CopilotKit renderer 和控件处理，再把结果返回原 DSH 工具执行。
- `src/main.tsx` 仅挂载 CopilotKit 聊天层和 SaaS 工作区，不挂载 DSH 原生聊天 UI。DSH 会话/消息映射仍由 `DshAgUiAgent` 提供。
- `src/browser-native-worker.ts` 复用 Browser-Native DSH v2 的 Worker Host、真实 Cordis 插件和 `ctx.agentLoop`；服务端同源 LLM 代理及 Session backend 复用现有 v2 PoC。
- DSH Session 是聊天历史、工具调用/结果和模型上下文的唯一耐久来源。CopilotKit UI 根据 DSH Session 投影并在刷新时 hydration；演示 SaaS 列表状态独立保存在浏览器 `localStorage`，不注入模型上下文。

CopilotKit 和 AG-UI 版本由本目录 `package.json` 与 `package-lock.json` 固定；工具调用身份和 DSH Session seq 的转换见 `src/dsh-agui-agent.ts`。Agent Loop 不在 CopilotKit 中重建。

本地 chat/tool 结果以业务摘要呈现，完整工具参数与结果仍保留在 DSH Session。新会话显示示例提示；已有对话隐藏提示按钮，避免它们挤占聊天阅读空间。

## 安装和启动

要求 Node.js 22.19+ 或 24+；本机真实模型配置沿用仓库 `docs/drafts/.env`，只由 Node backend 读取。若 npm 访问外网需要代理，可在安装前设置：

```sh
export https_proxy=http://127.0.0.1:9981
export http_proxy=http://127.0.0.1:9981
export all_proxy=socks5://127.0.0.1:9981
```

在 PoC 目录安装局部依赖并构建：

```sh
cd docs/drafts/copilotkit-browser-native-dsh-poc
npm ci
npm run build
```

从仓库根目录启动真实 LLM backend；API key 不进入前端，也不要复制或提交 `.env`：

```sh
node docs/drafts/copilotkit-browser-native-dsh-poc/run.mjs \
  --port 4197 \
  --data-dir /tmp/copilotkit-browser-native-dsh-real \
  --llm real \
  --env-file "$PWD/docs/drafts/.env"
```

打开 `http://127.0.0.1:4197/copilotkit-browser-native-dsh-poc/index.html`。新建会话使用 `New session`；已有会话可在刷新时保留 URL 中的 `sessionId`。后台退出用 `Ctrl-C`。真实 LLM 配置下 `run.mjs` 会在 Node 支持时根据 `HTTP(S)_PROXY` 自动启用环境代理。

## 手动验收

建议在桌面 Chrome 先执行，再用窄屏/移动设备检查布局：

1. 确认左侧显示 `Growth launch`、`Platform refresh`、`Customer operations` 和现有工作项，右侧仅显示 CopilotKit 聊天层。
2. 输入“请使用 SaaS workspace 工具读取当前项目和开放工作项”，确认回复内容来自左侧工作台，而非模型猜测。
3. 输入“请调用 `saas_create_work_item`，在 Growth launch 创建计划工作项 Prepare launch review，分配给 You，并展示可编辑卡片”。
4. 在聊天卡片把项目改为 `Platform refresh`、标题改为 `Confirm launch checklist`、优先级改为 `High`、负责人改为 `Mina`，然后点击 `Add to workspace`。
5. 确认左侧开放工作项由 3 增至 4，新工作项显示在首行，聊天卡片显示相同最终值；助手应以确认后的值总结，不再要求第二次确认。
6. 请求 DSH 使用 `todo_write` 添加一个 pending 任务，确认聊天完成且 Session 有 DSH 工具调用和结果。
7. 询问刚刚确认写入的工作项标题，确认助手根据本 Session 中的工具结果回答 `Confirm launch checklist`。
8. 再次提出工作项创建并点击 `Cancel`，确认没有新工作项写入；继续对话，确认取消没有使 Session 失去响应。
9. 让 DSH 调用 `ask_user_question`，分别选择 `Approve`、`Reject` 和 `Cancel`；确认答案分别写回原始 DSH tool call，取消产生工具错误而不是虚构答案。
10. 在一次待回答的 `ask_user_question` 显示时点击聊天输入栏的 `Stop`；确认 DSH waiter 收到 abort、turn 结束，随后同一 Session 还能继续对话。
11. 在第二个浏览器标签打开同一 `sessionId`；确认新标签显示只读原因、聊天不可交互，且没有向该 Session 提交第二份 prompt。关闭第一个标签后刷新新标签以取得写租约。
12. 刷新相同 `sessionId`，确认聊天历史与左侧已确认的模拟工作项都恢复。
13. 390px 窄屏下确认业务面在上、聊天在下，无横向溢出，表单和取消/确认按钮可操作。

以上值是操作样例；如真实模型生成的卡片字段不符合预期，先不要确认，检查 DSH tool call 参数与模型回复。

## 自动化验收

真实 LLM E2E 使用同源服务。先按“安装和启动”启动端口 `4197` 的真实 backend，再在 PoC 目录执行 Chrome 与 WebKit 验收：

```sh
COPILOTKIT_POC_URL=http://127.0.0.1:4197/copilotkit-browser-native-dsh-poc/index.html \
COPILOTKIT_POC_E2E_TIMEOUT=360000 \
DSH_POC_PLAYWRIGHT_MODULE="$HOME/node_modules/playwright/index.js" \
  npm run test:e2e:chrome:real

COPILOTKIT_POC_URL=http://127.0.0.1:4197/copilotkit-browser-native-dsh-poc/index.html \
COPILOTKIT_POC_E2E_TIMEOUT=360000 \
DSH_POC_PLAYWRIGHT_MODULE="$HOME/node_modules/playwright/index.js" \
  npm run test:e2e:real -- --browser webkit
```

脚本使用真实模型并验证多轮 Session 记忆、真实流式事件、业务工作区读取、可编辑操作卡片、确认/取消、`todo_write`、HITL 批准/拒绝/取消、Stop 后继续、刷新恢复、双标签写租约冲突、列表排版、移动布局、工具 call/result 配对、无重复 prompt/副作用、浏览器无密钥及无 CopilotKit Cloud 请求。它也检查业务工具卡不展示原始 JSON，且已有消息后隐藏欢迎建议。运行会产生模型费用和网络延迟；截图由 `COPILOTKIT_POC_ARTIFACT_DIR` 控制，Session JSON 留在 backend 的数据目录。

Scripted E2E 应使用独立的无密钥 backend，避免改变正在验收的真实模型服务。先在仓库根目录启动：

```sh
node docs/drafts/copilotkit-browser-native-dsh-poc/run.mjs \
  --port 4198 \
  --data-dir /tmp/copilotkit-browser-native-dsh-scripted \
  --llm scripted
```

再在 PoC 目录运行：

```sh
COPILOTKIT_POC_URL=http://127.0.0.1:4198/copilotkit-browser-native-dsh-poc/index.html \
DSH_POC_PLAYWRIGHT_MODULE="$HOME/node_modules/playwright/index.js" npm run test:e2e
```

Playwright 包可通过 `DSH_POC_PLAYWRIGHT_MODULE` 指向本机已安装入口，不必将其复制进 PoC。

Backend flush 与进程重启恢复使用自动启动/停止独立 scripted backend 的 Chrome 测试：

```sh
DSH_POC_PLAYWRIGHT_MODULE="$HOME/node_modules/playwright/index.js" npm run test:e2e:restart
```

它验证显式 flush 的 durable sequence、关闭并重启 backend 后从同一数据目录恢复 transcript、再次 flush/restart 后 Session 事件数不变；临时 backend、Session 文件和截图均留在操作系统临时目录。

单元测试和静态构建：

```sh
npm test
npm run build
npm run test:e2e
```

## 安全和限制

- 业务界面和 `saas_create_work_item` 是浏览器内 mock，不代表生产可直接写入 SaaS。真实集成应替换领域状态函数为受认证、授权、审计和服务端幂等保护的业务 API，保留用户确认与错误语义。
- 浏览器关闭后 Dedicated Worker 不会继续运行；服务端持久化 Session 不代表后台 Agent 仍在执行。
- 取消工具调用会产生 DSH tool error；它不是已完成业务操作。重试确认会产生新的 DSH 工具调用，生产副作用必须由 SaaS 后端按稳定 operation id 去重。
- 浏览器对话存储和模拟 SaaS `localStorage` 是不同数据。前者来自 DSH Session，后者只为演示业务列表刷新保持一致。
- 复用 DSH Web bootstrap 时浏览器控制台可能有 `/open-in-app/apps` 和 `/plugins/events` 的 preview 404；这些请求不承载本 PoC 的聊天、SaaS 操作或 LLM 调用。
- 双标签页打开同一 Session 时，只有一个标签持有写租约；其他标签会显示只读提示并禁用聊天交互。关闭写入标签后，需要刷新只读标签以重新申请写租约。
- Playwright WebKit 的真实 LLM E2E 不等同 Safari.app 本体手动验收；Safari.app 本体仍需用户最终验收。

## 相关资料

- [DSH Browser-Native v2 PoC](../browser-native-dsh-poc/README.md)：Worker、Cordis、Agent Loop、Session backend 和真实 LLM 代理的基础实现。
- [assistant-ui + Browser-Native DSH PoC](../assistant-ui-browser-native-dsh-poc/README.md)：另一种聊天呈现层的增量验证。
- [CopilotKit 源码核查研究](../copilotkit-browser-native-dsh-source-verification.md)：版本、公开扩展点和实验前风险。
- [实施计划](implementation-plan.md)、[设计说明](design.md)、[实施经验与陷阱](lessons-learned.md)、[进度](progress.md)、[变更清单](change-ledger.md)和[验收记录](test-record.md)。
