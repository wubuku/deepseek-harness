---
description: "记录 Workspace 内容分块上传协议的实现、故障实验、真实 Chrome 与 LLM 验证。"
---

# Workspace 内容分块上传协议实施进度

## 当前状态

本批实施与验证完成。主工作区 `research` 起始与远端同步且干净；无隔离 worktree。范围与验收见[验证计划](content-upload-protocol-validation-plan.md)，脱敏 HTTP 与成本证据见[Chrome 结果](content-upload-protocol-chrome-results.json)。CDC 保持显式 opt-in：二进制场景减少上行，文本场景出现负收益，不能据此替换默认固定分块协议。

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 候选评估与规划 | 完成 | 选定真实上传、服务端成本、故障恢复、安全与版本协商四个交付面 |
| M1 backend 协议与负向测试 | 完成 | 新增 16 项通过；布局、来源授权、幂等、损坏、CAS、fencing、GC 与完成后 staging 释放 |
| M2 Worker uploader 与桥接测试 | 实现完成 | capability preflight、稳定布局、非静默降级、缺块校验；新客户端 3 项与 Workspace/持久化/chunker 合计 43 项测试通过 |
| M3 Chrome HTTP 成本与重启恢复 | 完成 | 9 场景、14 runs，166.93 秒；5 场景各跑独立冷存储 fixed/CDC，另 4 个丢响应恢复场景 |
| M4 真实 LLM、文档与交付 | 完成 | CDC opt-in、original roster 三轮真实 LLM；固定协议 64 MiB 恢复回归；文档与类型检查通过，验收服务可访问 |

## 真实 HTTP 成本

每个策略和场景使用全新 backend dataDir 与空 blob store；恢复只复用自己的 dataDir 和端口。以下是目标修改阶段实际 PUT body bytes，不含协议 metadata、响应体和初次文件上传，不能当作所有网络流量。插入/删除为中部 64 KiB，等长修改为 4 KiB；输入均为确定性合成数据。

| 场景 | 固定分块 bytes | CDC bytes | 上行变化 |
|---|---:|---:|---|
| 16 MiB 二进制插入 | 8,454,144 | 168,315 | 减少 98.01% |
| 16 MiB 二进制删除 | 8,323,072 | 161,744 | 减少 98.06% |
| 16 MiB 文本插入 | 8,454,144 | 8,540,757 | 增加 1.02% |
| 16 MiB 文本删除 | 8,323,072 | 8,409,685 | 增加 1.04% |
| 64 MiB 二进制等长修改 | 1,048,576 | 216,594 | 减少 79.34% |

二进制插入的 fixed/CDC 修改阶段请求数为 15/7，PUT 数为 9/1；CDC start layout 为 12,322 bytes。64 MiB CDC layout 为 44,656 bytes。完整字段与其余场景见 JSON；没有将估算节省率填成实测值。

上行减少没有消除 backend I/O。16 MiB 二进制插入仍完整读取来源 16,777,216 bytes，候选范围读取及 staging 复制各 16,674,437 bytes，staging 额外校验读取 33,348,874 bytes，最终组装读写各 16,842,752 bytes；完成后保留 staging bytes 为 0。manifest commit 还校验完整目标；工件里的 `derivedManifestCommitVerifyBytes` 是按源码和成功 commit 文件大小核算，不是观测计数器。metadata 文件 I/O、对象存储请求费和低端设备资源成本未测。

## 恢复、安全与负对照

`reuse`、缺块 PUT、`complete`、`commit` 四阶段均先让真实 backend 处理成功，再丢弃响应、终止 Worker、重启同 dataDir backend 并刷新恢复。operationId、目标 hash、布局保持一致，只重试同步协议，manifest revision 只增加一次；完整文件 hash、刷新读取与目标一致。脚本不提交 composer prompt、不执行 Agent Loop，LLM 请求数为 0；preview 会创建空 Session，检查该 Session 无用户、助手、工具或 turn 事件。页面错误、Worker 错误、意外外连均为空。

backend 单测覆盖连续布局、gap/overlap/块数上限、块与整文件 hash、同 operation 改布局、未授权来源、staging 损坏、来源 GC、stale CAS 和 fencing。sidecar GC 只处理当前持锁 Workspace；完成标记保留重放身份，释放 `.part`，重放不依赖来源或重组文件。

强制将 CDC 路径改成 fixed 的负对照如期失败：节省率为 0，未满足两个移位场景至少 50% 的既定判据。早期测试误将所有文本也约束为 50% 并失败，最终恢复规划中原定的“至少两个场景”判据，保留文本负结果；没有更换语料或算法迎合结果。首次混用后端缓存的试跑不计入最终基准。

## 命令与结果

本批实际执行：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
pnpm run build:check
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/content-upload-client.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-content-chunker.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/content-upload-backend.test.mjs docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/content-upload-backend.test.mjs
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
git diff --check
```

preview、Web tsc、build:check、43 项 Vitest、文档检查与 diff 空白检查通过。首次联合 backend 运行是新增 15 项和既有 77 项；随后补充 GC 锁范围回归，新文件单独 16/16 通过，既有 backend-v2 单独复跑 56/56 通过。`test:docs` 21/21、`doc-sync` 43/43。定向 oxlint 通过；全仓 lint 存在未改文件的既有错误：`packages/core/tools/tests/json-schema.spec.ts:251`、`apps/web/src/browser-native-recovery.ts:62` 和 `:252`，另有 `client-ui-cot-translation` unused-disable warning；不宣称全仓 lint 通过。

真实 Chrome/`original` roster 在 CDC opt-in 下通过 3 轮真实模型 `read → write → read`、刷新 Session 记忆与 durable 文件读取；60 Session events、watermark 59、8/8 模型 HTTP 200、两次 Workspace commit 200、无 pageError。保留既有 context-capacity warning、preview 附属 API 404 与流/刷新 abort 记录，不宣称无警告。模型为 `gpt-5.6-sol`；命令见 README 本节入口。

固定协议回归使用 `DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 DSH_POC_EXTERNAL_EDIT_CRASH_STAGE=reuse` 运行 `tests/external-edit-unknown-commit.e2e.mjs`，确认 64 MiB 文件只上传 1 MiB，revision 2，单次 edit/receipt，无重放 prompt，无页面或 Worker 错误。

本批本机证据目录为 `/tmp/dsh-content-upload-validation.tB3EJw`，包括 `chrome-cold-all.log`、`chrome-cold-negative-fixed.log`、`real-llm-cdc-final.log`、`fixed-recovery.log`、`client-tests.log`、`content-backend-final.log` 与各检查日志；提交工件只含脱敏 HTTP 字段和合成数据。模型密钥仅 backend 从 `docs/drafts/.env` 读取。首次误用 `pnpm exec eslint` 因仓库没有 ESLint config 退出，随后采用仓库 oxlint；临时验收 probe 首次使用 Playwright named import 失败，改为该 CJS 包的 default import 后通过，没有改动共享依赖。

## 用户验收服务

| 项目 | 实际值 |
|---|---|
| URL | `http://127.0.0.1:49217/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none` |
| worktree / 分支 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness` / `research` |
| 端口 / PID | 49217 / 69113，`listen(0)` 分配 |
| 日志 | `/tmp/dsh-content-upload-validation.tB3EJw/acceptance-server.log` |
| 数据 | `/tmp/dsh-content-upload-validation.tB3EJw/acceptance-data` |
| 启动记录 | `/tmp/dsh-content-upload-validation.tB3EJw/acceptance.json`；同目录 `acceptance-server.mjs` |
| 停止 | `kill -TERM 69113` |
| 截图 | `/tmp/dsh-content-upload-validation.tB3EJw/acceptance-chrome.png` |

已检查同源 config 为 real 模式，并用真实 Chrome 打开页面，Workspace 显示 synced、composer 可用、pageError 为空。首次 bootstrap 可能显示无法创建默认 Workspace 的既有提示，选择 `/dsh/home/` 后可用。该服务启用 CDC，实际内容为私有 runtime image，仍引用 preview 构建产物；后续重建 preview 后应重新启动验收服务，不能将临时服务路径当长期部署。

## 经验与限制

1. 内容分块收益依赖语料、实际边界和服务端允许复用的范围；上一批算法估算不能代替协议执行结果。文本负结果是保留默认 fixed 的直接依据。
2. 测量必须隔离 backend 冷存储；浏览器 context 隔离不足以排除同一 blob store 预热带来的假收益。脚本自证路径不能替代 HTTP、Session 和持久化核对。
3. upload complete 不等于 manifest commit。保留完整 blob 校验、CAS、writer fencing 与 OPFS/IndexedDB retry 身份，才能在丢响应后继续而不重放业务副作用。
4. 布局是有版本的验证索引，不能只按算法名字信任 bytes；server 校验实际范围、每块和全文件，不重新计算 gear 边界。缺少旧文件索引明确报错，本批不补建、不静默回退。

完整 blob 仍是文件内容权威；本批不实现 chunk 对象库，不用估算流量冒充实际上传，不把本机 backend 视为生产云存储。自然 eviction、OS crash、多实例、生产对象存储、旧索引迁移、低端设备和真实业务语料的通用收益未验证。Dedicated Worker 仍受页面生命周期约束。
