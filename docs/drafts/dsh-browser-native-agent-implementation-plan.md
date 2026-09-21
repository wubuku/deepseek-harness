---
description: "Browser Native 执行模式的可实施工程方案：运行拓扑、能力与包归属、/api/llm 与 Main/Worker 桥接协议、Tool 与持久化策略、分阶段路线、测试矩阵、安全边界与验收标准。"
---

# DSH 扩展 Browser Native Agent 执行模式：可执行实施方案

## Summary

本方案把已完成调研收敛成可执行的工程路线，回答的是“DSH 应新增哪些运行时能力、每一步改哪些包、协议怎样定义、如何避免双轨 Agent Loop、怎样验收和逐步上线”，不重新论证方向是否成立。

核心结论保持不变：DSH 不应转型为 Browser Native Harness；Browser Native 应作为 DSH 的一个可选执行模式、Host profile 和 Agent Loop 驻留位置。

本方案的边界是：复用既有 `agent-loop`、`tools`、`session`、`llm`、`client/connection` 与 Cordis profile 机制，不创建第二套浏览器 Agent Loop；`/api/llm` 是独立的受限 Host 能力，不是现有 generic Worker tunnel 的 direct lane；浏览器是交互式编排和低风险 Tool 执行环境，不是 provider secret、业务授权或 durable side effect 的最终权威。

本方案只做设计与实施计划，不代表任何代码已经实现。

方案把四组关系写成可执行规范，并把它们作为后续实现的验收基准：模型可见输入与 Session event/projection/replay 的等价；Browser LLM wire DTO 与 `StreamChunk` 的转换；owner metadata 与 server-issued authority 的绑定；Tool 执行与 canonical tool lifecycle 的对应。

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

第一阶段不做：让浏览器保存 DeepSeek、OpenAI 或其他 provider key；让 Browser Worker 访问任意 provider URL；让 Browser Worker 直接决定业务授权；让模型生成任意 HTML、JavaScript 或 React 组件；让 Worker 通过 DOM selector、截图或页面抓取理解业务状态；把 Web Worker 当作可持续运行的 daemon；用 Browser Native 替代已有 Node、Headless、SDK、ACP 或 Desktop 模式；让已有 `web` profile 默认切换成 Browser Native；让浏览器取消操作伪装成已经回滚了业务副作用；用 `ownsHost: true`、loopback Host 或 Origin trust fence 代替 LLM Proxy 授权；把浏览器提交的 transcript 当作服务端防篡改审计；让两个 tab 各自满足不同 owner authority 同时写入。

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

### 2.4 generic `/api` tunnel 的隔离

现有 `packages/experimental/webworker-runtime` 通过 `Connection.createSharedFetchHandler('/api')` 提供 Worker-local 的 `/api` 通道。Browser Native profile 必须显式限制它，而不是依赖“Worker 代码不会调用”。

Browser Native profile 的要求是：Worker 不得通过 generic direct lane 访问 `/api/llm` 或 `/api/llm/cancel`；Worker 不得把任意 URL、任意 route 或任意 upstream header relay 到 Host；只有显式注册的 server capability 可以被调用；`/api/browser-agent/*` 的 claim、heartbeat、release、events、flush、handoff 和 cancel 与 `/api/llm` 一样，必须各自执行独立的业务授权，而不是只通过 Connection 的 trust fence；Worker bundle 中不得存在 provider adapter、credential provider 或 `x-api-key` 生成代码。

关闭或隔离 generic direct lane 是 Phase 2 的退出条件，不是可选项。

## 三、能力所有权划分

| 执行位置 | 负责内容 | 明确不负责 |
|---|---|---|
| Browser Worker | Agent Loop、模型请求编排、低风险 Tool 调度、Session 本地状态、取消传播 | provider secret、最终业务授权、不可逆副作用 |
| Browser Main Thread | DOM、React/Vue/store、结构化 UI state、审批 UI、用户手势、前端 Tool handler | Agent Loop、模型凭据、直接伪造 Session 事实 |
| DSH Host/BFF | `/api/llm`、用户/租户认证、provider credential、模型 allowlist、quota、stream、server cancel | 接受浏览器提供的任意 URL、Authorization 或 upstream header |
| Domain Backend | 发布、删除、支付、权限、秘密、长任务、业务事务、收据、补偿 | 信任浏览器传来的权限结论 |
| Session Persistence | 有序 event、writer ownership、flush durability、recovery | 自动重放或重复执行副作用 |

最重要的规则是：浏览器可以提出意图、执行低风险交互、发起经过授权的操作；后端必须重新验证每一个高风险动作。

### 3.1 事件生产者与权威分类

Browser Worker 是低信任执行面，因此 Session event 必须按生产者分类，而不是按“谁能 append”分类。

| 类别 | 生产者 | 示例 | 服务端处理 |
|---|---|---|---|
| Browser-observed | Main Thread / Worker | 注册过的 UI state、用户 gesture、local Tool result | 只接受 profile allowlist 中的类型；校验 schema、大小、顺序；不改变 ownership |
| Browser-requested | Worker | Tool intent、cancel request、handoff proposal | 只能作为请求；权威结论由服务端产生 |
| Server-authored | DSH Host / Domain Backend | 授权结论、provider usage、server receipt、高风险副作用 settlement、ownership transition | 只能由服务端写入；浏览器提交的同名事件一律拒绝 |

浏览器提交的 transcript 对服务端不是防篡改审计。服务端审计必须记录独立的请求、授权、receipt 和 provider 元数据；浏览器本地 Session 只能作为运行时副本和恢复缓存。

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
│   │   ├── events.ts
│   │   ├── lifecycle.ts
│   │   └── handoff.ts
│   ├── host/
│   │   ├── llm-route.ts
│   │   ├── owner-service.ts
│   │   ├── session-ingest.ts
│   │   ├── event-authority.ts
│   │   └── handoff-service.ts
│   ├── client/
│   │   ├── bridge.ts
│   │   ├── capability-registry.ts
│   │   ├── state-adapter.ts
│   │   ├── state-projection.ts
│   │   └── approval-adapter.ts
│   └── worker/
│       ├── bridge-service.ts
│       ├── llm-adapter.ts
│       ├── llm-wire.ts
│       ├── operation-controller.ts
│       └── profile.ts
├── tests/
├── tsconfig.host.json
├── tsconfig.client.json
├── package.json
└── README.md
```

`src/types.ts` 只放类型。协议 parser、限制检查和运行时逻辑放在其他文件。

新包必须同时具备：`@deepseek-ai/dsh-browser-native-agent` 的 `package.json`、Host 与 Client 两个 compiler face 的 leaf tsconfig、对应 resolver manifest 的 dependencies 登记，以及 package README。

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

所有 Browser Native route（`/api/llm`、`/api/llm/cancel` 和 `/api/browser-agent/*`）必须采用同一套跨站请求防护，并把它作为共同前置条件：必须校验 `Origin`；`Referer` 只能作为显式配置的兼容 fallback；拒绝缺失或不匹配的 `Origin`；要求非 simple 的 `Content-Type`（例如 `application/json` 或 `application/x-ndjson`）；拒绝跨站 form POST 和 `text/plain` POST；不得只依赖 SameSite cookie；反向代理必须保留或重写原始 Origin，并且该行为必须被测试覆盖。

CSRF 通过不等于授权通过。Origin 校验解决“请求是否来自本站”，不解决“该用户是否有权对当前 Session 发起该请求”。

### 5.2 请求字段

建议 LLM wire protocol 版本为 `1`。示例中的 `protocolVersion` 指该 wire protocol 版本，与 Session log format version 和 batch transport protocol version 相互独立。

```json
{
  "protocolVersion": 1,
  "requestId": "opaque-request-id",
  "sessionId": "session-id",
  "agentId": "agent-id",
  "workerInstanceId": "worker-id",
  "tabInstanceId": "tab-id",
  "ownerEpoch": 12,
  "leaseToken": "opaque-lease-token",
  "baseSessionSeq": 40,
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

服务端必须做的事情：从认证会话派生 user/tenant identity；检查 `sessionId` 属于当前用户/租户；把 `agentId`、`workerInstanceId`、`tabInstanceId`、`ownerEpoch` 和 `leaseToken` 与 server-issued claim 绑定，而不是采信客户端自报值；校验 session 当前 owner 与 lease 有效性；校验 provider/model allowlist；校验所有消息、Tool schema、字符串和嵌套 JSON 的大小；拒绝非有限数字、非法 stop sequence、未知 generation 字段；从服务端 credential store 解析 credential；使用服务端配置的 provider endpoint；把请求绑定到 server-side quota、budget、purpose 和 audit context；检查 `deadlineAt` 是否已过期；防止 nonce/requestId 重放；对同一个请求做幂等重试，但不允许不同 payload 复用同一 id。

客户端提供的 `provider` 和 `model` 只能是逻辑标识。它们不是 URL，也不能直接映射成任意远程地址。

`generation.messages`、`generation.tools`、`toolCatalogDigest` 和 `contextDigest` 不能只做“客户端自洽”校验。客户端 digest 只能证明 payload 与该 digest 一致，不能证明该 payload 是当前 Session、当前 Tool catalog 和当前 owner 有权提交的内容。服务端必须至少满足下面一条：根据 authoritative Session 和 server-side tool catalog 重新计算 digest 并拒绝不匹配的请求；向 Worker 下发带版本与签名的 catalog 并要求请求引用该 server-issued 版本；或要求请求携带 `baseSessionSeq` 和 server-issued capability token，验证 payload 是允许的 Session prefix 的确定性派生结果。

`baseSessionSeq` 是比 digest 更基本的字段：没有它，服务端无法判断客户端提交的消息是否引入了未记录的 Session 内容。

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

Tool call 使用 DSH 的 canonical `StreamChunk` 语义，不把 provider 原始 SSE 透传到浏览器。

wire record 不是 `StreamChunk`。浏览器侧 adapter 必须把 wire record 转换成 `AsyncIterable<StreamChunk>` 之后再交给 `ctx.llm`，转换表如下：

| wire record | DSH 内部结果 |
|---|---|
| `accepted` | 不产生 `StreamChunk`；仅表示服务端已接受并分配 `streamId` |
| `chunk`（text-delta / reasoning-delta / tool-call-delta） | 同类 `StreamChunk`，保留 `index` 与增量字段 |
| `chunk`（tool-call 起始或完整 block） | 对应 `StreamChunk`，由 agent-loop 的 assembler 组装 |
| `finish`，`reason: "stop"` | `StreamChunk: finish`，`reason.kind = "stop"` |
| `finish`，`reason: "tool-use"` | `StreamChunk: finish`，`reason.kind = "tool-calls"` |
| `finish`，`reason: "length"` | `StreamChunk: finish`，`reason.kind = "length"` |
| `error` | `StreamChunk: finish`，`reason.kind = "error"`，只保留稳定 code 与 `messageSafe` |
| 连接中断或 abort | `StreamChunk: finish`，`reason.kind = "aborted"` |
| 协议违规（跳号、重复 seq、terminal 后数据） | adapter 生成受控 terminal error；不得把原始 record 交给 Agent Loop |

wire record 的字段名与 DSH 内部字段名不必相同，但转换必须是确定的、可测试的，并且不得让 Agent Loop 直接消费 wire DTO。provider failure 一律规范化为 terminal finish chunk，不新增一个 Agent Loop 需要理解的 error record。

终止成功：

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

流尚未开始时的失败必须返回普通 HTTP error response，带稳定 code 和 `messageSafe`，不得返回 provider 原始 body；流开始之后的失败必须使用 `error` record。adapter 必须保证每个 attempt 恰好产出一个 terminal `StreamChunk`，包括连接中断的情况。

wire stream 不支持断点续传：连接中断即视为该 attempt 已结束，adapter 产出 aborted terminal，不重放整个响应。需要重试时由 retry policy 通过新的 `requestId` 发起新的 attempt。

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

transport cancel state 与 Session settlement 是两件事，必须分别定义：

```text
transport:  requested → propagating → settled
                     ↘ too-late
                     ↘ unknown

Session:    assistant/attempt (reason: aborted)
         → step/end
         → turn/end
```

不能只关闭 HTTP 连接而不写 durable settlement。`too-late` 表示 provider 已经产生完整结果，Agent Loop 按正常结果继续，不自动重试；重复 cancel 返回同一状态；cancel target 必须是当前 active request，对已结算 request 的 cancel 返回 `too-late` 或 `unknown`，不改变 Session。

取消成功不代表 provider 已经回滚任何副作用。对于可能已经发生的业务副作用，返回 `unknown` 并提供 reconciliation/receipt 路径；此时必须进入 unknown settlement，不得用普通 aborted settlement 覆盖。

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

`MessageChannel` 只保证单次连接内的消息顺序，不能替代 reconnect 协议。bridge 必须定义：

每个方向各自维护递增 `seq`；帧区分 request、response、event 和 ack；接收方按 `seq` 检测 gap 和 duplicate；`bridgeGeneration` 每次重新握手递增，旧 generation 的帧一律拒绝；重连后先交换 `resync`，再由双方用 snapshot 加 delta 恢复；未完成 action 在重连后必须被明确结算为 settled、cancelled 或 unknown，不能继续停留在 pending；两侧各自声明 replay buffer 上限，超过上限时 fail closed 并要求重建 Session 视图。

reconnect 只保证 bridge 层连续性。跨 Worker 重启和跨页面刷新的恢复由 persistence profile 决定，不由 bridge 决定。

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
  "contentDigest": "sha256:...",
  "observedAt": 1730000000000
}
```

Main Thread 只允许注册过的 `surface` 和 field 被导出。

`modelVisible: true` 的状态必须满足 model-visible state 与 Session log 可重建之间的等价关系。只把 state 通过 `agent.inject()` 发给模型而不写 Session event 是禁止的。

方案冻结的实现方式如下，不使用“例如”：新增 Browser Native surface event `browser/ui-state-observed`，payload 记录经过脱敏和大小限制的结构化 state，不能记录原始 DOM。它必须同时完成六件事：

1. 在 `SessionEventMap` 中声明 payload（`surface`、`entityRef`、`stateVersion`、`fields`、`capabilities`、`sensitivity`、`contentDigest`、`observedAt`）；
2. 注册 surface projection，使 `deriveMessages()` 能把该 state 投影进下一次模型请求的上下文；
3. 对同一 `surface` 的后一次观测产生替换，而不是无限追加，避免上下文无界增长；
4. 进入 persistence catalog，并按 persistence type change 流程确认；
5. 同步 TypeScript 与 Python SDK 的 expected output；
6. 在 schema 不匹配、字段未注册或超出大小限制时拒绝该 state，而不是降级发送。

追加顺序是强制的：

```text
UI state 被 capability registry 接受
→ append browser/ui-state-observed
→ 等待 flush，或确认该事件已进入本次请求的 Session prefix
→ agent/pre-step 与 request assembly
→ request/header + request/context
→ 模型请求
```

state event 只能影响它之后的请求；晚于 request admission 的 state 只能影响下一个 step。

不是模型可见的 transient UI state 不必进入 Session log，但不得被隐式升级为模型上下文。

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

### 7.5 Tool 执行的 canonical lifecycle

Browser Tool 不改变 DSH 的 Tool lifecycle，只改变 Tool body 的执行位置。每个 Tool 调用必须落到确定的事件序列：

| 阶段 | 必须追加的事件 | 不成立的替代做法 |
|---|---|---|
| Tool 被模型选中 | `tool/call`（含 `callId`、`turn`、`step`、`name`、`arguments`） | 只发 bridge frame 而不写 `tool/call` |
| 需要审批 | 复用现有 approval 事件 | 用 bridge frame 冒充审批记录 |
| Main Thread 拒绝 | `tool/result`，`isError: true`，error code 稳定 | 静默丢弃该 Tool call |
| bridge 断开 | `tool/result`，`isError: true`，标记 cancelled | 保留 pending 直到超时后仍无结果 |
| 执行完成 | `tool/result`，包含结果或 `meta` | 只把结果发给 Worker 而不落 Session |
| 结果未知 | `tool/result`，`isError: true`，标记 unknown，并附 reconciliation 路径 | 把 unknown 写成成功或失败 |
| turn 结束 | `step/end`、`turn/end` | 留下 open step 或 open turn |

`tool/call` 与 `tool/result` 的 `callId` 必须一一对应；没有 `tool/call` 就不能产生 `tool/result`。取消、审批拒绝、bridge 丢失和 unknown 都必须在同一个 Tool 生命周期内结算，不允许跨 turn 悬挂。

## 八、Session、持久化和 Profile 策略

### 8.1 四种明确 Profile

**Profile A：ephemeral。** Session 只在 Worker 生命周期内有效；页面关闭或 Worker 被回收后不承诺恢复；适合第一个垂直闭环；允许无 IndexedDB；不允许高风险 durable side effect。

**Profile B：browser-persistent。** Worker 使用 IndexedDB Session backend；`flush()` 是浏览器崩溃恢复的 durability barrier；页面刷新后从最后一个 flushed prefix 恢复；仍然是单浏览器设备范围；不承诺跨设备恢复。

**Profile C：server-synchronized。** Browser Worker 本地保存运行时副本；已提交事件批次同步到 DSH Host；Server 保存 authoritative Session；Browser Worker 每次 append/flush 带 owner epoch；多 tab 由服务端 fencing；reconnect 从 server cursor 恢复。

**Profile D：durable-handoff。** 建立在 server-synchronized 之上；支持显式 handoff；handoff 接受后 Browser Agent 必须停止；Backend Job 或 Backend Agent 成为唯一执行 owner。

不要把这些语义压缩成一个布尔值，例如 `persist: true`。调用者必须明确选择运行 profile。

每个 profile 的 owner authority 必须唯一，不能同时存在两个权威：

| Profile | owner authority | 跨 Tab 语义 | 恢复来源 |
|---|---|---|---|
| ephemeral | Worker-local（无 lease） | 不提供；同 Session 多 Worker 视为冲突 | 无 |
| browser-persistent | IndexedDB 原子 lease | 仅单设备协调，不宣称安全 fencing | 最后一个 flushed prefix |
| server-synchronized | Server lease | 服务端 fencing | server cursor |
| durable-handoff | Server owner epoch | 服务端 fencing，浏览器只 follow | server cursor 加 job |

local lease 是 profile-local coordination，不是安全 fence。Profile C 和 D 不得把 local lease 当作授权依据。

### 8.2 浏览器 persistence backend

建议新增 `packages/session/session-persistence-browser/`。第一版可以使用 IndexedDB 保存 session header store、event batch store、checkpoint store、lease store、corruption marker 和 version/migration store。如果事件或附件过大，再将大型 payload 迁移到 OPFS，但不能把 OPFS 当成自动耐久保证。

必须实现现有 `SessionHandle` 语义：append 只接受 contiguous batch；append 成功不等于 crash durability；`flush()` 成功才代表已持久化；close 必须 drain pending writes；writer 丢失时返回明确 ownership error；不自动重放 Tool side effect。

浏览器 backend 必须处理账户和租户隔离，因为同一浏览器可能被多个 principal 使用：IndexedDB namespace 必须绑定 deployment 与 user/tenant；Session header 必须记录 principal binding；恢复前必须重新认证并校验 principal binding，不匹配时拒绝恢复；登出或切换账户时必须清理或隔离上一 principal 的本地 Session；IndexedDB 被浏览器 eviction 后必须能识别为丢失而不是损坏；private mode、quota exhausted 和 partial deletion 必须返回明确失败。

`flush()` 的语义是“该 backend 定义的提交语义”，不要泛化成所有浏览器都提供物理磁盘级持久性。

### 8.3 批次 envelope

本地或服务端同步都建议使用：

```json
{
  "batchProtocolVersion": 1,
  "sessionFormatVersion": 3,
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

这里至少有三个独立版本，不能共用一个名字：Session log format version（`sessionFormatVersion`，由 Session format 机制拥有）、batch transport protocol version（`batchProtocolVersion`）、以及 LLM 与 bridge 的 wire protocol version（`llmProtocolVersion`、`bridgeProtocolVersion`）。batch transport 版本变化不得改变 Session format compatibility；每种版本都必须有独立的拒绝路径。

### 8.4 中断恢复

如果浏览器在 provider response 未结束、Tool 已开始但结果未知、approval 已发出但未确定，或 side effect 已发送但 receipt 未返回的阶段断开，恢复时不得自动继续该操作。应当关闭未完成 turn/step；写入明确的 interrupted/unknown settlement；将 operation 标记为需要人工或 reconciliation；只有新的 Agent step 才能继续；不重放原始副作用调用。

### 8.5 Canonical durable lifecycle

Browser Native 不定义新的 turn/step 语义。每个 turn 必须落到下面的 durable 序列；缺任何一个 settlement 都会让 reload 或 replay 丢失失败、取消或未知结果：

```text
prompt accepted
→ turn/start
→ step/start
→ request/header (reason: initial | change | series)
→ request/context
→ assistant/message          （成功）
  或 assistant/attempt       （失败、重试、取消、stream error）
→ tool/call
→ tool/result
→ step/end
→ turn/end (reason: completed | failed | cancelled | unknown)
```

`agent/assistant-stream` 是进程内临时事件，用于实时 UI；`assistant/message` 和 `assistant/attempt` 才是可重放的 durable settlement，`deriveMessages()` 与 replay 只依赖后者。Browser Native E2E 必须断言完整的事件类型序列，而不只是断言最终 assistant 文本。

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

### 9.3 Authority 切换

Profile 升级或 server synchronization 上线时，唯一权威必须原子切换，不能让两个 tab 各自满足不同权威：旧 local-only Worker 必须先获得 server lease 才能继续写；拿到 server lease 之前只能 read-only；server-synchronized profile 不接受只有 local lease 的写入；切换期间宁可让所有 writer 进入 follower，也不允许双写；server fence 一旦生效，旧 epoch 的 LLM request、Tool action、append、cancel 和 handoff 全部拒绝。

迁移判定以服务端 lease 为准：local lease 只用于减少重复启动。

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
  "leaseToken": "opaque-lease-token",
  "lastCommittedSeq": 240,
  "checkpointDigest": "sha256:...",
  "turn": 7,
  "step": 3,
  "capabilitySet": [
    "release.inspect",
    "release.start_canary"
  ],
  "toolCatalogDigest": "sha256:...",
  "requestedProfile": "durable-handoff",
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

handoff 必须是服务端的原子 ownership 转换，而不是“先接受、再停止浏览器”：

```text
browser-owned
→ handoff-prepared
→ browser-lease-revoked
→ server-owner-issued
→ job-started
```

约束是：`handoffId` 必须幂等；lease revoke 与 server owner grant 必须在同一个 authoritative transaction 中完成；只有旧 owner 已经被 fencing 之后才能返回 `accepted`；Job 必须持有新的 server owner epoch；Job 创建失败时必须进入明确的 recovery state，而不是回到 browser-owned；旧 epoch 的 LLM request、Tool action、append、cancel 和第二次 handoff 全部拒绝；两次并发 handoff 只有一个成功；cancel 在 `accepted` 前后到达时必须能区分“未开始”和“已转移”。

handoff accepted 后：Browser Worker 立刻停止 Agent Loop；不再发送 LLM request；不再执行 Browser Tool；不再 append；只 follow 后端产生的 Session/job events；如果 handoff 后浏览器仍发送旧 epoch 请求，服务端拒绝。

## 十一、分阶段实施路线

### Phase 0：冻结数据和授权契约

目标是不写生产运行逻辑，先冻结后续所有实现都依赖的契约：Browser Native 定义、profile 分类与每个 profile 的唯一 owner authority、`/api/llm` 与 bridge 的 wire protocol 版本、LLM wire DTO 到 `StreamChunk` 的转换表、canonical durable lifecycle、model-visible UI state 的投影方式、event producer/authority 表、CSRF 与 Origin 策略、principal binding、error code namespace、threat model 和 mock provider 行为。

产物在新增的 `packages/experimental/browser-native-agent` 包内新增或更新 `README.md`、`src/protocol/*` 和 `tests/protocol/*`，并新增 `packages/bundle/browser-native/cordis.patch.yml`。如果该决定会长期影响 DSH 的执行位置和 Session ownership，应在实现 PR 中增加一篇 active Agent Note，记录为什么 Browser Native 是 execution mode 而不是新 Harness、为什么不能复用 generic `/api` direct lane、为什么 `ownsHost` 不能当作 provider authorization，以及为什么 handoff 后必须停止 Browser Loop。

退出条件是：每个 owner 都有明确责任；每个 profile 只有一个 owner authority；协议字段有版本和大小限制；所有拒绝路径都有稳定 code；wire DTO 到 `StreamChunk` 的转换表已冻结；model-visible UI state 的 event 与 projection 已冻结；event producer/authority 表已冻结；CSRF 与 Origin 策略已冻结；没有默认 profile 变化；mock LLM 可以返回确定性的 Tool call sequence。

### Phase 1：Worker profile 和 fake LLM 内存闭环

目标是在不接真实 provider 的前提下证明 Worker Agent Loop 能收到 fake LLM 的 tool call、请求 Main Thread 执行 Tool、拿到 tool result、发出第二次请求并获得 final assistant message。本阶段只证明内存内的事件重建，不涉及任何持久化或崩溃恢复。

预计涉及 `packages/experimental/webworker-runtime/`、`packages/experimental/browser-native-agent` 的 `src/worker/` 与 `src/client/`、`packages/bundle/browser-native/`、`apps/web/src/browser-native.ts` 和 `apps/web/tests/browser-native-loop.e2e.ts`。

必须复用 `ctx.agents`、`ctx.agentLoop`、`ctx.tools`、Session event、`tool/call`、`tool/result`、`assistant/message`、`assistant/attempt` 和 `agent/assistant-stream`。

不允许新建 `BrowserAgent` 复制 `Agent`；在 UI 组件内直接访问 Worker；用普通 postMessage 承载未定义的业务对象；用 DOM 文本作为 Tool result；通过现有 generic `/api` tunnel 绕过 bridge。

退出条件是：Worker 内确实产生两次 model request；第一次响应包含 Tool call；Main Thread 执行 Tool；第二次请求包含上一次 Tool result；内存中可以重建完整事件序列（`turn/start` → `step/start` → `request/header` → `request/context` → `assistant/message` → `tool/call` → `tool/result` → `step/end` → `turn/end`）；默认 `web` profile 行为不变；dispose Worker 后所有 bridge handler、Tool registration 和 stream 都撤销。

本阶段不得使用 durable、crash recovery 或跨刷新恢复等措辞；这些验收属于 Phase 4 和 Phase 5。

### Phase 2：Browser LLM Adapter 和 test-only `/api/llm` route

目标是实现 wire DTO 到 `StreamChunk` 的转换和受限的同源 route，但仍使用 test provider，不接真实 DeepSeek key，也不对生产用户开放。

预计涉及 `packages/experimental/browser-native-agent` 的 `src/worker/llm-adapter.ts` 与 `src/worker/llm-wire.ts`、`src/host/llm-route.ts` 和 `src/protocol/llm.ts`，`packages/llm/llm/src/*`，`packages/llm/llm-deepseek/src/*`（只验证 Host 侧，不加入 Worker bundle），以及 `packages/client/connection/src/rpc.ts`（仅在确有通用 transport 需求时）。

Host handler 使用现有 `ctx.llm` provider adapter：

```text
Browser logical request
 → browser-agent host authorization
 → ctx.llm.stream(...)
 → canonical StreamChunk
 → wire DTO（bounded NDJSON）
```

浏览器侧 adapter 反向转换：

```text
wire DTO
 → BrowserLlmAdapter
 → AsyncIterable<StreamChunk>
 → ctx.llm / llm/stream / agent-loop assembler
```

Host 侧继续使用现有 `apiKeyEnv`、`resolveApiKey`、provider-specific adapter、retry policy、attribution headers 和 existing LLM error normalization。Browser Worker 中禁止加载 `llm-deepseek` direct fetch adapter、`pi-ai` provider auth、credential provider、provider baseURL configuration 和 `x-api-key` 生成代码。

本阶段还没有 server owner authority。因此 `/api/llm` 只能以 test-only authority 运行：只接受 test principal 和 test Session，不能对生产用户开放，bundle/profile 不得暴露生产入口，production activation 明确阻塞到 Phase 5。否则 §5.2 要求的 owner 校验无法在 Phase 2 成立。

退出条件是：Worker bundle 中没有 provider key、`x-api-key` 或 provider baseURL；`/api/llm` 拒绝任意 URL/Auth/header；provider/model allowlist 生效；wire DTO 到 `StreamChunk` 的转换覆盖 text-delta、tool-call-delta、finish、error、abort 和协议违规；stream sequence 严格校验；abort 能从 Worker 传到 Host 再传到 provider；provider 原始错误不会进入浏览器；Browser Native Worker 无法通过 generic direct lane 访问 `/api/llm`；request attribution 包含 session/agent/tab/worker metadata；真实 browser E2E 可以完成两次 `/api/llm` 请求。

### Phase 3：真实前端 Tool 和结构化 UI state

目标是把 fake Main Thread Tool 替换成一个真实业务 UI capability。建议先实现一个低风险示例，例如 `ui.selection.read` 或 `release.scope.preview`。不要第一例就选择发布、删除或支付。

预计涉及 `packages/experimental/browser-native-agent` 的 `src/client/capability-registry.ts`、`src/client/state-adapter.ts`、`src/client/state-projection.ts`、`src/client/approval-adapter.ts` 和 `src/worker/bridge-service.ts`，`packages/client/ui-tool/`，`packages/client/ui-renderer/`，以及 `apps/web/tests/browser-native-loop.e2e.ts`。

退出条件是：UI state 通过 typed adapter 提供；Worker 不依赖 DOM；`browser/ui-state-observed` 已按 §6.3 的投影方式实现，replay 后能重建同一模型上下文；Tool schema、arguments、output 都经过限制；state version conflict 能拒绝；action result 只在 commit point 后发布；Tool result 被现有 Tool pipeline 和 Session event 记录，并符合 §7.5 的 lifecycle；bridge reconnect 后 UI card 能从当前内存事件重新派生；UI 组件不接收 `ctx`、DOM handler 或裸 observable。

本阶段只要求 bridge 层 reconnect。跨页面刷新和跨 Worker 重启的恢复属于 Phase 4，跨服务端 cursor 的恢复属于 Phase 5。

### Phase 4：浏览器持久化和单 writer

目标是支持页面刷新后的安全恢复，但先限定在单浏览器设备，并使用 IndexedDB 原子 lease 作为唯一 owner authority。

预计涉及 `packages/session/session-persistence-browser/`、`packages/experimental/browser-native-agent` 的 `src/worker/operation-controller.ts` 与 `src/protocol/ownership.ts`、`packages/bundle/browser-native/`，以及 `apps/web/tests/browser-native-persistence.e2e.ts`。

实施顺序是 IndexedDB header/store、contiguous append、`flush()` durability barrier、torn tail 检测、interrupted turn repair、local owner lease、restart from last flushed sequence、principal binding，以及明确 unknown side effect recovery。

退出条件是：append gap/overlap 被拒绝；flush 前崩溃不会声称数据 durable；flush 后刷新可恢复；Worker 重启不会重复执行已提交 Tool；active unknown Tool 不会自动重放；本地事件序列符合 §8.5；账户隔离和 principal binding 生效；quota、private mode、corrupt batch、eviction 有明确失败；Session 中不出现 provider secret。

本阶段的 local lease 只用于单设备协调，不宣称安全 fencing，也不能替代 Phase 5 的 server lease。

### Phase 5：Server synchronization 和 multi-tab fencing

目标是让 Session 在服务器上成为 authoritative durable state，支持多个 tab 的 owner/follower 模型，并让 `/api/llm` 从 test-only 转为生产可用。

预计新增 `packages/experimental/browser-native-agent` 的 `src/host/owner-service.ts`、`src/host/session-ingest.ts`、`src/host/event-authority.ts`、`src/host/handoff-service.ts`、`src/protocol/ownership.ts`、`src/protocol/events.ts` 和 `src/protocol/handoff.ts`，以及 `apps/web/tests/browser-native-ownership.e2e.ts`。

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

其中 claim/heartbeat/release/handoff/cancel 可使用 Typed Remote；高吞吐 event batch 使用精确 Fetch route；`/api/browser-agent/events` 不能变成任意 Session event append，必须按 §3.1 的事件生产者分类只接受允许的类型；Host 必须验证事件顺序和当前 Agent state；`SessionController.prompt()` 不应被复用成 Browser Native event ingest。

authority 切换按 §9.3 执行：server lease 一旦生效，local lease 只能用于减少重复启动。

退出条件是：两个 tab 同时 claim 时只有一个成功；follower 无法发 LLM/Tool/append；stale owner epoch 和 stale lease 全部被拒绝；owner lease 过期后旧 Worker 无法恢复写权限；`/api/llm` 的 owner 校验绑定 server-issued claim；生产 principal 无法使用 test-only authority；reconnect 能从 last committed cursor 继续；baseline 和 delta 不重复、不跳号；hidden/frozen/pagehide 行为可测试；server persistence 与 browser cache 不产生双 writer。

### Phase 6：Durable handoff

目标是完成 Browser Loop 到 Backend Durable Job 的显式转移，并按 §10 的原子状态机实现。

退出条件必须验证：clean checkpoint 可以 handoff；dirty/unflushed checkpoint 被拒绝；active Tool unknown 被拒绝；stale owner 和 stale lease 被拒绝；backend Tool catalog 不匹配被拒绝；handoff request 重试是幂等的；lease revoke 与 server owner grant 在同一事务中完成；handoff accepted 后浏览器不能继续 LLM request；后端 job 成为唯一 owner 并持有新 epoch；job 创建失败进入明确 recovery state；browser 断线后重新 follow；job 完成、失败、unknown 都有 receipt；cancel handoff 不会制造第二个 owner；两次并发 handoff 只有一个成功；浏览器无法使用旧 resume handle 伪造新 owner。

## 十二、测试矩阵

### 12.1 协议单元测试

覆盖 frame version、缺字段、unknown field、oversized nested JSON、non-finite number、invalid correlation id、sequence gap、duplicate sequence、second terminal、post-terminal data、invalid origin、missing origin、forbidden headers、request nonce replay、digest mismatch、deadline expired、prototype pollution keys、CRLF/header injection、multibyte byte limits，以及 wire DTO 到 `StreamChunk` 的转换（text-delta、tool-call-delta、finish、error、abort、协议违规恰好产生一个 terminal）。

### 12.2 LLM Proxy 测试

成功路径覆盖合法 provider/model、合法 session/agent/owner、合法 lease、deterministic chunk stream、tool call delta、finish、explicit cancel、transport close cancel 和 retryable provider error。

拒绝路径覆盖 arbitrary endpoint、client-supplied Authorization、client-supplied API key、unknown provider、unknown model、wrong session、wrong tenant、stale owner、stale lease、client-forged ownerEpoch、catalog digest mismatch、oversized request、oversized response、provider raw error leakage、duplicate request nonce、expired deadline、CSRF 与 Origin 校验失败，以及通过 generic direct lane 访问 `/api/llm`。

### 12.3 Worker/Main Bridge 测试

覆盖 wrong worker id、wrong tab id、wrong session id、stale owner epoch、out-of-order frame、duplicate frame、sequence gap、unknown capability、invalid arguments、stateVersion conflict、preview digest mismatch、missing approval、missing user gesture、duplicate idempotency key、action handler throws、action result unknown、queue backpressure、Worker restart、bridge reconnect、stale bridge generation、resync 后未完成 action 的结算、transient state coalescing，以及 model-visible state cannot be dropped。

### 12.4 Session Persistence 测试

覆盖 exact contiguous batch、gap、overlap、conflicting duplicate batch、append before flush、flush durability、torn tail、corrupt digest、unknown format、unknown event、lost lease、two writers、quota exhausted、private mode、eviction、restart、interrupted turn、unknown active Tool、principal binding mismatch、replay cannot execute side effect，以及 secret scan over events and storage。

### 12.5 Multi-tab 和 lifecycle 测试

覆盖 simultaneous claim、follower read-only、stale heartbeat、tab hidden、page frozen、pagehide、Worker termination、old Worker sends LLM request、old Worker sends Tool action、old Worker sends append、tab crash and lease expiry、reconnect generation、local lease 与 server lease 的 authority 切换、duplicate prompt、duplicate cancel 和 duplicate handoff。

### 12.6 真实组合测试

必须通过 Loader 和 test-only `cordis.yml` 启动实际 composition，不使用纯手工 `ctx.plugin(...)` 代替。验证 profile rows、service injection、Tool registry、Worker bridge provider、LLM proxy route、session persistence、event authority 分类、HMR/disposal、model-visible output、durable event output 和 default profile remains unchanged。

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

### 12.8 Durable lifecycle 测试

对 §8.5 的每个阶段分别断言事件类型序列：成功、provider error、user cancel、bridge 断开、审批拒绝、Tool unknown、Worker 终止、flush 前崩溃、flush 后恢复。

断言 replay 后 `deriveMessages()` 产生与崩溃前一致的模型上下文；断言 `browser/ui-state-observed` 的 projection 在 replay 后重建同一上下文；断言 unknown 结果不会被重放成副作用；断言没有 `tool/call` 时不会出现 `tool/result`，且不存在 open step 或 open turn。

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

### 13.4 事件权威和跨站防护

`/api/browser-agent/events` 和 `/api/browser-agent/flush` 不是任意 Session append 入口。服务端只能接受 §3.1 中 Browser-observed 和 Browser-requested 允许的类型，并拒绝浏览器提交的 Server-authored 事件（授权结论、provider usage、server receipt、高风险副作用 settlement、ownership transition）。

所有 Browser Native route 必须通过 §5.1 的 Origin 与 CSRF 前置校验。缺少该校验时，跨站页面可以用受害者 cookie 发起 `/api/llm` 或 handoff 请求。

IndexedDB 和 localStorage 不是 secret store；本地 Session 必须按 principal 隔离，登出或切换账户时必须清理或隔离。

## 十四、迁移、回滚和兼容策略

### 14.1 默认行为保持不变

第一版必须是显式 opt-in，例如 `dsh --profile browser-native`，或显式 session execution profile。不得让现有 `dsh --profile web`、`dsh --profile headless`、`dsh --profile sdk`、`dsh --profile acp` 隐式改变 Agent Loop 所有权。

### 14.2 不自动转换已有 Session

现有后端 Agent Session 不自动变成 Browser Native Session。反方向也一样：Browser Native Session 不能被普通 `prompt()` API 隐式接管；server Agent 不能在 Browser owner 仍存活时启动；execution ownership 必须显式声明和校验。

### 14.3 回滚

如果 Browser Native 发生严重问题：禁用 `browser-native` bundle/profile；保留已有 `web`、`headless`、`sdk`；Browser Session 只能进入 read-only/follow；不自动重试不确定副作用；允许用户显式 handoff 到后端；协议版本保持可拒绝，不通过静默降级解释错误 payload。

## 十五、Definition of Done

Browser Native 执行模式只有满足以下条件才可以从实验性 profile 提升。

**Loop。** Agent Loop 确实在 Dedicated Worker；第一轮模型响应产生 Tool call；Tool 在 Main Thread 执行；第二轮模型请求包含 Tool result；final assistant message 完成；内存中可重建 §8.5 的完整事件序列；没有同时运行后端 Agent Loop。

**Protocol。** `/api/llm` 只接受逻辑 provider/model；provider credential 始终留在 Host；wire DTO 到 `StreamChunk` 的转换确定且每个 attempt 恰好一个 terminal；流有严格 sequence；cancel 能传播到 provider 并写出 aborted settlement；provider 原始 key、URL、header、错误不会泄漏。

**Authority。** 每个 profile 只有一个 owner authority；`/api/llm` 的 owner 与 lease 校验绑定 server-issued claim；生产 principal 无法使用 test-only authority；不存在两个 tab 各自满足不同权威并同时写入的状态。

**UI bridge。** Main Thread 只发布 typed JSON state；不传 DOM、函数、组件和 observable；`modelVisible: true` 的 state 有 Session event 和 projection，replay 后重建同一模型上下文；action 有 allowlist、state version、approval、gesture、idempotency；commit 前不发布成功；unknown outcome 不伪装成失败或成功；bridge reconnect 有 generation 和 resync，未完成 action 被明确结算。

**Session。** 所有 model-visible state 都可以从 Session 重建；`append`、`flush`、ownership 语义保持一致；刷新不会重复执行已提交副作用；unknown Tool 不会自动重放；multi-tab 同一 Session 只有一个 active writer；浏览器提交的事件按 §3.1 分类接受。

**Handoff。** handoff 必须基于已 flush 的 clean checkpoint；lease revoke 与 server owner grant 在同一 authoritative transaction 中完成；接受后 Browser Loop 停止；后端成为唯一执行 owner；浏览器只能 follow；job receipt、失败和 unknown outcome 可查询。

**Product。** 默认 profile 无行为变化；现有 preview boot 测试继续通过；新增真实 Browser Native E2E；keyless snapshot 可以回放；UI Tool presentation 由 raw events/result metadata 派生；包 README、JSDoc、subsystem 文档和必要 Agent Note 同步。

可执行验证命令如下，每条都必须实际运行并记录结果：

| 验证 | 命令 | 通过标准 |
|---|---|---|
| 单元与协议 | `pnpm run test` | 新增协议、adapter、persistence 用例全绿 |
| 真实组合 | `pnpm run test:e2e` | 需要 `DEEPSEEK_API_KEY`；无 key 时记录为未验证 |
| Web 快照 | `DSH_SNAPSHOT=replay pnpm run test:web` | 只读回放通过，无写入 |
| GUI 单元 | `pnpm run test:gui` | 无回归 |
| 类型 | `pnpm run typecheck` | 无错误 |
| 文档 | `pnpm run test:docs` | 全绿 |
| 文档全量 | `pnpm run doc-sync` | 全绿 |

“相关测试”或“安全测试”不是可复核的验收项，必须落到上表的具体命令。

## 十六、最终建议

推荐的最小落地顺序不是一次性实现“浏览器持久 Agent 平台”，而是：先冻结数据和授权契约；fake LLM 加 Worker Agent Loop 的内存闭环；wire DTO 到 `StreamChunk` 的 adapter 与 test-only `/api/llm`；one low-risk UI Tool 和 model-visible state 投影；IndexedDB persistence；server owner fencing；durable handoff。

其中最重要的架构决策有三条：Agent Loop 复用 `dsh-agent-loop`，不创建第二套 loop；`/api/llm` 是独立的受限 server capability，不是现有 generic tunnel 的 direct lane；浏览器是交互式编排和低风险 Tool 执行环境，不是 provider secret、业务授权或 durable side effect 的最终权威。

这四条关系是后续实现的验收基准：模型可见输入与 Session event/projection/replay 的等价；Browser LLM wire DTO 与 `StreamChunk` 的转换；owner metadata 与 server-issued authority 的绑定；Tool 执行与 canonical tool lifecycle 的对应。

这条路线可以让 DSH 获得 Browser Native 能力，同时保留其作为 all-plugin Cordis Agent Harness 的总体定位。
