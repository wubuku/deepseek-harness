---
description: "给 Browser-Native Session 定义可移植导出包（格式版本、附件引用、导入校验），并用 8 个坏数据用例证明导入会拒绝而不是静默错读。"
---

# Session 导出与导入

## Summary

[导出/导入测试](tests/session-export-import.e2e.mjs)先通过 Node 侧 Session API 创建一个带附件的 Session（1 个 `user/message` 文件块 + 1 个 assistant 事件、1 个 content-addressed 附件），再用 `POST /api/browser-native/session/export` 导出，改成新 id 后 `POST /api/browser-native/session/import` 导入，最后读回并核对附件。

导出包固定带三个版本口径：`format: "dsh-session-bundle"`、`formatVersion: 1`、`sessionFormatVersion: 4`（与 Session 日志头一致）。包内还包含 `exportedAt`、`workspaceId`、`session.header`、`inheritedEventCount`、`events`、`durableThroughSeq`，以及被事件引用的附件（`attachmentId` 为 `sha256:<64hex>`、`bytes`、base64 `data`、可选 `name`）。

导入先完整校验再落盘：格式/版本、会话 id 与 header 一致、事件序号从 0 连续、事件必须有类型与 data、每个文件块引用必须在包里存在且摘要与字节数匹配。8 个坏数据用例全部按预期拒绝，且被拒的 id 不出现在 `session/list`，源 Session 的事件数保持不变。

## 导出包

| 字段 | 含义 | 校验 |
| --- | --- | --- |
| `format` | 固定 `dsh-session-bundle` | 不匹配即 `INVALID_BUNDLE` |
| `formatVersion` | 1 | 其他整数即 `UNSUPPORTED_BUNDLE_VERSION`（409） |
| `sessionFormatVersion` | 4，与 Session 日志版本一致 | 仅作携带；导入以 `session.header.version` 为准 |
| `exportedAt` | ISO 时间 | 导出生成，导入不信任该值 |
| `workspaceId` | 附件所属 Workspace | 导入时由请求体指定，不采用包内值 |
| `session.header` | 原始 Session 头（id、version、createdAt、cwd） | `header.id` 必须等于 `session.id`；`header.version` 必须为 4，否则 `SESSION_FORMAT_UNSUPPORTED`（422） |
| `session.events` | 存储顺序的事件 | `seq` 必须等于下标；`type` 非空字符串；`data` 必须存在 |
| `session.durableThroughSeq` | 已持久化到的序号 | 必须落在 `[-1, events.length)` |
| `attachments[]` | 以 `sha256:` id 定位的附件 | base64 必须规范、`bytes` 等于解码长度、sha256 等于 id |

附件按内容寻址写入 `attachments-v1/<workspaceId>/<hash>`，已存在且校验通过的对象直接复用，因此重复导入附件幂等。导入不复制 `principalId`：新 Session 归导入方的 principal 所有。

## 拒绝用例

| 坏数据 | 错误码 | HTTP |
| --- | --- | --- |
| `formatVersion: 2` | `UNSUPPORTED_BUNDLE_VERSION` | 409 |
| `session.header.version: 5` | `SESSION_FORMAT_UNSUPPORTED` | 422 |
| 第二个事件 `seq: 5`（序号断档） | `INVALID_BUNDLE` | 400 |
| 事件 `type: 42` | `INVALID_BUNDLE` | 400 |
| 文件块引用存在但 `attachments` 为空 | `ATTACHMENT_MISSING` | 409 |
| 篡改 base64 首字节 | `ATTACHMENT_DIGEST_MISMATCH` | 409 |
| `bytes` 比实际多 1 | `ATTACHMENT_SIZE_MISMATCH` | 409 |
| 导入已存在的 Session id | `SESSION_ALREADY_EXISTS` | 409 |

拒绝发生在任何写入之前：`assertSessionBundle` 是纯函数，只有全部通过后才会 `store.create`、写附件、`store.flush`。若 `create` 因重复 id 失败，不会写任何附件；若附件写入或 flush 失败，内存中的新 Session 被删除并释放 mount，不留下“空壳 Session”。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 版本不匹配时是否尝试兼容读取 | 否，直接拒绝 | 静默按旧/新格式解释会产生看似正常但语义错误的事件；`SESSION_FORMAT_UNSUPPORTED` 已在存储层表达同一立场。 |
| 包的 id 是否允许改写 | 允许，但 `session.id` 与 `header.id` 必须同时一致 | 复制/迁移需要新 id；只改一个会破坏两者一致性的校验。 |
| 附件是否内嵌 base64 | 是 | 单文件包便于迁移；代价是请求体受 8 MB 限制，大附件需要分片或外部引用，尚未实现。 |
| 导入方工作区如何确定 | 请求体 `workspaceId`，并要求导入方拥有该 Workspace | 包内的 `workspaceId` 只是导出方上下文，不能作为写入授权。 |
| 失败的导入是否清理已写附件 | 不清理 | 附件是内容寻址且未被任何 Session 引用的对象，可安全留在磁盘；删除会与并发导出竞争。 |
| 导出是否需要 owner 写租约 | 不需要 | 导出只读；用 `store.exclusive` 保证读到一致快照，不检查 owner。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [backend-v2.mjs](backend-v2.mjs) | 新增 `assertSessionBundle`、`bundleAttachmentReferences`、`decodeBundleAttachment`（纯校验）与 `buildSessionBundle`、`writeBundleAttachment`、`importSessionBundle`（IO），并在 `/session/export`、`/session/import` 路由接上。 |
| [tests/session-export-import.e2e.mjs](tests/session-export-import.e2e.mjs) | 创建带附件 Session、导出、复制导入、读回与 8 个拒绝用例。 |
| [apps/web/src/browser-native-page-control.ts](../../../apps/web/src/browser-native-page-control.ts) | 页面在持有 Session 写租约后显示导出按钮，调用 `/session/export` 并下载 `dsh-session-<id>.json`；失败只显示状态文本。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增导出/导入行。 |

导出/导入是 PoC backend 的 HTTP 接口，不改 Session 存储格式、Worker、profile 或 Agent Loop；未新增 Session 事件，也不影响模型可见输入。

## 证据

```sh
node docs/drafts/browser-native-dsh-poc/tests/session-export-import.e2e.mjs
```

输出：

```json
{"result":"passed","scope":"session-export-import",
 "format":{"format":"dsh-session-bundle","formatVersion":1,"sessionFormatVersion":4},
 "exported":{"sessionId":"portable-export-1","eventCount":2,"attachmentCount":1,"attachmentBytes":28},
 "imported":{"sessionId":"portable-import-1","eventCount":2,"attachmentCount":1,
  "durabilityReceipt":"durable-portable-import-1-1"},
 "rejections":[
  {"name":"unsupported bundle version","code":"UNSUPPORTED_BUNDLE_VERSION","status":409},
  {"name":"unsupported Session log version","code":"SESSION_FORMAT_UNSUPPORTED","status":422},
  {"name":"non-contiguous event sequence","code":"INVALID_BUNDLE","status":400},
  {"name":"event without a type","code":"INVALID_BUNDLE","status":400},
  {"name":"referenced attachment is missing","code":"ATTACHMENT_MISSING","status":409},
  {"name":"attachment digest mismatch","code":"ATTACHMENT_DIGEST_MISMATCH","status":409},
  {"name":"attachment size mismatch","code":"ATTACHMENT_SIZE_MISMATCH","status":409},
  {"name":"duplicate Session id","code":"SESSION_ALREADY_EXISTS","status":409}],
 "catalogSize":3}
```

确定性断言：导出包的 `formatVersion` 为 1、`sessionFormatVersion` 为 4；事件序号 `[0,1]`；附件 `bytes` 与原始字节数一致；导入后 `eventCount` 与 `attachmentCount` 与导出相同；附件可再次下载；所有被拒 id 不在 `session/list`；源 Session 仍是 2 个事件。

## 限制

- 请求体上限 8 MB，附件以 base64 内嵌，因此单包只适合小附件；大文件需要外部引用或分片，未实现。
- 导入只覆盖单 Session；跨 Session 的 fork/handoff 历史、Session 继承链与 workspace 文件不打包。
- 未验证两个 backend 实例之间的迁移（同一 `workspaceId` 在另一实例不存在）；当前要求导入方已拥有目标 Workspace。
- 未测并发导入同名 Session、导入过程中的 lease 竞争、磁盘写满与 `flush` 失败注入后的附件残留。
- 浏览器 UI 只提供导出按钮（见[产品可见性](product-visibility.md#session-导出)）；导入没有页面入口，仍走 HTTP。
- 附件内容校验只保证摘要与长度，没有媒体类型检测；包内 `name` 仅作展示。
