---
description: "Browser Native 执行模式的可实施工程方案：运行拓扑、能力与包归属、/api/llm 与 Main/Worker 桥接协议、Tool 与持久化策略、分阶段路线、测试矩阵、安全边界与验收标准。"
---

# DSH 扩展 Browser Native Agent 执行模式：可执行实施方案

## Summary

本方案把已完成调研收敛成可执行的工程路线，回答的是“DSH 应新增哪些运行时能力、每一步改哪些包、协议怎样定义、如何避免双轨 Agent Loop、怎样验收和逐步上线”，不重新论证方向是否成立。

核心结论保持不变：DSH 不应转型为 Browser Native Harness；Browser Native 应作为 DSH 的一个可选执行模式、Host profile 和 Agent Loop 驻留位置。

本方案的边界是：复用既有 `agent-loop`、`tools`、`session`、`llm`、`client/connection` 与 Cordis profile 机制，不创建第二套浏览器 Agent Loop；`/api/llm` 是独立的受限 Host 能力，不是现有 generic Worker tunnel 的 direct lane；浏览器是交互式编排和低风险 Tool 执行环境，不是 provider secret、业务授权或 durable side effect 的最终权威。

本方案只做设计与实施计划，不代表任何代码已经实现。

## Table of Contents

- [一、最终目标与明确边界](#一最终目标与明确边界)
- [二、目标拓扑](#二目标拓扑)
- [三、能力所有权划分](#三能力所有权划分)
- [四、建议的 Capability Seam 和包归属](#四建议的-capability-seam-和包归属)
- [五、`/api/llm` 协议](#五apillm-协议)
- [六、Main Thread / Worker Typed UI Bridge](#六main-thread--worker-typed-ui-bridge)
- [七、Tool 分类和执行政策](#七tool-分类和执行政策)
- [八、Session、持久化和 Profile 策略](#八session持久化和-profile-策略)
- [九、Multi-tab 和 owner fencing](#九multi-tab-和-owner-fencing)
- [十、Durable Handoff 协议](#十durable-handoff-协议)
- [十一、分阶段实施路线](#十一分阶段实施路线)
- [十二、测试矩阵](#十二测试矩阵)
- [十三、安全设计和上线限制](#十三安全设计和上线限制)
- [十四、迁移、回滚和兼容策略](#十四迁移回滚和兼容策略)
- [十五、Definition of Done](#十五definition-of-done)
- [十六、最终建议](#十六最终建议)

-----

## 一、最终目标与明确边界

### 1.1 Browser Native 的严格验收定义

只有满足下面完整链路，才算 Browser Native Agent：

```text
Browser Worker Agent Loop
    → /api/llm
    → LLM 返回 tool call
    → Worker 通过 Typed UI Bridge 请求 Main Thread
    → Main Thread 执行前端 Tool
    → Tool result 返回 Worker
    → Worker 追加 Tool result
    → 下一次 /api/llm 请求
    → Agent 继续或结束
```

以下情况不算 Browser Native Agent Loop：

```text
Backend Agent Loop
    → Browser callback
    → Frontend Tool
    → Backend Agent Loop
```

这仍然是 Backend Agent + Frontend Tool。

### 1.2 本项目要新增的不是新 Agent Loop

必须复用 `packages/core/agent-loop`、`packages/core/tools`、`packages/session`、`packages/llm/llm`、`packages/client/connection`、`packages/client/ui-tool`、现有 Cordis profile/bundle 机制，以及现有 `agent/*`、`tools/*`、Session event 和 persistence 语义。

不要在浏览器模式下复制一套 `BrowserAgentLoop`。如果 `agent-loop` 的现有能力不足，应先通过既有 extension point 补能力；只有确认无法通过扩展点完成，才允许修改 `agent-loop`，并同时更新 `docs/architecture.md` 和相关 subsystem 文档。

### 1.3 非目标

第一阶段不做：让浏览器保存 DeepSeek、OpenAI 或其他 provider key；让 Browser Worker 访问任意 provider URL；让 Browser Worker 直接决定业务授权；让模型生成任意 HTML、JavaScript 或 React 组件；让 Worker 通过 DOM selector、截图或页面抓取理解业务状态；把 Web Worker 当作可持续运行的 daemon；用 Browser Native 替代已有 Node、Headless、SDK、ACP 或 Desktop 模式；让已有 `web` profile 默认切换成 Browser Native；让浏览器取消操作伪装成已经回滚了业务副作用；用 `ownsHost: true`、loopback Host 或 Origin trust fence 代替 LLM Proxy 授权。

## 二、目标拓扑

### 2.1 生产 Web 拓扑

```text
┌─────────────────────────────────────────────────────────┐
│ Browser Main Thread                                     │
│                                                         │
│  Web App UI / React / Stores                            │
│  Typed UI State Adapters                                │
│  Browser Capability Registry                            │
│  Approval / User Gesture                                │
│                                                         │
│                  MessageChannel                         │
│                         │                               │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│ Dedicated Worker                                        │
│                                                         │
│  DSH Cordis Worker Profile                             │
│  Agent Loop                                             │
│  Tool Registry                                          │
│  Browser Tool Bridge Consumer                           │
│  Browser LLM Adapter                                    │
│  Browser Session / Checkpoint                           │
│                                                         │
│  fetch('/api/llm')                                      │
└─────────────────────────┼───────────────────────────────┘
                          │ same-origin HTTPS
┌─────────────────────────▼───────────────────────────────┐
│ DSH Host / BFF                                          │
│                                                         │
│  Authenticated /api/llm                                 │
│  Session / Agent / Owner authorization                   │
│  Provider/model allowlist                                │
│  Server-side credential resolution                       │
│  Provider adapter                                        │
│  Quota / budget / timeout / audit                        │
│  Browser Session synchronization                         │
│  Durable Job / handoff                                  │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│ Provider                                                │
│  DeepSeek / compatible provider / future model backend  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Worker 的具体定位

现有 `packages/experimental/webworker-runtime` 已经能够在 Worker 中启动完整 DSH Cordis tree，这是重要基础，但它当前主要服务于 Worker Host preview、VFS、synthetic HTTP、postMessage tunnel、fixture/history 路径，以及没有真实模型请求的预览验收。

它不能直接被当成 Browser Native 的完整安全方案，原因包括：Worker tunnel 的 `/api` direct lane 不是 LLM Proxy 授权；`api-request-trust` 解决的是 Host/Origin 信任，不是 provider credential 授权；当前 `pi-ai` Worker 替代实现是结构性 stub；当前 Worker VFS 默认没有浏览器持久化；当前 `preview-boot.e2e.ts` 不证明真实 `LLM → Tool → LLM` 闭环。

推荐做法是复用 Worker Host 的启动与打包能力，为 Browser Native profile 提供专用的 Worker composition，在该 composition 中关闭直接 provider adapter，注入一个只访问同源 `/api/llm` 的 Browser LLM Adapter，通过独立 `MessageChannel` 建立 Main Thread/Worker Typed Bridge，并且不把 Browser Native `/api/llm` 放进现有 generic direct lane。

### 2.3 静态 Preview 的限制

现有静态 Worker preview 没有天然的后端 `/api/llm` 代理。因此静态 preview 可以使用 test-only mock LLM，可以验证 Worker boot、Tool bridge、Session replay 和错误处理，但不能宣称静态 preview 已经完成生产级 provider 调用；生产 Browser Native E2E 必须连接实际 DSH Host。如果 preview 需要真实模型，必须显式配置外部同源或受信 Host，不能把 provider key 放入 Worker。

## 三、能力所有权划分

| 执行位置 | 负责内容 | 明确不负责 |
|---|---|---|
| Browser Worker | Agent Loop、模型请求编排、低风险 Tool 调度、Session 本地状态、取消传播 | provider secret、最终业务授权、不可逆副作用 |
| Browser Main Thread | DOM、React/Vue/store、结构化 UI state、审批 UI、用户手势、前端 Tool handler | Agent Loop、模型凭据、直接伪造 Session 事实 |
| DSH Host/BFF | `/api/llm`、用户/租户认证、provider credential、模型 allowlist、quota、stream、server cancel | 接受浏览器提供的任意 URL、Authorization 或 upstream header |
| Domain Backend | 发布、删除、支付、权限、秘密、长任务、业务事务、收据、补偿 | 信任浏览器传来的权限结论 |
| Session Persistence | 有序 event、writer ownership、flush durability、recovery | 自动重放或重复执行副作用 |

最重要的规则是：浏览器可以提出意图、执行低风险交互、发起经过授权的操作；后端必须重新验证每一个高风险动作。

## 四、建议的 Capability Seam 和包归属

下面是建议的第一版包边界。包名是实施提案，最终应在依赖图审查后确定。

### 4.1 新增 Browser Native capability family

建议建立一个初始实验性 capability family，例如 `packages/experimental/browser-native-agent/`。如果 Host、Client 和 protocol 在实现过程中显示出独立演化需求，再拆成多个包。初始实现仍需按 Host/Client compiler face 分离，不能用一个混合编译入口掩盖依赖。

建议目录：

```text
packages/experimental/browser-native-agent/
├── src/
│   ├── types.ts
│   ├── protocol/
│   │   ├── llm.ts
│   │   ├── bridge.ts
│   │   ├── ownership.ts
│   │   └── handoff.ts
│   ├── host/
│   │   ├── llm-route.ts
│   │   ├── owner-service.ts
│   │   ├── session-ingest.ts
│   │   └── handoff-service.ts
│   ├── client/
│   │   ├── bridge.ts
│   │   ├── capability-registry.ts
│   │   ├── state-adapter.ts
│   │   └── approval-adapter.ts
│   └── worker/
│       ├── bridge-service.ts
│       ├── llm-adapter.ts
│       ├── operation-controller.ts
│       └── profile.ts
├── tests/
├── tsconfig.host.json
├── tsconfig.client.json
└── README.md
```

`src/types.ts` 只放类型。协议 parser、限制检查和运行时逻辑放在其他文件。

### 4.2 现有包的职责

| 现有包 | Browser Native 计划 |
|---|---|
| `packages/core/agent-loop` | 复用，不复制 Loop；仅通过 `agent/*`、`agent/turn-stopping` 等扩展点接入限制和生命周期 |
| `packages/core/tools` | 复用 Tool schema、guard、pipeline、cancel、result；Browser Tool 通过桥接实现 |
| `packages/session/session-persistence` | 保持通用 `append`/`flush`/ownership 语义 |
| `packages/session/session-persistence-browser` | 建议新增 IndexedDB/OPFS 浏览器 backend |
| `packages/client/connection` | 只提供通用 HTTP/RPC/stream transport；不承载 Browser Agent 业务策略 |
| `packages/client/ui-tool` | 继续从 raw events/result metadata 派生 UI，不把 Worker bridge 细节泄漏给组件 |
| `packages/experimental/webworker-runtime` | 提供 Worker boot、静态资源、通道接入等中立能力；不放 LLM credential 逻辑 |
| `packages/llm/llm-deepseek` | 继续只在受信 Host 中直接访问 provider；不进入 Browser Worker bundle |
| `packages/api/session-controller` | 保持已有 server Agent 的 prompt/follow/cancel 语义，不直接变成 Browser event ingest API |
| `packages/bundle` | 新增 opt-in `browser-native` bundle/profile，不改变 `web` 默认 composition |
| `apps/web` | 新增 Browser Native bootstrap 和真实 Worker E2E 入口，不把 browser loop 硬编码进普通 Web shell |

## 五、`/api/llm` 协议

### 5.1 路由约束

必须注册精确的 Fetch route：

```text
POST /api/llm
POST /api/llm/cancel
```

不能接受任意 provider URL、任意 `baseURL`、任意 `Authorization`、任意 `Cookie`、任意 `Host`、`X-Forwarded-*`、`Proxy-*`、浏览器传入的 upstream headers、URL relay、provider key、OAuth refresh token、secret reference 的实际值。

现有 `ConnectionFetchRoute` 可以作为 transport 入口，但 `/api/llm` 必须拥有独立的业务授权逻辑。不能因为路由通过了 Connection 的 trust fence，就认为请求已经被授权调用 provider。

### 5.2 请求字段

建议协议版本为 `1`：

```json
{
  "protocolVersion": 1,
  "requestId": "opaque-request-id",
  "sessionId": "session-id",
  "agentId": "agent-id",
  "workerInstanceId": "worker-id",
  "tabInstanceId": "tab-id",
  "ownerEpoch": 12,
  "turn": 4,
  "step": 2,
  "attemptId": "attempt-id",
  "purpose": "conversation",
  "provider": "deepseek-official",
  "model": "deepseek-chat",
  "toolCatalogVersion": 3,
  "toolCatalogDigest": "sha256:...",
  "contextDigest": "sha256:...",
  "generation": {
    "messages": [],
    "tools": [],
    "reasoningEffort": "high",
    "maxTokens": 4096,
    "temperature": 0.2,
    "stop": []
  },
  "deadlineAt": 1730000000000,
  "requestNonce": "one-shot-request-nonce"
}
```

服务端必须做的事情：从认证会话派生 user/tenant identity；检查 `sessionId` 属于当前用户/租户；检查 `agentId`、`workerInstanceId`、`tabInstanceId` 和 `ownerEpoch`；校验 session 当前 owner；校验 provider/model allowlist；校验 tool catalog digest；校验所有消息、Tool schema、字符串和嵌套 JSON 的大小；拒绝非有限数字、非法 stop sequence、未知 generation 字段；从服务端 credential store 解析 credential；使用服务端配置的 provider endpoint；把请求绑定到 server-side quota、budget、purpose 和 audit context；检查 `deadlineAt` 是否已过期；防止 nonce/requestId 重放；对同一个请求做幂等重试，但不允许不同 payload 复用同一 id。

客户端提供的 `provider` 和 `model` 只能是逻辑标识。它们不是 URL，也不能直接映射成任意远程地址。

### 5.3 流式响应

建议使用 `Content-Type: application/x-ndjson`。每一行是一个完整 JSON record：

```json
{
  "protocolVersion": 1,
  "streamId": "stream-id",
  "requestId": "request-id",
  "seq": 0,
  "type": "accepted"
}
```

之后可以是：

```json
{
  "protocolVersion": 1,
  "streamId": "stream-id",
  "requestId": "request-id",
  "seq": 1,
  "type": "chunk",
  "chunk": {
    "type": "text-delta",
    "index": 0,
    "text": "..."
  }
}
```

Tool call 使用 DSH 的 canonical `StreamChunk` 语义，不把 provider 原始 SSE 透传到浏览器。终止成功：

```json
{
  "protocolVersion": 1,
  "streamId": "stream-id",
  "requestId": "request-id",
  "seq": 10,
  "type": "finish",
  "reason": "tool-use"
}
```

终止失败：

```json
{
  "protocolVersion": 1,
  "streamId": "stream-id",
  "requestId": "request-id",
  "seq": 10,
  "type": "error",
  "error": {
    "code": "llm/provider-timeout",
    "messageSafe": "The model request timed out.",
    "retryable": true,
    "retryAfterMs": 1000
  }
}
```

强制规则：`seq` 必须从固定起点开始递增；只能有一个 terminal record；terminal 后拒绝任何数据；拒绝重复 seq、乱序 seq、跳号；限制单 chunk、单 event、总响应字节数；限制 stream duration 和 idle timeout；provider 原始错误 body 不出现在浏览器；provider request id 只能作为脱敏诊断字段；provider headers 和 credential 永不进入响应。

### 5.4 取消协议

Worker 立即 abort 当前 fetch，但不能只依赖 TCP 连接关闭。增加显式取消：

```json
{
  "protocolVersion": 1,
  "cancelId": "cancel-id",
  "sessionId": "session-id",
  "agentId": "agent-id",
  "workerInstanceId": "worker-id",
  "tabInstanceId": "tab-id",
  "ownerEpoch": 12,
  "target": {
    "requestId": "request-id",
    "attemptId": "attempt-id",
    "turn": 4,
    "step": 2
  },
  "reason": "user",
  "requestedAt": 1730000000000,
  "deadlineAt": 1730000005000
}
```

返回 `{ "cancelId": "cancel-id", "state": "requested" }`。状态至少包括 `requested`、`propagating`、`settled`、`too-late`、`unknown`。

取消成功不代表 provider 已经回滚任何副作用。对于可能已经发生的业务副作用，返回 `unknown` 并提供 reconciliation/receipt 路径。

## 六、Main Thread / Worker Typed UI Bridge

### 6.1 不传递的对象

桥接协议禁止传递 DOM node、React element、Vue component instance、function、observable object、arbitrary class instance、credential、provider key、DOM selector、`eval` payload、未验证的任意 URL，以及直接访问 Main Thread 全局对象的句柄。

桥接只传 JSON-compatible data，必要的文件字节单独使用受限 binary channel，并设置大小上限。

### 6.2 Frame 公共字段

```json
{
  "protocolVersion": 1,
  "bridgeInstanceId": "bridge-id",
  "workerInstanceId": "worker-id",
  "tabInstanceId": "tab-id",
  "sessionId": "session-id",
  "ownerEpoch": 12,
  "correlationId": "correlation-id",
  "seq": 42,
  "kind": "action.execute.request",
  "deadlineAt": 1730000000000,
  "payload": {}
}
```

建议使用独立 `MessageChannel`，不要把 Browser Agent bridge frame 混入现有 Worker tunnel frame。现有 `webworker-runtime` 只需要提供一个中立的 external port/extra channel 接入点；它不应该依赖 Browser Native protocol，也不应该知道 UI action 的业务含义。

### 6.3 State snapshot

```json
{
  "surface": "release.select_scope",
  "entityRef": {
    "type": "release",
    "id": "v1.8"
  },
  "stateVersion": 17,
  "fields": {
    "environment": "staging",
    "percentage": 10,
    "dirty": true,
    "canSubmit": true
  },
  "capabilities": [
    "release.scope.preview",
    "release.scope.update"
  ],
  "sensitivity": "business-data",
  "modelVisible": true,
  "contentDigest": "sha256:..."
}
```

Main Thread 只允许注册过的 `surface` 和 field 被导出。`modelVisible: true` 的状态必须进入 Worker 的 model-visible context，并且必须满足 model-visible state 与 Session log 可重建之间的等价关系。也就是说，不能仅把 state 通过 `agent.inject()` 发给模型而不写 Session event。

建议新增一个 Browser Native 专属 Session event，例如 `browser/ui-state-observed`。它记录经过脱敏和大小限制的结构化 state，不能记录原始 DOM。不是模型可见的 transient UI state 不必进入 Session log，但不得被隐式升级为模型上下文。

### 6.4 Action request

```json
{
  "actionId": "action-id",
  "capability": "release.scope.update",
  "arguments": {
    "environment": "staging",
    "percentage": 10
  },
  "expectedStateVersion": 17,
  "previewDigest": "sha256:...",
  "idempotencyKey": "idempotency-key",
  "requiresUserGesture": false,
  "sideEffectClass": "local-ui"
}
```

Main Thread 必须校验 capability 是否注册、arguments 是否符合 JSON Schema、`expectedStateVersion` 是否仍然有效、`previewDigest` 是否匹配当前状态、是否需要人工审批、是否需要真实用户手势、idempotency key 是否已执行、deadline 是否已过期、session/tab/worker/owner epoch 是否匹配，以及 action 是否允许当前用户和当前 UI surface 执行。

结果：

```json
{
  "accepted": true,
  "committed": true,
  "receiptId": "receipt-id",
  "actualStateVersion": 18,
  "unknownOutcome": false
}
```

对于执行已经开始但结果无法确认的情况：

```json
{
  "accepted": true,
  "committed": false,
  "receiptId": "receipt-id",
  "actualStateVersion": 18,
  "unknownOutcome": true,
  "errorCode": "browser/action-outcome-unknown"
}
```

只有在实际 commit point 之后，Main Thread 才能发布 `committed: true`。

## 七、Tool 分类和执行政策

### 7.1 Browser-local Tool

适合读取当前选中的业务对象、读取当前 filter、读取表单 draft、打开或关闭面板、更新本地 UI selection、创建本地预览、读取浏览器允许访问的文件，以及触发已注册的 UI action。

约束是：必须通过 capability registry；不使用 DOM scraping；不把任意 store 暴露给模型；结果必须有大小上限；状态如果进入模型，必须有 Session event。

### 7.2 Browser-orchestrated / server-backed Tool

Worker 负责决定何时调用，Host 负责执行 API：

```text
Worker Tool
    → typed server capability
    → Host authentication
    → domain authorization
    → result
    → Worker Tool result
```

浏览器不得拼接任意 URL。每个 server-backed Tool 应绑定固定逻辑 capability、固定 API route、input/output schema、timeout、retry policy、side-effect class 和 idempotency policy。

### 7.3 Server-authorized side-effect Tool

适合发布、删除、修改权限、支付、发邮件、创建生产资源、写入外部系统，以及生成或使用秘密 credential。

执行过程：

```text
Worker 选择 Tool
    → Main/Host 请求审批
    → Host 重新认证用户和租户
    → Host 检查业务状态和权限
    → Host 使用 idempotency key 执行
    → 返回 receipt / unknown
    → Worker 写入 Tool result
```

模型不能通过修改 Tool arguments 绕过后端授权。

### 7.4 Durable/background Tool

适合长时间执行、页面关闭后仍应继续的任务。必须显式执行 `handoff`：

```text
Browser Agent
    → flush Session
    → propose handoff
    → Host claim ownership
    → Browser Agent 停止
    → Backend Job 继续
    → Browser follow Session/job events
```

不能让 Browser Agent 和 Backend Job 同时成为一个 Session 的 active loop owner。

## 八、Session、持久化和 Profile 策略

### 8.1 四种明确 Profile

**Profile A：ephemeral。** Session 只在 Worker 生命周期内有效；页面关闭或 Worker 被回收后不承诺恢复；适合第一个垂直闭环；允许无 IndexedDB；不允许高风险 durable side effect。

**Profile B：browser-persistent。** Worker 使用 IndexedDB Session backend；`flush()` 是浏览器崩溃恢复的 durability barrier；页面刷新后从最后一个 flushed prefix 恢复；仍然是单浏览器设备范围；不承诺跨设备恢复。

**Profile C：server-synchronized。** Browser Worker 本地保存运行时副本；已提交事件批次同步到 DSH Host；Server 保存 authoritative Session；Browser Worker 每次 append/flush 带 owner epoch；多 tab 由服务端 fencing；reconnect 从 server cursor 恢复。

**Profile D：durable-handoff。** 建立在 server-synchronized 之上；支持显式 handoff；handoff 接受后 Browser Agent 必须停止；Backend Job 或 Backend Agent 成为唯一执行 owner。

不要把这些语义压缩成一个布尔值，例如 `persist: true`。调用者必须明确选择运行 profile。

### 8.2 浏览器 persistence backend

建议新增 `packages/session/session-persistence-browser/`。第一版可以使用 IndexedDB 保存 session header store、event batch store、checkpoint store、lease store、corruption marker 和 version/migration store。如果事件或附件过大，再将大型 payload 迁移到 OPFS，但不能把 OPFS 当成自动耐久保证。

必须实现现有 `SessionHandle` 语义：append 只接受 contiguous batch；append 成功不等于 crash durability；`flush()` 成功才代表已持久化；close 必须 drain pending writes；writer 丢失时返回明确 ownership error；不自动重放 Tool side effect。

### 8.3 批次 envelope

本地或服务端同步都建议使用：

```json
{
  "formatVersion": 1,
  "sessionId": "session-id",
  "writerId": "writer-id",
  "ownerEpoch": 12,
  "leaseToken": "opaque-lease-token",
  "baseSeq": 40,
  "nextSeq": 48,
  "batchId": "batch-id",
  "eventCount": 8,
  "eventDigest": "sha256:...",
  "checkpointSeq": 47,
  "durability": "accepted",
  "flushId": "flush-id",
  "events": []
}
```

服务端返回：

```json
{
  "batchId": "batch-id",
  "acceptedThroughSeq": 47,
  "flushedThroughSeq": 47,
  "revision": 8
}
```

拒绝的情况包括：`baseSeq` 不等于 stored next seq；gap；overlap；冲突 batch；stale writer；stale lease；wrong owner epoch；digest 不匹配；unknown event type；unsupported format；超过 batch 或 byte limit；lease 过期后的写入。

### 8.4 中断恢复

如果浏览器在 provider response 未结束、Tool 已开始但结果未知、approval 已发出但未确定，或 side effect 已发送但 receipt 未返回的阶段断开，恢复时不得自动继续该操作。应当关闭未完成 turn/step；写入明确的 interrupted/unknown settlement；将 operation 标记为需要人工或 reconciliation；只有新的 Agent step 才能继续；不重放原始副作用调用。

## 九、Multi-tab 和 owner fencing

每个 Browser Agent 实例需要 `sessionId`、`tabInstanceId`、`workerInstanceId`、`ownerEpoch`、`leaseToken`、`issuedAt`、`expiresAt` 和 `lastHeartbeatSeq`。

### 9.1 Claim 规则

一个 Session 同时只能有一个 active Browser Loop owner。Claim 返回：

```json
{
  "ownerEpoch": 12,
  "leaseToken": "opaque-token",
  "expiresAt": 1730000010000,
  "role": "owner"
}
```

其他 tab 得到 `{ "role": "follower", "ownerEpoch": 12 }`。

Follower 只能 follow Session、读取当前 state、显示 owner 状态，以及请求用户把 ownership 转移给当前 tab。Follower 不能发送 LLM request、执行 Browser Agent Tool、append Session event、发起高风险 action，或发起 handoff。

`Web Locks` 和 `BroadcastChannel` 只能减少重复启动，不能当作安全 fencing。安全判断必须由服务端或 authoritative persistence 做。

### 9.2 生命周期规则

当页面进入 hidden、被冻结或 Worker heartbeat 丢失：禁止开启新的 LLM request；禁止开启新的 side effect；尝试取消当前可取消操作；将结果收敛为 settled 或 unknown；释放或等待 lease 过期；由新 owner 从最后 committed sequence 恢复。

## 十、Durable Handoff 协议

建议请求：

```json
{
  "requestId": "handoff-request-id",
  "sessionId": "session-id",
  "agentId": "agent-id",
  "workerInstanceId": "worker-id",
  "tabInstanceId": "tab-id",
  "ownerEpoch": 12,
  "lastCommittedSeq": 240,
  "checkpointDigest": "sha256:...",
  "turn": 7,
  "step": 3,
  "capabilitySet": [
    "release.inspect",
    "release.start_canary"
  ],
  "toolCatalogDigest": "sha256:...",
  "requestedProfile": "server-durable",
  "sideEffectPolicy": "approved-only",
  "deadlineAt": 1730000010000
}
```

服务端必须确认当前 owner 正确；checkpoint 是 authoritative；last committed sequence 连续；没有未 flush 的 model-visible input；没有 active unknown side effect；backend profile 支持所需 Tool；tool catalog digest 兼容；server 具备 durable persistence；handoff requestId 未发生冲突；requested profile 是 allowlist 中的 profile。

返回：

```json
{
  "handoffId": "handoff-id",
  "jobId": "job-id",
  "acceptedThroughSeq": 240,
  "executionOwner": "server",
  "handoffEpoch": 2,
  "state": "accepted",
  "resumeHandle": "opaque-session-bound-handle"
}
```

`resumeHandle` 不能是 provider credential 或通用 bearer token。

handoff accepted 后：Browser Worker 立刻停止 Agent Loop；不再发送 LLM request；不再执行 Browser Tool；不再 append；只 follow 后端产生的 Session/job events；如果 handoff 后浏览器仍发送旧 epoch 请求，服务端拒绝。

## 十一、分阶段实施路线

### Phase 0：冻结契约和安全边界

目标是不写生产运行逻辑，先冻结 Browser Native 定义、profile 分类、`/api/llm` 协议版本、bridge frame 版本、owner epoch 语义、error code namespace、threat model 和 mock provider 行为。

产物建议在新增的 `packages/experimental/browser-native-agent` 包内新增或更新 `README.md`、`src/protocol/*` 和 `tests/protocol/*`，并新增 `packages/bundle/browser-native/cordis.patch.yml`。如果该决定会长期影响 DSH 的执行位置和 Session ownership，应在实现 PR 中增加一篇 active Agent Note，记录为什么 Browser Native 是 execution mode 而不是新 Harness、为什么不能复用 generic `/api` direct lane、为什么 `ownsHost` 不能当作 provider authorization，以及为什么 handoff 后必须停止 Browser Loop。

退出条件是：方案中的每个 owner 都有明确责任；协议字段有版本和大小限制；所有拒绝路径都有稳定 code；没有默认 profile 变化；mock LLM 可以返回确定性的 Tool call sequence。

### Phase 1：Worker profile 和 fake LLM 闭环

目标是在不接真实 provider 的前提下证明 Worker Agent Loop 能收到 fake LLM 的 tool call、请求 Main Thread 执行 Tool、拿到 tool result、发出第二次请求并获得 final assistant message。

预计涉及 `packages/experimental/webworker-runtime/`、`packages/experimental/browser-native-agent` 的 `src/worker/` 与 `src/client/`、`packages/bundle/browser-native/`、`apps/web/src/browser-native.ts` 和 `apps/web/tests/browser-native-loop.e2e.ts`。

必须复用 `ctx.agents`、`ctx.agentLoop`、`ctx.tools`、Session event、`tool/call`、`tool/result` 和 `agent/assistant-stream`。

不允许新建 `BrowserAgent` 复制 `Agent`；在 UI 组件内直接访问 Worker；用普通 postMessage 承载未定义的业务对象；用 DOM 文本作为 Tool result；通过现有 generic `/api` tunnel 绕过 bridge。

退出条件是：Worker 内确实产生两次 model request；第一次响应包含 Tool call；Main Thread 执行 Tool；第二次请求包含 durable Tool result；Session 中可以重建完整 sequence；默认 `web` profile 行为不变；dispose Worker 后所有 bridge handler、Tool registration 和 stream 都撤销。

### Phase 2：同源 `/api/llm` Proxy

目标是把 fake LLM 替换成真实 HTTP proxy，但仍使用 test provider，不马上接真实 DeepSeek key。

预计涉及 `packages/experimental/browser-native-agent` 的 `src/worker/llm-adapter.ts`、`src/host/llm-route.ts` 和 `src/protocol/llm.ts`，`packages/llm/llm/src/*`，`packages/llm/llm-deepseek/src/*`（只验证 Host 侧，不加入 Worker bundle），以及 `packages/client/connection/src/rpc.ts`（仅在确有通用 transport 需求时）。

Host handler 使用现有 `ctx.llm` provider adapter：

```text
Browser logical request
 → browser-agent host authorization
 → ctx.llm.stream(...)
 → canonical StreamChunk
 → bounded NDJSON response
```

Host 侧继续使用现有 `apiKeyEnv`、`resolveApiKey`、provider-specific adapter、retry policy、attribution headers 和 existing LLM error normalization。Browser Worker 中禁止加载 `llm-deepseek` direct fetch adapter、`pi-ai` provider auth、credential provider、provider baseURL configuration 和 `x-api-key` 生成代码。

退出条件是：Worker bundle 中没有 provider key、`x-api-key` 或 provider baseURL；`/api/llm` 拒绝任意 URL/Auth/header；provider/model allowlist 生效；stream sequence 严格校验；abort 能从 Worker 传到 Host，再传到 provider；provider 原始错误不会进入浏览器；request attribution 包含 session/agent/owner metadata；真实 browser E2E 可以完成两次 `/api/llm` 请求。

### Phase 3：真实前端 Tool 和结构化 UI state

目标是把 fake Main Thread Tool 替换成一个真实业务 UI capability。建议先实现一个低风险示例，例如 `ui.selection.read` 或 `release.scope.preview`。不要第一例就选择发布、删除或支付。

预计涉及 `packages/experimental/browser-native-agent` 的 `src/client/capability-registry.ts`、`src/client/state-adapter.ts`、`src/client/approval-adapter.ts` 和 `src/worker/bridge-service.ts`，`packages/client/ui-tool/`，`packages/client/ui-renderer/`，以及 `apps/web/tests/browser-native-loop.e2e.ts`。

退出条件是：UI state 通过 typed adapter 提供；Worker 不依赖 DOM；Tool schema、arguments、output 都经过限制；state version conflict 能拒绝；action result 只在 commit point 后发布；Tool result 被现有 Tool pipeline 和 Session event 记录；reconnect 后 UI card 从 raw event/result metadata 重新派生；UI 组件不接收 `ctx`、DOM handler 或裸 observable。

### Phase 4：浏览器持久化和单 writer

目标是支持页面刷新后的安全恢复，但先限定在单浏览器设备。

预计涉及 `packages/session/session-persistence-browser/`、`packages/experimental/browser-native-agent` 的 `src/worker/operation-controller.ts` 与 `src/protocol/ownership.ts`、`packages/bundle/browser-native/`，以及 `apps/web/tests/browser-native-persistence.e2e.ts`。

实施顺序是 IndexedDB header/store、contiguous append、`flush()` durability barrier、torn tail 检测、interrupted turn repair、local owner lease、restart from last flushed sequence，以及明确 unknown side effect recovery。

退出条件是：append gap/overlap 被拒绝；flush 前崩溃不会声称数据 durable；flush 后刷新可恢复；Worker 重启不会重复执行已提交 Tool；active unknown Tool 不会自动重放；quota、private mode、corrupt batch 有明确失败；Session 中不出现 provider secret。

### Phase 5：Server synchronization 和 multi-tab fencing

目标是让 Session 在服务器上成为 authoritative durable state，并支持多个 tab 的 owner/follower 模型。

预计新增 `packages/experimental/browser-native-agent` 的 `src/host/owner-service.ts`、`src/host/session-ingest.ts`、`src/host/handoff-service.ts`、`src/protocol/ownership.ts` 和 `src/protocol/handoff.ts`，以及 `apps/web/tests/browser-native-ownership.e2e.ts`。

建议 API：

```text
POST /api/browser-agent/claim
POST /api/browser-agent/heartbeat
POST /api/browser-agent/release
POST /api/browser-agent/events
POST /api/browser-agent/flush
POST /api/browser-agent/handoff
POST /api/browser-agent/cancel
```

其中 claim/heartbeat/release/handoff/cancel 可使用 Typed Remote；高吞吐 event batch 使用精确 Fetch route；`/api/browser-agent/events` 不能变成任意 Session event append；Host 必须验证事件顺序和当前 Agent state；`SessionController.prompt()` 不应被复用成 Browser Native event ingest。

退出条件是：两个 tab 同时 claim 时只有一个成功；follower 无法发 LLM/Tool/append；stale owner epoch 全部被拒绝；owner lease 过期后旧 Worker 无法恢复写权限；reconnect 能从 last committed cursor 继续；baseline 和 delta 不重复、不跳号；hidden/frozen/pagehide 行为可测试；server persistence 与 browser cache 不产生双 writer。

### Phase 6：Durable handoff

目标是完成 Browser Loop 到 Backend Durable Job 的显式转移。

退出条件必须验证：clean checkpoint 可以 handoff；dirty/unflushed checkpoint 被拒绝；active Tool unknown 被拒绝；stale owner 被拒绝；backend Tool catalog 不匹配被拒绝；handoff request 重试是幂等的；handoff accepted 后浏览器不能继续 LLM request；后端 job 成为唯一 owner；browser 断线后重新 follow；job 完成、失败、unknown 都有 receipt；cancel handoff 不会制造第二个 owner；浏览器无法使用旧 resume handle 伪造新 owner。

## 十二、测试矩阵

### 12.1 协议单元测试

覆盖 frame version、缺字段、unknown field、oversized nested JSON、non-finite number、invalid correlation id、sequence gap、duplicate sequence、second terminal、post-terminal data、invalid origin、forbidden headers、request nonce replay、digest mismatch、deadline expired、prototype pollution keys、CRLF/header injection 和 multibyte byte limits。

### 12.2 LLM Proxy 测试

成功路径覆盖合法 provider/model、合法 session/agent/owner、deterministic chunk stream、tool call delta、finish、explicit cancel、transport close cancel 和 retryable provider error。

拒绝路径覆盖 arbitrary endpoint、client-supplied Authorization、client-supplied API key、unknown provider、unknown model、wrong session、wrong tenant、stale owner、catalog digest mismatch、oversized request、oversized response、provider raw error leakage、duplicate request nonce 和 expired deadline。

### 12.3 Worker/Main Bridge 测试

覆盖 wrong worker id、wrong tab id、wrong session id、stale owner epoch、out-of-order frame、duplicate frame、sequence gap、unknown capability、invalid arguments、stateVersion conflict、preview digest mismatch、missing approval、missing user gesture、duplicate idempotency key、action handler throws、action result unknown、queue backpressure、Worker restart、bridge reconnect、transient state coalescing，以及 model-visible state cannot be dropped。

### 12.4 Session Persistence 测试

覆盖 exact contiguous batch、gap、overlap、conflicting duplicate batch、append before flush、flush durability、torn tail、corrupt digest、unknown format、unknown event、lost lease、two writers、quota exhausted、private mode、restart、interrupted turn、unknown active Tool、replay cannot execute side effect，以及 secret scan over events and storage。

### 12.5 Multi-tab 和 lifecycle 测试

覆盖 simultaneous claim、follower read-only、stale heartbeat、tab hidden、page frozen、pagehide、Worker termination、old Worker sends LLM request、old Worker sends Tool action、old Worker sends append、tab crash and lease expiry、reconnect generation、duplicate prompt、duplicate cancel 和 duplicate handoff。

### 12.6 真实组合测试

必须通过 Loader 和 test-only `cordis.yml` 启动实际 composition，不使用纯手工 `ctx.plugin(...)` 代替。验证 profile rows、service injection、Tool registry、Worker bridge provider、LLM proxy route、session persistence、HMR/disposal、model-visible output、durable event output 和 default profile remains unchanged。

### 12.7 Browser E2E

新增真实 Worker 垂直链路，不能只扩展现有 `preview-boot.e2e.ts` 的 fixture 检查：

```text
create Session
→ start Worker
→ claim owner
→ send prompt
→ mock /api/llm returns Tool call
→ Main Thread executes UI Tool
→ Worker appends Tool result
→ second /api/llm request
→ final assistant response
→ follow/reconnect
→ cancel
→ restart
```

现有 `preview-boot.e2e.ts` 仍然保留，职责继续是 Worker boot、fixture overlay、history、tool/UI fixture 和 cold discovery。它不能作为真实 Browser Native Loop 的验收证据。

## 十三、安全设计和上线限制

### 13.1 Browser Worker 是低信任执行面

即使 Worker 与 Main Thread 隔离，也必须假设用户可以调试 Worker；同源 XSS 可以读取页面可访问的状态；依赖供应链可能被污染；prompt injection 可以出现在 Tool result；UI state 可能包含业务敏感数据；浏览器扩展可能观察页面；localStorage/IndexedDB 不能当作 secret store。

因此 provider key 永不下发；OAuth refresh token 永不下发；SSH/cloud credential 永不下发；Session 中不记录 credential；后端每次重验权限；Tool result 当作不可信数据；Tool schema 和 capability 由应用 allowlist 控制。

### 13.2 限制必须覆盖完整结果

需要同时限制 request body bytes、message count、message nesting、Tool schema bytes、Tool result bytes、stream event count、stream chunk bytes、total stream bytes、idle timeout、total duration、per-session step count、per-owner concurrent operations、bridge queue size、IndexedDB batch size 和 handoff checkpoint size。

仅限制原始 chunk，不限制包装后的 event 和 metadata，不足以防止洪泛。

### 13.3 Browser loop budget

现有 `agent-loop` 没有内置通用 turn budget。不要直接复制一个 Browser Loop。Browser Native profile 应通过独立 policy plugin 使用 `agent/turn-stopping`、`agent/*`、`tools/pre-execute` 和 `tools/execute`，实现最大 step 数、最大 turn duration、最大 bridge wait、最大 Tool result bytes、最大模型请求次数、最大连续重复 Tool 检测和最大总 token budget。

这些值必须是 profile `Config`，不能散落在代码里的硬编码 tunable。

## 十四、迁移、回滚和兼容策略

### 14.1 默认行为保持不变

第一版必须是显式 opt-in，例如 `dsh --profile browser-native`，或显式 session execution profile。不得让现有 `dsh --profile web`、`dsh --profile headless`、`dsh --profile sdk`、`dsh --profile acp` 隐式改变 Agent Loop 所有权。

### 14.2 不自动转换已有 Session

现有后端 Agent Session 不自动变成 Browser Native Session。反方向也一样：Browser Native Session 不能被普通 `prompt()` API 隐式接管；server Agent 不能在 Browser owner 仍存活时启动；execution ownership 必须显式声明和校验。

### 14.3 回滚

如果 Browser Native 发生严重问题：禁用 `browser-native` bundle/profile；保留已有 `web`、`headless`、`sdk`；Browser Session 只能进入 read-only/follow；不自动重试不确定副作用；允许用户显式 handoff 到后端；协议版本保持可拒绝，不通过静默降级解释错误 payload。

## 十五、Definition of Done

Browser Native 执行模式只有满足以下条件才可以从实验性 profile 提升。

**Loop。** Agent Loop 确实在 Dedicated Worker；第一轮模型响应产生 Tool call；Tool 在 Main Thread 执行；第二轮模型请求包含 Tool result；final assistant message 完成；没有同时运行后端 Agent Loop。

**Protocol。** `/api/llm` 只接受逻辑 provider/model；provider credential 始终留在 Host；流有严格 sequence 和唯一 terminal；cancel 能传播到 provider；provider 原始 key、URL、header、错误不会泄漏。

**UI bridge。** Main Thread 只发布 typed JSON state；不传 DOM、函数、组件和 observable；action 有 allowlist、state version、approval、gesture、idempotency；commit 前不发布成功；unknown outcome 不伪装成失败或成功。

**Session。** 所有 model-visible state 都可以从 Session 重建；`append`、`flush`、ownership 语义保持一致；刷新不会重复执行已提交副作用；unknown Tool 不会自动重放；multi-tab 同一 Session 只有一个 active writer。

**Handoff。** handoff 必须基于已 flush 的 clean checkpoint；接受后 Browser Loop 停止；后端成为唯一执行 owner；浏览器只能 follow；job receipt、失败和 unknown outcome 可查询。

**Product。** 默认 profile 无行为变化；现有 preview boot 测试继续通过；新增真实 Browser Native E2E；keyless snapshot 可以回放；UI Tool presentation 由 raw events/result metadata 派生；包 README、JSDoc、subsystem 文档和必要 Agent Note 同步；`test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`、相关 typecheck 和安全测试通过。

## 十六、最终建议

推荐的最小落地顺序不是一次性实现“浏览器持久 Agent 平台”，而是：fake LLM 加 Worker Agent Loop；Typed Main/Worker Bridge；real same-origin `/api/llm` proxy；one low-risk UI Tool；IndexedDB persistence；server owner fencing；durable handoff。

其中最重要的架构决策有三条：Agent Loop 复用 `dsh-agent-loop`，不创建第二套 loop；`/api/llm` 是独立的受限 server capability，不是现有 generic tunnel 的 direct lane；浏览器是交互式编排和低风险 Tool 执行环境，不是 provider secret、业务授权或 durable side effect 的最终权威。

这条路线可以让 DSH 获得 Browser Native 能力，同时保留其作为 all-plugin Cordis Agent Harness 的总体定位。
