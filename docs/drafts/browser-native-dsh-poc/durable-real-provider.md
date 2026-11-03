---
description: "真实模型 durable 全链路：LongCat 端点跑审批、取消与重启恢复；发现 30 秒租约在慢模型下过期并加入租约续期。"
---

# 真实模型 durable 全链路

## 目的

scripted 模型只证明状态机；真实 provider 的延迟、流式格式与工具调用决定 durable 路径能否在生产节奏下成立。本项在真实端点上跑一次完整链路：`write` 审批 → 取消 → 被强杀后恢复。

## 环境

- `DSH_POC_ENV_FILE=docs/drafts/.env` 提供 `OPENAI_*` 配置；未设置时测试 skip。
- `DSH_POC_REAL_PROVIDER=longcat` 让测试 fixture 使用 `OPENAI_MODEL`、`OPENAI_BASE_URL`、`OPENAI_API_KEY`，补全路径 `v1/chat/completions`，并把 LLM 超时放宽到 120 秒。
- 模型：LongCat-2.5，OpenAI 兼容流式接口；durable turn 超时 180 秒，审批超时 120 秒。
- 命令：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_REAL_PROVIDER=longcat \
  node --test docs/drafts/browser-native-dsh-poc/tests/durable-real-lifecycle.e2e.mjs
```

## 链路

1. **审批**：提示模型调用 `write` 写入 `real-durable-approved.txt`。在 `pendingApproval` 出现前 Workspace 无文件；批准后 turn `completed`，文件出现。
2. **取消**：第二次提示写另一个文件，在 `pendingApproval` 出现后 `stop`。turn `cancelled`、`pendingApproval` 清空、目标文件不存在。
3. **重启恢复**：第三次提示写第三个文件，在 `pendingApproval` 出现后对 backend 发 `SIGKILL`。新进程 `recovered: 1`，turn 为 `failed`/`DURABLE_HOST_RESTARTED`，attach 回放 `tool/result`（`isError`）与 error `turn/end`，目标文件不存在，journal 已删除，重启进程的 `model.requests` 为 0。

## 发现并修复：慢模型会耗尽 Session 租约

第一次真实运行在第三个 turn 失败：

```text
turn real-durable-restart settled as failed without a pending write approval
error: SESSION_OWNERSHIP_LOST
```

LongCat 对该请求的响应耗时约 62 秒，超过默认 30 秒 Session 租约。durable host 在等待模型时没有续租，模型返回后 `appendEvents` 的 `store.assertOwner` 因过期拒绝写入。scripted 模型从不触发这个路径。

修复：`durable-host-v2.mjs` 在 `driveTurn` 期间启动心跳，每 `ownerLeaseMs / 3`（默认 10 秒）通过 `store.exclusive` 调用 `store.renew`。token 已被接管、epoch 已移动或租约已过期时心跳静默停止，不会复活旧写者。turn 结算时 `clearInterval`，随后释放租约。

修复后同一命令通过：审批与取消分别 20–30 秒，第三个 turn 的模型请求同样超过 30 秒，但恢复前仍持有租约并成功进入审批等待。

## 可判定输出

```text
✔ real model completes a durable approval turn, cancels a second turn, and a killed backend recovers the third (71515.047375ms)
{"result":"passed","scope":"durable-real-approval-cancel-restart","provider":"longcat","pids":[17648,19935],"approval":{"status":"completed","pendingName":"write","wroteFile":true},"cancellation":{"status":"cancelled","pendingName":"write","wroteFile":false},"restart":{"recovered":1,"status":"failed","code":"DURABLE_HOST_RESTARTED","settlement":["turn/start","user/message","step/start","assistant/message","step/end","tool/call","tool/result","turn/end"],"modelRequestsAfterRestart":0,"journalCleared":true,"wroteFile":false},"elapsedMs":71494}
```

| 断言 | 观测 |
|---|---|
| 真实审批 | `pendingName: write`、批准后 `completed`、`wroteFile: true` |
| 真实取消 | 待决时 stop → `cancelled`、无待决审批、`wroteFile: false` |
| 真实重启恢复 | `recovered: 1`、`failed`/`DURABLE_HOST_RESTARTED`、8 条事件、`modelRequestsAfterRestart: 0`、journal 删除、`wroteFile: false` |
| 租约续期 | 修复前 `SESSION_OWNERSHIP_LOST`；修复后跨 30 秒的响应仍完成或进入审批等待 |
| 总耗时 | 71 494 ms（3 次真实模型请求） |

同批复跑 scripted 回归 8/8：`durable-approval`、`durable-cancellation`、`durable-tool-attach`、`durable-host-restart`（2）、`durable-multi-host`（2）、`observability`。

## 失败场景清单（仍可能成立）

1. **单一 provider/单次运行**：只验证 LongCat-2.5 一次；其他 provider 的流式格式、工具调用与限流未覆盖。
2. **依赖模型服从提示**：审批链路要求模型主动调用 `write`；提示不生效时测试在等待审批处失败，而不是跳过。
3. **取消发生在审批等待**：真实取消没有覆盖模型流式传输中途的 abort；该路径仍只有 scripted 证据。
4. **工具结果语义未校验**：只验证文件出现/不出现与 `isError`，没有校验真实模型对工具结果的后续推理。
5. **租约续期只覆盖进程内**：心跳随进程死亡停止；重启恢复仍按失败结算，没有跨进程续租。
6. **成本与延迟**：每次运行 3 次真实请求、约 70 秒；没有预算、重试或 provider 失败的稳定性断言。
7. **真实 provider 故障未注入**：没有 429/5xx、断流、慢首字节的确定性用例。
8. **环境私有**：`docs/drafts/.env` 是本机文件，不入库；没有该文件的环境只能跳过。

## 边界

- 修改 `docs/drafts/browser-native-dsh-poc/durable-host-v2.mjs` 的租约续期；未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 真实端点只通过 OpenAI 兼容接口访问；未打印或提交凭据。
- 未覆盖多实例真实模型、真实 provider 故障与流式中途取消。
