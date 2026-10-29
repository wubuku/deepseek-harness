---
description: "规划 Browser-Native DSH 通用文件附件的流式保存、Session 引用、OPFS 缓存与刷新恢复验证。"
---

# 通用文件附件验证计划

## 目标

验证成熟 DSH composer 选取的通用文件能否沿正式 `FileUploads`、`AttachmentStore`、Session `FileBlock` 和标准 `read` 工具路径，在 Worker 中流式接收并可恢复地供 Agent 读取。Session 只保存 DSH 文件引用；附件不是 Workspace 文件，不参与 Workspace revision、dirty 状态或 manifest。

本批在主工作区 `research` 实施，不创建隔离 worktree。只修改 `docs/drafts/browser-native-dsh-poc/`；不修改正式 package、默认 profile、根依赖或 lockfile。Chrome 是验收浏览器，Safari 暂停。

## 当前依据

正式 Web profile 已有 composer 文件选择、独立后台上传 carrier、Session staged receipt 和附件引用；`AttachmentStore.saveFileStream()` 接收有背压的异步字节流，`FileBlock` 经 DSH LLM 请求组装转换为可读路径提示。Browser Worker transport 可传递 `ReadableStream`，Host `prepareVfs` 在 Cordis boot 前恢复 VFS。当前 browser-native Workspace 只持久化 Workspace 路径，不能兼作 Session 附件存储。

PoC 当前使用的 `attachment-local` 面向 Node `DSH_HOME`，并非可依赖的 OPFS/cloud 附件实现。本批以独立 Browser-native AttachmentStore 替换 PoC profile 中该 provider，不更改普通 DSH profile。

## 交付面

1. **身份隔离的后端内容存储。** 在 PoC `dataDir` 中按已有 browser Workspace identity 隔离附件对象；上传端点逐块读取、限制总字节、计算 SHA-256，并以内容摘要原子发布。下载端点要求同一身份与 Workspace 授权。重复内容返回相同 `FileAttachmentRef`，不创建重复对象；PoC 不把本地 dataDir 描述为生产云存储。
2. **Worker AttachmentStore 与 OPFS。** 真实 composer 原始流先写入 OPFS 临时文件并增量计算摘要，再以 OPFS `File.stream()` 上传后端；不将整文件聚合到 JS heap。完整收到并校验后，Worker 将 OPFS 文件作为只读 VFS external backing 暴露在 `fileHostPath()` 返回路径。上传取消、配额错误、后端失败或摘要不一致均不得返回附件引用。
3. **Session 历史补水。** Worker 打开 Session 时从真实 Session event pages 收集 `FileBlock` 引用；先验证本地 OPFS 缓存，缺失时从身份授权的同源后端流式下载、校验并缓存，再把文件挂入 VFS。补水失败必须阻止该 Session read/turn 返回成功，不能向模型提供无法读取的引用。
4. **浏览器闭环及隔离。** Chrome 真实 UI 选择文件、发送消息、检查 Session `FileBlock`、由真实 DSH `read` 读取；清除该身份的 OPFS 附件缓存并刷新，验证后端补水后同 Session 再次 `read` 成功。另测重复内容、跨 Workspace 拒绝、取消/失败无 Session 引用、附件不出现在 Workspace manifest，以及大文件流式资源上限。
5. **真实模型冒烟。** 通过 `docs/drafts/.env` 仅在 backend 配置的真实 LLM，上传小文本附件，验证真实模型工具调用 `read`、回复引用内容、Session 持久化和刷新恢复。脚本模型故障测试不能替代此项。

## 安全与状态语义

- 后端只接受已有 HttpOnly Workspace identity cookie，并校验请求中的 Workspace 归属；浏览器不提交 principal id 或模型凭据。
- 对象键是 SHA-256；临时对象在完整摘要验证和同文件系统原子发布前不可读。
- Session `FileBlock` 只有在附件对象已经在后端完整发布后才可生成；若 HTTP 响应丢失，重传相同 bytes 由内容寻址自然幂等，不重放 Agent prompt 或工具副作用。
- OPFS 是本机可丢失缓存；恢复以授权后端对象为源。OPFS eviction 后允许重新下载，后端对象缺失或身份不符则显式失败。
- 文件名仅用于显示和 VFS 别名，不参与对象身份；路径分隔符、控制字符和跨平台设备名必须安全处理。
- Workspace、Session event log 和 Attachment object 是独立持久化对象，没有跨存储原子事务。先发布不可变附件对象，再写 Session 引用；未引用对象可遗留，不能通过回滚 Session 假装删除附件。

## 验收判据

| 面向 | 验收 |
|---|---|
| 正常流程 | 官方 composer 选择文件后出现 staged attachment；正式 Session 保存 `FileBlock`；真实 DSH `read` 读取精确字节并产出匹配 callId 的 `tool/result` |
| 流式资源 | 对合成 16 MiB 文件，页面、Worker 和 backend 路径均不调用 `arrayBuffer()`/base64 聚合；记录流块、文件字节和最大单块，不将 VFS `residentBytes` 当作浏览器 heap |
| 持久化 | 同一 Session 刷新可从 OPFS cache 读取；清除附件 OPFS 后由 backend 分块下载并再次读取，摘要和长度一致 |
| 身份 | 用另一 Workspace identity 下载旧对象返回拒绝/不可见；不得向攻击者返回对象是否存在的敏感区分 |
| 故障 | 上传中止、backend 503、OPFS quota/写入失败、坏摘要、缺失远端对象均无 `FileBlock`/staged success；会话可继续 |
| 隔离 | 上传和读取不创建 Workspace manifest entry、revision 或 Workspace receipt；正文与密钥不写入 backend logs、Session 以外日志或截图 |
| 回归 | 原 browser-native Workspace、普通文件 read/write、真实模型普通文件 smoke 仍通过；普通 DSH Web profile 未变 |

## 顺序

先完成后端流式对象协议与负向测试，再加入 Worker OPFS provider 和 Session hydration；随后做 provider 单测与 Chrome composer/恢复/隔离 E2E。最后运行真实 LLM smoke、检查网络与脱敏日志、更新 README、兼容矩阵、drafts 索引和变更账本，再运行针对性文档门禁并提交推送。

## 限制

本批后端是单进程 PoC `dataDir`，不证明生产云对象存储、跨主机可用性、对象 GC、保留策略或跨 Workspace 分享。Dedicated Worker 仍受页面生命周期约束。未验证的真实自然 eviction 与 OS 级崩溃不得用可控删除或脚本故障注入冒充。

## Dev Note

此文记录实施前计划；实际实现、命令、结果和偏差见[实施进度](generic-file-attachment-validation-progress.md)。
