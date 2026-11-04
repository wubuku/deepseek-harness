---
description: "Browser-Native DSH 的一次性只读分享链接：带过期时间的 token、兑换后的 viewer 授权、到期与撤销语义，以及实测证据。"
---

# 带过期时间的只读分享链接

## 结论

owner 现在可以在不知道对方 principal 的情况下分享：生成一个带过期时间的一次性 viewer 链接，查看者用自己的 principal 兑换成只读授权，授权与链接同寿，owner 可随时撤销。token 只以 SHA-256 出现在磁盘上，兑换不会发放 owner token 或编辑租约，到期/撤销后该 principal 立即失去读、写与导出能力。

| 行为 | 结果 |
| --- | --- |
| 兑换前读取 | 404 `SESSION_NOT_FOUND`（尚无授权） |
| 兑换 | `role: viewer`，授权带 `linkId` 与 `expiresAt`，无 `ownerToken` |
| 兑换后读取 | 200 `shared: true`，读到 `[0,1]` 两个事件 |
| 兑换后写入 | `open(access:'write')` 403 `SESSION_READ_ONLY`，`append` 403 |
| 重复兑换 | 409 `SHARE_LINK_USED` |
| 到期后 | 读取 404；再兑换 410 `SHARE_LINK_EXPIRED` |
| 撤销后 | 读取 404；再兑换 410 `SHARE_LINK_REVOKED`；重复撤销 `revoked:false` |
| 重启后 | 已撤销与已到期的授权仍为 404 |
| 令牌持久化 | `session-shares.json` 无 token 明文，只有 64 位十六进制 hash |

## 机制

`session-shares.mjs` 的 share 文件升到 v2：`shares` 之外新增 `links`，每条 link 保存 `linkId`、`sessionId`、`ownerPrincipalId`、`role`、`tokenHash`、`createdAt`、`expiresAt`、`redeemedBy`、`revokedAt`。v1 文件（只有 `shares`）仍按 viewer 授权加载，下一次写入才升级为 v2；不认识 v3 的读取方 fail loud。

- `createLink` 生成 32 字节随机 token（43 字符 base64url），只把 `sha256` 写入文件；`expiresAt` 必须是未来的毫秒时间戳，`role` 固定为 `viewer`。
- `inspectLink` 依次拒绝格式错误、未知、已撤销、已过期、已兑换的 token；过期优先于已兑换，避免把“曾可用”误报成“仍可用”。
- `redeemLink` 在单个 Session 的串行区里复核 token 后写入授权，授权带 `linkId` 与链接的 `expiresAt`；已存在 `editor` 授权时不会被降级，但仍标记链接已兑换。
- `roleOf(sessionId, principalId)` 对带 `expiresAt` 的授权按注入时钟判定，过期即返回空；读、写、导出与 transfer 因此统一失效。
- `revokeLink` 只能由 owner 调用，写入 `revokedAt` 并删除该 `linkId` 产生的授权；重复调用返回 `revoked:false`。
- 路由 `POST /session/share-link`、`/share-link/redeem`、`/share-link/revoke` 复用 `dsh-browser-native-session-principal` cookie；创建与撤销走 `getForPrincipal`（非 owner 一律 404），兑换先校验 Session 是否存在再落授权，避免为已删除 Session 留下孤儿 grant。

## 实测输出

```text
{
  "result": "passed",
  "scope": "expiring-read-only-share-link",
  "sessionId": "sess-link-47b9afbc-9b24-4814-b598-cf80d3e8ab16",
  "linkId": "59f19443-6582-4ef2-ae32-9d35685de383",
  "linkExpiresInMs": 120000,
  "viewerReadEvents": 2,
  "viewerWriteDenied": "SESSION_READ_ONLY",
  "viewerLeaseAcquired": false,
  "secondRedemption": "SHARE_LINK_USED",
  "expiredRedemption": "SHARE_LINK_EXPIRED",
  "revokedRedemption": "SHARE_LINK_REVOKED",
  "revokeIdempotent": true,
  "accessAfterRestart": { "revoked": 404, "expired": 404 },
  "auditDenials": 2
}
```

复跑：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/session-share-link.test.mjs
node docs/drafts/browser-native-dsh-poc/tests/share-link.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/session-sharing.e2e.mjs
```

## 限制

- 链接只能兑换一次，且要求查看者已持有自己的 principal（同一浏览器身份）；没有免身份匿名访问。
- 只支持 viewer 链接，editor 授权仍走需要目标 principal 的 `session/share`。
- 撤销与到期只影响该链接产生的授权，不影响 owner 或其它已授予的 viewer/editor。
- 共享读取的审计仍是 access-denial 与 collaboration 日志，不含查看页面停留时长或下载次数。
- 时钟来自 backend 进程；多机部署需要同步时钟或把 `expiresAt` 判定下沉到共享存储。
