# CopilotKit + Browser-Native DSH PoC 进度

## 当前状态

- **分支**：`poc/copilotkit-browser-native-dsh`
- **基线**：当前已提交的 `research` 分支 HEAD
- **状态**：自有页面桥支持的 SaaS 工作台/Agentic UI、真实模型 Chrome/WebKit E2E、生命周期与 scripted backend 重启恢复已有通过记录；原生前端工具调度、生产 Agent 注入与 adapter/bridge 单测未完成。本轮仅做文档重评，没有重跑 E2E。
- **固定版本**：`@copilotkit/react-core@1.79.1`、`@copilotkit/react-ui@1.79.1`、`@ag-ui/client@1.0.2`、`@ag-ui/core@1.0.2`；版本由本目录 `package-lock.json` 固定。
- **真实验收模型**：`gpt-5.6-sol`；凭据由外部 Node backend 从主工作区 `docs/drafts/.env` 读取。

## 阶段结果

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| 仓库与源码核查 | 完成 | 已阅读根/`docs/` 指引、架构、生命周期规则、两个既有 PoC 和 CopilotKit 固定版本源码记录 |
| 聊天投影 | 完成 | 真实 DSH Session hydration、流式事件、CopilotKit 官方 Chat；未启用第二个 Agent Loop |
| DSH 工具呈现 | 完成 | 保留 DSH `tool/call`/`tool/result` 身份，Session 事件可回放 |
| Browser-Native 前端工具 | 完成 | `saas_get_workspace` 与 `saas_create_work_item` 经页面 MessagePort 回到原 DSH waiter |
| CopilotKit 原生前端工具调度 | 未验收 | 业务闭环采用自有页面桥；`useFrontendTool` probe 注册不等于原生 handler/续跑闭环通过 |
| adapter/bridge 单测 | 未补齐 | 当前两项单测只覆盖领域状态行为；去重、晚到结果和卸载等仍待覆盖 |
| SaaS GUI 与 Agentic UI | 完成 | 左侧工作台 + 右侧聊天；聊天操作卡片可改项目/标题/优先级/负责人，确认后更新业务列表和 DSH tool result |
| 聊天消息排版 | Chrome 与 WebKit 验收通过 | Markdown 列表行距、用户气泡和固定输入框遮挡均以真实浏览器检查；操作卡片确认按钮完整可见 |
| HITL/取消/Stop | Chrome 与 WebKit 验收通过 | 真实模型多轮、真实 `todo_write`、操作卡片确认、问答批准/拒绝/取消、Stop 后原 DSH turn aborted 且同 Session 可继续 |
| Session owner 与刷新 | Chrome 与 WebKit 验收通过 | 第二标签明确只读且不提交消息；刷新恢复同一 Session |
| backend 持久化恢复 | 独立 Chrome scripted E2E 通过 | 显式 flush 后重启 backend 两次；同一 Session 事件数保持 18，`durableThroughSeq=16` |
| 桌面/窄屏呈现 | Chrome 与 WebKit 验收通过 | 1280px 桌面截图、390px 窄屏无横向溢出 |
| 研究成果归档 | 完成 | 选型综述、研究综合报告和 drafts 导读已更新；明确当前首选的证据范围与生产限制，实施陷阱记录见 `lessons-learned.md` |

## 实际验证命令

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | 2 passed | 工作项状态变更、未知项目拒绝 |
| `npm run build` | 通过 | Vite 构建 PoC；依赖含大 chunk 警告 |
| `pnpm run test:docs` | 21/21 gates passed | 文档快速检查通过 |
| `pnpm run doc-sync` | 43/43 gates passed | 包含文档链接、格式、翻译配对、doc-typecheck、站点构建及仓库引用检查 |
| `pnpm exec vitest run scripts/repo-files.spec.ts` | 10 passed | 覆盖递归跳过 `node_modules`、显式字面路径仍可检查 |
| `pnpm exec oxlint scripts/repo-files.ts scripts/repo-files.spec.ts scripts/doc-typecheck.ts` | 通过 | 修改的仓库扫描脚本和测试无 lint 问题 |
| `pnpm run lint` | 未通过 | 仓库全量 lint 在未修改的 `packages/core/tools/tests/json-schema.spec.ts:251` 报 `typescript(unbound-method)`；定向 lint 已通过 |
| `COPILOTKIT_POC_URL=http://127.0.0.1:4198/copilotkit-browser-native-dsh-poc/index.html DSH_POC_PLAYWRIGHT_MODULE=$HOME/node_modules/playwright/index.js npm run test:e2e` | scripted E2E 通过 | Session `session-5ecaedd5-0914-4e9e-894b-76f9698ba824`；2 个 LLM 代理请求；0 pageerror、0 CopilotKit Cloud 请求，临时服务已停止 |
| `DSH_POC_PLAYWRIGHT_MODULE=$HOME/node_modules/playwright/index.js npm run test:e2e:restart` | 通过 | Chrome Session `session-dcc699e1-2fbe-4f77-9894-d3a8f3cc5a0b`；flush + 两次进程重启后同一 Session 事件数为 18、`durableThroughSeq=16`；0 pageerror |
| `DSH_POC_PLAYWRIGHT_MODULE=$HOME/node_modules/playwright/index.js COPILOTKIT_POC_E2E_TIMEOUT=360000 npm run test:e2e:chrome:real` | 真实 Chrome E2E 通过 | 最新 Session `session-d0d2ca8c-5a7c-4541-b529-238e91e877df`；20 个同源 LLM 请求 = 19 个 DSH step + 1 个标题请求，145 events，8/8 tool calls 唯一 result；覆盖 SaaS、HITL、Stop、租约、刷新和窄屏 |
| `DSH_POC_PLAYWRIGHT_MODULE=$HOME/node_modules/playwright/index.js COPILOTKIT_POC_E2E_TIMEOUT=360000 npm run test:e2e:real -- --browser webkit` | 真实 WebKit E2E 通过 | 最新 Session `session-6133121b-b342-4559-9423-a165c1188499`；145 events、20 个代理请求、8/8 工具结果，0 pageerror/Cloud 请求，390px 无溢出 |

真实 E2E 截图保存在 `/tmp/copilotkit-browser-native-dsh-poc-artifacts/`；真实 Session 事件和持久化文件保存在 `/tmp/copilotkit-browser-native-dsh-real/sessions/`。Chrome Session `session-d0d2ca8c-5a7c-4541-b529-238e91e877df` 共 145 个事件、12 个 turn、19 个 Agent Loop step、1 个标题请求、8 个工具调用和 8 个唯一匹配结果；Playwright 观察到 20 个同源 LLM 代理请求，恰等于 `step/start` 与 `session/title-llm-request` 事件数之和。测试覆盖 `saas_get_workspace`、`saas_create_work_item`、`todo_write` 和 `ask_user_question`。验收中的相同用户输入各只记录一次，业务确认结果包含用户编辑字段；页面错误数与 CopilotKit Cloud 请求数均为 0。截图断言三项列表的行高/间距、气泡宽度、Agentic UI 按钮与输入栏不相交，以及 390px 无横向溢出。

WebKit Session 为 `session-6133121b-b342-4559-9423-a165c1188499`。flush/restart Session 为 `session-dcc699e1-2fbe-4f77-9894-d3a8f3cc5a0b`，隔离数据目录中两次 backend 重启后仍为 18 个事件。

## 未完成与限制

- CopilotKit 原生 `useFrontendTool` handler/`useHumanInTheLoop` 续接未完成验收；业务闭环是 `useRenderTool` 加 DSH 自有页面桥。已使用 `/v2` API，不存在因包版本 `1.79.1` 就需要迁移 v2 的结论。
- Provider 的开发期 Agent 注入、同名 waiter fallback、旧卡片晚到结果、并发结算和副作用安全需在产品采用前验证；当前两项单测不覆盖 adapter/bridge。
- Safari.app 本体尚未由自动化或人工启动验收；Playwright WebKit 是 WebKit 引擎路径，不等同 Safari.app 本体。
- 业务 GUI 和业务操作仍为浏览器内 mock，不代表生产 SaaS API 接入完成。
- 浏览器 Worker 仍受页面生命周期约束；不代表页面关闭后 Agent 持续运行。
- 生产 API 的权限、事务、服务端幂等账本、审计 receipt 和未知提交恢复尚未验证。
- 浏览器 Console 的两个静态 preview 404 与基础 DSH Web bootstrap 相同；本轮未修改仓库外 bootstrap。

## 过程记录

- 2026-10-19 路线重评：复核三份 PoC 的不等价验收目标、实际包导入、工具桥和两份留存 Session。修正此前 CopilotKit 末位/assistant-ui 普遍默认的建议，也纠正“`1.79.1` 未使用 v2”的误判。统一结论与代码风险由[选型评估](../dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)维护，验收事实与未执行项由[测试记录](test-record.md)维护。
- 本轮文档检查：`pnpm run test:docs` 21 项通过，`pnpm run doc-sync` 43 项通过；日志为 `/tmp/dsh-route-reassessment-test-docs.log`、`/tmp/dsh-route-reassessment-doc-sync.log`。出站范围以已 fetch 的 `origin/poc/copilotkit-browser-native-dsh` 为基准核对，仅有研究文档改动；主 worktree 未触碰。
- 后续开发需明确生产 Worker Agent 注入方式、移除模糊 waiter 匹配、补齐 adapter/bridge 单测，并用相同真实 SaaS 组件/API 对照 assistant-ui，不能以本轮文档提交宣称这些实现已完成。

- 初次浏览器启动发现新 JSX 文件缺少 React import，修正后重建。
- 首次 SaaS 工具 E2E 暴露工具 handler 没有注册，随后将桥接组件挂载至 CopilotKit Provider 并复测。
- 初次刷新验证发现业务 mock 状态会丢失，加入 localStorage 持久化并通过同 Session 刷新验收。
- 真实模型测试发现普通“帮我创建并等待确认”可能选择通用 `ask_user_question`；自动化验收改为显式指定 `saas_create_work_item`，手动验收说明仍保留自然语言路线。
- 视觉验收发现 CopilotKit 输入栏覆盖较长的 Agentic UI 卡片；移除固定滚动底部留白，让 CopilotKit 根据输入区实际高度计算可滚动空间。
- 用户指出 Markdown 列表项行距过大。检查发现自定义 `.cpk-prose` 选择器未匹配实际 `cpk:prose` 类，Streamdown 列表项还自带 `py-1`；改用属性类选择器并清除列表项上下 padding，E2E 直接核对相邻行偏移。
- 真实模型不保证主动采用列表；E2E 明确请求恰好三项无序列表，再检查实际排版，避免把模型格式随机性误当成 UI 回归。
- 真实 Chrome/WebKit E2E 覆盖 HITL approve/reject/cancel、用户 Stop、停止后同 Session 继续、第二标签只读和刷新恢复；隔离 scripted backend E2E 覆盖 flush 与两次 backend restart。
- WebKit 重跑发现拒绝选项后模型又提交了一次问答工具调用；原测试只约束问题和选项，没有约束答复后的行为。提示补充“收到选择后确认并停止调用工具”后通过，保留该约束避免把模型二次提问误当作 UI hang。

## 手动验收服务

- URL：`http://127.0.0.1:4197/copilotkit-browser-native-dsh-poc/index.html`
- Worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-copilotkit-poc`
- Backend：端口 `4197`，真实 LLM；Session 数据目录 `/tmp/copilotkit-browser-native-dsh-real`；凭据只由 backend 从主工作区 `docs/drafts/.env` 读取。
- 停止方式：启动终端按 `Ctrl-C`；当前后台进程 PID 为 `73522` 时可执行 `kill -TERM 73522`。
- 临时 scripted 验收服务 `4198` 和临时真实测试服务 `4200` 已停止；保留 `4197` 供用户验收。
