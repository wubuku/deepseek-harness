---
description: "规划 Browser-Native DSH 附件对象的安全回收与 Worker 侧增量 hydrate 校验。"
---

# Browser-Native DSH 附件 GC 与增量 hydrate 验证计划

## Summary

本批为附件（`sha256:<64hex>` 内容寻址对象）定义生命周期，并在 PoC backend 与 Worker 中实现最小闭环：backend 只删除「没有任何 durable Session 引用、且足够旧」的对象；Worker 对已校验过的 OPFS 对象复用校验结果，避免每次挂载 Session 都全量重读并重新计算 SHA-256。

附件对象存放在 `dataDir/attachments-v1/<workspaceId>/<aa>/<hash>`，由 `PUT /api/browser-native/workspace/attachments/<64hex>` 创建，由 Session 日志中的 `user/message` `FileBlock` 引用。当前 PoC 没有任何回收路径，重复上传与删除会话会永久留下对象；同时每次恢复 Session 都会对每个附件做完整流式 hash。

## 生命周期与判定标准

| 阶段 | 定义 | 判定 |
|---|---|---|
| 创建 | 上传请求成功写入或复用内容寻址对象 | backend 返回 `attachmentId` 回执 |
| 引用 | 某个已持久化 Session 的 `user/message` 含 `type: 'file'` 块 | 该块的 `attachment.attachmentId` 等于对象 hash |
| 在用 | 至少一个 durable Session 引用该 hash | GC 必须保留 |
| 孤儿 | 无任何 durable Session 引用 | 仅在年龄超过 `attachmentGcMinAgeMs` 后可删除 |
| 回收 | 从对象目录删除孤儿文件 | GC 统计 `deleted`，重复回收幂等 |

### 决策

1. **引用权威只有 durable Session 日志。** backend 扫描 `FormalSessionStore` 中全部已知 Session（不按 principal 过滤），任何 `user/message` 的 `file` 块都算引用。扫描范围放宽到全部 Session 只会阻止删除，不会误删。
2. **未落盘的引用由宽限期保护。** 附件在上传与 `user/message` 落盘之间存在时间窗；`attachmentGcMinAgeMs`（默认 5 分钟）要求对象年龄超过该窗口才可回收，覆盖正常写入延迟。
3. **上传代（generation）守卫。** 每个 workspace 维护单调递增的 `attachmentGeneration`，任何成功的 `PUT`（新建或复用）都递增。`GET /attachments/gc-token` 返回 `instance:generation`；`POST /attachments/gc` 必须携带该 token。GC 在扫描后、删除前在同一 workspace 的锁内重新校验 token；不匹配返回 `scan-stale` 且不删除任何对象。这样扫描期间完成的上传一定保留对象，包括复用旧 hash 的上传。
4. **两阶段 API。** 先取 token，再由调用方决定何时 GC；token 与进程实例绑定，backend 重启后旧 token 必然失配，不会用重启前的引用快照误删。
5. **删除幂等、失败可见。** `ENOENT` 视为已回收；其他删除错误收集进 `failures` 并由调用方判定，不把部分失败描述为成功。
6. **不回收其他对象。** GC 只处理 `attachments-v1/<workspaceId>` 下的 64 位十六进制文件；`.part` 临时文件、Workspace blob、Session 日志和 operation receipt 不属于本能力。
7. **增量 hydrate 校验。** Worker 以 `hash` 为键缓存已成功校验对象的 `size` 与 `lastModified`。命中缓存时只比较 `File.size` 与引用、`File.lastModified` 与缓存值，跳过全量流式 SHA-256；任何一次完整校验失败、对象缺失或 `lastModified` 变化都退回完整校验并在成功后更新缓存。缓存只在当前 Worker 实例内有效，刷新后首次挂载仍完整校验。
8. **正确性优先于节省。** 读取附件内容（`readFileStream`）仍然边读边全量校验；缓存只影响「文件是否可挂载」的重复校验，不改变读取内容的完整性保证。

## 交付面

### 1. backend 两阶段 GC

新增 `GET /api/browser-native/workspace/attachments/gc-token?workspaceId=...` 与 `POST /api/browser-native/workspace/attachments/gc`，后者 body 为 `{protocolVersion, requestId, workspaceId, token}`。返回 `{generation, scanned, kept, deleted, skipped, failures}`。`skipped: 'scan-stale'` 时 `deleted` 必为 0。

### 2. Worker 测试探针

在 `runtime-validation` 的挂载集内提供 `attachment-verify-state` 与 `attachment-hydrate-probe`，用于在真实 Worker 中对同一 hash 连续两次 hydrate，并返回每次是完整校验还是缓存命中。探针只在显式测试通道开启时可用。

### 3. 验收测试

- backend 合同测试：在用附件保留、孤儿删除、token 失配时不删除、复用的新上传因代递增而不被删除、重复 GC 幂等。
- Chrome E2E：上传附件并完成 turn；直接上传一个未被任何 Session 引用的对象；GC 后在用对象 `GET` 仍 200 且内容一致、孤儿 404；随后同一 Worker 内二次 hydrate 返回缓存命中；篡改 OPFS 对象后 hydrate 触发完整校验并重新下载。

## 非目标与证据边界

不实现真正的跨实例共享存储 GC、分布式 generation fencing、跨主机协调、对象版本历史、按 workspace 的容量配额、S3 对象删除、被删除 Session 的历史保留策略，也不证明 `lastModified` 在所有浏览器实现中严格单调。GC 由单进程 backend 的显式两阶段调用或定时 sweep 触发；生产系统需要独立的对象保留策略与跨实例协调。

## 定时与跨实例 fence（补充）

- 定时 sweep 每 `attachmentGcSweepIntervalMs` 运行一次，默认 5 分钟，设为 0 关闭；timer `unref()` 且 `close()` 清除。
- sweep 枚举 `attachments-v1` 下的 workspace 目录，对每个 workspace 沿用同一宽限期、durable Session 引用扫描和 generation 守卫；扫描期间有上传则返回 `scan-stale` 并保留对象。
- 测试通过 `testHooks.attachmentGcNow` 注入 GC 时钟，只影响宽限期判断，不改变 Session/Workspace lease 的真实时钟。
- 跨实例由 dataDir 锁 fence：第二个存活实例在启动时返回 `BACKEND_ALREADY_RUNNING`，因此不能并发运行 sweeper；重启后旧 GC token 失配且不删除对象。
- 验收：`node --test docs/drafts/browser-native-dsh-poc/tests/attachment-gc.backend.test.mjs` 覆盖年轻孤儿保留、注入时钟后删除、10 ms interval 触发删除、在用对象保留和第二实例拒绝。

## 实施顺序

1. 落档本计划的语义决策。
2. 实现 backend 两阶段 GC 与合同测试。
3. 实现 Worker 增量校验缓存与测试探针。
4. 编写并运行 Chrome E2E，更新 README、兼容矩阵与索引。
5. 聚焦检查后独立提交并推送。

## Dev Note

本计划是当前 checkout 的 PoC 研究范围，不是正式附件服务规范。任何不能证明引用关系的删除都必须保守跳过或保留对象。
