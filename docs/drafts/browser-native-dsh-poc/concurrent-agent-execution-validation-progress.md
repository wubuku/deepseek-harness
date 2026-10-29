---
description: "记录 Browser-Native DSH 并行 Agent Loop、共享 authority、Workspace writer fencing 和真实模型烟测的执行证据。"
---

# Browser-Native 并行 Agent 执行验证进度

## 当前状态

状态：实现、Chrome 验证和文档门禁完成；提交与推送待完成。

基线：`research` 分支起始工作区干净，只有主 worktree。DSH-TUI 参考 checkout 为干净的 `main`。本批只验证 Chrome，Safari/WebKit 暂停。

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：源码核对与候选选择 | `complete` | 选择双 Worker Loop、round-robin 双 backend、共享 authority、Workspace owner/observer 和 lease takeover fencing；滚动升级、authority OS 强杀和生产 HA 另列后续。 | 已完成 |
| M1：两个 DSH Loop 并发与双 backend | `complete` | Chrome 156 route barrier 同时挂起两个不同 Session 的模型请求，分别命中 backend A/B；两个 backend 都处理模型请求，且本地 Session/Workspace store 保持为空。 | 已完成 |
| M2：Workspace owner/observer 与单写权 | `complete` | owner DSH `write` 提交后，observer DSH `read` 成功；observer 工具 schema 仅含 `read`/`grep`/`glob`，模型伪造的 `write` 在 Worker 被拒绝，manifest 与 commit 数不变。 | 已完成 |
| M3：长 edit 接管与 fencing | `complete` | 32 MiB OPFS edit 在 `copy-prefix` 暂停；token 从 1 转到 2 后旧 Worker 仍在途，但本地 writer invalidation 在发布前拒绝旧 edit，无 receipt、无旧本地发布或远端覆盖。新 owner 提交唯一最终内容。 | 已完成 |
| M4：真实 LLM 文件工具 smoke | `complete-with-limitations` | `gpt-5.6-sol` 在真实 Chrome 完成 `read → write → read`、跨轮记忆和刷新恢复；58 个 Session events，`durableThroughSeq=57`。Session 记录流式 chunks，但可见 DOM 只采到一次更新，不作为渐进渲染通过证据。 | 保留该 UI 流式证据缺口 |
| M5：文档门禁、提交和推送 | `in-progress` | backend-v2 tests 56/56、test:docs 21/21、doc-sync 43/43、whitespace 与 change-scope 均通过；Git 发布待执行。 | 提交并推送 `research`，核对远端 head 和干净工作区 |

## 执行记录

| 日期 | 命令或检查 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-29 | `node --check docs/drafts/browser-native-dsh-poc/tests/concurrent-agent-loops.e2e.mjs` | 通过。 | 运行综合 scripted Chrome E2E。 |
| 2026-10-29 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/concurrent-agent-loops.e2e.mjs` | Chrome 156.0.8078.48 通过。两个不同 Session 的模型请求同时在途并分别由 backend A/B 处理；observer 隐藏 write 被拒；writer fencing token 为 1→2；旧 edit 错误为 `local writer was invalidated`，没有 Workspace receipt 或旧 Worker 发布。最终 manifest revision 为 3，三个成功 commit，各 backend 本地 Session/Workspace 记录为 0；无页面错误或跨源请求。 | 执行真实 LLM smoke。 |
| 2026-10-29 | `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u no_proxy -u NO_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=600000 DSH_POC_TURN_TIMEOUT_MS=900000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 Chrome smoke 通过：模型 `gpt-5.6-sol` 完成 3 轮、`read → write → read`、刷新后同一 Session 记忆与 Workspace 文件恢复；Session 58 events，watermark 57，Workspace commit responses 均为 200，页面无错误，浏览器模型请求只访问同源 backend。Session 记录多个 assistant chunks；可见 DOM 仅采到一次更新，不能据此宣称视觉流式效果已充分验收。 | 记录已知预览 warning 并完成回归。 |
| 2026-10-29 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | backend contract tests 56/56 通过。 | 文档门禁。 |
| 2026-10-29 | `pnpm run test:docs` | 21/21 gates 通过。 | 完整文档同步门禁。 |
| 2026-10-29 | `pnpm run doc-sync` | 43/43 gates 通过。 | 最终 diff 与变更范围核对。 |
| 2026-10-29 | `git diff --check`; `pnpm run change-scope --base origin/research` | whitespace 检查通过；范围仅含本批 8 个文件，无其他工作区修改或隔离 worktree。 | 提交并推送。 |

## 经验记录

- 页面重载后，preview 会先自动创建 Session。复用此前累积的 request 数组会让 smoke helper 选择旧 Session；需要在导航前清空该角色的 capture array，才能捕获新页面 Session。
- 长 edit 被 release 后，Worker 可以先以 `local writer was invalidated` 拒绝本地发布；不能只把 `writer lease was released` 当成唯一有效的 fencing 错误。
- 等待 `copy-prefix` 时还要确认旧 turn 在新 lease 建立后仍未结束，否则测试只证明顺序执行，不证明 stale edit 与接管交叠。
- 失败诊断按 backend、route 和状态聚合，不打印请求正文、身份凭据、operation id 或大文件 chunk 路径。

## 已知限制

- 并发、observer capability 与 takeover 故障顺序由 scripted LLM 控制；真实模型 smoke 只证明普通文件工具路径和刷新恢复，不证明真实模型自主处理多 Worker 冲突。
- authority 是单进程 PoC JSON 服务；双 backend 同机 round-robin 不构成多机 HA、生产数据库事务或跨主机 fencing 证据。
- 真实模型 Session 记录了多个文本 chunk，但本轮可见 DOM 采样不足以判断渐进渲染体验；Worker 日志还包含 compaction context capacity warning 和 preview API 404。它们未导致本轮 smoke 失败，但需要在产品化前分别调查。
- 未验证真实模型自主触发 observer/owner 竞争、真实模型大型工具参数、自然 OPFS eviction、浏览器/OS 崩溃、Safari/WebKit 或页面关闭后的后台 Agent。
