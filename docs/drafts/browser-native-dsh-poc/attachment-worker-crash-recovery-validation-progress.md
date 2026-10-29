---
description: "记录 Browser-Native DSH 附件 Worker 强制终止恢复验证的实施状态、Chrome 证据、真实模型 smoke 和经验教训。"
---

# 附件 Worker 强制终止恢复进度

## 当前状态

状态：已完成。本批在主工作区 `research` 实施，起始时分支与 `origin/research` 同步，没有创建隔离 worktree。范围和验收见[验证计划](attachment-worker-crash-recovery-validation-plan.md)。Safari/WebKit、自然 eviction、OS/磁盘崩溃、生产对象存储和附件引用账本仍未验证。

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：现状与候选核验 | 完成 | 确认上一批只覆盖 AbortSignal 取消；`upload-*`/`download-*` 与 `.crswap` 没有 Worker crash 后回收；backend 已有部分上传清理和对象原子发布路径。 |
| M1：临时文件锁与保守回收 | 完成 | `upload-*`、`download-*` 临时项在创建前取得按 Workspace 和文件名派生的 Web Lock；恢复扫描只删除能取得锁的临时项及对应 `.crswap`。 |
| M2：Chrome 双标签活动上传隔离 | 完成 | Chrome 156 中标签页 A 的暂停上传持有 Workspace writer lease 时，标签页 B 的只读 Worker 跳过清理并拒绝上传；A 的 staging 与 `.crswap` 保持不变。 |
| M3：强制终止与对象重试矩阵 | 完成 | OPFS staging 强杀后新 Worker 清理孤儿；backend 收到部分 body 后终止会清理 `.part`；对象发布后终止不会删除完整对象，同 hash 显式重选可复用。 |
| M4：回归、真实模型与文档 | 完成 | Preview、定向 lint、语法检查、附件/backend 回归、Chrome 取消与 crash E2E、真实 Chrome/LLM 附件 smoke 通过；文档、索引和变更账本已更新。 |

## 实施结果

- `BrowserNativeAttachmentModule` 暴露测试限定的 `reconcileTemporaryFiles()`；生产附件 API 没有新增恢复请求或自动补交行为。
- 每次 OPFS 临时写入在创建文件前持有同源 Web Lock，锁覆盖 staging、发布或失败清理的完整生命周期。没有 Web Locks 时，清理器不猜测活跃状态，也不删除临时项。
- AttachmentStore 首次访问 Workspace 的附件目录时扫描 `upload-<uuid>`、`download-<uuid>` 及 `.crswap`，对每个候选使用 `ifAvailable` 锁；活动 Worker 持锁时跳过，已终止 Worker 留下的项可被后继 Worker 清理。Workspace writer lease 仍独立限制双标签写入，读者不能借临时文件锁绕过 writer 权限。
- hash 命名的 OPFS 内容对象不是临时项。backend 上传期间即使 Worker 已终止，另一 Worker 也必须保留该对象；对象发布后的未知 receipt 通过内容 hash 重选和服务端 `reused` 结算恢复，不按本地 Session 视图删除。
- 强制终止不会写入 Session prompt、FileBlock 或 Agent `read`。浏览器 File 和 composer draft 不跨 Worker/刷新持久化；用户重新选择文件并显式发送后，Session 才记录 FileBlock。

## 验证结果

| 命令或验收 | 结果 |
|---|---|
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；仅有仓库既有不匹配平台和 chunk-size 警告。 |
| `pnpm exec oxlint docs/drafts/browser-native-dsh-poc/browser-native-attachments.ts docs/drafts/browser-native-dsh-poc/browser-native-providers.ts docs/drafts/browser-native-dsh-poc/browser-native-worker.ts` | 通过。 |
| `node --check docs/drafts/browser-native-dsh-poc/tests/attachment-worker-crash-recovery.e2e.mjs` | 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs` | 5/5 通过；覆盖中断清理、并发同 hash 发布、响应丢失重试和 backend 重启读取。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 56/56 通过。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-worker-crash-recovery.e2e.mjs` | Chrome 156.0.8078.48 通过；活动 staging 在双标签扫描和只读上传拒绝期间保留，OPFS 强杀后孤儿 `upload-*`/`.crswap` 被回收，partial backend upload 结果为 `aborted`，发布后 receipt 为 `sent`，同 hash 重试 `reused=true`，最终显式发送产生 1 个 prompt 和 1 个 FileBlock，页面错误/跨源请求均为 0。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs` | Chrome 156.0.8078.48 通过；既有 OPFS、发布前和发布后取消路径保持通过。 |
| `DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs` | Chrome 156.0.8078.48 真实 LLM smoke 通过；37-byte 附件完成两次 `read`、Session FileBlock 持久化、清理 OPFS 后 backend 补水和刷新恢复，5 个模型请求，Workspace revision 0，页面错误为 0。 |

故障矩阵使用测试 barrier 和 backend test hooks，不把真实模型宣称为故障注入证据。测试观察到 backend 在对象发布后可以继续发送 receipt；因此 Worker terminate 后不能据此判断远端是否回滚。发布前中断的 `.part` 和对象清理由 backend contract test 与 Chrome crash E2E 共同确认。该实现没有附件引用账本，发布后取消或未知 receipt 仍可能留下无引用对象；本批不实现对象 GC。

复跑时曾将“第二标签页必须成功上传”误写为断言；Chrome 正确以 Workspace writer lease 拒绝只读 Worker 的上传。修正后的断言验证 fail-closed、无第二个临时上传和活动 staging 保留，未放宽运行时权限。

## 经验与限制

- Web Lock 只能证明同源活跃 Worker 当前持有锁。浏览器崩溃、进程被系统终止或锁实现异常不等于可安全删除；生产实现仍需要远端引用账本、对象生命周期和保守 GC。
- OPFS 临时项清理与 hash 内容对象采用不同安全级别：前者可由可取得锁的扫描回收，后者必须等待引用/上传账本确认，不能按文件年龄、当前 Session 或“没有 FileBlock”删除。
- backend 对 `.part` 的清理不等于跨存储事务。Session FileBlock、OPFS 内容、backend 对象和 Workspace revision 仍可能处于不同状态，未知结果必须查询或按 hash 幂等对账，不能盲目重放用户 prompt。
- 该批验证了真实 Chrome Worker/OPFS/同源 PoC backend 的可控故障窗口，不验证自然 storage eviction、OS 级崩溃、跨设备恢复、多实例生产对象存储或页面关闭后后台 Agent。

## 复跑入口

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-worker-crash-recovery.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs
pnpm run test:docs
pnpm run doc-sync
```

## Dev Note

本进度记录只陈述当前 checkout 的实际证据；计划中未纳入的自然 eviction、OS crash、生产对象存储和附件 GC 不得由本批结果外推。
