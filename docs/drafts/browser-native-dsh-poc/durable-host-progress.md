---
description: "记录 Browser-Native DSH 最小服务端 durable turn host 的关页续跑、重开接管与幂等证据，以及未闭环的工具、重启和 UI 缺口。"
---

# Browser-Native 服务端 durable turn host 进度

## 当前状态

状态：durable host 已对齐 Worker 路径的 6 工具、审批、图片附件、共享 Session 写权、嵌套子代理、归档重开与合法 Session 事件封套；正式 Web preview UI 已渲染 durable 待决审批并支持键盘批准/拒绝，移动端原型与主 composer 之外的 durable 启动入口仍为页面级 port。

结论：跨页面关闭的 turn 可以由服务端持有并完成。服务端用 `turnId` 作为幂等键，重复提交不会再次请求模型；关页后 turn 继续，重开标签读取同一 Session 事件；turn 结算后释放 Session 所有权，重开标签可以接管写权。durable 写入的 Session 事件现在满足 Session 封套（`time`、`surfaceOp`、message 字段、`isSeeded`），可被检索索引与归档读取器直接消费。

## 范围

| 已闭环 | 未闭环 |
|---|---|
| 服务端创建或接管空闲 Session，写入 `turn/start`、`user/message`、`step/start` 并 flush | 主 composer 仍把 turn 交给 Worker；durable 启动入口仍是页面级 port |
| 服务端经同源 `/llm` 完成文本 turn，追加 `assistant/message`、`step/end`、`turn/end` 并 flush | 待决审批跨 backend 重启恢复；工具结果的跨 store 事务 |
| `read`/`write`/`edit`/`grep`/`glob`/`subagent` 六工具与审批策略在服务端执行 | 多 backend、HA、持久运行队列与租户配额 |
| `turnId` 幂等：运行中、完成后重复提交都返回既有状态，不产生第二次模型请求 | 运行记录只在内存；进程重启后的在途 turn 仍以 `SESSION_TURN_ACTIVE` 拒绝 |
| 关页后服务端继续，重开标签读取相同事件并观察完成 | 重开标签通过 test HTTP 读取，产品 UI 不渲染服务端 turn |
| turn 完成后释放所有权，重开标签可 `session/open {access:'write'}` 接管 | 跨节点关页接管 |
| 共享 Session：viewer 写 turn 返回 403 `SESSION_READ_ONLY`，editor 以 editor lease 续跑 | 共享 Session 的跨节点租约与冲突提示 UI |
| 正式 Web preview UI 渲染 durable `pendingApproval`，显示工具名与目标，键盘 Enter 批准、Escape 拒绝，决策后 turn 继续 | 产品主 composer 没有 durable 启动入口；面板由页面级 durable port 驱动 |
| 图片附件：durable start 接收 `attachments`，校验哈希/尺寸后写入 Workspace 附件目录，事件保存 ImageBlock，模型请求收到 data URL | 产品 composer 的 durable 图片上传路径（移动端原型未提供上传入口） |
| 子代理可再委派一层（`MAX_DURABLE_SUBAGENT_DEPTH=2`），孙代不再获得 `subagent` | 超过两层的递归预算与取消传播 |
| 归档 Session 可在下一 durable turn 打开，历史事件保留且归档索引保留 | 归档自动调度与保留期 |

## 实现

`durable-host-v2.mjs` 导出 `createDurableTurnHost({ store, admission, model, originOf, timeoutMs, prepareUserMessage, resolveWriter })`：

- `start({ sessionId, principalId, turnId, prompt, header, attachments })`：同一 `turnId` 只执行一次；同一 turnId 绑定到不同 Session 或 principal 返回 409 `TURN_CONFLICT`；附件由 `prepareUserMessage` 校验并发布。
- `status({ turnId, principalId })`：只向同一 principal 返回状态，不暴露 owner token。
- 阶段一在 `store.exclusive` 内创建/校验 Session、`claim` 所有权、追加 3 个开场事件并 flush，然后立即返回 `202`；阶段二在锁外请求模型，阶段三重新取锁并校验 owner 后结算。
- 模型请求复用同源 `/api/browser-native/llm`，因此 Host/Origin 准入、owner fencing 与真实 provider 路径不变。
- 失败时尝试追加 `step/end` 与 `turn/end` 错误结算；无论结算是否成功，最终都释放 owner 与 admission mount。

backend 新增：

- `POST /api/browser-native/session/durable`：请求体 `sessionId`、`turnId`、`prompt`，可选 `header` 与 `attachments`（最多 4 张，元素含 SHA-256、base64、mediaType、像素尺寸）；新 turn 返回 202，幂等重放返回 200。
- `GET /api/browser-native/session/durable?turnId=...`：返回运行状态、turn、事件 seq 与错误；跨 principal 返回 404 `TURN_NOT_FOUND`。
- 两条路由都要求 Session principal cookie，并沿用回环 Host/Origin 准入。

## 可判定证据

| 检查 | 结果 |
|---|---|
| `node --test tests/durable-host.test.mjs` | 通过。`modelCalls=["primary","primary-released","second"]`；运行中重放与完成后重放均未增加模型请求；turn 1 事件 seq `[0,1,2,3,4,5]`，`durableThroughSeq=5`；跨 principal 404；不同 Session 复用 turnId 409；浏览器已持有的 Session 被服务端接管时 409 `SESSION_ALREADY_OWNED`；settle 后可 `access:'write'` 接管。 |
| `DSH_POC_BROWSER=chrome node tests/durable-host.e2e.mjs` | Chrome 156.0.8078.79 通过：turn 在模型 barrier 中挂起，关页前 3 事件；关页 400 ms 后重开标签读到相同 3 事件且状态仍 `running`；释放 barrier 后同一标签读到 6 事件、1 个 `turn/end`、`durableThroughSeq=5`；重放 `durable-e2e-1` 返回 `completed` 且模型请求仍为 1 次；第二 turn 独立完成；重开标签成功接管写权；另一 principal 读取状态 404；`pageErrors=0`。 |
| 真实模型 smoke | `LongCat-2.5` 完成 `turn/start → assistant/message → turn/end`，耗时 4.1 s，assistant 文本 `DURABLE_REAL_SMOKE_OK`，`durableThroughSeq=5`。同批 `gpt-5.6-sol` 请求返回上游 `insufficient_quota`（HTTP 403），服务端正确结算为 `turn/end` 错误，未重试、未伪造 assistant 输出；该失败是 provider 配额，不是 durable host 逻辑。 |
| `node --test tests/durable-feature-alignment.test.mjs` | 6 项全过：图片 `ImageBlock` + 附件字节落盘；viewer 403 / editor 续跑 / owner 再续；16 并发 durable turn 时 `activeTurns=16` 且列表 16 条；两个 durable Session 可列出并读回；嵌套子代理 3 次模型请求、孙代无 `subagent`；归档后第二 turn 完成且历史保留。 |
| `node tests/mobile-ui-only.e2e.mjs` | en-US 移动端原型：write 审批面板出现、点击批准后 `turn/end` 完成、文本 `MOBILE APPROVAL APPLIED`，两次移动 turn 均落库。 |
| `node tests/durable-ui-approval.e2e.mjs` | 正式 Web preview（`preview.html?browser-native-durable=1`）：durable turn 的 `pendingApproval` 渲染为 “Approval needed: write” + 精确目标；键盘 Enter 批准后 11 个事件 seq 0–10、`tool/result` 无 `isError`、Workspace 出现 `durable-ui-approved.txt`；Escape 拒绝后 11 个事件 seq 0–10、`tool/result.isError=true`、`durable-ui-rejected.txt` 不存在；`pageErrors=0`。 |
| `node tests/session-query-scale.e2e.mjs` | 122 Session（含 1 个 durable Session）检索探针通过：列表/过滤/全文/会话内命中均可索引 durable 事件；alpha 命中 61、beta 60。 |

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

## durable 路径功能对齐审计（2026-11-05）

| 用户功能 | durable 状态 | 证据 | 仍缺失原因与下一步 |
|---|---|---|---|
| 多模态图片附件 | 已修复 | `durable-feature-alignment` 图片用例；`user/message` 保存 `ImageBlock`，模型收到 `data:` URL，附件字节可按 SHA-256 读回 | 产品 composer 仍走 Worker 上传；下一步把附件上传与 durable start 接到同一 composer 动作 |
| Session 共享（viewer/editor） | 已修复 | 同文件共享用例：viewer 403 `SESSION_READ_ONLY`，editor 续跑并落库，owner 随后再续，3 个 `turn/end` | 共享租约跨节点未验证；下一步补跨节点 editor fencing |
| 审批 UI 与决策 | 已修复（正式 Web preview + 原型） | `durable-ui-approval.e2e`：正式 preview UI 键盘批准落盘、键盘拒绝无写入；`mobile-ui-only.e2e`：移动端原型批准后完成 | 主 composer 无 durable 启动入口；下一步把 durable start 接入 composer 动作 |
| 仪表盘 16 路 | 已验证 | 16 个 durable Session 并发，`activeTurns=16`，全部完成后列表 16 条 | 仪表盘 UI 仍读取服务端 Session 列表，未做专门视觉回归；下一步加一次 16 项 durable 会话的浏览器截图校验 |
| 跨 Session 检索 | 已修复 | 122 Session 检索探针含 durable Session；补齐 `time`、`surfaceOp`、message 字段与 `isSeeded` 后才可索引 | 仅线性全文回退；下一步把服务端 SQLite 索引接上 durable 事件 |
| 子代理嵌套 | 已修复 | 嵌套用例：父→子→孙 3 次模型请求，孙代 tools 不含 `subagent`，父记录子结果 | 仅两层；下一步把深度预算与取消传播暴露为配置 |
| 归档后打开 | 已验证 | 归档后下一 durable turn 202 完成，前后 prompt 均保留，`turn/end` 2 条 | 无自动保留期调度；下一步接归档调度器 |

结论：7 项在 durable 路径均已复验，审批另有正式 Web preview UI 的键盘批准/拒绝 E2E；“仍缺失”只剩主 composer 的 durable 执行入口与配套上传路径，不是服务端能力缺口。

## 风险与下一步

- 服务端 turn 已挂载 `read`/`write`/`edit`/`grep`/`glob`/`subagent`，写操作经审批；同一 10 任务真实模型基准达到 10/10、29 请求 / 23,318 tokens。尚未覆盖的是待决审批跨重启恢复与工具结果的跨 store 事务。
- 运行记录只在内存。backend 重启后，已 flush 的开场事件会保留成一个没有 `turn/end` 的 turn；下一次 durable turn 会以 `SESSION_TURN_ACTIVE` 拒绝，需要启动恢复流程把未知 turn 结算为 `interrupted`。
- 产品 UI 没有只读挂载服务端 Session 的入口。本批“重开标签接管视图”由真实 Chrome 标签的 HTTP 读取与写权接管证明，不证明聊天 UI 渲染；durable 审批已在正式 Web preview UI 可见并可决策，但启动仍由页面级 port 触发。
- Session 所有权在 turn 结束后立即释放；长 turn 期间重开标签只能只读，不能抢写。若产品需要“接管即抢占”，需要显式的接管协议与旧执行者 fencing。
- 未验证：多 backend/HA、关页中途正在执行的工具 turn、待决审批跨重启恢复、Safari/WebKit、自然浏览器崩溃与 OS 崩溃。
