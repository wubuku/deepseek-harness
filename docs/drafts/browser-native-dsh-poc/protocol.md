---
description: "Browser-native DSH PoC 的版本化协议 owner：SessionPersistence 远程操作、LLM NDJSON stream、Worker/Main Thread Tool bridge 和错误语义。"
---

# Browser-native DSH PoC 协议

## Summary

本文是 `docs/drafts/browser-native-dsh-poc/` 中 PoC wire DTO 和错误语义的 owner。实施规划只说明为什么需要这些协议；实现代码、fixture 和测试必须以本文的字段、版本、错误和幂等规则为准。

本文定义的是 PoC 协议，不是 DSH 稳定公共 API。Session log format version、Session transport protocol、LLM wire protocol 和 browser-tool bridge protocol 相互独立；任何一个版本变化都不能通过修改另一个版本字段来掩盖。

## Table of Contents

- [一、通用约束](#一通用约束)
- [二、Session DTO](#二session-dto)
- [三、LLM DTO](#三llm-dto)
- [四、Tool bridge DTO](#四tool-bridge-dto)
- [五、错误和取消](#五错误和取消)
- [六、幂等、所有权和持久性](#六幂等所有权和持久性)
- [七、禁止字段](#七禁止字段)
- [Dev Note](#dev-note)

-----

## 一、通用约束

所有 JSON DTO 都必须是 plain JSON object，拒绝数组、null、未知顶层协议版本、重复字段无法可靠表示的输入、非有限数字、控制字符和超过 PoC 限额的字符串或数组。

除 GET stat 请求外，所有请求都必须带 `protocolVersion: 1` 和非空 `requestId`；需要 Session 的请求还必须带 `sessionId`。`requestId` 是一次逻辑操作的幂等键，重试相同逻辑操作时必须保持不变。

跨 boundary 的 id 在 TypeScript 中使用对应的 branded type；wire 上仍然是受长度和字符集限制的字符串。Session event 和 header 不在本文重新定义，必须直接使用 `@deepseek-ai/dsh-session` 的当前格式和 `@deepseek-ai/dsh-session-persistence` 的 validator。

### 1.1 基本限额

第一版建议固定以下 protocol constants；它们不是部署 tunables，若需要调整应同时更新测试和文档：

```text
maxRequestBytes: 1 MiB
maxResponseLineBytes: 1 MiB
maxSessionEventBatch: 256 events
maxToolArgumentsBytes: 64 KiB
maxToolResultBytes: 64 KiB
maxLlmStreamItems: 10000 per request
```

实际实现如果使用更小的值是允许的，但必须在响应中返回稳定的 `REQUEST_TOO_LARGE` 或 `STREAM_LIMIT`，不能截断后当作成功。

-----

## 二、Session DTO

### 2.1 Create

```text
interface SessionCreateRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  header: SessionHeader
  inheritedEventCount: number
}

interface SessionCreateResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  header: SessionHeader
  inheritedEventCount: number
  nextSeq: number
  owner: SessionOwnerReceipt
}
```

`create` 只允许创建不存在的 Session，并在同一个逻辑操作中取得 write owner。若 Session 已存在，返回 `SESSION_ALREADY_EXISTS`，不能隐式转成 open 或覆盖现有 log。

### 2.2 Open

```text
interface SessionOpenRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  access: 'read' | 'write'
}

interface SessionOpenResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  header: SessionHeader
  inheritedEventCount: number
  nextSeq: number
  owner?: SessionOwnerReceipt
}

interface SessionOwnerReceipt {
  ownerToken: string
  generation: number
  expiresAt: number // Unix epoch milliseconds
  backendRevision: string
}
```

`read` 不返回 owner；`write` 成功时返回 server-issued opaque owner token。客户端不能自己构造 token，也不能把 `requestId` 当作 owner token。

### 2.2.1 Renew write ownership

```text
interface SessionRenewRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  ownerToken: string
  generation: number
}

interface SessionRenewResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  owner: SessionOwnerReceipt
}
```

`renew` 只能延长仍然有效的当前 owner lease；它不改变 `generation`，不追加 Session event，也不改变 `backendRevision`。Worker 必须在 `expiresAt` 之前定期 renew；renew 失败或 lease 过期后，remote handle 停止 mutation，并要求重新 `open('write')`。lease 过期后到达的旧 renew 必须返回 `SESSION_OWNERSHIP_LOST`，新 write open 才能取得递增的 generation。相同 `requestId` 的 renew 重试返回第一次的 owner receipt，不得再次改变 lease 语义。

### 2.3 Read

```text
interface SessionReadRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  offset: number
  length?: number
}

interface SessionReadResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  eventState: 'owned' | 'shared-frozen'
  events: SessionEvent[]
  nextSeq: number
  backendRevision: string
}
```

读取必须返回连续的合法逻辑前缀片段；不返回 torn tail，不跳过 unknown required event，不把数组尾部的半个事件当成空成功。

### 2.4 Append

```text
interface SessionAppendRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  ownerToken: string
  generation: number
  expectedNextSeq: number
  events: SessionEvent[]
}

interface SessionAppendResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  acceptedFromSeq: number
  acceptedCount: number
  nextSeq: number
  backendRevision: string
}
```

Backend 必须先验证 owner、generation、batch contiguity、Session format、event type 和 `expectedNextSeq`，再一次性提交整个 batch。任何验证失败都不能留下部分 batch。

同一个 `requestId` 重试时，如果第一次 append 已经提交，必须返回与第一次等价的 receipt；如果第一次请求处于未知状态，backend 必须能通过 request id 查询或明确返回 `REQUEST_OUTCOME_UNKNOWN`，不能再写一份副本。

### 2.5 Flush 和 Close

```text
interface SessionFlushRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  ownerToken: string
  generation: number
}

interface SessionFlushResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  durable: true
  durableThroughSeq: number
  durabilityReceipt: string
  backendRevision: string
}

interface SessionCloseRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  ownerToken: string
  generation: number
}

interface SessionCloseResponse {
  protocolVersion: 1
  requestId: string
  sessionId: string
  closed: boolean
  ownerReleased: boolean
  backendRevision: string
}
```

`flush` 成功才允许 Worker 把对应的 event prefix 当作 crash-reopenable。`close` 释放 owner，不删除 Session；close 是幂等的，已经失效的 owner 只能得到明确的 ownership result，不能重新获得写权。

### 2.6 Stat

```text
interface SessionStatRequest {
  protocolVersion: 1
  sessionId: string
}

interface SessionStatResponse {
  protocolVersion: 1
  sessionId: string
  header: SessionHeader
  nextSeq: number
  backendRevision: string
  durableThroughSeq: number
  ownerActive: boolean
}
```

`SessionStatRequest` 通过 `GET /api/browser-native/session/stat?protocolVersion=1&sessionId=...` 的查询参数传输；GET 请求不带 `requestId`，因为 stat 不产生 mutation。Stat 只观察，不读取完整 log，不抢写权，不把 owner churn 当作 log revision change。

-----

## 三、LLM DTO

### 3.1 Request

```text
interface BrowserLlmRequest {
  protocolVersion: 1
  requestId: string
  sessionId: string
  ownerToken: string
  generation: number
  provider: string
  model: string
  messages: RequestMessage[]
  system?: string
  tools?: ToolSchema[]
  toolHistory?: ToolHistory
  reasoningEffort?: string
  maxTokens?: number
  temperature?: number
  stop?: string[]
}
```

`RequestMessage`、`ToolSchema` 和 `ToolHistory` 的语义来自 `@deepseek-ai/dsh-llm`；wire codec 只负责 schema validation、结构化 clone 和 transport encoding，不改变模型可见内容。`ownerToken` 和 `generation` 把模型调用绑定到当前 Session write owner，防止已经失去写权的 Worker 继续发起可计费的请求。

Backend 必须根据已授权 Session policy 重新解析 provider/model，并拒绝请求中的 `baseURL`、Authorization、API key、cookie、任意 header、代理设置、任意 tool executor 或 secret reference value。

### 3.2 NDJSON stream

```text
type BrowserLlmStreamItem =
  | { protocolVersion: 1; kind: 'chunk'; chunk: StreamChunkWire }
  | { protocolVersion: 1; kind: 'error'; error: LlmWireError }
  | { protocolVersion: 1; kind: 'end'; finish: FinishReasonWire }
```

`StreamChunkWire` 是对 DSH `StreamChunk` 的显式 JSON 映射；实现不得直接对带 prototype、Error、AbortSignal 或 provider-private object 的运行时值调用 JSON.stringify。

正常响应必须恰好有一个 `end`；错误响应必须有一个 `error` 或 HTTP error，且 Worker 不得把缺少终止 item 的连接关闭当作成功。

### 3.3 LLM error

```text
interface LlmWireError {
  code: string
  message: string
  status?: number
  requestId?: string
  retryable?: boolean
}
```

错误 message 不应包含 API key、Authorization、Cookie、完整 prompt 或 provider secret。provider-specific detail 只能在 server diagnostic 中保留，不能直接下发到页面。

-----

## 四、Tool bridge DTO

### 4.1 Call

```text
interface BrowserToolCall {
  protocolVersion: 1
  kind: 'browser-tool-call'
  callId: string
  name: 'browser_echo'
  args: { text: string }
}
```

第一版只有 `browser_echo`，并且 args 的 `text` 有明确字符数上限。后续增加 tool name 必须新增 schema、权限说明、失败语义和测试，不能把 `name` 放宽为任意 string 后动态执行。

### 4.2 Result

```text
interface BrowserToolResultOk {
  protocolVersion: 1
  kind: 'browser-tool-result'
  callId: string
  ok: true
  result: { text: string; length: number }
}

interface BrowserToolResultError {
  protocolVersion: 1
  kind: 'browser-tool-result'
  callId: string
  ok: false
  error: { code: string; message: string }
}
```

Main Thread 只能针对一个 pending call id 返回一次 result；Worker 只能接受当前请求对应的 result。未知、重复或过期 call id 必须被丢弃并记录诊断，不得改变 Session。

-----

## 五、错误和取消

PoC 使用以下稳定错误码：`PROTOCOL_UNSUPPORTED`、`INVALID_REQUEST`、`REQUEST_TOO_LARGE`、`SESSION_NOT_FOUND`、`SESSION_ALREADY_EXISTS`、`SESSION_ALREADY_OWNED`、`SESSION_OWNERSHIP_LOST`、`SEQ_CONFLICT`、`DURABILITY_FAILED`、`REQUEST_OUTCOME_UNKNOWN`、`MODEL_NOT_ALLOWED`、`UPSTREAM_LLM_FAILED`、`TOOL_NOT_ALLOWED`、`TOOL_TIMEOUT`、`CANCELED`、`STREAM_LIMIT` 和 `INTERNAL`。

HTTP status 是 transport signal，不能替代业务 error code。JSON/NDJSON error body 必须包含 code 和安全 message；客户端需要保留 code 并把不可恢复错误传给 DSH failure normalization。

客户端取消必须触发 AbortSignal、停止消费 stream、通知 backend 取消 admitted request，并释放本地 pending state。取消不等于回滚已经提交的 Session event 或已经发生的外部副作用。

-----

## 六、幂等、所有权和持久性

Mutation 的判断顺序必须是：解析协议版本 → 验证 request schema → 验证 Session identity → 验证 owner/generation → 检查 request id replay record → 验证 expected seq → 提交 batch/lease mutation → 返回 receipt。

Backend 在同一个 Session 内按 `requestId` 保存最小 replay record，至少包括 operation kind、request digest、result digest、nextSeq 和 durableThroughSeq。相同 request id 但 payload digest 不同必须返回 `INVALID_REQUEST`，不能复用旧结果。

`backendRevision` 只用于诊断和读缓存失效，不作为跨 backend 的全局时间或 Session format version。`generation` 是 owner fencing token；它单调递增，但不能替代 event seq。

`durabilityReceipt` 是 opaque string。PoC 不应伪造 WAL LSN、数据库 commit timestamp 或跨区域复制确认；临时目录 backend 只能返回它真实实现的本地 durability receipt。

-----

## 七、禁止字段

以下字段在浏览器提交的任何请求中禁止出现：`apiKey`、`authorization`、`cookie`、`baseURL`、`upstreamUrl`、`proxyUrl`、`x-forwarded-for`、`x-forwarded-host`、`x-dsh-auth-token`、`secret`、`credential`、`eval`、`script` 和任意未注册的 HTTP header map。

未知字段默认拒绝，而不是静默忽略；如果兼容性需要忽略某个扩展字段，必须把它命名为版本化的 `extensions`，并规定其大小、来源和忽略规则。

## Dev Note

本文是实施前的协议草案。实现每完成一个 Phase，都应把“草案”改成当前事实，把不再使用的字段删除或标记为明确的 future extension，并同步更新测试和实施规划。
