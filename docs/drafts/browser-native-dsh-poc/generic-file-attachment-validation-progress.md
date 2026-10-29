---
description: "记录 Browser-Native DSH 通用文件附件从正式 composer 到 Session、OPFS/VFS、backend 和刷新恢复的验证证据与限制。"
---

# 通用文件附件实施进度

## 当前状态

本批选择的文件附件闭环已在主工作区 `research` 完成；没有使用隔离 worktree。源码基线为 `dsh-v0.2.1-rc.2`，起始 checkout 为 `research`、起始工作区干净。计划见[通用文件附件验证计划](generic-file-attachment-validation-plan.md)。

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0 源码核对与方案 | 完成 | 复用正式 composer、`FileUploads`、`AttachmentStore.saveFileStream()`、Session `FileBlock`、`ctx.fs` 和 Worker Host boot 前 VFS 准备；不把 Workspace store 当作附件库。 |
| M1 身份授权后端附件流 | 完成 | 新增按 Workspace principal 隔离的 PoC object PUT/GET；流式 SHA-256 校验、64 MiB 上限、完整临时对象验证后 hard-link 发布、同身份下载；覆盖重复对象、跨身份拒绝、中断清理、坏 hash、上限和 backend 重启读取。 |
| M2 Worker OPFS/VFS provider | 完成 | profile overlay 替换 Node `attachment-local`；Worker 流式写 OPFS、上传 backend，再通过 `MemoryVfs.seedExternal()` 暴露只读文件路径；Session 历史 `FileBlock` 在 `read()` 返回前从 OPFS 校验或由 backend 补水。Worker Host 关闭 VFS 时释放 external backing。 |
| M3 Chrome 故障和恢复 | 完成本批范围 | scripted E2E 通过正式 composer 上传 16 MiB 文件、DSH `read`、删除附件 OPFS 缓存、刷新同 Session 后 backend 补水并再次 `read`；Workspace revision/entries 不变。backend Node 测试覆盖中断上传、身份和对象校验。浏览器级 OPFS quota、上传 outage 后无 `FileBlock`、自然 eviction 未覆盖。 |
| M4 真实 LLM 和文档 | 完成 | 真实 Chrome/LLM 上传 37-byte 文本文件，模型两轮调用标准 `read` 并回答文件内容；清除 OPFS 后同 Session 刷新由 backend 补水。页面/Worker 请求保持同源。README、兼容矩阵、drafts 索引和本账本已登记本批能力与限制。 |

## 实际验收

后端中断上传用例确认客户端 abort 后没有 `.part` 或已发布对象残留。backend contract tests 覆盖 principal 隔离、SHA-256、大小上限、同内容重传、重启下载和 Workspace revision 不变。完整 backend 回归用于确认新附件 route 与原 v2 行为共存。

scripted Chrome 使用 16 MiB 文本附件；backend 收到 256 个流块，最大观察块为 130,276 bytes。Session 记录一条 `FileBlock`，每轮只执行一个标准 `read`；清理 OPFS 后出现一次附件 GET，第二轮读取成功。Workspace revision 保持 0、manifest entries 不变，页面无错误。此块统计是 backend 请求流的观察值，不是浏览器 heap/RSS 测量，也不证明任何环境中都采用相同块长。

真实 Chrome/LLM 使用 37-byte 附件；两轮 `read` 成功，Session 保留同一附件引用，清除 OPFS 后从 backend 下载一次并在同 Session 续聊。两个提示词必须区分，避免刷新后的轮询把旧 user message/terminal 当作新 turn；测试按 turn 和 callId 配对，不假设 callId 跨 turn 全局唯一。真实模型只验证小文本文件，不覆盖大附件或大 tool arguments。

## 命令与结果

本批实际命令和结果：

```text
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview — passed
node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs — 3/3 passed
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs — 56/56 passed
node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs — Chrome 156.0.8078.48 scripted passed; 16 MiB, 256 chunks, max chunk 130276 bytes
DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs — Chrome 156.0.8078.48 real LLM passed; 37 bytes; 2 read turns; OPFS restore download 1
pnpm run test:docs — 21/21 passed
pnpm run doc-sync — 43/43 passed
```

真实模型仅由 backend 使用 `docs/drafts/.env`；不复制或记录任何凭据。

## 限制与经验

- `FileAttachmentRef` 不携带独立 Workspace namespace；恢复使用当前浏览器 Workspace 身份。切换身份后读取旧 Session 附件会显式失败，跨设备共享尚未设计。
- OPFS 仅作可丢失缓存，backend `dataDir` 是单机 PoC 对象存储；没有对象 GC、生产认证、云对象存储或跨主机可用性。
- Session FileBlock、附件对象、Workspace manifest 是分开写入的持久化对象，没有跨存储事务。backend 已保存但后续 Session append 失败时可能遗留不可达对象。
- 同源 API 会按内容 hash 幂等复用对象，但当前没有保留期、配额账户、删除接口或孤儿回收。
- 附件限 64 MiB；图片附件明确拒绝。自然 eviction、OS/磁盘崩溃、多设备恢复、浏览器 quota、上传期间 backend outage、Safari 和大文件真实 LLM 未验证。
- Session 的 callId 不保证单独构成跨 turn 的全局键；验证和恢复按 DSH turn/step/callId 复合身份匹配。
- E2E 启动并关闭临时同源 backend；本轮未留下供手工验收的常驻服务。
