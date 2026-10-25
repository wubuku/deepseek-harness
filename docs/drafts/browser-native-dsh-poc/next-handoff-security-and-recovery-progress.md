---
description: "记录 Browser-Native DSH Session handoff 安全、unknown durability、pending work 与 owner 恢复验证的进度和证据。"
---

# Browser-Native DSH handoff 安全与恢复验证进度

## 当前状态

状态：M0–M5 完成。本批在 `research` 主工作区实施；开始时工作区干净且只有主 worktree。上一批 handoff 实现位于当前 checkout，但它的测试通过不代表凭据重放、rename 后故障或 pending execution handoff 安全。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：现状审计与基线 | `complete` | backend 30/30；Chrome Dedicated Worker handoff 通过；源码确认 receipt 重放返回新 token、磁盘 receipt 保存两侧 token、rename 后失败会走旧 owner rollback | 实施 M1，不复用旧的“handoff 安全”结论 |
| M1：凭据隔离与旧 receipt 兼容 | `complete` | bearer 只返回于首次成功响应；receipt 只保留旧 token SHA-256 digest；legacy receipt 启动迁移移除两侧 bearer，迁移写盘失败时 backend 不启动 | 不把 digest 称为加密或生产授权机制 |
| M2：handoff durability/unknown | `complete` | rename 前注入失败返回 `DURABILITY_FAILED` 并保留旧 owner；rename 后注入失败返回 `DURABILITY_UNKNOWN`、封锁 Session 写入，重启从已发布 receipt 恢复 | Chrome 响应丢失可被浏览器透明重试为无凭据 receipt；租约过期后 claim epoch 3 |
| M3：安全点与 pending work | `complete` | operation 或 execution ID 非空时返回 `HANDOFF_BUSY`，owner 可续租；同一 handoff ID 随后以空列表成功 | PoC 不提供 pending tool、HITL 或 outbox 的迁移协议 |
| M4：fencing、并发与 Chrome Worker | `complete` | 同 ID 并发只有首次响应含 owner；不同 ID 竞争最多一个成功；旧 token 的 append/renew/flush/close/LLM 被拒；真实 Chrome Worker 丢响应后安全重试并由新 claimant 接管 | 只证明单 backend PoC Session API，不证明多实例或 Cloud Agent |
| M5：文档、兼容矩阵与门禁 | `complete` | README、兼容矩阵、旧进度、目录索引和 change ledger 已更新；typecheck、preview build、docs quick、doc-sync、diff check 均通过 | 版本与命令见下表 |

## M0：已核实事实

- `backend-v2.mjs` 的 `beginHandoff()` 将 `receipt.previous.ownerToken` 与 `receipt.next.ownerToken` 写入 Session handoff map；`flush()` 将 map 序列化到 `sessions/<id>.json`。
- 相同 `handoffId` 重放只核对旧 token 或新 token，并把 `receipt.next` 原样作为 `owner` 返回；旧 token 因而能再次取得新 bearer token。
- `backend-v2.test.mjs` 的旧测试明确断言重放返回与首次响应相同的新 token；backend restart 测试也通过旧 token 重新取回它。
- checkpoint 校验只限制 pending ID 列表长度与字符串，不拒绝非空列表；当前 Chrome Worker handoff E2E 只用空列表。
- `flush()` 在临时文件 `fsync`、原子 `rename` 和目录 `fsync` 任一步失败时都抛 `DURABILITY_FAILED`；route 对所有失败执行 `rollbackHandoff()`。rename 已完成而目录同步失败时，最终文件可能已替换，但内存会回到旧 owner。
- 现有 backend 验证命令 `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 通过，30/30。
- 现有真实浏览器验证命令 `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs` 通过；只覆盖首次交接、旧 append 拒绝和新 owner append，不覆盖凭据重放、响应丢失或未结算工作。

## 经验与限制

- `ownerEpoch` fencing 只说明旧 token 被当前 owner 检查拒绝，不代表旧 owner 无法通过幂等回执取得新 token。
- 幂等响应不能无条件重放 bearer credential。持久化业务回执与一次性凭据交付必须分开；不确定结果需要单独定义恢复方和凭据取回方式。
- 原子替换以后出现 I/O 错误不是确定回滚。若无法确定发布状态，当前 backend 必须停止该 Session 写入，而不是让内存 owner 与磁盘 receipt 分叉。
- 接受 pending ID 只是保存了字符串，不构成执行、工具、HITL 或 Workspace 操作恢复协议。
- 真实 Chrome Worker handoff test seam 不等于云端 agent 已接管；Workspace lease、模型流、插件 Host 和账号权限均未迁移。

## 本批验证结果

| 命令 | 结果 |
|---|---|
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 35/35 通过；包括 receipt 秘密清除、legacy 迁移/迁移失败、pending 拒绝、pre/post-rename fault、response drop、并发 handoff、旧 owner API fencing 和既有 Workspace/LLM 回归。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts` | 1 文件、4/4 通过；包含 pending execution 拒绝且 owner 不变。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs` | Google Chrome 155.0.8059.85 通过；真实 DSH Worker 发起 handoff，服务端提交后丢弃响应，重试不返回 owner token；租约过期后新 claim epoch=3，旧 owner append 返回 409。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs` | Chrome 155 通过；9 个默认工具 schema、真实 Worker DSH `bash` 调用、24 个 Session events、无工具错误、无跨源请求、无 page error。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-observers.e2e.mjs` | Chrome 155 双页面通过；observer 读取 `nextSeq=2`，无 owner token 的 append 返回 409。 |
| `pnpm run typecheck` | 5/5 gates 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；输出既有 native platform 与 chunk-size warnings。 |
| `pnpm run test:docs` | 21/21 gates 通过。 |
| `pnpm run doc-sync` | 43/43 gates 通过。 |
| `git diff --check` | 通过。 |

本批没有运行真实 LLM、Safari/WebKit、OS/磁盘 crash、生产对象存储或多实例 backend。Chrome 的响应丢失由测试 hook 在 Session 文件 rename 后销毁 HTTP response；它验证应用级 unknown/retry 语义，不模拟内核崩溃或断电。
