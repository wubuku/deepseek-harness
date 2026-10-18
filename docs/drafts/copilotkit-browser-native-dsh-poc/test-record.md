# 验收测试记录

## 运行环境

- 日期：2026-10-19
- Browser：Playwright Google Chrome 与 WebKit，headless；完整 E2E 在 1280px 桌面和 390px 窄屏运行。WebKit 不是 Safari.app 本体。
- Backend：`run.mjs --port 4197 --llm real`；数据目录 `/tmp/copilotkit-browser-native-dsh-real`。
- 模型：`gpt-5.6-sol`，密钥从主工作区 `docs/drafts/.env` 读取。
- Playwright：通过 `DSH_POC_PLAYWRIGHT_MODULE=$HOME/node_modules/playwright/index.js` 指定，不复制依赖到 PoC。

## 真实 Chrome 端到端结果

执行：

```sh
DSH_POC_PLAYWRIGHT_MODULE="$HOME/node_modules/playwright/index.js" \
  npm run test:e2e:chrome:real
```

结果：通过，0 pageerror、0 CopilotKit Cloud 请求；页面请求头和 Session 文本均未包含本地模型凭据。Playwright 观察到 20 个同源 LLM 代理请求，恰等于 DSH 的 19 个 `step/start` 加 1 个 `session/title-llm-request`；标题请求是 DSH 辅助标题生成，不是第二个 Agent Loop。Session `session-d0d2ca8c-5a7c-4541-b529-238e91e877df` 共 145 个事件、12 个 turn、8 个 `tool/call` 和 8 个按 call id 唯一配对的 `tool/result`，记录了：

- 用户读取 SaaS 工作区；`saas_get_workspace` 返回 3 个项目及工作项，模型依据结果回复。
- `saas_create_work_item` 先呈现聊天表单。测试将四个字段从 Agent 初稿都改为不同值，再确认；左侧列表计数变为 4，DSH `tool/result` 记录 `userConfirmed: true`、四个 `userEditedFields` 和最终字段。
- DSH `todo_write` 仅执行一次，产生一个 `todo/write`。
- 第二个业务动作点击取消；Session 保存 `isError` tool result，没有第二个业务操作结果，Agent 正常结束取消轮次。
- 取消后再发消息，助手在同一 Session 中答出刚创建工作项的标题。
- 刷新相同 `sessionId` 后恢复聊天历史和浏览器持久化的 mock SaaS 工作项。
- Session 有真实模型的多段 `text-chunks`；用户操作 prompt 各记录一次；相关工具调用均可按 call id 找到对应 tool result。
- 390px 下工作台在聊天前、无水平溢出；真实模型请求由同源 backend 代理，浏览器请求和 Session 数据不含模型凭据。
- `ask_user_question` 的批准、拒绝、取消都回到原 DSH waiter；取消后同一 Session 可继续。
- 用户在工具等待期间点 CopilotKit Stop 后，原 DSH 工具结果结算、对应 turn 以 `aborted` 结束；随后发送恢复消息成功。
- 第二标签读取相同 Session 时显示只读，聊天控件为 inert，且没有额外写入用户消息；关闭第二标签后主标签可继续。
- 全部 8 个工具调用都恰有一个相同 call id 的结果；验收中的相同 prompt 各只提交一次，mock 业务操作只产生一个成功副作用。

截图：

- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/chrome-real-workbench.png`
- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/chrome-real-agentic-card.png`
- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/chrome-real-agentic-ui-message.png`
- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/chrome-real-mobile.png`
- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/webkit-real-agentic-card.png`
- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/webkit-real-agentic-ui-message.png`
- `/tmp/copilotkit-browser-native-dsh-poc-artifacts/webkit-real-mobile.png`

最新 Chrome E2E Session：`session-d0d2ca8c-5a7c-4541-b529-238e91e877df`。E2E 明确要求模型输出三项列表，并检查每个 `li` 的行高不超过 23px、上下 margin 不超过 3px、padding 为 0、相邻项顶边偏移不超过 24px；同时检查用户气泡宽度、Agentic UI 确认按钮不被输入栏覆盖。Session JSON：`/tmp/copilotkit-browser-native-dsh-real/sessions/session-d0d2ca8c-5a7c-4541-b529-238e91e877df.json`。

Playwright WebKit 使用真实 LLM 完成相同 E2E；Session `session-6133121b-b342-4559-9423-a165c1188499`，145 个事件、19 个 Agent Loop step、1 个标题请求、20 个同源代理请求；0 pageerror、0 CopilotKit Cloud 请求、390px 无水平溢出。Safari.app 本体未手动启动验收。Session JSON：`/tmp/copilotkit-browser-native-dsh-real/sessions/session-6133121b-b342-4559-9423-a165c1188499.json`。

## 单测与构建

- `npm test`：2 passed，覆盖有效工作项更新、source state 不变、未知项目拒绝。
- `npm run build`：通过；Vite 对第三方 `use client` 指令、依赖注释和超过 500 KB 的 chunk 发出警告，未阻断构建。
- scripted E2E：通过；端口 `4198` 的独立无密钥 backend，Session `session-5ecaedd5-0914-4e9e-894b-76f9698ba824`，2 个同源 LLM 代理请求；0 pageerror、0 CopilotKit Cloud 请求，临时服务已停止。
- `npm run test:e2e:restart`：通过；独立 Chrome + scripted backend，Session `session-dcc699e1-2fbe-4f77-9894-d3a8f3cc5a0b`。显式 flush 的 `durableThroughSeq=16`；backend 进程重启两次后 hydration 成功，事件数保持 18，prompt 仅一条，0 pageerror。临时 server、数据和截图位于 `/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/copilotkit-browser-native-restart-wqoWgG/`。

## 未执行/未通过项

- Safari.app 本体手动验收：未执行；Playwright WebKit 的真实 LLM E2E 已通过，不能当作 Safari.app 本体验收。
- 生产 SaaS API、真实授权/审计/服务端幂等、receipt、跨用户隔离和页面关闭后后台运行：未实现、未验证；当前业务工作台及操作为本地 mock。
- CopilotKit 原生 `useFrontendTool` handler 与 `useHumanInTheLoop` 的 DSH 续接：未完成闭环验收。业务工具及问答采用 `useRenderTool` 和自有 DSH 页面桥，不能以其成功替代原生路径的证据。
- adapter/bridge 的去重、重复结算、旧卡片晚到答案、并发同名工具和卸载单测：未补齐；当前 `npm test` 的两项测试仅覆盖业务状态模型。
- 受支持的生产 Worker Agent 注入与相应支持条件：未验收；Provider 仍使用 `agents__unsafe_dev_only`。

## 2026-10-19 文档重评的证据复核

本轮没有重跑浏览器或真实模型，只复核 lockfile、源码、E2E 脚本和前述 Chrome/WebKit 两份持久化 Session。两者各为 145 个事件、12 个 turn、19 个 step、1 次标题请求；8 个工具调用均恰好匹配一个结果。工具序列含工作区读取、两次工作项操作、一次 `todo_write` 和四次问答，没有 `browser_native_ui_probe`。浏览器网络和页面错误观察值沿用原验收记录，不从 Session 计数推导。

脚本在工具验收时显式指定 `saas_create_work_item` 或 `ask_user_question`；它证明指定工具的执行/UI/结果闭环，不证明无工具名提示时的路由成功率。mock 工作台和操作卡都是本 PoC 新写的示例，不能替代真实 SaaS 已有组件迁移测试。三条路线未以同一业务任务做成本、性能或可维护性对照，当前推荐和生产准入条件见[路线重评](../dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)。
