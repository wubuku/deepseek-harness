---
description: "记录 Browser-Native DSH 最小服务端 durable turn host 的关页续跑、重开接管与幂等证据，以及未闭环的工具、重启和 UI 缺口。"
---

# Browser-Native 服务端 durable turn host 进度

## 当前状态

状态：最小原型、Chrome E2E、真实模型 smoke 完成；工具执行、进程重启恢复和产品 Worker 只读挂载未实现，按缺口落档。

结论：跨页面关闭的 turn 可以由服务端持有并完成。服务端用 `turnId` 作为幂等键，重复提交不会再次请求模型；关页后 turn 继续，重开标签读取同一 Session 事件；turn 结算后释放 Session 所有权，重开标签可以接管写权。

## 范围

| 已闭环 | 未闭环 |
|---|---|
| 服务端创建或接管空闲 Session，写入 `turn/start`、`user/message`、`step/start` 并 flush | 工具调用执行；模型返回 tool-call 时 turn 以 `DURABLE_TOOL_UNSUPPORTED` 错误结算 |
| 服务端经同源 `/llm` 完成文本 turn，追加 `assistant/message`、`step/end`、`turn/end` 并 flush | 审批、取消、附件、Workspace 工具写和跨 store operation |
| `turnId` 幂等：运行中、完成后重复提交都返回既有状态，不产生第二次模型请求 | backend 进程重启后的在途 turn 恢复；运行记录只在内存 |
| 关页后服务端继续，重开标签读取相同事件并观察完成 | 产品 Worker 只读挂载服务端 Session 的视图；重开标签通过 test HTTP 读取，不渲染聊天 UI |
| turn 完成后释放所有权，重开标签可 `session/open {access:'write'}` 接管 | 多 backend、HA、持久运行队列与配额 |

## 实现

`durable-host-v2.mjs` 导出 `createDurableTurnHost({ store, admission, model, originOf, timeoutMs })`：

- `start({ sessionId, principalId, turnId, prompt, header })`：同一 `turnId` 只执行一次；同一 turnId 绑定到不同 Session 或 principal 返回 409 `TURN_CONFLICT`。
- `status({ turnId, principalId })`：只向同一 principal 返回状态，不暴露 owner token。
- 阶段一在 `store.exclusive` 内创建/校验 Session、`claim` 所有权、追加 3 个开场事件并 flush，然后立即返回 `202`；阶段二在锁外请求模型，阶段三重新取锁并校验 owner 后结算。
- 模型请求复用同源 `/api/browser-native/llm`，因此 Host/Origin 准入、owner fencing 与真实 provider 路径不变。
- 失败时尝试追加 `step/end` 与 `turn/end` 错误结算；无论结算是否成功，最终都释放 owner 与 admission mount。

backend 新增：

- `POST /api/browser-native/session/durable`：请求体 `sessionId`、`turnId`、`prompt`，可选 `header`；新 turn 返回 202，幂等重放返回 200。
- `GET /api/browser-native/session/durable?turnId=...`：返回运行状态、turn、事件 seq 与错误；跨 principal 返回 404 `TURN_NOT_FOUND`。
- 两条路由都要求 Session principal cookie，并沿用回环 Host/Origin 准入。

## 可判定证据

| 检查 | 结果 |
|---|---|
| `node --test tests/durable-host.test.mjs` | 通过。`modelCalls=["primary","primary-released","second"]`；运行中重放与完成后重放均未增加模型请求；turn 1 事件 seq `[0,1,2,3,4,5]`，`durableThroughSeq=5`；跨 principal 404；不同 Session 复用 turnId 409；浏览器已持有的 Session 被服务端接管时 409 `SESSION_ALREADY_OWNED`；settle 后可 `access:'write'` 接管。 |
| `DSH_POC_BROWSER=chrome node tests/durable-host.e2e.mjs` | Chrome 156.0.8078.79 通过：turn 在模型 barrier 中挂起，关页前 3 事件；关页 400 ms 后重开标签读到相同 3 事件且状态仍 `running`；释放 barrier 后同一标签读到 6 事件、1 个 `turn/end`、`durableThroughSeq=5`；重放 `durable-e2e-1` 返回 `completed` 且模型请求仍为 1 次；第二 turn 独立完成；重开标签成功接管写权；另一 principal 读取状态 404；`pageErrors=0`。 |
| 真实模型 smoke | `LongCat-2.5` 完成 `turn/start → assistant/message → turn/end`，耗时 4.1 s，assistant 文本 `DURABLE_REAL_SMOKE_OK`，`durableThroughSeq=5`。同批 `gpt-5.6-sol` 请求返回上游 `insufficient_quota`（HTTP 403），服务端正确结算为 `turn/end` 错误，未重试、未伪造 assistant 输出；该失败是 provider 配额，不是 durable host 逻辑。 |

## 复跑

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/durable-host.test.mjs
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
  DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/durable-host.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/local-request-guard.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/principal-isolation.test.mjs
```

真实模型 smoke 从 `docs/drafts/.env` 读取 provider 配置，只在 Node 进程内使用，不打印密钥；本批因 `gpt-5.6-sol` 配额不足改用同一文件中的 `LongCat-2.5` OpenAI 兼容配置。

## 风险与下一步

- 服务端 turn 已挂载 `read`/`write`/`edit`/`grep`/`glob`/`subagent`，写操作经审批；同一 10 任务真实模型基准达到 10/10、29 请求 / 23,318 tokens。尚未覆盖的是待决审批跨重启恢复与工具结果的跨 store 事务。
- 运行记录只在内存。backend 重启后，已 flush 的开场事件会保留成一个没有 `turn/end` 的 turn；下一次 durable turn 会以 `SESSION_TURN_ACTIVE` 拒绝，需要启动恢复流程把未知 turn 结算为 `interrupted`。
- 产品 UI 没有只读挂载服务端 Session 的入口。本批“重开标签接管视图”由真实 Chrome 标签的 HTTP 读取与写权接管证明，不证明聊天 UI 渲染。
- Session 所有权在 turn 结束后立即释放；长 turn 期间重开标签只能只读，不能抢写。若产品需要“接管即抢占”，需要显式的接管协议与旧执行者 fencing。
- 未验证：多 backend/HA、关页中途正在执行的工具 turn、待决审批跨重启恢复、Safari/WebKit、自然浏览器崩溃与 OS 崩溃。
