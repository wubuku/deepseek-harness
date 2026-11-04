---
description: "一条真实 Chrome 脚本串起首次使用、多 turn、审批、协作与导出，并逐步核对可见 UI 与 durable Session 数据。"
---

# 用户旅程叙事 E2E

`tests/user-journey.e2e.mjs` 把此前分散验证的能力收进同一条叙事路径：首次打开、连续对话、审批工具执行、第二 principal 只读协作、Session 导出。脚本在每一步同时断言页面可见状态与 backend 的 durable 记录，最后要求导出包与权威 `session/read` 逐事件相等。模型使用 scripted 分支，UI、审批卡、composer、Worker 与 Session 持久化都是真实路径。

## 步骤与断言

| 步骤 | 操作 | 可见状态 | durable 断言 |
| --- | --- | --- | --- |
| 首次使用 | 打开 durable preview，等待 Workspace `synced` | composer 可见、0 条用户气泡、无审批卡 | 恰有 1 个 `session/create`；该 Session 0 条 `user/message`、0 个 `turn/start`；`/workspace/identity` 返回 owner 的 `workspaceId` |
| 多 turn | 真实 composer 连续发送 3 条普通任务 | 用户气泡数随 turn 依次为 1/2/3 | 3 条 `user/message`、3 个 `turn/start`、3 个 `turn/end`；每个 turn 均有 assistant 文本且 reason 为 `completed` |
| 审批 | 发送 `BROWSER_NATIVE_APPROVAL_ALLOW_ONCE_E2E`，等待审批卡并点击 `Allow once` | 卡片出现且含 `ALLOW_ONCE` 命令与 `Allow once`；结算后卡片消失；transcript 出现结算 marker | 1 条 `approval/asked`、1 条 `approval/decided`（`allowed-once`）、工具结果 `isError=false`；工作区文件为 `APPROVAL_ALLOW_ONCE_WRITE_OK\n`（29 字节） |
| 协作 | 新 principal 取得 viewer 授权；owner 再跑第 5 个 turn | owner 用户气泡为 5 | 授权前 viewer `open` 为 404；授权后 `shared:true` 且无 owner lease；viewer `read` 的 `seq` 与 owner 完全一致；viewer `open(access:write)`/`append` 为 403 `SESSION_READ_ONLY`；viewer `export` 为 404 |
| 导出 | `POST /session/export` | — | `dsh-session-bundle` v1 / `sessionFormatVersion: 4`；事件与 `read` 深度相等、`seq` 连续；5 条用户 prompt、1 条审批决策、0 个附件；`durableThroughSeq` 相同 |

## 实测结果

Chrome 156.0.8078.80 / macOS，`llmMode: 'scripted'`，roster `original`：

| 指标 | 值 |
| --- | --- |
| 首次使用到 `synced` | 3,438 ms |
| 3 个普通 turn | 2,935 ms / 35 事件 |
| 审批结算 | 1,029 ms，`allowed-once`，1,029 ms 内完成卡片到 turn 结束 |
| 协作授权到 viewer 读回 | 900 ms；授权前 404，授权后 59 事件 |
| 导出 | 12 ms / 33,782 字节 / 59 事件 / `durableThroughSeq 58` |
| 请求计数 | 1 次 `session/create`、33 次 `session/append`、7 次 `/llm` |

页面错误、Worker 错误与跨源请求均为 0。

## 结论

同一条用户路径上的四个状态源保持一致：页面转录、Session 事件日志、Workspace 文件与导出包。审批作为一次性决策在 UI 与日志中都只结算一次；viewer 协作不改变 owner 的写入权，也不能借此导出；第 5 个 turn 在授权后仍能被 viewer 读到，说明授权只读不影响 owner 继续追加。导出包与权威读取逐事件相等，说明导出不是第二套投影。

## 边界

- 模型为 scripted 分支，不证明真实模型的工具选择或长上下文质量；真实模型产品路径仍由[黄金路径回归](golden-path-e2e.md)与[审批策略配置](approval-policy-configuration.md)拥有。
- viewer 协作通过 HTTP 证明读取与拒绝，未在 viewer UI 中打开第二份转录；没有实时推送，viewer 的读回是新请求。
- 只验证 viewer 角色；editor 共编、执行权移交与实时流另见[协作章节](README.md#实时协作editor-共编与执行权移交)。
- 导出包没有附件；附件与导入的坏数据用例见[导出与导入](session-export-import.md)。
- 没有覆盖多标签控制权争用、刷新恢复或 backend 重启；这些由各自专项测试拥有。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/user-journey.e2e.mjs
```
