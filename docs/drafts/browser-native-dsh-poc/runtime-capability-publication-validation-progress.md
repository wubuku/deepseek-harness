---
description: "记录 Browser-Native 运行期能力发布批次的 Chrome、真实 LLM 证据和限制。"
---

# Browser-Native 运行期能力发布验证进度

## 当前状态

状态：实施、运行验证和文档门禁完成。提交状态以 Git 历史为准，不在验证进度中维护。

基线：2026-10-26 的 `research` 分支 checkout，起始工作区干净且只有主 worktree。Safari/WebKit 暂停，本批只运行 Chrome。上一批运行期 probe 已包含在本批起始历史中；旧进度中的“commit/push 待完成”已过期。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：能力状态与候选范围 | `complete` | 计划区分启动 probe、模型 schema、dispatch guard、本地 durability、云端 commit pending 和刷新恢复；Session `request/header` 保留 DSH 组装的模型工具 schema | 实现共享 publication 状态 |
| M1：schema、Session header 与执行授权一致 | `complete` | Worker 未通过 runtime probe 时拒绝 init；schema 中未知/重复/撤销工具 fail closed；Chrome E2E 核对 `request/header` 与 backend wire schema | 注入本地 durability 故障 |
| M2：本地失败、远端失败与同批调用 | `complete` | Chrome 真实 DSH turn 验证 OPFS quota failure 撤销 Workspace 工具、同批第二次 write 在 dispatch 前被拒；远端 commit 503 时本地 durable write 成功且 operationId 重试复用 | 验证刷新恢复与真实 LLM |
| M3：刷新后重新探测 | `complete` | 刷新不重放 quota failure turn；volatile bytes 不恢复为 durable；新 Worker probe 成功后完整工具 roster 恢复且 baseline 可读 | 运行真实模型普通读写读 |
| M4：真实 LLM 与文档交付 | `complete` | 最终代码上的 Chrome 真实 LLM `read → write → read`、刷新恢复通过，8 个模型请求均为 HTTP 200；本批文档已登记实际证据与限制 | 按推送前检查发布本批更改 |

## 执行记录

| 日期 | 命令或检查 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `git status --short --branch`; `git worktree list --porcelain`; `git log -1 --oneline` | `research` 起始工作区干净，只有主 worktree | 在主 worktree 按计划实施 |
| 2026-10-26 | capability publication 初次 Chrome E2E | 失败：Cordis 因 profile 未声明注入 `agents` 而拒绝激活 LLM provider；增加显式 injection 后暴露旧 onboarding helper 和简化 roster 与 manifest 不一致 | 对齐 profile 与 helper 后重跑 |
| 2026-10-26 | `node docs/drafts/browser-native-dsh-poc/tests/runtime-capability-publication.e2e.mjs` | 初始脚本进入故障路径后发现 `tools.schemas()` 需要显式 Agent scope；修正后最终复跑通过，结果为 Chrome、9 个同源 LLM 请求、Bash durable commit 1 次、远端 pending commit 两次复用同一 operationId、迟到写入被拒、quota 写入刷新后消失、baseline 恢复、Workspace commit 共 4 次，页面错误和跨源请求均为 0 | 记录精确状态与限制 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts` | 7/7 通过 | 跑 Web typecheck 和 preview build |
| 2026-10-26 | `pnpm exec tsc --noEmit -p apps/web/tsconfig.json` | 通过 | 重建 preview 并跑既有 roster 回归 |
| 2026-10-26 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留仓库既有 optional native-platform、tsdown deprecation 和大 chunk warnings | Chrome E2E 使用新 Worker bundle |
| 2026-10-26 | `DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome DSH_POC_ROSTER=browser node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 简化 validation roster scripted Chrome 回归通过；provider 激活、schema 与同源请求正常 | 使用真实模型做最终 smoke |
| 2026-10-26 | `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ROSTER=original DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 首次真实模型读出 input 文件后，续接请求在 backend 默认 60 秒 deadline 超时；该轮不是完整 E2E PASS | 显式提高 upstream deadline 并配置 context window，仅重试一次 |
| 2026-10-26 | `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ROSTER=original DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=300000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | Chrome 真实 `gpt-5.6-sol` 闭环通过；3 turns、8/8 LLM HTTP 200、首轮 `read → write → read`、刷新后 Session 和 durable Workspace 文件恢复、凭据检查及同源流量检查通过。最终代码修改后同命令再次执行，退出码 0 | 完成文档和 pre-push 检查 |
| 2026-10-26 | `pnpm run test:docs`; `pnpm run doc-sync`; `git diff --check`; `pnpm run change-scope --base origin/research` | test:docs 21/21、doc-sync 43/43；diff check 与变更范围核对通过。首轮文档门禁因进度页记录的 commit hash 被仓库引用规则拒绝；去除 hash 后完整重跑通过 | 提交并推送后继续下一批评估 |

## 证据边界

- Chrome quota fault 和 Workspace commit 503 都是定向故障注入；它们不代表自然 eviction、OS/磁盘 crash、所有 OPFS 错误或生产对象存储。
- Session `request/header` 与 LLM wire schema 的一致性只验证当前 Browser-Native manifest 和两个当前 PoC profile；这不是任意 Cordis profile 的动态 capability discovery。
- 本地 Workspace durability 失败不回滚已经写入 VFS 的 mutation；当前 turn 会按错误结算，后续 Workspace 工具被隐藏并在 dispatch guard 拒绝。页面刷新后该未持久化 bytes 不可恢复。
- 云端 commit pending、但本地 Workspace 已 durable 时，工具结果可成功结算，Workspace 工具保持发布；恢复请求重用同一 operationId。Session 与 Workspace 仍不是跨存储事务。
- 真实模型只验证普通文件闭环及刷新恢复；quota/503 次序由 scripted E2E 控制，不能宣称真实模型自主发现或处理该故障。
- 最终真实 LLM smoke 有一条 validation profile compaction headroom warning；当前任务闭环仍通过，但该 smoke 不证明 compaction 配置正确。
- Safari/WebKit、自然 quota eviction、生产云存储、多实例 backend、页面关闭后的后台 Agent 和 OS crash 未验证。
