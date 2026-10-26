---
description: "记录 Browser-Native DSH 复制标签页恢复隔离的实施、Chrome Worker、真实 LLM 与文档检查结果。"
---

# Browser-Native 复制标签页恢复隔离验证进度

## 当前状态

状态：实现、Chrome/真实 LLM 验证、文档门禁、commit 与 push 均完成。工作位于主 worktree 的 `research` 分支，没有隔离 worktree；结束时工作区干净，`origin/research` 与本地 HEAD 一致。Safari 按当前安排暂停。候选范围与取舍见[验证计划](next-tab-recovery-isolation-validation-plan.md)。

本批确认了一个真实单写者风险：Chrome `window.open()` 会复制 `sessionStorage`，同一 Workspace `resumeId` 可让两个 Worker 获得相同 writer token/fencing，复制的 Session owner token 也能续租。页面现在在恢复凭据进入 Worker 前取得同源 Web Locks；冲突或没有 Web Locks 时 fail closed。backend owner 和 Workspace fencing 仍负责服务端最终写权。

## 里程碑

| 里程碑 | 状态 | 验收证据 | 下一步 |
|---|---|---|---|
| M0：候选范围、源码和 TUI 线索核查 | `complete` | 核对页面凭据保存、Workspace 相同 `resumeId` 重放、Session owner claim、backend fencing 和 dsh-TUI 的单 writer/恢复原则；扩展候选面并选择复制标签页恢复凭据隔离。 | 已完成 |
| M1：真实 Chrome 风险复现 | `complete` | 修复前 opener popup 复制两类恢复材料；两个 Worker 对同 `resumeId` 得到相同 writer token/fencing，两次 renew 均 HTTP 200；日志只保留布尔结论，不含凭据。 | 已完成 |
| M2：恢复锁与输入校验 | `complete` | `browser-native-recovery.spec.ts` 8/8；验证无效记录拒绝、批量冲突只回滚本次新锁、卸载时取消待处理获取且晚到授权立即释放。Web TypeScript 与 preview build 通过。 | 已完成 |
| M3：Chrome 单写、刷新与恢复续聊 | `complete` | 最终真实 Chrome E2E 覆盖 Workspace-only、Session-only、完整凭据副本、无 Web Locks、合成 persisted pagehide 持锁、原页关闭后刷新、旧 fencing 拒绝、同 Session 新 turn 单次模型请求、一次 Workspace commit，以及释放 Workspace lock 时仍保留 Session lock；页面错误和跨源请求均为零。 | 已完成 |
| M4：真实 LLM 回归 | `complete` | 最新无代理真实 Chrome smoke 完成 3 turns、59 个 Session events、`durableThroughSeq=58`、`read → write → read` 和刷新后文件恢复；两次 Workspace commit 均 HTTP 200，8 个 LLM response status 均 HTTP 200，LLM route 同源，页面错误为零。Playwright 另记录刷新/工具探测期间的 request abort，以及可选 preview API 的 404；这些旁路观测不属于通过断言，但保留为 PoC 限制。 | 已完成 |
| M5：文档门禁、commit、push | `complete` | `test:docs` 21/21、`doc-sync` 43/43、`git diff --check` 通过；pre-commit lint/whitespace/vendor hooks 和 pre-push TypeScript 5/5 通过。提交已 push 到 `research`；远端 ref 与本地 HEAD 一致，工作区干净，只有主 worktree。 | 已完成 |

## 执行记录

| 命令或检查 | 结果 |
|---|---|
| `git status --short --branch`、`git worktree list` | 起始为 `research...origin/research`，工作区干净，只有主 worktree。 |
| 源码核对：`apps/web/src/browser-native-page-control.ts`、`docs/drafts/browser-native-dsh-poc/workspace-v2.mjs`、`backend-v2.mjs`、`browser-native-providers.ts` | 页面先前在 `sessionStorage` 保留 owner token 和 Workspace lease；Workspace 相同 `resumeId` 是响应丢失重试身份，不能当作排他锁；旧 Workspace token 仍由 backend fencing 拒绝。 |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/tab-recovery-duplication.e2e.mjs`（修复前） | 真实 Chrome 复现 opener storage copy 后的相同 Workspace token/fencing 和双 renew 接受；无页面错误或跨源请求。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-recovery.spec.ts` | 最终 8/8 通过：记录校验、资源锁互斥、批量冲突只释放新取得的锁、释放时取消未决获取，以及在底层回调晚到时不遗留锁。 |
| `node --check docs/drafts/browser-native-dsh-poc/tests/tab-recovery-duplication.e2e.mjs` | 通过。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/tab-recovery-duplication.e2e.mjs`（最终代码） | 通过：无 Web Locks 的 context 有有效格式恢复材料仍零 Browser-Native API 请求；Workspace-only、Session-only 与完整副本在原页存活时均被拒；刷新接管 resume HTTP 200、fencing 递增、旧 token renew HTTP 409；恢复后同 Session composer turn 有 1 个对应模型请求，Workspace 测试写入产生 1 个 commit；页面错误 0、跨源请求 0。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/tab-recovery-duplication.e2e.mjs`（最终锁管理实现） | 通过：新增释放 Workspace lock 后确认 Session lock 仍被持有；所有先前复制、刷新接管、续聊、fencing 与单次 commit 断言继续通过，页面错误 0、跨源请求 0。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；有原生平台依赖、依赖弃用和 chunk-size 警告，不阻断 build。 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过。 |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`（最终代码） | 退出码 0；3 turns、59 个 Session events、`durableThroughSeq=58`、普通文件 `read → write → read`、刷新后同 Session 恢复和文件读取；两次 Workspace commit HTTP 200、8 个 LLM response status 均 HTTP 200，LLM route 同源，页面错误 0。Playwright 记录刷新/工具探测期间的 request abort 和 6 个可选 preview API 404；烟测没有把它们当作 Browser-Native 文件闭环失败。未使用代理；脚本检查模型凭据未进入浏览器请求。原始输出含临时本地 preview tunnel token，未复制到文档。 |
| `pnpm run test:docs` | 初次因进度草稿包含起始 commit 短哈希而失败；删除该哈希后 21/21 通过。 |
| `pnpm run doc-sync` | 43/43 通过。 |
| `git diff --check` | 通过；没有 whitespace error。 |
| `pnpm --silent run change-scope --base origin/research` | 通过；scope 为本批 8 个 tracked files 和 5 个 untracked files，无已提交 outgoing commit。 |
| `git commit -m "feat(browser-native): isolate copied recovery credentials"` | 通过；staged lint、whitespace 与 vendor manifest hooks 均通过。 |
| `git push origin research` | 通过；pre-push TypeScript 5/5 通过，`research` 已推送。 |
| `git status --short --branch`、`git rev-parse HEAD origin/research`、`git worktree list` | 工作区干净；本地和远端 ref 指向同一 HEAD；仅保留主 worktree。 |

opener E2E 使用 Playwright BrowserContext 的 `page` 事件先安装网络监听，避免 popup 请求早于 page listener 而造成零请求假通过。Session-only 负例临时从 opener storage 移除 Workspace lease 后创建 popup；完整恢复负例另行复制两种凭据。Chrome 实测表明 Web Locks 不允许 `signal` 与 `ifAvailable` 同时传入；首次加入 `signal` 后的 E2E 在首屏 45 秒超时，独立诊断观察到 `NotSupportedError`。最终仍使用非阻塞 `ifAvailable`，页面释放时以本地取消状态标记未决请求，晚到 callback 不保留锁。恢复 notice 串行处理，并在非持久 pagehide 后忽略迟到 notice。初次实现的测试恢复页缺少 Workspace lease，不能用于接管验收；分离 Session-only 负例和完整凭据接管后通过。合成 BFCache 事件只验证 `persisted` 分支，不等同真实 BFCache 往返。

## 已知限制

- Web Locks 只协调同 origin/storage partition 中遵守页面 adapter 的标签页；它不是服务端授权，也不能防止绕过页面的 API 客户端。
- 本批验证的是已有恢复凭据的 opener 复制；没有 Web Locks 时当前 Browser-Native Host 一律拒绝启动，即使 storage 中没有恢复凭据。
- `pagehide.persisted` 通过合成 `PageTransitionEvent` 验证；pending lock callback 的晚到情况由确定性单测覆盖，但真实页面卸载与浏览器调度 callback 的竞争未直接注入。真实 BFCache 导航和返回、后台标签冻结及锁饥饿未验证。
- 首次 Session/Workspace claim 竞态、不同 principal 的锁命名隔离、真实 storage policy/quota 错误、跨设备/浏览器 profile、多 backend HA、自然 eviction、OS crash、Safari/WebKit 和生产授权仍未验证。
- 真实 LLM smoke 只验证这次接线没有破坏普通文件闭环和刷新恢复；它不验证模型自主发现重复标签、不验证锁故障时序，也不替代 scripted Chrome 并发负例。
- Dedicated Worker 仍受页面生命周期约束；这项修复不将 Browser-Native DSH 变为页面关闭后继续运行的后台 Agent。
