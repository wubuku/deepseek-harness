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

所有 JSON DTO 都必须是 plain JSON object，拒绝数组、null、未知顶层协议版本、重复字段无法可靠表示的输入、非有限数字、身份字段中的 NUL/DEL 控制字符和超过 PoC 限额的字符串或数组。用户文本可以包含普通换行；内容字段的更细粒度 schema 由对应 operation 负责。

Session 和 LLM API 请求（包括 GET stat）都必须带 `protocolVersion: 1`；静态资源和 health probe 不参与此协议版本校验。配置 probe `GET /api/browser-native/config` 只返回非敏感的 mode/provider/model 信息。除 GET stat 和 config 外，所有 Session 和 LLM API 请求都必须带非空 `requestId`。需要 Session 的请求还必须带 `sessionId`。stat 将 `protocolVersion` 和 `sessionId` 放在查询参数中；Session mutation 和 body-based read 的 `requestId` 是幂等键，重试相同逻辑操作时必须保持不变；LLM 的 `requestId` 只作调用关联标识，是否可重试由 provider adapter 决定。

跨 boundary 的 id 在 TypeScript 中使用对应的 branded type；wire 上仍然是受长度和字符集限制的字符串。正式 DSH 接入时，Session event 和 header 必须使用 `@deepseek-ai/dsh-session` 的当前格式和 `@deepseek-ai/dsh-session-persistence` 的 validator。当前目录内 PoC 为了保持零核心改动，使用最小 JSON-safe event/header fixture；它验证的是 transport、ownership 和 durability 语义，不是正式 DSH Session format 的兼容性证据。

### 1.1 基本限额

第一版建议固定以下 protocol constants；它们不是部署 tunables，若需要调整应同时更新测试和文档：

```text
maxRequestBytes: 1 MiB
maxResponseLineBytes: 1 MiB
maxSessionEventBatch: 256 events
maxDurableSessionEvents: 1000000 events per persisted Session
maxToolArgumentsBytes: 64 KiB
maxToolResultBytes: 64 KiB
maxLlmMessages: 256 messages per request
maxLlmStreamItems: 10000 per request
maxLlmStreamBytes: 8 MiB per response
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
  backendRevision: string
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
  backendRevision: string
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
  nextSeq: number
  backendRevision: string
  owner: SessionOwnerReceipt
}
```

`renew` 只能延长仍然有效的当前 owner lease；它不改变 `generation`，不追加 Session event，也不改变 `backendRevision`。Worker 必须在 `expiresAt` 之前定期 renew；renew 失败或 lease 过期后，remote handle 停止 mutation，并要求重新 `open('write')`。lease 过期后到达的旧 renew 必须返回 `SESSION_OWNERSHIP_LOST`，新 write open 在当前 backend 状态中取得递增的 generation。PoC 只在 `flush` 时持久化 generation，因此 backend 在未 flush 的 owner claim 后重启时不保证数值跨重启连续；旧 owner token 仍因进程重启而失效。相同 `requestId` 的 renew 重试返回第一次的 owner receipt，不得再次改变 lease 语义。

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
  durableThroughSeq: number
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
  nextSeq: number
  durableThroughSeq: number
  durabilityReceipt?: string
  backendRevision: string
}
```

`flush` 成功才允许 Worker 把对应的 event prefix 当作 crash-reopenable。`close` 释放 owner；包含事件的 Session 保留，尚未写入任何事件且从未 flush 的空 Session 可以由这个 PoC 清理。保留的 Session 支持相同 request id 的 close replay；空 Session 清理后不再保留 replay record，因此客户端不能把清理后的 Session 当作可查询资源重试。已经失效的 owner 只能得到明确的 ownership result，不能重新获得写权。

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
  model: string
  messages: RequestMessage[]
}
```

当前 PoC 的 `model` 只允许 `poc-scripted` 或 `real`。`poc-scripted` 使用确定性 backend fixture；`real` 不把 provider model、base URL 或 credential 暴露给浏览器，而是由 backend 根据启动时加载的环境配置选择 provider 和 model。当前 GPT 配置中的 model 是 `gpt-5.6-sol`，real GPT request 默认发送 `reasoning_effort: low`；Grok 的 model/key/path 选择仍完全由 backend 配置决定。没有把 DSH 的完整 `GenerateOptions` 暴露为浏览器协议字段。`RequestMessage` 的当前 PoC 形式是带 `role` 和不超过 64 KiB 的文本 `content` 的 plain object；assistant message 可以额外带 allowlisted 的 `toolCall`。未来增加系统提示、工具 schema 或采样参数时，必须先扩展 DTO、后端 allowlist 和测试；不能因为字段名与 DSH 内部类型相同就直接透传。`ownerToken` 和 `generation` 把模型调用绑定到当前 Session write owner，防止已经失去写权的 Worker 继续发起可计费的请求。

LLM 请求中的 `requestId` 是调用关联标识，不表示 backend 会重放或合并已经发出的模型调用；scripted 和 real route 都不提供 LLM replay。客户端不能把连接超时当作模型调用未发生，并在没有 provider-specific 幂等保证时自动重发。real route 在 backend 内把 PoC message DTO 转换为 OpenAI-compatible Chat Completions request，并由 backend 固定提供 `browser_echo` tool schema；浏览器不能提交任意 tool executor、provider URL 或 HTTP header。

Backend 必须根据已授权 Session policy 重新解析 provider/model，并拒绝请求中的 `baseURL`、Authorization、API key、cookie、任意 header、代理设置、任意 tool executor 或 secret reference value。

### 3.2 NDJSON stream

```text
type BrowserLlmStreamItem =
  | { protocolVersion: 1; kind: 'chunk'; chunk: StreamChunkWire }
  | { protocolVersion: 1; kind: 'error'; error: LlmWireError }
  | { protocolVersion: 1; kind: 'end'; finish: FinishReasonWire }
```

`StreamChunkWire` 是对 DSH `StreamChunk` 的显式 JSON 映射；实现不得直接对带 prototype、Error、AbortSignal 或 provider-private object 的运行时值调用 JSON.stringify。

正常响应必须恰好有一个 `end`；错误响应必须有一个 `error` 或 HTTP error，且 Worker 不得把缺少终止 item 的连接关闭当作成功。scripted route 直接生成这些 item；real route 解析上游 SSE 的 text delta、function tool call 和 finish reason，再生成相同的 PoC NDJSON，不把 provider-private response 透传给浏览器。

### 3.3 LLM error

```text
interface LlmWireError {
  code: string
  message: string
}
```

当前 PoC 只允许 `code` 和 `message`；错误 message 不应包含 API key、Authorization、Cookie、完整 prompt 或 provider secret。未来增加 `status`、`requestId` 或 `retryable` 等字段时，必须先更新 Worker exact-key 校验、后端 allowlist 和回归测试，不能仅修改文档。

-----

## 四、Tool bridge DTO

### 4.1 Call

```text
interface BrowserToolCall {
  callId: string
  name: 'browser_echo'
  args: { text: string }
}

interface BrowserToolCallEnvelope {
  protocolVersion: 1
  kind: 'browser-tool-call'
  call: BrowserToolCall
}
```

第一版只有 `browser_echo`，并且 args 的 `text` 有明确字符数上限。后续增加 tool name 必须新增 schema、权限说明、失败语义和测试，不能把 `name` 放宽为任意 string 后动态执行。

### 4.2 Result

```text
interface BrowserToolResultOk {
  callId: string
  ok: true
  result: { text: string; length: number }
}

interface BrowserToolResultError {
  callId: string
  ok: false
  error: { code: string; message: string }
}

interface BrowserToolResultEnvelope {
  protocolVersion: 1
  kind: 'browser-tool-result'
  callId: string
  ok: true
  result: { text: string; length: number }
}

interface BrowserToolResultErrorEnvelope {
  protocolVersion: 1
  kind: 'browser-tool-result'
  callId: string
  ok: false
  error: { code: string; message: string }
}
```

`type` 是页面与 Worker 使用的本地控制字段，不属于上述 bridge DTO。Main Thread 只能针对一个 pending call id 返回一次 result；Worker 只能接受当前请求对应的 result。未知、重复或过期 call id 必须被丢弃并记录诊断，不得改变 Session。

当前 PoC 的 pending browser Tool 等待时间为 10 秒；超时返回 `TOOL_TIMEOUT`，不会自动重放该 Tool。页面或 Worker 之后到达的旧 result 仍会被丢弃。

-----

## 五、错误和取消

PoC 使用以下稳定错误码：`PROTOCOL_UNSUPPORTED`、`INVALID_REQUEST`、`REQUEST_TOO_LARGE`、`SESSION_NOT_FOUND`、`SESSION_ALREADY_EXISTS`、`SESSION_ALREADY_OWNED`、`SESSION_OWNERSHIP_LOST`、`SEQ_CONFLICT`、`DURABILITY_FAILED`、`REQUEST_OUTCOME_UNKNOWN`、`MODEL_NOT_ALLOWED`、`UPSTREAM_LLM_FAILED`、`TOOL_NOT_ALLOWED`、`TOOL_TIMEOUT`、`CANCELED`、`STREAM_LIMIT` 和 `INTERNAL`。

HTTP status 是 transport signal，不能替代业务 error code。JSON/NDJSON error body 必须包含 code 和安全 message；客户端需要保留 code 并把不可恢复错误传给 DSH failure normalization。

正式 provider route 的客户端取消必须触发 AbortSignal、停止消费 stream、按 provider adapter 的取消能力通知 backend，并释放本地 pending state。当前 PoC real route 在浏览器连接中断时向上游 fetch 传递 AbortSignal，但没有独立 cancel route；断开连接只表示 backend 尝试取消上游请求，不承诺 provider 已撤销已经开始的推理或计费。取消不等于回滚已经提交的 Session event 或已经发生的外部副作用。

-----

## 六、幂等、所有权和持久性

Mutation 的判断顺序必须是：解析协议版本 → 验证 request schema 和字段值 → 验证 Session identity → 检查 exact request-id replay record → 若没有 replay 才验证 owner/generation → 验证 expected seq → 提交 batch/lease mutation → 返回 receipt。Exact replay 只返回此前已经提交的 immutable receipt，不重新执行 mutation，因此不会让旧 owner 恢复写权；未知字段和值仍然在 Session lookup 前拒绝，避免错误地报告为 `SESSION_NOT_FOUND`。

Backend 在同一个 Session 内按 `requestId` 保存最小 replay record，至少包括 operation kind、request digest、result digest、nextSeq 和 durableThroughSeq。当前 backend 只把不含 owner receipt 的 `read`、`append`、`flush` 和 `close` replay 持久化；`create`、`open` 和 `renew` 的 replay 只在进程内保留，因为它们的 response 含有绑定当前 backend 进程的 owner token，不能在重启后返回。重启后客户端必须重新 `open('write')`。replay 表按自有键查找，不得把对象原型属性当成已提交的 request。相同 request id 但 payload digest 不同必须返回 `INVALID_REQUEST`，不能复用旧结果。

`backendRevision` 只用于诊断和读缓存失效，不作为跨 backend 的全局时间或 Session format version。`generation` 是当前 backend 状态中的 owner fencing token；它不能替代 event seq，也不承诺成为跨重启全局单调时钟。

当前 PoC backend 对同一 `sessionId` 的 Session operation 和 `stat` 串行处理，使异步 flush、owner release 和 replay receipt 使用同一个可观察的 Session 状态。LLM stream 不持有该队列；它只在响应开始前校验 owner，避免长时间的上游 stream 阻塞 lease renew。该保证只覆盖单个 backend 进程；多节点部署仍需要持久化存储提供事务或锁。

`durabilityReceipt` 是 opaque string。PoC 不应伪造 WAL LSN、数据库 commit timestamp 或跨区域复制确认；临时目录 backend 只能返回它真实实现的本地 durability receipt。

-----

## 七、禁止字段

以下字段在浏览器提交的任何请求中禁止出现：`apiKey`、`authorization`、`cookie`、`baseURL`、`upstreamUrl`、`proxyUrl`、`x-forwarded-for`、`x-forwarded-host`、`x-dsh-auth-token`、`secret`、`credential`、`eval`、`script` 和任意未注册的 HTTP header map。

未知字段默认拒绝，而不是静默忽略；如果兼容性需要忽略某个扩展字段，必须把它命名为版本化的 `extensions`，并规定其大小、来源和忽略规则。

## Dev Note

本文是实施前的协议草案。实现每完成一个 Phase，都应把“草案”改成当前事实，把不再使用的字段删除或标记为明确的 future extension，并同步更新测试和实施规划。
