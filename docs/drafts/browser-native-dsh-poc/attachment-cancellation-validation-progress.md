---
description: "记录 Browser-Native DSH composer 附件取消传播与对象发布竞态的实现、Chrome 证据和限制。"
---

# Browser-Native DSH 附件取消验证进度

## 当前状态

状态：M0–M5 验证与文档工作完成。本批在主工作区 `research` 进行，开始时工作区干净且与 `origin/research` 同步，没有隔离 worktree。范围与验收见[验证计划](attachment-cancellation-validation-plan.md)。

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：现状与候选范围核验 | 完成 | 已检查 DSH-TUI cancel/dispose 原则、正式 composer draft release/AbortController、Worker AttachmentStore 和 backend 原子发布路径。 |
| M1：可控取消 barrier | 完成 | Worker 测试端口可在 OPFS staging write 后暂停；backend 测试 hook 可暂停 body 接收和对象发布后的回执；teardown 有显式释放路径。 |
| M2：OPFS staging 写入取消 | 完成 | Chrome 156 在 `WritableFileStream.write()` 成功后暂停；OPFS 中存在 `upload-*` 与浏览器 writer 的 `.crswap` 临时项；移除 draft 后 Worker 观察到 AbortSignal，两项均被清理，且没有 backend PUT。随后纯文本 turn 成功。 |
| M3：backend 对象发布前取消 | 完成 | Chrome 156 在 backend 收到 1 MiB body 后移除附件；request 中止，`.part` 和 hash 对象均不存在，后续纯文本 turn 成功。 |
| M4：发布后 receipt 前取消 | 完成 | Chrome 156 在 backend 对象发布并完成目录 fsync、尚未发 receipt 时移除文件；request 取消，完整远端对象保留，late completion 不恢复 FileCard，纯文本 turn 成功。 |
| M5：回归与文档 | 完成 | PoC README、兼容矩阵、drafts 索引、change ledger 和进度已更新；Chrome 三时序测试、真实 LLM 附件 smoke、preview build、定向 lint、`test:docs` 和 `doc-sync` 通过。变更范围仅含本批 PoC 文件。 |

## 执行记录

| 日期 | 操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-29 | `git status --short --branch`; `git log -1 --oneline`; `git worktree list` | `research` 与 `origin/research` 同步于上一批附件恢复提交；工作区干净；只有主 worktree。 | 阅读 TUI 备忘与当前 Session/附件实现，形成候选范围。 |
| 2026-10-29 | 阅读 `dsh-tui-reference-architecture-memo.md`、上一批附件提交恢复计划/进度、`browser-native-attachments.ts`、`backend-v2.mjs`、Conversation/FileUpload 实现 | 移除 draft 会 abort active upload；backend 对象发布前有 `.part`，发布后 hard-link 原子可见；发布后丢 receipt 会留下可重用对象。FileBlock 不含独立 Workspace namespace，不具备安全 GC 的完整引用映射。 | 规划发布前与发布后两条取消时序，先落文档，再编码。 |
| 2026-10-29 | `node --check docs/drafts/browser-native-dsh-poc/backend-v2.mjs`; `node --check docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs`; `node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs` | 语法检查通过；附件 backend tests 5/5。异步 hook 默认返回 `undefined` 时不改变既有同步测试行为。 | 构建最新 preview，在 Chrome 驱动两种 composer remove 交错。 |
| 2026-10-29 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；Worker runtime、packer、Vite preview 和 VFS image 均完成构建。保留既有 native platform、tsdown deprecation、dependency bundling hint 与 Vite chunk-size warnings。 | 运行 Chrome 156 scripted cancellation E2E。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_VERBOSE=1 DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs`（首次运行） | 未完成；测试复用了修改前的 `apps/web/dist`，没有新 Worker staging hook，等待后被中断。此结果不计为通过；随后重建 preview 再运行。 | 重建 preview，确保测试 bundle 含有本次 Worker hook。 |
| 2026-10-29 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；Worker runtime、packer、Vite preview 和 VFS image 均完成构建。保留既有 native platform、tsdown deprecation、dependency bundling hint 与 Vite chunk-size warnings。 | 用新 build 重跑 Chrome 156 scripted cancellation E2E。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_VERBOSE=1 DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs`（第一次完整通过） | 三种取消与续聊通过；当时只检查取消后 OPFS 目录为空，尚未在暂停时枚举目录条目。最终无 FileBlock、无 `read`、无 page error、无跨源请求。 | 增加暂停时的 OPFS 状态断言，避免只从 hook 回调推断已有临时对象。 |
| 2026-10-29 | Chrome staging directory 检查的修正 | 新增的暂停时断言最初只允许一个 OPFS 条目；Chrome `WritableFileStream` 实际同时创建 `upload-*` 与 `.crswap` 项，因此断言过窄，不代表产品清理失败。测试改为核对条目属于同一上传，再检查取消后目录为空。 | 重跑完整 Chrome E2E。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_VERBOSE=1 DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs`（最终复跑） | Chrome `156.0.8078.48` 通过。暂停时观测到同一上传的 `upload-*` 和 `.crswap` 两项，移除后 Worker 观察到 AbortSignal 且两项均被清理，无 backend PUT。另两个 PUT 分别在 backend 对象发布前、发布后 receipt 前取消。三个 prompt marker 在同一 Session 各出现一次，另含一条 harness runtime-context user event；最终无 FileBlock、无 `read`、无 page error、无跨源请求。 | 记录真实 LLM smoke 的当前结果，完成文档门禁和 push 检查。 |
| 2026-10-29 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 56/56 通过。 | 运行真实 Chrome/LLM 附件正常路径；故障 E2E 不由真实模型触发。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs`（连续两次） | 两次都在 turn 1 收到 `UPSTREAM_LLM_EMPTY`：上游流正常结束但没有文本或工具调用；附件 `read` 与刷新恢复未完成。本次没有真实 LLM smoke 通过。配置只安全核对了模型名、endpoint 和凭据存在性，没有输出或读取凭据值；此前 checkout 的真实 LLM 通过记录不能替代本次结果。 | 真实 LLM 验证标记为未通过；不把该外部失败写成本地 Worker/OPFS 回归。 |
| 2026-10-29 | `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs`（第三次） | 通过。Chrome `156.0.8078.48` 完成真实模型附件路径：37-byte 附件上传，Session 记录一条 FileBlock，模型执行两次 `read`，清空 OPFS 后从 backend 补水并再次读取；5 个模型请求，Workspace revision 保持 0，页面错误为 0。前两次 `UPSTREAM_LLM_EMPTY` 仍作为间歇性上游结果保留。 | 更新真实模型验收状态；运行最终 diff、文档门禁和 pre-push scope 检查。 |
| 2026-10-29 | `pnpm exec tsx scripts/run-oxlint.ts docs/drafts/browser-native-dsh-poc/browser-native-attachments.ts docs/drafts/browser-native-dsh-poc/browser-native-providers.ts docs/drafts/browser-native-dsh-poc/browser-native-worker.ts docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs` | 通过，无诊断。 | 重跑文档门禁和 diff/scope 检查。 |
| 2026-10-29 | `pnpm run test:docs`; `pnpm run doc-sync`; `git fetch origin research`; `pnpm --silent run change-scope --base origin/research`; `git diff --check` | 文档 quick gate 21/21、doc-sync 43/43 通过；fetch 成功，`change-scope` 的 merge base 为当前 HEAD，范围只有本批 11 个文件；diff whitespace 检查通过。 | 最终复跑文档门禁，复核完整 diff 后提交并推送 `research`。 |
| 2026-10-29 | 最终 `pnpm run test:docs`; `pnpm run doc-sync`; `git diff --check` | progress 更新后再次通过：21/21、43/43，无 whitespace 错误。 | 本批验证结束。 |

## 验证结果

OPFS staging、backend 发布前和发布后三种取消时序的 Chrome E2E、backend 合同测试、backend-v2 回归、preview build、定向 Oxlint、文档门禁，以及真实 LLM 正常附件闭环均已通过。真实 LLM smoke 前两次因 `UPSTREAM_LLM_EMPTY` 失败，第三次成功；该间歇性上游空响应仍需保留为观察结果。变更范围仅包含本批 11 个 PoC 文件，`git diff --check` 通过。

## 限制与经验

- 无 Session 到 Workspace 的权威绑定和附件引用账本前，不按 mtime 或“当前没有 FileBlock”推断对象可删除。
- backend 在对象发布后无法由浏览器 AbortSignal 撤销 hard-link 发布；UI 必须区分移除 draft 与删除远端对象。
- Session snapshot 中包含 harness runtime-context user event；验收按三个唯一 prompt 内容 marker 检查用户提交次数，不把该上下文投影误报为重复 prompt。
- E2E barrier 必须显式释放并等待 Worker writer、backend handler、browser request 和临时目录清理结束，不能用固定 sleep 推断取消完成。
- Browser-Native Worker E2E 读取 `apps/web/dist`；改完 Worker 源码后必须先重建 preview，不能把旧 bundle 上的 barrier 超时当成产品行为。
- Safari/WebKit、自然 eviction、自然网络失败、OS/磁盘崩溃、生产对象存储和真实 LLM 故障路径不属于本批证据。本批真实 LLM 正常附件 smoke 前两次遇到 `UPSTREAM_LLM_EMPTY`，第三次完整通过；上游空响应的成因不在本批验证范围内。
