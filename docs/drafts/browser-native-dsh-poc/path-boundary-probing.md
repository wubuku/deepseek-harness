---
description: "Browser-Native PoC 的路径边界探测：Workspace、附件、blob、Session、durable 与静态预览的穿越/编码/符号链接防护及两处修复。"
---

# 路径穿越与文件边界

## 探测范围

`tests/path-boundary.test.mjs` 对同一 backend 发起四组请求：

- Workspace `commit` 的 `changes[].path`：`..`、多级 `..`、绝对路径、Windows 盘符、反斜杠、NUL、空段、`.` 段、尾斜杠，以及 `%2f`/`%2e`/`%5c`/`%00` 编码变体。
- 附件、blob-upload 的 `workspaceId`，Session `create`/`durable` 的 `sessionId`：`..`、`../escape`、`..%2fescape`、绝对路径、NUL、斜杠。
- 附件上传的 `name=../../escape.txt`：断言只保留叶子名。
- 静态预览：`/../secret.txt`、`/%2e%2e/secret.txt`、`/..%2fsecret.txt`、`/..%5csecret.txt`、`/..\secret.txt`、`/%2fsecret.txt`、`/etc/passwd`、`/%00`，以及 `dist` 内指向根目录外文件的符号链接。

每个失败请求后检查 `manifest` 仍为空、根目录外的 canary 目录只有原文件、canary 内容不变。

## 既有防护（无需修改）

- Workspace 路径由 `validatePath()` 拒绝绝对路径、反斜杠、NUL、空段、`.` 与 `..` 段。
- 附件与 blob 路径只接受 UUID `workspaceId` 与 64 位十六进制 `hash`，文件名经 `attachmentName()` 取叶子并去除控制字符/Windows 保留名。
- Session id 只允许 `[A-Za-z0-9._-]`，不含 `/`、`\`、NUL 与 `%`，落盘为 `sessions/<id>.json`，无法跨目录。
- durable `turnId` 只作内存键；`sessionId` 走与 Session 路由相同的校验。

## 修复

1. **编码穿越**：`workspace-v2.mjs` 的 `validatePath()` 增加一次解码检查。`%2f`、`%2e%2e%2f`、`%5c`、`%00` 在本 backend 里原本会被当作字面文件名保存，不直接越界；但任何下游解码一次就会看到不同路径。现在这类编码在写入前返回 400 `INVALID_PATH`。普通含 `%` 但解码后不改变路径结构的名字仍可用。
2. **预览符号链接**：`backend-v2.mjs` 的 `safeStaticPath()` 在解析路径后对 dist 根与目标文件做 `realpath`，目标的真实路径必须仍在真实根内，否则 404。`dist` 内指向根外的链接此前会被 `readFile` 跟随并读出根外内容。
3. **Windows 盘符**：`C:/escape.txt` 在 POSIX 上只是普通文件名；为可移植性一并按 `INVALID_PATH` 拒绝。

## 证据

```text
▶ browser-native path boundaries
  ✔ rejects traversal and encoded separators in Workspace paths without creating files
  ✔ rejects traversal ids in attachments, blobs, sessions, and durable routes
  ✔ reduces an attachment upload name to its leaf and keeps it inside the workspace
  ✔ static preview requests cannot read outside the dist root
ℹ pass 4  fail 0
```

回归：`workspace-durability`、`verified-stream-backend`、`session-workspace-reconciliation`、`backend-v2` 共 92/92。

## 边界

- 符号链接只覆盖静态预览；`sessions/`、`attachments-v1/`、`uploads/` 的符号链接需要本地文件系统写入权限，HTTP 层没有创建链接的入口，因此未纳入远程攻击面。
- 编码检查只做一次解码；多层编码（如 `%252e%252e%252f`）不会被本层识别，但也不会在本 backend 内越界，下游若反复解码需自行再校验。
- 未测 Windows 路径语义、大小写不敏感文件系统、NTFS ADS 与 Unicode 规范化冲突。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`；未改 LLM 语义，无需真实模型 smoke。
