# 测试记录

## 当前结论

2026-10-19，本目录的同口径实验在独立 worktree、分支 `poc/saas-agentic-ui-comparison` 上完成以下验证。证据目录位于各次命令输出的临时目录；其中包含初始页、业务表单、刷新恢复截图、Session JSON 和汇总 JSON，未保存模型密钥。

| 测试 | 结果 | 覆盖 |
|---|---|---|
| `npm test` | 9 项通过 | 业务字段、权限、版本冲突、receipt、响应丢失/重启、同名调用精确 call id、取消/卸载、文本后多工具 SSE |
| `npm run check:core` | 通过 | 共享 schema、领域操作和页面桥的严格 TypeScript 检查 |
| `npm run build` | 通过 | overlay、Vite 三路线构建；仅有第三方 `use client` 与大 chunk 警告 |
| `npm run test:e2e` | 通过 | Chrome scripted；native/assistant/CopilotKit 各 10 条用户消息、业务表单、流式、记忆、权限拒绝、停止、刷新、无云请求 |
| `npm run test:e2e -- --webkit` | 通过 | Playwright WebKit scripted；同上。WebKit 不等于 Safari.app |
| `npm run test:e2e:lifecycle` | 通过 | 三路线双标签写权冲突、flush、backend 重启、刷新等待表单不恢复但可继续对话 |
| `node --use-env-proxy --import tsx tests/comparison.e2e.mjs --real` | 通过 | 真实 LLM + Chrome；native/assistant/CopilotKit 各完成同一业务矩阵，模型请求来自 DSH backend |
| `node --use-env-proxy --import tsx tests/comparison.e2e.mjs --real --webkit` | 通过 | 真实 LLM + Playwright WebKit；三路线同一业务矩阵 |
| `node --test ../browser-native-dsh-poc/tests/backend-v2.test.mjs` | 通过 | 原 Browser-Native v2 backend 回归，包括真实代理 stream 测试 |
| `pnpm run verify-translation-pairing --write docs/i18n/README.md` | 通过写入 | 登记本目录中文豁免并更新配对记录；提交前另运行无参数检查 |
| 聚焦 `scripts/run-oxlint.ts` | 通过 | 新目录 `src`、`tests`，使用 `.oxlintrc.staged.json`；不等于根仓库完整 lint |
| `pnpm run test:docs` | 21 项通过 | 文档快速检查 |
| `pnpm run doc-sync` | 43 项通过 | 文档、目录引用、翻译配对和站点检查；末次文字补充另执行链接、排版、仓库引用检查 |
| `4217` 真实服务启动冒烟 | 三路线通过 | 安装版 Chrome 分别完成 GUI 保存和真实模型回复；日志 `/tmp/dsh-saas-manual-service-verified.log` |

真实 Chrome 的最近一次汇总：三条路线均 `users=10`、`receipts=4`、`errors=[]`；真实 WebKit 也是三条路线均通过，CopilotKit 真实模型可能选择不同工具次数，但业务结果、工具结果和 receipt 均满足断言。`users` 包含普通消息、业务请求、记忆、权限、停止后的继续消息；工具续接没有制造新的用户 prompt。

## 证据目录

- Chrome 真实模型十轮：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-saas-real-chrome-xk9gTS/artifacts`。
- WebKit 真实模型十轮：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-saas-real-webkit-FkJu4J/artifacts`。
- Chrome scripted 最终代码回归：`/tmp/dsh-saas-scripted-release.log` 记录对应目录。
- 双标签/重启/等待中刷新：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-saas-lifecycle-n68l3C/artifacts`。
- 以上临时路径供本机复核；[持久化证据](evidence/README.md)保存两种引擎的真实模型摘要、六张业务表单截图、scripted 与生命周期摘要，详细 Session 不作为产品 fixture 提交。

## 关键证据

- 三路线的 Session `request/header` 都只包含 `ask_user_question`、`saas_read_workspace`、`saas_create_task`、`saas_update_ticket`、`saas_approve_invoice` 五个 Browser/SaaS 工具；没有 bash、filesystem 或 web 工具。
- 每个原 DSH `tool/call` 至多对应一个 `tool/result`；业务确认使用原 `toolCallId`，不是生成新调用伪造结算。
- 业务后端对相同 operation id 重放同一 receipt；不同参数返回冲突；viewer 返回拒绝；旧 version 返回冲突；响应丢失后可查询 receipt，backend 重启后 receipt 仍在。
- 流式断言记录页面文本长度的递增样本；assistant-ui 和 CopilotKit 通常观察到更多中间长度，原生 UI 因过程折叠或 DOM 批处理可能只观察到两个稳定长度，但都不是单次只出现最终文本。
- 真实模型测试读取主 worktree 的 `docs/drafts/.env` 仅在 Node backend；对请求、页面 HTML 和 Session JSON 做密钥字符串检查，未发现泄露；测试未打印密钥。
- 浏览器请求检查未发现 CopilotKit cloud 或 assistant-ui cloud 请求。

## 未执行或不能宣称

- 没有使用 Safari.app 自动化；WebKit 只能作为 Safari 引擎近似，不等于 Safari 浏览器验收。
- 没有把真实生产 SaaS API、认证、租户授权、事务数据库、生产审计或多实例幂等当作已验证。
- 没有验证 CopilotKit 原生 `useFrontendTool`/`useHumanInTheLoop` 取代自有精确桥，也没有验证 assistant-ui 所有 Interactables/Generative UI 能力；本实验只比较它们在同一 DSH 执行面上的实际聊天/工具呈现接线。
- 没有声称页面关闭后 Worker 仍运行；正在等待的表单刷新后不恢复，业务 receipt 可查询但自动补写 DSH 工具结果尚未实现。
- 没有运行根仓库完整 `pnpm run build`、全量 `pnpm run lint` 或 `pnpm run test`；它们不属于本目录新增 PoC 的最小证据，且本目录只依赖已生成的预览/VFS 构件。`check:core` 不包含全部前端适配器和三方依赖的严格类型检查，不能用局部通过代替整套前端类型验收。

## 真实模型故障与修复

第一轮真实模型暴露原共用 `backend-v2.mjs` 只处理首个工具 delta，并以单个 `started` 状态混淆文本块和工具块：模型先输出说明文本、随后输出工具调用时，代理可能无法正确组装工具参数并返回 400/stream failed。修复后按文本块和上游 `tool_calls[index]` 分别保留状态，支持文本后工具和多个碎片化并行调用；`tests/llm-proxy.test.ts` 用本地上游流回归，三路线真实 Chrome/WebKit 均通过。

这条修复属于 Browser-Native backend 的共用协议适配，不改变 Agent Loop，也不把真实模型异常掩盖为 scripted 通过。

## 启动检查的注意事项

原生 UI 首次有预览版确认。一次额外启动冒烟遗漏点击“继续”，虽然能定位输入框，但 Session 没有产生 `user/input`，因此等待回复超时；按正式 E2E 和手动说明先完成预览确认后，`4217` 三入口均完成 GUI 操作与真实模型回复。定位这类问题应检查 Session 是否收到输入，而不是把页面上输入框存在当作 Agent 已启动的证据。
