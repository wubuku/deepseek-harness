---
description: "记录 Browser-Native DSH 附件 GC 与增量 hydrate 的实现位置、证据与限制。"
---

# 附件 GC 与增量 hydrate 实施进度

## 已落档的语义

[计划](attachment-gc-validation-plan.md)确定：

- 引用权威是 durable Session 的 `user/message` `FileBlock`；
- 孤儿必须超过 `attachmentGcMinAgeMs` 才可回收；
- `PUT` 成功（新建或复用）递增 workspace 上传代，GC 在扫描后、删除前重校验代，失配返回 `scan-stale` 且不删除；
- 删除幂等，失败单独报告；
- Worker 仅在 `size` 与 `lastModified` 都与已校验记录一致时复用校验结果；
- 定时 sweep 默认每 5 分钟运行，可用 `attachmentGcSweepIntervalMs` 配置或设为 0 关闭；测试用 `testHooks.attachmentGcNow` 注入时钟，不依赖真实等待；
- 跨实例由 dataDir 锁 fence，第二个存活实例返回 `BACKEND_ALREADY_RUNNING`，不能并发运行 sweeper。

## 实现位置

- `backend-v2.mjs`：`referencedAttachmentHashes()`、`listAttachmentObjects()`、`listAttachmentWorkspaces()`、`attachmentGcToken()`、`collectAttachments()`、`sweepAttachments()`；`GET /api/browser-native/workspace/attachments/gc-token` 与 `POST /api/browser-native/workspace/attachments/gc`；定时 sweep 与 dataDir 锁 fence。
- `browser-native-attachments.ts`：`verifiedObjects` 缓存与 `verifyObject()`；挂载、发布和下载统一走该函数，完整校验失败时清除对应缓存项。
- `browser-native-worker.ts`：测试通道 action `attachment-verify-state`、`attachment-hydrate-probe`；仅在 `browser-native-test` 打开时记录校验模式。
- 测试：`tests/attachment-gc.backend.test.mjs`、`tests/attachment-gc.e2e.mjs`。

## 证据

### backend 合同测试

`node --test docs/drafts/browser-native-dsh-poc/tests/attachment-gc.backend.test.mjs` 通过：

- durable Session 引用的对象在 GC 后保留，孤儿对象被删除；
- 用同一 token 重跑 GC 不删除任何对象；
- 取 token 后新上传触发 `scan-stale`，新对象保留；
- 复用上传也递增代，旧 token 被拒绝，原对象保留；
- 用新 token 回收前一轮的迟到对象；
- backend 重启后旧 token 失配，在用对象仍可下载。

### 定时与跨实例合同测试

`node --test docs/drafts/browser-native-dsh-poc/tests/attachment-gc.backend.test.mjs` 通过，定时用例输出：

```json
{"result":"passed","scope":"scheduled-attachment-gc-with-injected-clock","skippedYoungOrphan":true,
 "deletedAfterClockAdvance":["3d282165f374f23f1a4ed91812d34b4b31dc1924ba2a42556d801f7d9c8763c7"],
 "keptAfterClockAdvance":1,"intervalSweptOrphan":true,"inUseBytesIntact":true,
 "secondInstanceRejected":"BACKEND_ALREADY_RUNNING"}
```

注入时钟前进前后调用 `app.sweepAttachments()`：年轻孤儿保留，超期孤儿删除，在用附件保持 200；随后上传的新孤儿由 10 ms interval 自动回收；同一 dataDir 的第二个实例启动被拒绝。

### Chrome E2E

`node docs/drafts/browser-native-dsh-poc/tests/attachment-gc.e2e.mjs` 在 Chrome `156.0.8078.79` 通过，输出摘要：

```json
{"browser":"chrome","browserVersion":"156.0.8078.79","attachmentBytes":8232,
 "gc":{"tokenGeneration":2,"scanned":2,"kept":1,
       "deleted":["3f522bede96430baa557bb5c935956364101aa6c01ae431af89076a7dde69fb9"],
       "skipped":null,"failures":[]},
 "keptAfterGc":200,"orphanAfterGc":404,
 "warmProbe":["cached","cached"],
 "evictedProbe":["cached","cached"],
 "rehydrateDownloads":2,"pageErrors":[]}
```

步骤：上传附件并由标准 `read` 工具读取成功；durable Session 文件包含 `sha256:` 引用后才取 token；直接上传孤儿对象；GC 只删除孤儿；在用对象 `GET` 返回 200 且内容逐字节一致、孤儿返回 404。同一 Worker 连续两次 hydrate 只报告缓存命中；随后清空 OPFS 目录并重新打开预览，Session 挂载重新下载对象，再次 hydrate 仍报告缓存命中。

## 限制与未覆盖

- 定时 sweep 只在单进程 backend 内运行；不提供真正的跨实例共享存储 GC、分布式 generation fencing、跨主机协调、容量配额、对象版本历史或 Session 删除后的保留策略。
- 宽限期默认 5 分钟；测试把 `attachmentGcMinAgeMs` 设为 0。生产值需要覆盖上传与 Session 落盘的最大延迟。
- 未用 OPFS 原地篡改证明 `lastModified` 缓存失效路径：Chrome 中 Worker 的同步访问句柄独占对象，其他上下文无法在保持 Worker 存活时覆盖同一文件。缓存失效依赖 `getFileHandle` 失败或 `size`/`lastModified` 变化；读取内容仍每次全量校验。
- 未验证 Safari/WebKit 的 OPFS `lastModified` 行为、真实模型上传大附件、跨标签同时 GC。

## 下一步

定时/跨实例 fence 已完成；真正多实例共享存储 GC、分布式 fencing、容量配额、Safari OPFS 与真实模型大附件仍未验证。
