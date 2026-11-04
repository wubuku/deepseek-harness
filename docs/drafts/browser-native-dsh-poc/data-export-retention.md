# 用户数据导出与保留策略

本页定义 Browser-native PoC 的 principal 数据导出包与可配置保留期，并用真实 Chrome 与真实 provider 客户端路径验证两件事：导出必须完整且无法混入其他 principal 的数据；保留期到期后任何读路径都不能再取回数据，清理也不依赖客户端配合。

## 导出包

`GET /api/browser-native/workspace/principal-export` 用 Workspace principal cookie 鉴权，返回 `principal-export.mjs` 的 v1 bundle。导出路由挂在 `/api/browser-native/workspace/` 前缀下，因为 principal cookie 的 `Path` 限定在该前缀；放在独立前缀会拿不到身份。

bundle 字段：

| 字段 | 内容 |
| --- | --- |
| `identity` / `principalId` / `workspaceId` | 当前 principal 与其绑定 Workspace |
| `workspace` | `workspace-v2/workspaces/<id>.json` 元数据 |
| `workspaceBlobs` | Workspace entry 引用的文件 blob（base64、字节数、sha256） |
| `sessions` | 该 principal 的 Session 记录：头、完整事件、`durableThroughSeq`、owner epoch 与 handoff |
| `attachments` | `attachments-v1/<workspaceId>` 下的附件对象（base64、字节数、sha256） |
| `usage` | usage ledger 条目，含缓存读写拆分 |
| `cost` | 由同一批 usage 派生的成本报表 |
| `accessDenials` | 仅属于该 principal digest 的拒绝访问审计 |
| `counts` | 上述各集合的数量与字节数 |
| `digest` | 覆盖其余全部字段的 SHA-256 |

导出本身先做一次 `verifyPrincipalExport`，不完整或归属错误的 bundle 不会发出。校验方重新推导摘要、每个附件与 blob 的长度和 sha256、Session 的 `principalId` 与 `header.id` 一致性、每类 `counts` 以及成本报表的 `requests` 是否等于 usage 条目数；任一不符即抛 `principal export verification failed`。HTTP 信封会加 `protocolVersion`，摘要只覆盖 bundle 自身字段，校验时剔除该信封字段。

## 保留期

保留期按 Session 的 `lastActivityAt` 计算：`max(header.createdAt, 文件 mtime, 最近一次 flush 时刻)`。配置入口为 `createBrowserNativeV2Server({ retentionDays, retentionSweepMs })`，`retentionDays` 为 0 表示不启用；`retentionSweepMs` 默认 5 分钟，最小 250 毫秒。usage 与审计 journal 记录按各自的 `at` 时间戳判定。

到期数据有两条防线：

1. 读取层立即拒绝。`session/get`、`session/get-for-principal`、`session/list` 与导出在访问时调用 `isExpired`，越过窗口即返回 410 `SESSION_EXPIRED`，不等待后台清理；`usage-audit`、`usage-report`、支持包摘要与导出统一走 `retainedUsage()`，按同一 cutoff 过滤。
2. 后台清理删除落盘数据。`purgeExpired()` 删除 Session 文件与内存锁；`sweepRetention()` 同时删除内存 usage 条目，并调用 `observability-journal.redact()` 删除过期 journal 行（访问拒绝与 usage 两个文件）。启动时先清理一次，之后按 `retentionSweepMs` 周期执行；定时器 `unref()`，不阻止进程退出。

`GET /api/browser-native/retention` 返回 `retentionDays`、`sweepIntervalMs` 与最近一次 sweep 的 `at`/`cutoff`/`sessions`/`usageEntries`/`journal` 计数，用于运维确认清理确实运行。

## 实测

`tests/principal-data.e2e.mjs` 分两段运行，均使用本地 OpenAI-compatible SSE upstream，驱动真实 provider 客户端、usage 解析与成本报表。

Run A（关闭保留期）：两个独立浏览器上下文（alice、bob）各完成一轮 turn 并各自写入一个 Workspace 文件，另为 alice 的 Workspace 写入一个附件对象。导出 alice 后断言：

- `sessions=1`、`sessionEvents=18`、`workspaceBlobs=1`、`attachments=1`，导出的 usage `requestId` 集合与 `/usage-audit` 完全一致，`cost.totals.requests === usage.length`。
- bundle 文本不含 bob 的 principalId、Session id、Workspace id 或 `BOB_` marker 内容。
- 篡改附件字节后 `verifyPrincipalExport` 抛 `/principal export verification failed/`。

Run B（`retentionDays=2/86400` 即 2 秒、`retentionSweepMs=5_000`）：carol 完成一轮后等待窗口越界，在 sweep 之前读与追加都返回 410 `SESSION_EXPIRED`；导出 `sessions=0`、`usageEntries=0`，`/usage-audit?sessionId=` 为空；随后轮询 `/retention` 直到 `lastSweep.sessions` 含该 id，确认 Session 文件 `ENOENT`、`usageEntries` 被删除、`/usage-report` 的 `totals.requests=0`。

实测输出：

```json
{"result":"passed","upstream":"local-openai-compatible","export":{"sessions":1,"sessionEvents":18,"workspaceBlobs":1,"attachments":1,"usageEntries":2,"costRequests":2,"digest":"68ddcad46bb1f9a4"},"retention":{"retentionDays":0.000023148148148148147,"sweepIntervalMs":5000,"readStatus":410,"readCode":"SESSION_EXPIRED","appendStatus":410,"exportSessions":0,"exportUsageEntries":0,"sweptUsageEntries":2,"reportRequests":0,"fileDeleted":true}}
```

## 默认策略

1. 托管部署应显式配置 `retentionDays`；未配置视为不清理，需要由运营策略决定而不是默认猜测。`retentionSweepMs` 只需小于期望的清理延迟上限，读取层已在到期时立即拒绝。
2. 导出包包含原始字节（附件与 Workspace blob 以 base64 内联），适合直接交还给用户或迁移，但不宜作为长期归档格式；需要长期归档时按 `hash` 去重存储并只保留元数据。
3. 清理不可绕过依赖两条路径同时实现：任何读接口先过滤，后台 sweep 再删除。新增读取路径必须复用 `retainedUsage()` 与 `isExpired`，否则会重新打开已过期数据的读口。
4. 附件与 Workspace blob 按 Workspace 归属，删除 Session 不等于删除文件对象；`attachments-v1` 与 `workspace-v2` 对象由既有附件 GC 与 Workspace 生命周期管理。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node docs/drafts/browser-native-dsh-poc/tests/principal-data.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/usage-report.test.mjs
```

## 边界

真实 provider 配额已耗尽（402 `Usage limit reached`），因此本项用本地 OpenAI-compatible upstream 走完整 provider 客户端与 usage 解析，未再请求外部网关；这不影响导出、保留期与成本口径的验证。Run B 的 2 秒窗口是测试用压缩时间，不代表生产窗口；未覆盖跨进程并发 sweep、清理过程中的崩溃恢复、对象存储后端的分段删除，以及导出包在传输层的加密与签名。以上均不改变“到期读取返回 410、sweep 删除落盘数据”的结论。
