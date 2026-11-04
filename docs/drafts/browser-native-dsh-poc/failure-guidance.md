---
description: "Browser-native DSH PoC 把失败或拒绝码映射为可读说明与下一步动作，并用真实拒绝场景验证界面入口。"
---

# 错误码与可操作建议

## Summary

`apps/web/src/locales/browser-native-failure-guidance.ts` 是失败文案与下一步动作的 owner：它把 backend 拒绝码、模型失败码和阻塞的 Workspace 状态映射为标题、说明、动作类型与可复制的请求文本。页面控制把结果渲染到 workspace 状态条与失败 turn 重试条，动作有 `retry`、`reload`、`request-access`、`contact-admin`、`diagnostics` 五类。未知码仍保留一次重试，并同时提供诊断包导出。

## 映射与入口

| 码 | 触发场景 | 页面说明 | 动作 |
| --- | --- | --- | --- |
| `SESSION_ALREADY_OWNED` | 同一 principal 的第二个标签页打开写 | 该会话已在另一个标签页写入 | `reload`（重新加载并接管） |
| `SESSION_EDITOR_LEASE_HELD` | 共享 editor 的写租约被占用 | 另一个编辑者持有写入租约 | `reload` |
| `SESSION_OWNERSHIP_LOST` | 本标签页失去租约 | 写入权已转移 | `reload` |
| `SESSION_READ_ONLY` | viewer 打开写或追加事件 | 只有查看权限 | `request-access`（复制权限申请） |
| `SESSION_OWNER_REQUIRED` / `SHARE_REQUIRED` / `SESSION_NOT_FOUND` | 缺少 owner 权限、未共享、链接失效 | 需要所有者授权 | `request-access` |
| `TOKEN_BUDGET_EXCEEDED` | Session 或租户 token 预算耗尽 | 请求未发送、没有新增 provider 费用 | `contact-admin` + 诊断包 |
| `UPSTREAM_LLM_AUTH_FAILED` | provider 拒绝凭据 | 需管理员修正密钥 | `contact-admin` + 诊断包 |
| `UPSTREAM_LLM_RATE_LIMITED` / `_TIMEOUT` / `_UNAVAILABLE` / `_STREAM_FAILED` / `_EMPTY` | 模型侧瞬时失败 | 可重试，部分附诊断包 | `retry` |
| `ADMISSION_TIMEOUT` / `SESSION_TURN_ACTIVE` | 并发槽位或在途 turn | 稍后重试 | `retry` |
| `SESSION_MOUNT_LIMIT` | 超过 16 个挂载 Session | 关闭不用的标签页 | `reload` |
| `SESSION_RECOVERY_REQUIRED` | 后端需先重载持久化状态 | 联系管理员或重载 | `reload` |
| `WORKSPACE_SNAPSHOT_STALE` | 只读 Workspace 快照过期 | 重新加载最新版本 | `reload` |
| 未知码 | 未登记的失败 | 先重试一次，仍失败导出诊断包 | `retry` + 诊断包 |

阻塞的 Workspace 状态直接复用同一张表：`session-conflict → SESSION_ALREADY_OWNED`、`lease-conflict → SESSION_EDITOR_LEASE_HELD`、`read-only → SESSION_READ_ONLY`、`stale → WORKSPACE_SNAPSHOT_STALE`。因此状态条与 turn 失败条不会出现两套措辞。

`contact-admin` 与 `request-access` 把带 Session id（和 turn 号）的文本写入剪贴板，并在原位显示“已复制”结果；`diagnostics` 调用既有 support bundle 下载，文件名仍为 `dsh-support-bundle-<sessionId>.json`。重试条只在动作是 `retry` 时显示重试按钮，预算、权限与凭据类失败不会给出盲重试。

## 验证

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-failure-guidance.spec.ts
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/failure-guidance.e2e.mjs
```

`failure-guidance.e2e.mjs` 用真实 preview、真实 Session log 与真实 backend 拒绝，覆盖三个场景：

- **预算超限**：scripted provider 以 `TOKEN_BUDGET_EXCEEDED` 拒绝 turn。重试条显示 “Token budget exhausted”、动作 `contact-admin`，重试按钮不可见；点击后剪贴板文本包含 Session id 与错误码；诊断包下载成功，原位结果变为 “Diagnostics bundle exported”。
- **lease 冲突**：第二个标签页打开同一 Session，Workspace 状态到达 `session-conflict`，指南码为 `SESSION_ALREADY_OWNED`、动作为 `reload`，并保留原有的 “Retry opening this Session” 按钮。
- **只读共享**：owner 创建 Session 并授予 viewer，viewer 的 `session/open` 写请求与 `session/append` 均返回 403 `SESSION_READ_ONLY`；viewer 的读请求返回 200。

实测输出（2026-11-05，Chrome，macOS，scripted）：

```json
{"budget":{"code":"TOKEN_BUDGET_EXCEEDED","title":"Token budget exhausted","action":"contact-admin","retryOffered":false,"copiedIncludesSession":true,"diagnostics":"dsh-support-bundle-session-….json"},"leaseConflict":{"code":"SESSION_ALREADY_OWNED","action":"reload","guidanceRendered":true},"readOnlyShare":{"openStatus":403,"appendStatus":403,"code":"SESSION_READ_ONLY"}}
```

回归：`turn-retry.e2e.mjs` 仍通过（未知码 `SCRIPTED_UI_RETRY_FAILURE` 保留重试按钮与一次结算），`turn-retry-ledger.test.mjs` 5/5，`browser-native-failure-guidance.spec.ts` 7/7。

## 限制

- 预算场景由 scripted provider fault hook 产生真实的失败 turn 与 `turn/end` error code，用于稳定验证界面映射；浏览器端 `browser-budget` 插件自身的“发送前拦截”仍由 `token-budget.e2e.mjs` 的真实 provider 路径拥有。
- 共享 viewer 目前无法在 preview 中打开共享 Session（preview 只打开自己的写 Session），因此只读共享的界面入口未在浏览器内驱动；本项用真实 403 拒绝验证码与状态，用单元测试验证 `SESSION_READ_ONLY` 的文案与动作。若后续增加 viewer preview，应复用同一个渲染入口。
- `contact-admin` / `request-access` 只复制文本，不发送邮件或通知；剪贴板不可用时原位显示失败并保留错误码，用户需手动记录。
- 未知码的诊断包按钮只在已知 Session 时出现；workspace 层的未知失败只显示说明。
- 没有覆盖真实模型自主触发预算拦截、真实 provider 凭据错误、移动端或 Safari。
