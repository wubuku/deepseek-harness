# External Edit 与 Agent Loop 验证进度

本文件记录[验证计划](external-edit-agent-loop-validation-plan.md)的实际执行证据。它只描述当前 checkout 的结果，不把计划或 WIP 写成已发布能力。

## 基线

- 分支：`research`
- 基线：开始时使用干净的 `research` checkout
- 开始时工作区：干净
- 隔离 worktree：无
- 浏览器主目标：Chrome；Safari 本批暂停

## 里程碑

| 里程碑 | 状态 | 证据 |
|---|---|---|
| 规划文档和验收矩阵 | 已完成 | 本文件与计划文件 |
| P0-A 标准 `edit` Agent Loop | 已完成 | `opfs-agent-file-tools.e2e.mjs` 与本批回归；真实 DSH Host 执行 scripted `read → grep → edit → read` |
| P0-B descriptor/replacement 语义 | 已完成 | VFS/Chunk editor focused tests；外置 replacement 的旧 descriptor 语义仍限定为当前 PoC 支持范围 |
| P0-C external crash/recovery | 已完成 | `external-edit-unknown-commit.e2e.mjs`；真实 Chrome Worker 终止、backend 重启、丢弃 commit response 后恢复 receipt 和 unknown result |
| P0-D external conflict/lease | 已完成 | `external-edit-conflict-retention.e2e.mjs`；真实 Chrome 中本地 external retry 与并发远端版本冲突，local/remote 均保留 |
| P1 chunk-addressed dedup | 门控 | 仅在 P0 全部通过后决定 |

## 证据规则

- scripted LLM 或固定 Worker test action 只能证明协议和恢复路径，不能证明真实模型自主选择工具。
- 真实 Chrome E2E 必须记录页面错误、非同源请求、Session 事件、Workspace revision、receipt 和 commit 次数。
- 真实 LLM 超时或上游失败时保留失败证据，不改写为通过。

## 实际验证

- `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`：通过。构建保留既有 unsupported native platform、tsdown deprecation 和大 chunk warning。
- `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs`：通过。真实 Chrome、Dedicated Worker、OPFS/IndexedDB、DSH `edit` 和同源 backend 覆盖 Workspace revision `2`、同一 operation 重放、单条 receipt、单个 `edit` call、`TOOL_OUTCOME_UNKNOWN`、无页面/Worker error、无跨源请求。Session `tool/call` 在 Workspace commit 前已有 durable flush；最终共观察到 seed、首次 edit 和同 operation retry 的三次 commit HTTP 请求，远端 revision 只增加一次。
- `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/external-edit-conflict-retention.e2e.mjs`：通过。标准 scripted DSH `edit` 产生 `externalContent` durable retry；并发页面提交 revision `2` 后刷新，local `after` 和 remote concurrent content 均保留，状态为 `conflict`，本地 operationId 不变，页面无错误且无跨源请求。
- `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs`：通过回归。普通 `write` 与 external `edit` 的 local-save 前/后 Worker 终止仍分别恢复旧内容或 durable 新内容，均结算为 `TOOL_OUTCOME_UNKNOWN`，后续 turn 不重放原工具。
- `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`：通过真实 LLM 回归。`gpt-5.6-sol` 返回 8 个 HTTP 200，Session 59 events，真实模型完成普通 `read → write → read`、刷新恢复和流式文本；本命令不证明模型会自主选择本批 external-edit 故障场景。
- 新增的 `sessionWriter.flush()` 屏障使 DSH `tool/call` 在 Workspace side effect 前可从 durable Session 重建。Chrome Worker 重启后短时保留 OPFS sync access handle；`BrowserDurableWorkspaceStore.openBlob()` 在 hash/size 校验通过后对 `NoModificationAllowedError` 采用有限重试，仍不可重开时使用已校验的只读内存 backing 完成恢复。该 fallback 可能增加 Worker heap，不能写成零拷贝保证。

## 未完成与限制

- P0 的“descriptor/replacement”只覆盖当前 VFS 外置 backing 支持的 descriptor 语义；没有把标准 Node `fs` 的所有 write、append、hard link、watch 行为扩展为 range mutation。
- 本批所有模型选择仍由 backend scripted handler 固定；没有把真实 LLM 自主选择 `edit` 或大型 external-reference 参数写成通过。真实模型只需按既有普通文件回归单独记录。
- backend 仍是单机 PoC `dataDir`；没有证明生产对象存储、多实例事务、OS/磁盘崩溃、自然 eviction、Safari 或页面关闭后的后台执行。
- OPFS access-handle fallback 以已完整校验的 `File` bytes 建立内存 backing，恢复正确性优先于 heap 上界；正式产品必须继续验证异步 range reader 或可重获的句柄生命周期。
- P1 chunk-addressed dedup 暂不实施；当前 Workspace 仍是文件级 content-addressed blob，不是 byte/chunk delta。

## 经验教训

- Workspace commit 成功不能反推对应 Session `tool/call` 已 durable。没有显式 Session flush 屏障，commit response 丢失并重启 backend 时可能出现“文件已提交但工具调用不可重建”的窗口。
- Worker `terminate()` 不等价于 OPFS sync access handle 立即释放。恢复代码必须允许短暂句柄竞争并保留经过 hash 校验的只读 fallback；测试必须区分本地存储损坏和浏览器句柄释放延迟。
- CAS 冲突测试必须阻塞本地 retry，先让第二 writer 提交远端 revision，再放行原 operationId；否则测试会验证 retry 竞速，而不是冲突保留语义。
