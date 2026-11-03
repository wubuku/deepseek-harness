---
description: "Browser-Native PoC 的 durable host 深化：关页期间工具执行继续、重开标签从任意 seq 接管事件流，验证事件一致、不重复执行与租约归属。"
---

# durable 工具执行与中途接管

## 范围

此前的 durable host 只执行文本 turn；模型返回 tool-call 时直接以 `DURABLE_TOOL_UNSUPPORTED` 结算。本轮把 `read`/`write` 两个 Workspace 工具交给后端执行，并新增事件流接管路由，使关页后已开始的工具步骤仍会完成，重开标签能在任意步骤接入。

## 行为

- durable turn 向模型声明 `read`、`write` 两个函数工具，参数各为 `{file_path}` 与 `{file_path, content}`。路径接受 Workspace 相对路径或 `/dsh/home/workspace/` 前缀，其他绝对路径返回 `DURABLE_TOOL_PATH_FORBIDDEN`。
- 工具在 backend 内以该 turn 的 principal 执行，写入走既有 blob 上传与 commit 路径，读取受 2 MiB 上限约束，写入受 1 MiB 上限约束。工具失败返回 `isError` 文本给模型，不中断 turn；模型错误或未知工具按既有 `DURABLE_*` 错误结算。
- 单个 turn 最多 8 个模型步骤，超出以 `DURABLE_STEP_LIMIT` 结算，防止模型循环。
- 每个模型步骤与每个工具调用都通过 `store.exclusive` + `assertOwner` 追加事件后才落盘，因此事件顺序与 Session 日志一致。
- `GET /api/browser-native/session/durable/stream?turnId=...&fromSeq=N` 以 `application/x-ndjson` 先回放 `seq >= N` 的已落盘事件，再持续推送新事件，turn 结算后写一行 `{kind:"settled", ...status}` 并关闭。`fromSeq` 取 0–1000000 的整数，其他 principal 返回 404 `TURN_NOT_FOUND`。
- 接管只读：订阅不会触发模型请求或工具执行。in-flight turn 持有 lease，同一 principal 以 `access: "write"` open 返回 409 `SESSION_ALREADY_OWNED`；turn 结算释放 lease 后可正常接管。

## 修复

- `parseCompletion` 只识别顶层 `finish` 行，而实际 wire 是 `{kind:"chunk", chunk:{type:"finish", reason}}`，因此 durable 一直把 finish reason 落回 `stop`。文本 turn 靠非空文本掩盖了该缺陷，tool-call turn 则误判为 `DURABLE_EMPTY_RESPONSE`。现在同时识别 `chunk.type === "finish"` 并读取其 reason。
- turn 起始的三个事件此前直接 push 进 Session，未进入订阅通道，重开标签从 seq 0 接管时只看到第 4 个事件起。现在起始事件也经过 `publish`。

## 可判定输出

`tests/durable-tool-attach.test.mjs` 1/1：

```text
✔ durable turn executes tools after the page stops reading and a reopened tab can attach mid-stream (512.9ms)
{"result":"passed","scope":"durable-tool-attach","toolResults":2,"workspaceBytes":38,"streamedEvents":16,"lateTabFirstSeq":9,"modelRequests":["user","user,assistant,tool","user,assistant,tool,assistant,tool"],"leaseDuringRun":409,"foreignAttach":404}
```

| 断言 | 观测 |
|---|---|
| 关页期间工具继续 | 发起 durable POST 后不再读取任何 turn 响应；轮询 Session 日志看到两条 `tool/result`，`write` 提交 `durable/tool-note.txt`（38 字节），`read` 返回同一内容 |
| 事件一致 | 接管流 16 条事件与 `session/read` 的 16 条逐字段相等，`seq` 连续 0–15 |
| 中途接管 | `fromSeq=9` 的第二个标签只收到 seq 9–15 共 7 条，类型为 `step/end`、`tool/call`、`tool/result`、`step/start`、`assistant/message`、`step/end`、`turn/end` |
| 不重复执行 | 模型请求恰好 3 次（`user` → `user,assistant,tool` → 再追加一对）；重放同一 turnId 返回 `completed` 且请求数不变 |
| 租约归属 | 运行中 open write 409 `SESSION_ALREADY_OWNED`；结算后 open write 200 并签发新 owner token；其他 principal 接管流 404 |

同批复跑 `durable-host`、`resource-limits`、`path-boundary`、`prompt-injection-boundaries` 共 14/14。

## 失败场景清单（仍可能成立）

1. **其他工具未实现**：`bash`、`edit`、`grep`、`browser` 等仍以 `isError` 文本回给模型；模型若依赖它们完成任务，会停在文本层面而没有真实副作用。
2. **审批未在服务端执行**：durable 的 `write` 直接提交，不经过 `ask` 审批点；浏览器侧审批 E2E 不能覆盖这条路径。若要在 durable 中执行危险工具，必须先补服务端审批强制点。
3. **进程重启丢失运行态**：`runs` 只在内存；重启后 `status` 与 `stream` 都返回 404，Session 日志可能留下未 `turn/end` 的 turn。
4. **并发写冲突**：durable 工具与浏览器写同一 Workspace 时，`commit` 以 revision 冲突失败；当前工具把它转成 `isError` 文本，模型需自行重试。
5. **真实标签关闭未复测**：本轮证据来自 Node 合同测试（客户端不读取 turn），不是真实 Chrome 标签关闭；既有 Chrome durable E2E 只覆盖文本 turn。
6. **流背压**：接管流按事件写入，未处理慢读者背压；单个 turn 事件数受 8 步与 2 个工具调用约束，但多个标签同时订阅会各自复制缓冲。
7. **工具结果上限**：2 MiB 读取与 1 MiB 写入是刻意上限，超出以 `isError` 返回；没有分块读取工具。
8. **`fromSeq` 语义**：seq 是 Session 全局序号；跨 turn 接管需要客户端自己按 `turn/start` 过滤。

## 边界

- 使用 `llmMode: "scripted"` 的模型与工具调用；未调用真实 provider。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未实现取消、审批、崩溃恢复与多实例租约。
