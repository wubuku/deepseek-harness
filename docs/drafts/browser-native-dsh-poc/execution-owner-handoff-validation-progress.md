---
description: "记录 Browser-Native DSH Session 与 Workspace 写权交接的实现、故障恢复、真实 Chrome/LLM 证据和限制。"
---

# Browser-Native Session 与 Workspace 写权交接验证进度

## 当前状态

状态：本批实现与当前列明的验证已完成；代码和文档尚待提交、推送。

基线：本批开始时 `research` 与 `origin/research` 同步。本批直接在主工作区实施，没有隔离 worktree；Safari/WebKit 暂停。目标是显式的 Worker-to-Worker 接管，不是 pagehide 保证或后台 Agent。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：协议与既有写权核对 | `complete` | 确认 Session event log 与 Workspace revision 分别权威；handoff API 使用 `epoch`，Workspace 用独立 fencing token；两个 store 没有跨存储事务。 |
| M1：有序协调器与 checkpoint | `complete` | 新增 PoC-local `handoffBrowserNativeExecution()`，依次 flush Workspace 远端与本地状态、flush Session 并核对 durable watermark、转移 Session owner、释放 Workspace lease；各阶段失败均保留结构化状态。 |
| M2：合同与 backend 故障测试 | `complete` | 协调器 Vitest 6/6；backend contract tests 45/45。覆盖顺序、durability 落后、未结算 receipts、Session handoff 失败及 backend 交接状态。 |
| M3：真实 Chrome 双 Worker | `complete` | 三个 scripted 场景均通过：正常交接、Session handoff 响应丢失、Workspace release 响应丢失；接收方在取得两侧写权前没有模型请求。 |
| M4：真实模型、文档和门禁 | `complete` | 真实 Chrome LLM 两轮文件工具闭环通过；preview build、Web typecheck 和文档门禁通过。push 前仍需按仓库流程检查并验证远端 ref。 |

## 已验证行为

- Worker coordinator checkpoint 记录 Session cursor、durable watermark、Workspace identity/revision/fencing token 与待结算 receipt。Worker wire adapter 将内部 `ownerEpoch` 明确映射到既有 handoff API 字段 `epoch`。
- handoff 的固定顺序是 Workspace remote/local flush → Cordis Session flush/outbox 与 receipt 检查 → Session owner epoch handoff → Workspace lease release。handoff 前失败不转移 Session owner；Session response unknown 不释放 Workspace lease；release response unknown 不被伪报为成功。
- 三个真实 Chrome scripted 场景各完成两轮 DSH `write`，产生 2 个唯一 Workspace commit 和 2 个 durable receipt。正常场景 owner epoch 从 1 到 2，Workspace fencing token 从 1 到 2。Session response loss 场景先观察 `session-unknown`，等待租约过期后由新 Worker 重新 claim，两侧 fencing 后继续同一 Session。
- 每个 scripted 场景都验证旧 Session append、旧 owner LLM request 和旧 Workspace renew 返回 409；页面错误为 0，跨源请求为 0。每个场景使用独立 backend `dataDir`，避免身份、Session、时钟和 lease 状态跨用例污染。
- 真实 Chrome + 真实 LLM 在同一个 Session 完成 `write → read → handoff → read → write → read`。5 个 DSH tool call 均成功，读回包含两份期望内容；共 2 次 Workspace commit、2 个唯一 receipt，Session owner epoch 与 Workspace fencing token 均递增；跨源请求为 0。
- identity cookie 保持 HttpOnly/SameSite；Workspace principal cookie 只匹配 `/api/browser-native/workspace`，handoff principal cookie 只匹配 `/api/browser-native/session/handoff`。Chrome 请求头观测确认两个 principal cookie 均未发送到 `/api/browser-native/llm`。

## 经验与修复

- 第一次 Chrome E2E 揭示协调器内部 checkpoint 使用 `ownerEpoch`，直接发送给既有 API 会缺少必填 `epoch`。不能假定新内部 DTO 与旧 wire schema 同名；Worker adapter 显式投影字段并在 E2E 检查实际 backend 收到的 checkpoint。
- 第二次运行进一步揭示 Workspace 身份 cookie 原先的 Path 只覆盖 `/workspace`，Session handoff 的 Workspace lease 校验因此返回 401。将原 cookie 粗略扩大到整个 `/api/browser-native/` 虽能修复请求，却会让它也发送给 LLM proxy；最终保留 Workspace cookie 原路径，并新增仅用于 handoff endpoint 的独立 Path cookie。真实 Chrome 验证 handoff 带授权 cookie、LLM 不带任一 principal cookie。
- 错误响应使用 `{ error: { code, message } }。Worker 原先只读取顶层字符串，隐藏了 backend 拒绝原因。handoff adapter 现在读取结构化错误字段，并仅把 `DURABILITY_UNKNOWN` 分类为 unknown；其他明确拒绝维持 rejected。
- 测试脚本最初让多个场景复用一套 backend 和身份状态，导致后续 composer 偶发处于前一轮运行态。每个场景现使用独立 `dataDir`、backend 和 clock；单场景环境变量仍可选择独立复跑。
- E2E diagnostics 不序列化 Workspace writer token、Session owner token 或 handoff 响应 bearer；只保留 checkpoint、epoch、fencing 和凭据是否存在等摘要。浏览器 network 输出只保留 cookie presence 布尔值。
- 真实模型一次把宽泛指令当成“只需最终文本”，未调用 DSH 文件工具；一次严格工具序列尝试又遇到 `UPSTREAM_LLM_EMPTY`。测试因此改为明确的工具顺序、参数和读回断言；后续真实 Chrome 重跑完整通过。单次上游空流不被归因于 handoff，也不被计为成功闭环。
- preview E2E 使用构建后的 Worker/VFS image；每次修改 Worker 入口后必须重新执行 preview build。根目录不存在 `pnpm run build:preview`，应使用 frontend package 的 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`。

## 验证命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-handoff.spec.ts` | 6/6 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 45/45 通过，含 Session/Workspace handoff 校验、租约时钟和 cookie Path。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留现有 unsupported native platform、tsdown deprecation 与大 chunk warnings。 |
| `pnpm run typecheck` | 5/5 gates 通过。 |
| `DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs` | Chrome scripted 三场景通过。每场景 2 个 DSH write、2 个 receipt、2 次成功 Workspace commit；handoff states 分别为 `complete`、`session-unknown`、`workspace-release-unknown`；无页面错误、无跨源请求、LLM 请求无 principal cookie。 |
| `DSH_POC_LLM_MODE=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs` | Chrome 真实模型闭环通过：5 个 DSH tool call、2 个 Workspace commit/receipt；Session owner epoch `1→2`，Workspace fencing token `1→2`；旧 Session append、旧模型 owner 和旧 Workspace renew 均 409；无页面错误、跨源请求或 LLM principal cookie。凭据只由 backend 从本机 env file 读取。 |
| `pnpm run test:docs` | 21 个文档检查通过，0 失败、0 跳过。 |
| `pnpm run doc-sync` | 43 个文档同步检查通过，0 失败、0 跳过；包含 doc-typecheck 与 documentation build。 |
| `git diff --check` | 通过。 |

以上文档门禁在最后一次文档编辑后执行；Safari/WebKit 与自然 eviction 未运行。

## 限制

这是 PoC 单 backend 上的顺序交接，不提供 Session 与 Workspace 原子事务、跨主机 fencing、SaaS 多租户授权、Cloud Host/插件内存迁移或后台 Agent。接收方得到 owner 前不调用模型；未知结果不会恢复原 JavaScript Promise，也不会自动重放 prompt、副作用、活动流或 HITL。Chrome response-loss 故障钩子不是 OS/磁盘 crash 证据；真实 LLM 只验证正常两轮续接，不将 scripted 故障状态描述为模型验证。自然 eviction、Safari/WebKit、pagehide handoff 和多实例 backend 未执行。
