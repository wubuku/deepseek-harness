# 大附件分片上传与取消

[通用文件附件](README.md#composer-通用文件附件)原先由 Worker 一次 `PUT` 发送整个对象。单请求在 8 MiB 以下可用，但接近 64 MiB 上限时客户端无法在传输中取消，失败后也没有可回收的分片状态。本实现为 8 MiB 及以上文件增加 begin / chunk / commit / abort 协议，小文件继续使用单次 `PUT`。

## 协议

| 请求 | 语义 |
| --- | --- |
| `POST /api/browser-native/workspace/attachments/<hash>/uploads?workspaceId=&name=` | 声明 `{ "bytes": <长度> }`，创建 staging 并返回 `uploadId`、`chunkBytes`（16 MiB） |
| `PUT .../uploads/<uploadId>/chunks/<offset>` | `application/octet-stream` 分片；服务端以 staging 文件大小校验 `offset`，返回 `{ offset, received, bytes }` |
| `POST .../uploads/<uploadId>/commit` | 校验总长度与整文件 SHA-256，`link` 到 content-addressed 对象后返回与单次上传相同的收据 |
| `DELETE .../uploads/<uploadId>` | 幂等删除 staging，不触碰已发布对象 |

`hash`、`workspaceId` 与 `uploadId` 在每条请求上重新校验；分片 URL 的 hash 必须与 begin 时记录的一致，否则返回 `ATTACHMENT_UPLOAD_HASH_MISMATCH`(409)。

## 服务端状态

staging 位于 `dataDir/attachment-uploads-v1/<workspaceId>/<uploadId>.part|json`，对象仍位于 `attachments-v1`。begin 同时创建空 `.part` 与元数据；每个分片先比较 `.part` 当前大小与声明偏移，再按偏移写入并 `fsync`；commit 读取整文件摘要后才发布。已存在目标对象时复用，摘要在任何失败路径上都不会被覆盖。

- 偏移不连续：`ATTACHMENT_UPLOAD_OFFSET_MISMATCH`(409)，staging 保留供客户端重传。
- 提前 commit：`ATTACHMENT_UPLOAD_INCOMPLETE`(409)，staging 保留。
- 整文件摘要不符：`ATTACHMENT_HASH_MISMATCH`(400)，staging 删除，因为无法修正为请求的对象。
- 显式取消：只删除该 `uploadId` 的两个 staging 文件。
- 启动与每 5 分钟 sweep：删除超过 1 小时 TTL 的 staging，只枚举 `attachment-uploads-v1`，不会删除 `attachments-v1` 中的对象。

同一 `uploadId` 的分片、commit 和 abort 由进程内 keyed lock 串行化；这依赖单 backend 实例。`dataDir` 锁已经阻止第二个实例同时运行。

## 客户端

`browser-native-attachments.ts` 在文件达到 8 MiB 时调用分片路径，每片 4 MiB。每次响应都核对 `received` 等于本片结束偏移。任何失败或 AbortSignal 取消都会向 upload 资源发 `DELETE`（`keepalive: true`），然后重新抛出原始错误；小文件路径保持不变。

## 验证

- `tests/attachment-chunked-upload.test.mjs`：3 MiB 分片上传后对象内容一致且 staging 为空；错误偏移、提前 commit、超限 begin 分别被拒；显式取消与摘要失败只删除 staging，已发布对象仍可下载；重启清理 2 小时前的 staging 并保留对象。
- `tests/browser-native-file-attachment.e2e.mjs`（scripted Chrome）：16 MiB 文件走 4 个 4 MiB 分片请求，commit 收据的 hash/name/bytes 与本地一致，随后标准 `read`、刷新补水照常通过。
- `tests/attachment-cancellation.e2e.mjs`：在 backend 收到第 0 片后暂停，UI Remove 触发请求失败与 `DELETE`，staging 清空且没有发布对象；单次 `PUT` 的 OPFS、发布前和发布后取消路径同步回归。

## 缺口

- 不支持刷新后从已有 `uploadId` 续传；客户端失败后重新 begin。
- 分片没有独立摘要，完整性只在 commit 的整文件摘要上一次性验证。
- 只有进程内锁；多 backend 或多进程共享 `dataDir` 时未验证并发分片与 abort 的互斥。
- 没有配额账本、上传进度 UI，也没有真实模型的 64 MiB 附件路径。
