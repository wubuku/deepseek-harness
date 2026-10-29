---
description: "记录 Browser-Native DSH 附件上传与 Session 提交故障恢复的实际实施、Chrome 证据和限制。"
---

# Browser-Native DSH 附件提交与恢复进度

## 当前状态

状态：M0–M4 完成；本批验收通过并准备提交。

本批在主工作区 `research` 进行，开始时工作区干净且与 `origin/research` 同步，只有主 worktree。范围和通过条件见[验证计划](attachment-commit-recovery-validation-plan.md)。

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：TUI 原则、已有附件链路与候选范围 | 完成 | 复核 Session 事实源、live/replay 一致、unknown 不可当失败盲重试；当前附件测试已证明正常上传和清缓存补水，但未证明 quota/outage/append response loss 的正式 composer 状态。 |
| M1：确定性故障 seam 与 backend 并发测试 | 完成 | backend 只在测试构造器选项中支持 503 与对象发布后丢响应；Node 用例覆盖同 hash 并发上传只发布一个对象、并发输家报告 `reused`，以及未知上传响应后的重传复用。附件合同测试 5/5 通过。 |
| M2：Chrome composer quota/上传失败/响应未知 | 完成 | Chrome 156 真实 composer 在 OPFS quota=64 KiB 时显示 Retry、禁用 Send、且不发 backend PUT；恢复 quota 后经历一次 503、一次对象提交后响应体中断，再以同 hash 重试成功。 |
| M3：Session FileBlock append unknown 与真实 LLM | 完成 | scripted FileBlock 所在 Session append 在 backend 接受后丢响应；readback 对账只触发一次含 FileBlock append，Session 只有一条 prompt、一条 FileBlock、一个 `read` call/result，Workspace revision 不变。独立真实 Chrome/LLM 附件 smoke 完成两轮 `read` 与刷新补水；它验证正常真实模型路径，不代表真实 LLM 触发了故障注入。 |
| M4：文档、检查与交付 | 完成 | README、兼容矩阵、drafts 索引、变更账本与本进度已更新；`test:docs` 21/21、`doc-sync` 43/43、`git diff --check` 通过。范围检查仅包含 PoC 与 draft 文档，没有正式 package/app 改动。 |

## 执行记录

| 日期 | 操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-29 | `git status -sb`; `git log -5 --oneline`; `git worktree list` | `research` 与 `origin/research` 同步；工作区干净；只有主 worktree。 | 基于已推送附件 provider 规划故障和幂等批次。 |
| 2026-10-29 | 阅读 `dsh-tui-reference-architecture-memo.md`、附件计划/进度、backend 和正式 `FileUploads`/composer 源码 | TUI 的连续性、可审计恢复和 unknown 语义与附件分阶段提交直接相关。Composer 上传在选取文件时开始；`ready` 是 Session-scoped staged receipt，不是 Session durable ack。backend 已提供 Session append response loss 注入，但未针对 FileBlock 精确断言。 | 已将四个互相衔接的故障面列入本批计划；开始写实现前先补计划。 |
| 2026-10-29 | `node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs`; `node --check .../backend-v2.mjs`; `node --check .../attachment-commit-recovery.e2e.mjs` | backend 5/5 通过；语法检查通过。并发同 hash 请求各得到 200，其中一个 `reused=false`、另一个 `reused=true`，对象仅一份；提交对象后丢响应的重传返回 `reused=true`。 | 构建 preview 并在 Chrome 触发 OPFS quota、backend 503、上传响应丢失和 FileBlock append response 丢失。 |
| 2026-10-29 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；PoC VFS image 与 preview bundle 重建完成。保留既有 unsupported-native-platform、tsdown deprecation 和 Vite chunk size warnings。 | 用最新 preview 运行真实 Chrome composer 故障链。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-commit-recovery.e2e.mjs` | Chrome `156.0.8078.48` 通过。quota 失败期间 0 PUT；恢复后 3 次 PUT 分别为 injected 503、提交后 JSON 响应体截断（`ERR_CONTENT_LENGTH_MISMATCH`）、同 hash 成功复用。含 FileBlock 的 Session append 在 backend 接收后丢响应；只执行 1 次该 append、1 条 prompt、1 个 FileBlock、1 个标准 `read`，Workspace revision=0、pageErrors=0、跨源请求=0。 | 运行 backend 全量针对性回归和真实 LLM attachment smoke。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs` | 真实 Chrome `156.0.8078.48` 通过。37-byte 文本附件进入唯一 FileBlock；真实模型在两个不同 turn 各执行一次 `read`，刷新并清除 OPFS cache 后从 backend 补水一次；模型请求 5 次、Workspace revision=0、pageErrors=0、跨源请求=0。凭据仅由 backend 读取，命令输出未包含密钥。该 smoke 不触发本批的 scripted 故障钩子。 | 更新文档，记录 scripted 故障覆盖与真实模型正常路径的证据边界。 |
| 2026-10-29 | `node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs`; `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 附件 backend tests 5/5、backend-v2 tests 56/56 通过；并发同内容请求各返回 200 和正确 `reused` 标记，响应丢失后的 hash 重试复用唯一对象。 | 完成 README、兼容矩阵、索引和变更账本，再跑文档门禁。 |
| 2026-10-29 | `pnpm run test:docs` | 首次运行有 20/21 gates 通过；repository reference gate 拒绝三处短 commit hash。改用分支同步描述后重跑，21/21 gates 通过。 | 运行完整 `doc-sync`、diff 检查和变更范围核对。 |
| 2026-10-29 | `pnpm run doc-sync`; `git diff --check`; `pnpm --silent run change-scope --base origin/research` | `doc-sync` 43/43 通过，diff whitespace 检查通过；范围报告列出 6 个已修改和 3 个新文件，均限于 `docs/drafts/`。 | 完成 pre-push 核对，提交并推送 research。 |

## 验证结果

scripted 后端合同、Chrome composer/Session 故障闭环、真实 Chrome/LLM 正常附件 smoke、针对性 backend 回归和文档门禁均已完成。真实 LLM smoke 不负责制造 quota、503、响应截断或 append unknown；这些失败路径仅由 scripted Chrome/backend hooks 验证。

## 限制与经验

- 本批使用的 quota override 只模拟 Chrome 存储拒绝，不代表浏览器自然 eviction、用户磁盘故障或 OS crash。
- 上传响应丢失后服务端对象可能已持久化；Retry 可以内容寻址复用，但取消不删除已发布对象。
- 本批通过 CDP quota override 验证 OPFS quota 错误，并用测试 hook 验证 backend 503、发布后响应体截断和 Session append unknown；未验证自然网络中断、自然 eviction、OS/磁盘崩溃或上传期间移除 draft/取消的竞态。
- 初版仅调用 Node `response.destroy()` 时，Chrome 观察到空的 HTTP 200，composer 没有进入可重试错误态；故障夹具改成先发成功状态头、再截断带 `Content-Length` 的 JSON body 并关闭 socket。故障注入必须让浏览器实际读到未完成的 body，不能只看服务端关闭连接。
- Playwright 的 Session 快照查询是 E2E helper 直连接口；本批用真实页面产生的事件和 helper 获取的权威 Session snapshot 断言，不另造与现有 Session cookie/DTO 不一致的 page fetch。
- DSH Session event 与附件对象没有跨存储事务；本批不以测试通过宣称没有 orphan，也不实现基于时间戳的危险回收。图片、多设备恢复、生产对象存储、跨 Workspace 身份命名空间和大附件真实 LLM 仍未验证。
- 本进度文件在每个里程碑后更新；真实 LLM 失败、超时或未执行均如实保留。
