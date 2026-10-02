---
description: "Browser-native DSH PoC 的自包含实施规划：复用 Dedicated Web Worker 中的 DSH Agent Loop，通过同源后端持久化 Session 并代理 LLM，在不改动既有核心行为的前提下验证浏览器内的真实 Agent loop。"
---

# Browser-native DSH PoC 实施规划

## Summary

本文是 `docs/drafts/browser-native-dsh-poc/` 的实施规划，不是实现报告，也不表示 PoC 已经完成。

本 PoC 要验证的严格命题是：DSH 的 Agent Loop 可以驻留在浏览器 Dedicated Web Worker 中，由 Worker 通过同源后端调用受控的 LLM 服务，由页面 Main Thread 执行一个明确授权的低风险浏览器 Tool，Session 事件同时写入同源后端并支持 Worker 终止后的重新打开和恢复。

Desktop app 是参考模型，不是要复制的运行时。Desktop 用 Electron Node Host 承载完整的 DSH profile，Browser-native 则使用现有 `@deepseek-ai/dsh-experimental-webworker-runtime` 承载选定的 DSH Host composition；Desktop 的本地 Node Host 和本机能力不能被浏览器 Worker 当作可用前提。

第一阶段默认只新增本目录中的 PoC 文件和测试驱动，不修改 `packages/core/agent-loop`、`packages/session`、`packages/llm`、`apps/web` 或现有 `web` profile。任何超出本目录的改动都必须先证明是现有入口无法表达的必要缺口，并在本目录的变更账本中记录上游基线、原因、替代方案、影响、验证和未来同步步骤。

PoC 不实现 Cloud Workspace、完整 POSIX 文件系统、后台 durable job、多标签页共享写入、任意插件安装、任意 JavaScript 执行、Native Bridge 或生产级多租户授权。它只验证“浏览器 Agent Loop、同源 LLM proxy、SessionPersistence 语义和一个前端 Tool”的最小闭环。

## Table of Contents

- [一、实施对象和完成定义](#一实施对象和完成定义)
- [二、当前代码事实](#二当前代码事实)
- [三、Desktop 参考与 Browser-native 差异](#三desktop-参考与-browser-native-差异)
- [四、变更预算和目录布局](#四变更预算和目录布局)
- [五、目标拓扑和所有权](#五目标拓扑和所有权)
- [六、PoC 内部协议](#六poc-内部协议)
- [七、Session 持久化方案](#七session-持久化方案)
- [八、LLM 代理方案](#八llm-代理方案)
- [九、Worker、Main Thread 和 Tool 桥](#九workermain-thread-和-tool-桥)
- [十、Worker 内 DSH 组合方式](#十worker-内-dsh-组合方式)
- [十一、分阶段实施顺序](#十一分阶段实施顺序)
- [十二、测试和故障注入矩阵](#十二测试和故障注入矩阵)
- [十三、安全和生命周期限制](#十三安全和生命周期限制)
- [十四、核心代码改动门槛和变更账本](#十四核心代码改动门槛和变更账本)
- [十五、实施者的执行清单](#十五实施者的执行清单)
- [十六、验收标准和不应宣称的能力](#十六验收标准和不应宣称的能力)
- [十七、参考资料](#十七参考资料)
- [Dev Note](#dev-note)

-----

## 一、实施对象和完成定义

### 1.1 PoC 要回答的问题

PoC 只回答以下五个问题：

1. Dedicated Web Worker 中的现有 DSH Host 能否装载足够的 profile 组成并创建真实的 `ctx.agentLoop` Agent，而不是只展示 fixture Session。
2. Worker 中的 DSH LLM 调用能否通过一个严格受限的同源 `/api/browser-native/llm` route 完成，并把流式响应转换回 `StreamChunk`。
3. Worker 中的 DSH Tool pipeline 能否调用一个由页面 Main Thread 提供的 typed browser Tool，并把真实 Tool result 通过现有 Agent Loop 写入 Session。
4. SessionPersistence 的 `create`、`open('write')`、`read`、`append`、`flush` 和 `close` 语义能否通过同源后端实现，而不是只上传一份最终 transcript。
5. Worker 被终止后，新的 Worker 能否以同一个 Session id 重新取得写所有权、读取已持久化事件并继续运行；并发 writer 能否被拒绝。

### 1.2 严格完成定义

只有下面的链路全部被自动化测试观察到，才可称为“browser-native DSH Agent loop PoC”：

```text
Browser page
  → starts Dedicated Web Worker
  → Worker boots selected DSH Host composition
  → Worker creates or resumes a DSH Agent through ctx.agentLoop
  → Agent Loop calls Worker-side browser-proxy LlmAdapter
  → same-origin backend /api/browser-native/llm
  → deterministic model returns a tool call
  → Agent Loop invokes a Worker Tool
  → Worker sends a typed browser-tool request to Main Thread
  → Main Thread executes the allowlisted browser Tool
  → typed tool result returns to Worker
  → Agent Loop appends tool/result and calls the LLM again
  → model returns final assistant text
  → Session events are readable from the backend after flush
  → a new Worker resumes the same Session
```

页面直接调用后端 LLM、后端运行 Agent Loop 再回调页面、或页面只展示预置 Session，都不满足上述完成定义。

### 1.3 第一版成功案例

第一版只需要一个确定性脚本模型和一个 `browser_echo` Tool：模型第一次调用返回 `browser_echo({"text":"hello"})`，页面返回经过 schema 校验的结果，模型第二次调用返回包含该结果的最终文本。

成功案例必须同时显示三个可独立观察的事实：页面收到了并执行了 browser Tool；后端保存了连续的 Session event seq；新 Worker 恢复后能读取同一 Session，而不是从页面内存复制 transcript。

### 1.4 明确不做的事情

本 PoC 不把现有 `web` profile 改造成 Browser-native 默认模式，不改变 Desktop、Headless、SDK、ACP 或普通 Web 的启动路径，不向浏览器发送 provider API key，不接受浏览器提交的任意 provider URL 或上游 headers，不把后端 generic `/api` tunnel 当作 LLM authorization boundary，不让模型生成任意代码执行，不实现远程 shell、Git、LSP、文件系统或 Native Bridge。

本 PoC 不声称浏览器关闭后 Agent 继续运行。Worker 终止后只验证已 flush 的 Session 可以恢复；后台执行、页面退出后的长任务和 durable job 属于后续云端执行面。

-----

## 二、当前代码事实

本节记录实施者必须知道的当前 checkout 事实，详细行为仍以链接的源码和 README 为准。

### 2.1 Agent Loop 已经是可复用的真实 loop

[`packages/core/agent-loop`](../../../packages/core/agent-loop/README.md) 的 `AgentLoop` 已负责创建或恢复 Session、构造 model-visible history、记录 request header、消费 `ctx.llm.stream()`、追加 assistant message、执行 Tool pipeline、追加 Tool result、处理 turn/step 生命周期、取消和中断恢复。

源码中的 `agentLoop.create(id, options, meta?)` 创建持久化 Session，`agentLoop.resume(ownerCtx, options)` 先通过 `ctx.sessionPersistence.open(id, 'write')` 取得单写者，再读取完整日志并为中断回合追加恢复事件；因此 PoC 不应另写 `BrowserAgentLoop`，也不应让页面自己拼装第二套消息历史。

### 2.2 SessionPersistence 已定义了 PoC 必须保留的语义

[`packages/session/session-persistence`](../../../packages/session/session-persistence/README.md) 的服务定义把 Session 建模为 append-only event log，并规定 `create`、`open`、`read`、`append`、`flush`、`close` 的职责。

`append()` 成功只表示事件已被后端接受并对当前后端实例可见；`flush()` 才是崩溃后仍应保留的 durability barrier；事件 seq 必须从 0 连续，已提交事件不能重写，未知且未标记 `ignorable` 的事件必须 fail closed。

`open(id, 'read')` 不抢写权；`open(id, 'write')` 必须原子取得单写者；并发 write open 应映射为 `SessionAlreadyOwnedError`；写权失效后旧 handle 不能隐式重新取得写权，而应关闭后重新打开。

[`packages/session/session-persistence-jsonl`](../../../packages/session/session-persistence-jsonl/README.md) 是当前 SessionPersistence 的真实实现参考，但它依赖 Node 文件系统和本地 lease，不能直接装进浏览器 Worker。PoC 需要实现一个远程 adapter 或 PoC backend，使其对 Agent Loop 暴露同一个抽象，不应把 JSONL 的物理文件上传协议当成正式远端协议。

### 2.3 LLM 服务允许在 Worker 内使用 provider-neutral adapter

[`packages/llm/llm`](../../../packages/llm/llm/README.md) 提供 `ctx.llm.stream(options)`、`ctx.llm.prepareCall()` 和 `LlmAdapter`；`GenerateOptions` 是 provider-neutral 请求，`StreamChunk` 是 provider-neutral 流式输出，且每个 adapter outcome 必须以一个 terminal `finish` chunk 结束。

`LlmAdapter` 的职责是 provider/model route、请求转换、stream chunk 转换、provider metadata、失败归一化、retry policy 和 attribution；因此 browser proxy 应注册一个明确的 `browser-proxy` adapter，让现有 Agent Loop 继续调用 `ctx.llm.stream()`。

[`packages/llm/llm-deepseek`](../../../packages/llm/llm-deepseek/README.md) 和其 Host 实现是受信 Node Host 直接访问 DeepSeek provider 的路径，不能作为浏览器 bundle 的默认依赖。浏览器 Worker 只应携带 proxy adapter，不应携带真实 API key adapter。

### 2.4 WebWorker runtime 已能运行 Host tree，但 preview 还没有 live model loop

[`packages/experimental/webworker-runtime`](../../../packages/experimental/webworker-runtime/README.md) 的 `createWorkerHost`/`startWorkerHost` 在 Dedicated Web Worker 中挂载 VFS image，安装 Node compatibility layer、module loader、process shim、Cordis Host tree 和 postMessage tunnel。

[`apps/web/src/preview.ts`](../../../apps/web/src/preview.ts) 当前通过 `chooseWorkerHostSource()` 和 `connectWorkerHost()` 启动 Worker；[`apps/web/tests/preview-boot.e2e.ts`](../../../apps/web/tests/preview-boot.e2e.ts) 验证的是 Worker boot、fixture workspace、Session discovery、历史展示和部分 Remote 写入。

现有 preview 中的 Tool call、subagent 和历史数据来自 fixture，不是测试过程中由实时模型新生成的调用。因此不能把 preview boot 当作 browser-native Agent Loop 已经存在的证据。

WebWorker runtime 的 VFS 是内存状态；它有 mutation observer 和 `flush()` seam，但当前没有可直接使用的 OPFS/IndexedDB durable backend，observer 失败也不能回滚已完成的内存 mutation。Session 远端持久化必须独立于 VFS sink 设计。

浏览器 shell 是受限解释器，不是 Bash、Node 子进程或原生文件系统。第一版不要让 Agent 依赖 shell、Git、LSP、package manager 或任意 native binary。

### 2.5 Connection 已提供 exact Fetch route 和浏览器 trust fence

[`packages/client/connection`](../../../packages/client/connection/README.md) 的 `HostConnectionFetch.register()` 接受 exact path、`GET`/`HEAD`/`POST` 方法和 `buffered`/`streaming` request body mode；Connection 负责浏览器 authentication、Host/Origin checks、请求取消和 shared `/api` transport。

PoC 的 LLM 和 Session route 应优先注册为独立 exact Fetch route，而不是增加 generic Remote endpoint。exact route 可以表达流式 response 和 request body backpressure；generic Remote 适合已有 Typert service，不应承载一组尚未稳定的 browser-agent business protocol。

Connection 的 trust fence 只回答“请求是否来自被接受的浏览器连接”，不自动回答“当前用户是否有权访问这个 Session”或“当前浏览器是否有权调用哪个模型”。PoC backend 仍需验证 Session id、Worker owner token、请求方向和 model allowlist。

### 2.6 Desktop 是宿主分层的参照

[`apps/desktop/README.md`](../../../apps/desktop/README.md) 和 [`apps/desktop/src/host-process.ts`](../../../apps/desktop/src/host-process.ts) 表明 Desktop 是 Electron shell 加共享 DSH Web application：Electron Node child 启动 Host，Web renderer 通过 authenticated local HTTP/WebSocket 连接 Host，IPC 只负责 shell-owned capability 和生命周期。

Browser-native 的对应关系是 Browser page 对应 renderer，Dedicated Worker 对应一个受限的 Host runtime，同源 backend 对应远端 Session/LLM service，`postMessage` 对应 IPC；但 Worker 没有 Node credentials、原生进程、安装权限或后台 daemon 生命周期。

-----

## 三、Desktop 参考与 Browser-native 差异

### 3.1 参考映射

| Desktop app | Browser-native PoC |
|---|---|
| Electron main process | Browser page/Main Thread 负责 UI 和 Worker 生命周期 |
| Electron Node Host | Dedicated Web Worker 中的 `createWorkerHost`/Host tree |
| packaged Web renderer | PoC 页面和页面端控制器 |
| Node IPC | `postMessage`、现有 Worker tunnel 和 PoC typed bridge |
| authenticated local Host HTTP | same-origin backend exact Fetch routes |
| local `$DSH_HOME` persistence | backend-owned Session store |
| trusted Host provider credentials | backend-only LLM provider credentials |
| native menu/file/process capability | 明确 allowlist 的 browser Tool |
| Desktop profile | opt-in browser-native PoC composition/image |

### 3.2 不可直接类比的部分

Desktop Host 是受信 Node 进程，可以访问本机文件、子进程、PTY、provider credential 和 native addon；Browser Worker 只能访问打包进 image 的 JavaScript、内存 VFS、浏览器 transport 和页面明确提供的能力。

Desktop 的 child process 可以被 shell lifecycle 管理；Browser Worker 可能被页面刷新、浏览器回收、系统节能或用户关闭 tab 直接终止，所以 PoC 只能把已 flush 的 Session 当作恢复基础，不能把 Worker 内存当作 durable state。

Desktop 的 local HTTP 是同一台机器上的受信部署；Browser-native 的同源 backend 仍然面对浏览器 cookie、Origin、CSRF、重放、并发 tab 和恶意页面脚本，必须有独立 route authorization。

-----

## 四、变更预算和目录布局

### 4.1 默认变更预算

第一阶段允许新增或修改的文件范围只有：

```text
docs/drafts/browser-native-dsh-poc/
```

在这个目录内可以放置规划、协议说明、PoC source、fixture、测试脚本、运行说明、故障记录和变更账本。目录外的代码、配置、package manifest、bundle patch、Vite entry、根 package script 和已有文档默认不改。

### 4.2 推荐目录布局

实施时优先按下面布局新增文件；实际文件可以在 Phase 0 根据代码验证删减，但不能把同一事实复制到多个 owner 文件：

```text
docs/drafts/browser-native-dsh-poc/
├── implementation-plan.md       # 本文，实施前和中途的唯一规划入口
├── README.md                    # PoC 完成后的运行和验收说明；实施前可暂缺
├── protocol.md                  # 版本化 HTTP、stream、ownership、bridge DTO
├── change-ledger.md             # 目录外每个必要改动的上游同步账本
├── fixtures/
│   ├── scripted-llm/            # 确定性模型脚本和错误场景
│   └── sessions/                # 最小合法 Session fixture，不复制生产日志
├── server/
│   ├── session-store.ts         # PoC backend 的 SessionPersistence 物理实现
│   ├── routes.ts                # exact Session 和 LLM routes
│   ├── scripted-model.ts        # server-side deterministic model
│   └── main.ts                  # 仅在根工具链允许时作为实验启动入口
├── worker/
│   ├── browser-proxy-adapter.ts # Worker-side LlmAdapter
│   ├── remote-session.ts        # Worker-side SessionPersistence adapter
│   ├── browser-tool-bridge.ts   # Worker-side typed Tool provider
│   └── bootstrap.ts              # Worker profile/agent bootstrap glue
├── client/
│   ├── index.html                # 最小页面，不嵌入普通 Web UI
│   ├── main.ts                   # 页面启动、输入、事件显示和 Worker owner
│   └── browser-tool-host.ts       # Main Thread allowlisted tool implementation
└── tests/
    ├── protocol.spec.ts          # DTO validation and negative cases
    ├── loop.integration.spec.ts  # mock model → tool → model → Session
    ├── recovery.integration.spec.ts
    └── browser-native.e2e.ts     # Playwright page/Worker/backend full path
```

### 4.3 是否新增 workspace package

第一轮不要新增 `packages/experimental/*` workspace package，因为仓库的 pnpm workspace 只自动收录 `packages/*/*`、`apps/*` 等目录，`docs/drafts` 不是 workspace package；把一个半成品包放进 `docs/drafts` 也会制造依赖、tsconfig、build 和发布语义。

如果实施中发现 Worker image packer 无法从草稿目录装载所需的 bootstrap 或 protocol，先尝试通过现有 `webworker-packer` 的参数化 API、测试 fixture 或动态 test entry 解决。只有这些方式都无法实现真实 Worker boot，才提出一个最小 `packages/experimental/browser-native-agent-poc` 包；该包必须只提供 PoC 所需的 Host/Worker/Client glue，不修改通用 Agent Loop、Session 或 LLM package。

若确实新增 workspace package，必须在 `change-ledger.md` 建立一条强制记录，并同步包含 package README、package.json、Host/Client face tsconfig、resolver manifest dependencies、测试、删除条件和上游重放顺序；不能只提交代码而不留下同步说明。

### 4.4 普通 Web profile 不得被隐式改变

PoC 应使用独立的页面入口、独立 image 或独立 opt-in overlay。不得修改 `apps/web/src/preview.ts` 使普通 preview 自动启动 Agent Loop，不得修改 `packages/bundle/web-app/cordis.patch.yml` 让所有 `dsh web` 实例自动注册 browser-native loop，不得复用生产 Web UI 的默认 route 名称造成冲突。

-----

## 五、目标拓扑和所有权

### 5.1 目标拓扑

```text
┌──────────────────────────────────────────────────────────┐
│ Browser                                                   │
│                                                          │
│  Main Thread                                              │
│  ├── PoC UI                                               │
│  ├── Worker owner/lifecycle                               │
│  ├── typed browser Tool registry                         │
│  └── displays Worker events and Session projection        │
│             ▲                         │                  │
│             │ typed postMessage        │ fetch/WebWorker   │
│             │                         ▼                  │
│  Dedicated Web Worker                                     │
│  ├── selected DSH Host composition                        │
│  ├── existing dsh-agent-loop                              │
│  ├── dsh-tools lifecycle                                   │
│  ├── remote SessionPersistence adapter                     │
│  ├── browser-proxy LlmAdapter                              │
│  └── browser Tool provider                                │
└──────────────────────────────┬───────────────────────────┘
                               │ same-origin HTTPS/HTTP in PoC
                               ▼
┌──────────────────────────────────────────────────────────┐
│ PoC backend                                                │
│  ├── Session create/open/read/append/flush/close           │
│  ├── single-writer owner lease and fencing                 │
│  ├── scripted LLM model                                    │
│  ├── real provider proxy only after scripted path passes   │
│  ├── Session authorization and model allowlist             │
│  └── request correlation and fault injection               │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Main Thread 的权威范围

Main Thread 负责页面 UI、Worker 创建和销毁、用户明确触发的低风险 browser Tool、Tool request 的 call id 去重、向页面展示 Worker 状态以及在 Worker 终止后重新连接；它不拥有 Agent Session 的 authoritative event log，不自行追加 assistant/tool/user event，不自己推进 Agent Loop。

Main Thread 可以保存短期 UI state 和当前 Worker connection state，但不能把“页面收到的 transcript”当作恢复输入。恢复必须由新的 Worker 通过 backend SessionPersistence 读取。

### 5.3 Worker 的权威范围

Worker 负责真正的 DSH Host composition、`ctx.agentLoop`、`ctx.tools`、`ctx.llm`、Session event append、Tool call/result lifecycle、取消和 flush。Worker 是 Agent Loop 的唯一主持者。

Worker 可以请求 Main Thread 执行 `browser_echo`，但不能要求 Main Thread 执行任意函数、任意 JavaScript、任意 DOM selector、任意 URL fetch 或未声明的权限。

### 5.4 Backend 的权威范围

Backend 负责 Session physical storage、write owner lease、append seq validation、flush durability、LLM provider credentials、model allowlist、请求授权、取消传播、fault injection 和服务器侧诊断。

Backend 不创建或主持 DSH Agent Loop，不接收页面发送的最终 transcript 作为权威历史，不从浏览器请求中信任 provider URL、Authorization、API key、Session owner 或 event seq。

### 5.5 唯一事实来源

在 PoC 中，Session backend 是 Session event 的唯一 durable source；Worker 内存中的 `Session` 是当前执行副本；Main Thread 的消息列表是 UI projection；LLM backend 的请求日志是 transport diagnostics，不替代 Session 中由 Agent Loop 记录的 `request/header` 和 model-visible event。

-----

## 六、PoC 内部协议

协议先写入 [`protocol.md`](protocol.md)，实现只引用该文件中的版本和字段。协议必须使用显式 DTO，不把 DSH 内部类实例、`GenerateOptions`、`StreamChunk` 或 `SessionHandle` 直接 JSON 化到公共网络。

### 6.1 通用请求字段

所有 mutation 和流式请求都带：

```text
protocolVersion
requestId
sessionId（Session route 必填；LLM route 必须与 authorized session 绑定）
ownerToken（仅需要写权的请求，使用短期 opaque token）
```

`requestId` 是幂等键；重试同一逻辑请求必须复用它；不同逻辑请求不能复用它。`ownerToken` 不能由浏览器自行生成后被 backend 当作 authority，必须由 backend 在 `open('write')` 成功时签发并绑定到 Session、worker instance、generation 和过期时间。

### 6.2 Session route

第一版建议使用以下 exact routes，路径最终以 `protocol.md` 为准：

```text
POST /api/browser-native/session/create
POST /api/browser-native/session/open
POST /api/browser-native/session/renew
POST /api/browser-native/session/read
POST /api/browser-native/session/append
POST /api/browser-native/session/flush
POST /api/browser-native/session/close
GET  /api/browser-native/session/stat?protocolVersion=1&sessionId=...
```

`create` 返回 `SessionHeader`、`inheritedEventCount`、`nextSeq`、owner token 和 backend revision；`open` 明确区分 `read` 与 `write`，写 open 成功才返回 owner token；`renew` 在当前 generation 和 lease 未过期时延长 write owner 的有效期；`read` 返回连续事件切片和 event ownership state；`append` 必须校验 batch 的第一个 seq 等于 backend `nextSeq`；`flush` 返回新的 durability receipt；`close` 释放 owner，但不能删除 Session。

为了减少协议面，第一版可以让 `open` 后的后续操作都发送到一个 `/session/operate` streaming/unary route，但必须在 DTO 中保留 operation discriminant、独立错误码和每个操作的幂等语义，不能用一个无类型的 `action` 加任意 JSON。

### 6.3 LLM route

第一版使用：

```text
POST /api/browser-native/llm
Content-Type: application/json
Accept: application/x-ndjson
```

请求 DTO 只允许 backend 已知的 provider-neutral 字段：`provider`、`model`、`messages`、`system`、`tools`、`toolHistory`、`reasoningEffort`、`maxTokens`、`temperature`、`stop`、`sessionId`、`requestId`、`ownerToken`、`generation`。`ownerToken` 和 `generation` 必须对应当前 write owner；否则 backend 返回 `SESSION_OWNERSHIP_LOST`，不调用模型。DTO 不允许 `baseURL`、`apiKey`、`authorization`、任意 headers、任意 cookie、`fetch` options 或 provider secret reference 的实际值。

Backend 不直接信任请求中的 provider/model；它先根据 server-side allowlist 和已授权 Session policy 解析有效 route，再调用真正 provider 或 deterministic scripted model。浏览器提交的 `provider` 和 `model` 只能是候选值，不能扩大 allowlist。

NDJSON stream 每一行必须是版本化的 `data`、`error` 或 `end` item；`end` 必须带 DSH 可转换的 terminal finish reason；错误发生在 response headers 发送后也必须发一个明确的 error item 或可识别的 stream termination，不能让 Worker 永久等待。

### 6.4 Worker/Main Thread Tool bridge

第一版只允许：

```text
Worker → { protocolVersion: 1, kind: 'browser-tool-call', callId, name: 'browser_echo', args }
Main   → { protocolVersion: 1, kind: 'browser-tool-result', callId, ok: true, result }
Main   → { protocolVersion: 1, kind: 'browser-tool-result', callId, ok: false, error }
```

Main Thread 必须按 `name` 查找静态 registry，使用与 Tool schema 相同的参数约束验证 `args`，拒绝未知 name、重复 call id、过大 payload、原型污染键和任意可执行字段。Worker 必须为每个 call id 设置超时和取消路径，并把成功或失败交回现有 Tool pipeline，让 `tool/call` 和 `tool/result` 仍由 Agent Loop 记录。

Tool bridge 的消息不是 Session event；它是 Agent Loop 与浏览器 capability 之间的 transport。只有 Agent Loop 接受并记录的 Tool lifecycle 才进入 Session log。

### 6.5 版本和错误码

Session log format version 继续复用 `@deepseek-ai/dsh-session` 的当前版本；Session transport protocol、LLM wire protocol 和 bridge protocol 各自独立编号，不把 HTTP DTO 版本写进 Session event type。

至少冻结这些错误码：`PROTOCOL_UNSUPPORTED`、`INVALID_REQUEST`、`SESSION_NOT_FOUND`、`SESSION_ALREADY_OWNED`、`SESSION_OWNERSHIP_LOST`、`SEQ_CONFLICT`、`DURABILITY_FAILED`、`MODEL_NOT_ALLOWED`、`UPSTREAM_LLM_FAILED`、`TOOL_NOT_ALLOWED`、`TOOL_TIMEOUT`、`CANCELED` 和 `INTERNAL`。

-----

## 七、Session 持久化方案

### 7.1 第一版物理存储选择

第一版 backend 使用 Node 侧的内存或临时目录 store 作为物理实现，但必须实现 `SessionPersistence` 的语义；默认优先复用 JSONL 的编码和校验 helper，而不是把事件数组直接 `JSON.stringify` 成一个最终 transcript。

如果实现者发现复用 `session-persistence-jsonl` 的内部模块会把 native `koffi`、Node filesystem 或 worker migration verifier 拉入浏览器 bundle，则只在 backend 侧复用其格式函数或直接写一个小型 PoC store；Worker 侧仍只依赖 backend-neutral `SessionPersistence` adapter。

第一版不引入 PostgreSQL、Redis、S3、OPFS 或 IndexedDB。目标是先证明 Agent Loop 和 Session contract，避免把数据库部署、浏览器本地存储和跨设备同步同时引入。

### 7.2 Remote adapter 的行为

Worker 侧 `RemoteSessionPersistence` 的公共行为必须与 `SessionPersistence` 相同：

```text
create(header) → remote create → owned handle
open(id, 'read') → read handle
open(id, 'write') → owned handle + owner token
renew(owner token, generation) → extended owner lease
handle.read() → remote read slice
handle.append(events) → idempotent append with requestId
handle.flush() → durability receipt
handle.close() → release/close owner
```

`renew` 是 remote adapter 与 backend 之间的 transport-private lease 操作，不是对现有 `SessionPersistence` 或 `SessionHandle` 公共接口新增的方法。Remote handle 内部保存 owner receipt，在 mutation 或定时任务前续租；续租失败后只把后续操作置为 ownership-lost，调用方必须关闭 handle 并重新 `open('write')`。除非现有接口无法表达这一生命周期，否则不得为了暴露 renew 而修改 `packages/session/session-persistence`。

Remote adapter 不能把每一次 `Session.append()` 都改成 fire-and-forget；append 的成功结果必须在当前 backend generation 内可读，flush 必须等待 backend 认可的 durability barrier。若请求超时，adapter 不能猜测 mutation 是否成功，而应使用相同 `requestId` 查询或重试，直到得到成功、明确拒绝或进入未知状态。

### 7.3 所有权和 fencing

Backend 记录至少以下 owner fields：`sessionId`、`ownerTokenHash`、`workerInstanceId`、`generation`、`expiresAt`、`lastRenewedAt`、`lastRequestId` 和 `lastSeq`。

每个写操作同时校验 owner token、generation、request id 和 expected next seq。旧 Worker 的请求即使网络延迟到达，也必须被 `SESSION_OWNERSHIP_LOST` 或 `SEQ_CONFLICT` 拒绝，不能因为旧 token 字符串仍存在就继续写入。

PoC 第一版只允许一个 active writer per Session，但允许任意数量的 read handle。Worker 必须在 lease 到期前 renew；backend 重启或网络中断导致 renew 失败时，handle 立即停止新的 mutation，直到重新取得 write owner。多 tab 共享同一 Session 的写入、workspace writer、semantic merge 和跨 Session handoff 不属于本阶段。

### 7.4 append、flush 和恢复

事件提交状态至少分为：

```text
accepted-in-memory
visible-to-current-backend
durable
reopenable
```

`append` 至少达到 `visible-to-current-backend`；`flush` 达到 `durable` 并返回 receipt；只有 backend 重启后仍能被新的 `open/read` 观察到才算 `reopenable`。PoC 的临时目录 backend 可以把 `flush` 定义为 `fsync`/原子替换完成；内存 backend 只能用于 contract test，不能作为 crash recovery 的通过证据。

Worker 终止后，新的 Worker 必须先 `open('write')`，再 `read(0, ...)`，由现有 `agentLoop.resume()` 负责中断回合修复。页面不应在 Worker 终止时自行补 `tool/result` 或伪造 assistant message。

### 7.5 Session 与 UI 的恢复边界

UI 可以从 Session projection 重新渲染 assistant text、tool result 和错误；UI 不应恢复一个未被 Agent Loop 接受的 browser-tool call。若 backend 中有 `tool/call` 而没有 `tool/result`，应沿用现有 Session recovery 语义，把结果视为未完成/未知，由 Agent Loop 的恢复逻辑决定是否向模型说明，而不是由 Main Thread 自动重放副作用。

-----

## 八、LLM 代理方案

### 8.1 先实现 scripted model，再接真实 provider

第一阶段的 backend model 是确定性脚本：根据调用次数和请求中是否出现 `browser_echo` 的 Tool result 返回固定的 `StreamChunk` 等价 wire item。它不需要 API key、网络或真实 provider，能够稳定制造一次 tool call 和一次 final text。

脚本模型必须检查 request 的 `sessionId`、messages、tool schema 和 request id，并把收到的 request 记录到诊断文件或内存列表；测试需要确认第二次请求包含第一轮 Tool result，而不是页面自行把结果拼入请求。

只有 scripted path 通过后，才增加 server-side DeepSeek adapter。真实 provider 路径仍由 backend 选择凭据和 base URL；Worker proxy adapter 的代码不因 provider 切换而改变。

### 8.2 Worker-side `browser-proxy` adapter

`BrowserProxyAdapter extends LlmAdapter` 只负责四件事：把 `GenerateOptions` 转成 LLM request DTO；使用 Worker 的 `fetch`/same-origin transport 发送请求；解析 NDJSON stream；把 wire items 转回 `StreamChunk`。

它不负责 Session append、Tool execution、重试决策或 UI rendering；这些职责仍属于 Agent Loop、LLM runtime、Tool runtime 和页面 projection。

adapter 必须保持 `ctx.llm.prepareCall()` 对 route capability 的要求。如果 scripted backend 使用固定 `reasoningEffort`、`maxTokens` 或 tool update capability，应通过 adapter 的 `resolveModel()` 返回明确 metadata；不应在 `stream()` 内偷偷 `?? default`。

### 8.3 LLM request 的日志和隐私

Agent Loop 已经把 model-visible request header 和相关事件写入 Session；backend 的 HTTP diagnostic 只记录 `requestId`、Session id 的脱敏标识、provider route、model、timing、status 和 byte counts，默认不复制完整 prompt、tool args 或 provider secret。

真实 provider 调试若必须记录 payload，应通过显式测试开关、临时目录和 redaction，并在测试结束清理；不能把真实 prompt 或 API key fixture 写入 `docs/drafts`。

### 8.4 取消和终端状态

Worker 的 `AbortSignal` 必须取消 fetch request；backend route 必须把 request signal 传递给 scripted/provider adapter；provider stream 取消后，Worker 仍需看到一个可归一化的 `aborted`/`error` finish 或明确错误。

测试必须区分“客户端 abort 已发出”和“上游 provider 已停止”；PoC 可以在 backend 不能确认上游停止时记录诊断，但不能宣称副作用或 token 消耗已经回滚。

-----

## 九、Worker、Main Thread 和 Tool 桥

### 9.1 Worker boot 复用现有 runtime

Worker 启动优先复用 `@deepseek-ai/dsh-experimental-webworker-runtime/worker`、`connectWorkerHost`、现有 VFS image 和 tunnel；不要复制 `createWorkerHost`、Node builtin proxy 或 module loader。

PoC 的 Worker bootstrap 需要在 Host tree ready 后取得 `ctx.agentLoop`、`ctx.sessionPersistence`、`ctx.llm` 和 `ctx.tools`，注册 remote Session provider、browser proxy adapter 和 `browser_echo` Tool，然后由页面通过一个明确的 Worker command 请求创建/恢复 Agent。

如果现有 image 的 profile rows 没有暴露一个安全的 bootstrap extension point，优先新增一个 PoC-only plugin row 或 test composition；不要直接在 `packages/core/agent-loop/src/index.ts` 增加 browser-specific 分支。

### 9.2 Main Thread 的 browser Tool registry

Main Thread 只注册固定的 `browser_echo`：输入是一个受限 UTF-8 文本，输出是固定结构 `{ text, length }`，执行不会访问 DOM、网络、剪贴板、文件选择器或用户权限。

为后续扩展保留 typed registry，但第一版 registry 的未知 name 必须拒绝。不要先实现“任意 page function tool”，因为它会把 PoC 变成任意 JavaScript 执行桥，无法证明授权边界。

### 9.3 Bridge lifecycle

每个 Tool call 具有 `callId`、创建时间、状态和 AbortController；Main Thread 返回结果后禁止重复 settle；Worker 终止时页面清理未完成 call；页面刷新后不自动重放未完成 call。

Worker 侧收到 bridge result 后再让 Tool pipeline settle，Agent Loop 才能追加 `tool/result` 并推进下一次模型调用。页面 UI 只能显示 raw bridge state 和 Session-derived result，不能先显示一个未提交的成功 Tool result 作为事实。

### 9.4 Worker 终止和重新启动

页面明确提供 `stop worker` 测试按钮或测试 hook；停止前可选择调用 Worker 的 `flush` command，但还必须测试中途终止。中途终止后页面创建新 Worker，使用同一 Session id 执行 resume；旧 Worker 的 late response 必须被 backend owner fence 拒绝或被页面 connection generation 丢弃。

-----

## 十、Worker 内 DSH 组合方式

### 10.1 选择 profile 的原则

PoC 需要一个“足够小但真实”的 Host composition，而不是整套生产 Web profile。它至少要有：Cordis loader、`dsh-llm`、`dsh-session`、`dsh-session-persistence` seam、`dsh-agent`、`dsh-agent-loop`、`dsh-tools`、`dsh-system-prompt`、Session projection 和 Worker connection/tunnel 所需的 webserver rows。

它不应默认加载 `dsh-llm-deepseek-api-key`、`dsh-llm-pi-ai`、local credentials、local filesystem、local subprocess、bash sandbox、plugin manager 或所有生产 UI bundles，除非 packer 验证这些依赖不会进入 Worker 或不会被执行。

### 10.2 复用现有 bundle 还是独立 PoC image

先检查现有 `webworker-packer` 的 `PackOptions`、`composeProfile()` 和 image reachability 是否允许从 docs/drafts 提供一个最小 composition。优先用其 library API 生成 PoC image，因为该 API 已能接受 config、workspace package index、resolve root、config trees 和 entry seeds。

如果必须修改 packer 才能支持草稿目录中的 composition，优先在 PoC 目录写一个 Node script 直接调用现有 library，并把 config 字符串、package index 和 entry seeds 作为显式输入；不要修改 `repository.ts` 的默认 `web` profile 逻辑。

如果必须增加 Worker image 的静态 entry seed，记录在 `change-ledger.md`，并说明它是打包输入，不是 Agent Loop 行为改变。任何修改都要有一个失败测试证明缺少该 seed 会导致 image 不完整。

### 10.3 正常 Web 行为的隔离

PoC image、PoC page 和 PoC backend 使用独立 URL prefix，例如 `/browser-native-poc/`；不覆盖 `/api/remote.mux`、`/plugins` 或普通 Web page 的默认 route。

PoC 只有在明确选择其页面或命令时才启动，不加入 shipped `web` profile 的自动 agent declaration。实施者必须能同时运行普通 `pnpm dsh web` 和 PoC 而不会改变普通 Web 的 startup snapshot。

### 10.4 可能的最小核心缺口

目前源码没有证据表明 `webworker-runtime` 已经提供“由 Worker 在 Host tree 中启动一个 live Agent Loop 并在页面侧显示其事件”的现成入口；这不是应当默认修改 core 的理由，而是需要先用 PoC-only bootstrap 验证的缺口。

只有以下情况才允许修改现有核心包：

1. 不修改时无法从已公开的 Service Definition/Provider/Consumer extension point 启动或关闭 Agent。
2. 一个小而稳定的通用扩展点可以解决问题，而不是加入 browser-specific `if` 分支。
3. 已有 package tests 能先锁定新扩展点的通用语义。
4. 该修改不改变普通 Node/Web/Desktop 行为，或所有消费者已同步更新。
5. `change-ledger.md` 已写明上游重放和删除条件。

-----

## 十一、分阶段实施顺序

### Phase 0：冻结协议和验证工具

实施内容：新增 `protocol.md`、DTO parser、错误码表、scripted model fixture、bridge fixture 和本目录变更账本；不启动真实 Worker，不接 provider。

必须验证：无效 protocol version、缺少 requestId、非连续 seq、未知 operation、过大 payload、未知 Tool name、重复 call id、缺少 terminal LLM item 都会明确拒绝。

退出条件：协议字段、错误码、幂等规则、Session format version 归属和目录外改动规则都能被第一次阅读文档的开发者直接理解；不存在未命名的“暂时透传 JSON”。

### Phase 1：SessionPersistence backend contract

实施内容：在本目录实现临时 backend 和 Worker remote adapter；先在 Node/Vitest 中直接执行 `create/open/read/append/flush/close`，再接 Worker transport。

必须验证：create 后可 read；append 后当前 backend 可见；flush 后重启 backend 可 reopen；第二个 writer 被拒绝；旧 owner token 被拒绝；相同 requestId 重试不产生重复 event；seq conflict 不会部分写入；未知 event fail closed；取消不会留下半个 batch。

禁止宣称：此阶段不能称为“云端 durable Session”，只能称为“PoC backend-preserving SessionPersistence semantics”，直到 crash/reopen 测试通过。

退出条件：同一组 backend contract tests 可以替换内存 store 和临时目录 store，且前者不被误认为 crash durability 证据。

### Phase 2：Worker boot 和 scripted LLM adapter

实施内容：使用现有 Worker runtime image 和独立 PoC bootstrap，在 Worker 中装载 `ctx.agentLoop`、remote Session adapter 和 browser proxy adapter；scripted model 通过同源 route 返回一次文本或固定 finish。

必须验证：Worker 能创建 Session；Agent Loop 产生 request header 和 assistant message；LLM adapter 发送 strict DTO；stream 有 terminal finish；abort 能结束 fetch；Session event 通过 remote adapter append/flush，而不是只留在 Worker 内存。

禁止宣称：此阶段还不能宣称 browser Tool 闭环，也不能宣称真实 provider 已接入。

退出条件：无 Tool 的 Worker Agent Loop 在 Playwright 或等价 Worker harness 中跑完一轮，并能从 backend 读到完整 Session event seq。

### Phase 3：Main Thread browser Tool bridge

实施内容：加入 `browser_echo` Tool schema、Worker provider、Main Thread allowlist registry 和 typed bridge；scripted model 第一次返回 tool call，第二次根据 Session 中的 tool result 返回 final text。

必须验证：页面收到 call；参数验证生效；结果只经过一次 settle；Agent Loop 记录 `tool/call` 与 `tool/result`；第二个 LLM request 的 messages 来自 Session/loop reconstruction；页面显示的是 Session projection 的 final result。

禁止宣称：此阶段不支持任意 DOM automation、网络访问、文件访问、Native Bridge 或用户确认 UI。

退出条件：在没有页面手工拼接消息的情况下，自动化测试观察到完整的 `LLM → Tool → LLM` 闭环。

### Phase 4：Worker crash/restart 和 owner fencing

实施内容：在不同时间点终止 Worker，包括 append 前、append response 后 flush 前、Tool bridge pending、LLM stream 中和 final result 后；随后启动新 Worker resume 同一 Session。

必须验证：已 flush prefix 可恢复；有效 owner 可以在 lease 到期前 renew；renew 失败或 lease 过期后 handle 停止 mutation；未确认 append 使用 requestId 查询或返回明确未知状态；旧 Worker late append 被拒绝；两个 Worker 不能同时 write；中断回合由现有 Agent Loop recovery 处理；页面不伪造未持久化 Tool result。

退出条件：故障矩阵中的每个点都有明确的“保留、拒绝、未知或可重试”结果，且没有测试依赖 sleep 猜测时序。

### Phase 5：真实 provider proxy，可选

实施内容：只在 Phase 0–4 通过后加入 backend-side DeepSeek adapter；provider key、base URL、retry 和 attribution 均留在 backend；Worker 仍使用相同 `browser-proxy` adapter。

必须验证：真实 provider request 不含浏览器 secret；provider errors 转成稳定 `LlmFailure`；stream finish、abort、timeout、rate limit 和 request id diagnostics 正常；keyless test 仍由 scripted model 覆盖。

退出条件：真实 provider 只增加一个 backend adapter，不改变 Worker Agent Loop、Session protocol 或 browser Tool protocol。

-----

## 十二、测试和故障注入矩阵

### 12.1 单元和协议测试

测试 DTO parser 的合法和非法输入；测试错误码映射；测试 Session event seq 校验；测试 owner token/generation 校验；测试 NDJSON decoder 的分片、空行、终端 item、错误 item 和截断流；测试 bridge call id、参数边界、未知 Tool 和重复结果。

协议测试不需要启动完整 DSH Host，但必须使用生产导出的 `SessionEvent`/`SessionHeader` 类型或其 owner validator，不能自己复制一套宽松的 event schema。

### 12.2 Agent Loop integration

直接复用 `packages/core/agent-loop/tests/mock-adapter.ts` 中的 scripted response 思路，但把 mock adapter 的输出通过 PoC backend route 和 Worker proxy adapter 传输；不要把测试直接注册成 Worker 内的 `MockAdapter` 后声称验证了远程代理。

至少覆盖：纯文本一步结束；tool call 后下一次 LLM；模型 stream error；模型 abort；Tool error；Tool timeout；Session append failure；flush failure；Agent disposal；resume 后继续。

### 12.3 Browser E2E

E2E 使用 Playwright 启动 PoC backend 和 PoC page，验证页面真的创建 Dedicated Worker、Worker 真的发出同源 LLM 请求、Main Thread 真的执行 bridge Tool、backend 真的收到 Session append/flush，且页面显示来自 Session projection 的结果。

E2E 不能只 intercept page fetch 并在浏览器测试里 mock Worker response；至少要保留一个真实 Worker 和真实 backend route。scripted model 可以是 deterministic，不代表 transport 可以 mock 掉。

### 12.4 Recovery 和 ownership

| 场景 | 期望结果 |
|---|---|
| 第二个 Worker `open('write')` | `SESSION_ALREADY_OWNED` |
| 有效 owner 在 lease 到期前 renew | 返回延长后的 owner receipt，generation 不变 |
| lease 到期后旧 Worker renew 或 append | `SESSION_OWNERSHIP_LOST` |
| lease 到期后新 Worker `open('write')` | 取得递增 generation |
| 旧 Worker 使用过期 owner 发起 LLM 请求 | `SESSION_OWNERSHIP_LOST`，不调用模型 |
| 旧 Worker 用旧 generation append | `SESSION_OWNERSHIP_LOST` |
| 相同 requestId 重试 append | 返回第一次结果，不重复写 |
| 不同 requestId 使用旧 nextSeq | `SEQ_CONFLICT`，batch 不可见 |
| append response 丢失但 backend 已提交 | 查询同 requestId 得到原结果 |
| append 未提交后断开 | batch 不可见或明确 unknown，不返回假成功 |
| flush 失败 | Session 不能标记 durable，页面显示可恢复错误 |
| Worker 在 tool call 等待时终止 | 不自动重放 browser Tool |
| Worker 在 LLM stream 中终止 | 新 Worker 按现有 loop recovery 处理中断 |
| backend 重启后 reopen | 只出现最后一个 durable prefix |
| unknown required Session event | fail closed |

### 12.5 安全测试

测试缺失/错误 `Origin`、错误 Host、跨站 form POST、`text/plain` 请求、伪造 owner token、伪造 Session id、过期 owner 发起 LLM 请求、任意 provider URL、Authorization 注入、过大 NDJSON 行、prototype pollution key、未知 Tool name、重复 call id、旧 worker late message 和错误的 Content-Type。

测试日志不能出现 API key、完整 Authorization、Cookie、未脱敏 prompt、Tool secret 或完整 provider response；失败时只保留 request id 和稳定错误码。

### 12.6 文档和仓库检查

每次实现迭代至少运行与本目录直接相关的 focused test、`pnpm run test:docs`、`pnpm run doc-sync` 和 `git diff --check`。如果新增了 workspace package 或改变了公共 package surface，再按仓库规则运行对应 typecheck、build、hygiene、persistence review、snapshot 和 pre-push checks。

本规划阶段只应运行文档检查，不应为了“预先证明”而声称 PoC 测试已通过。

-----

## 十三、安全和生命周期限制

### 13.1 Same-origin 不是完整授权

`/api/browser-native/*` 必须经过现有 Connection trust/auth checks，并在 route 内额外校验 Session authorization、owner token、model allowlist 和 request body schema。Origin 校验防止一部分跨站请求，不替代用户身份、Session ACL 或 provider policy。

### 13.2 Provider secret 永远留在 backend

Worker image、Worker static module、postMessage frame、页面 source、VFS overlay、Session event 和 browser console 都不能包含真实 provider key、refresh token 或任意 upstream Authorization。backend 只根据 server-side configuration 选择 credential。

### 13.3 Session event 与 browser bridge event 分离

页面发出的 bridge message 不等于 Session event；只有 Agent Loop 追加并 flush 的 `tool/call`、`tool/result`、assistant message 和 request header 才构成可恢复的 Session history。页面不可以自行提交一份“看起来完整”的 transcript 覆盖 backend log。

### 13.4 未确认的外部副作用不可自动重试

第一版 browser Tool 没有外部副作用，因此可以用 deterministic echo 完成验证。以后任何涉及网络写入、文件选择、剪贴板、支付、发送消息或业务 mutation 的 Tool 都必须定义幂等键、用户确认、未知结果和恢复策略；不能因为 fetch 可以重试就把 Tool 当作安全可重放。

### 13.5 页面和 Worker 生命周期

Worker 是 session execution cache，不是 daemon。页面关闭、刷新、浏览器回收、网络中断和 backend restart 都可能终止当前 execution。只有 backend durability receipt 能作为恢复点；Worker memory、Main Thread state、WebWorker VFS 和当前 stream 都不是恢复点。

-----

## 十四、核心代码改动门槛和变更账本

### 14.1 目录外改动的审批问题

在修改 `docs/drafts` 之外的任何文件前，实施者必须先在 [`change-ledger.md`](change-ledger.md) 增加一条记录并回答：当前现有接口为什么不能表达；为什么 PoC-only glue 不能解决；为什么这是通用能力而不是 browser-specific shortcut；改动是否会影响普通 Web、Desktop、Headless、SDK、ACP 或 Session format；怎样测试旧行为仍然不变；什么时候可以删除或上游化。

如果问题可以通过本目录中的 adapter、fixture、test composition、pack script、exact route 或 Worker bootstrap 解决，就不得修改核心包。

### 14.2 变更账本格式

每条目录外变更使用以下格式：

```text
changeId:
upstreamBaseline: 当前 checkout 的公开版本/文件路径，不记录不可验证的临时分支叙述
file:
reason:
existingExtensionPointsChecked:
whyDraftOnlyWasInsufficient:
behaviorChange:
consumersUpdated:
tests:
syncReplaySteps:
deleteCondition:
status: proposed | implemented | replayed | removable
```

`syncReplaySteps` 必须描述未来从 upstream tag 或 main 更新时怎样重新应用改动、怎样解决冲突、怎样确认新版本是否已经内置等价能力。`deleteCondition` 必须是可观察条件，例如“upstream `webworker-runtime` 提供了公开的 bootstrap hook，并且 PoC test 改用该 hook 后所有 E2E 仍通过”，不能写成“以后整理”。

### 14.3 允许的核心改动类型

优先级从低到高如下：

1. 新增测试 fixture 或独立 PoC script。
2. 通过现有 package public exports 和 Cordis registration 完成 PoC glue。
3. 新增独立 experimental package，不修改稳定 package 的运行时行为。
4. 为现有服务增加通用且与 browser 无关的 extension point。
5. 修改核心 loop、Session format、Connection trust、bundle 默认组合或 Desktop 行为。

第 4 项需要额外的 focused tests 和 README/JSDoc；第 5 项默认禁止，除非所有更低等级方案都已被测试证明不可行，并得到用户明确确认后再实施。

-----

## 十五、实施者的执行清单

### 15.1 开始实现前

- [ ] 阅读本文件、本目录 `protocol.md` 和 `change-ledger.md`。
- [ ] 阅读 [Agent Loop README](../../../packages/core/agent-loop/README.md)、[SessionPersistence README](../../../packages/session/session-persistence/README.md)、[LLM README](../../../packages/llm/llm/README.md)、[WebWorker runtime README](../../../packages/experimental/webworker-runtime/README.md) 和 [Connection README](../../../packages/client/connection/README.md)。
- [ ] 确认工作区中已有未提交变更，不覆盖或回滚它们。
- [ ] 确认普通 `web` profile 和 Desktop profile 不会被 PoC 默认路径改变。
- [ ] 确认 PoC 所需的所有文件仍在本目录，或已先写变更账本。

### 15.2 Phase 0–1

- [ ] 先写协议和错误码，再写 DTO parser。
- [ ] 用生产 Session 类型和 validator，不复制宽松 schema。
- [ ] 先通过 backend contract tests，再连接 Worker。
- [ ] 给每个 mutation 分配 request id，并测试 timeout/retry。
- [ ] 明确 `append`、`flush`、reopenable 和 unknown outcome 的区别。

### 15.3 Phase 2–3

- [ ] Worker 复用现有 `createWorkerHost`/`connectWorkerHost`，不复制 runtime。
- [ ] Worker 使用现有 `ctx.agentLoop`，不新增 BrowserAgentLoop。
- [ ] LLM route 不接受任意 URL、key、headers 或 secret。
- [ ] 先用 scripted model，确认第二次 request 由 loop 重建。
- [ ] Main Thread 只暴露静态 `browser_echo`，不开放 arbitrary code。
- [ ] Tool result 只经 Agent Loop 进入 Session。

### 15.4 Phase 4–5

- [ ] 注入 crash/timeout/late response，而不是用固定 sleep 假设顺序。
- [ ] 验证 owner renewal、lease expiry、owner fencing、single writer 和 idempotent append。
- [ ] 验证 Worker restart 后 Session resume。
- [ ] 只有 scripted model 通过后才接真实 provider。
- [ ] 真实 provider credentials 仅存在 backend。
- [ ] 记录任何目录外改动并补齐 `change-ledger.md`。

### 15.5 每次提交前

- [ ] `git diff --check`。
- [ ] `pnpm run test:docs`。
- [ ] `pnpm run doc-sync`。
- [ ] 运行本次改动对应的 focused tests。
- [ ] 如果改动触及 package/source，按 `.agents/skills/dsh-pre-push-checks/SKILL.md` 选择检查，不把未运行的检查写成已通过。
- [ ] 检查 `git status --short`，确认没有生成文件、缓存、真实凭据或未登记的目录外改动。

-----

## 十六、验收标准和不应宣称的能力

### 16.1 PoC Definition of Done

PoC 完成必须满足：

1. 有一个可以由开发者按 README 启动的 backend、page 和 Worker 组合。
2. Worker 使用现有 DSH Agent Loop，而不是复制 loop。
3. scripted model 通过同源 route 返回一次 Tool call 和一次 final response。
4. Main Thread 执行 allowlisted `browser_echo`，Tool result 经过 Agent Loop 写入 Session。
5. backend 能读到连续且合法的 Session events，`flush` 后重启可恢复。
6. 第二个 writer 被拒绝；有效 owner 可以续租；lease 过期后的旧 worker mutation 被 fencing 拒绝；重复 request id 不造成重复 append。
7. Worker 终止后，新 Worker 能 resume 已 flush Session，并让现有 recovery 处理未完成回合。
8. 普通 `web`、Desktop 和其他 profile 的默认行为没有被 PoC 隐式改变。
9. 所有目录外改动都有变更账本和 focused regression tests；没有未登记的核心修改。
10. 文档、协议、运行说明和测试结果与当前 checkout 一致，不能把计划写成已实现事实。

### 16.2 明确不能宣称的能力

在上述 DoD 之外，不能宣称：生产级多租户隔离、真实云端 durable job、页面关闭后的 Agent 继续执行、跨 tab 多 writer 协作、完整 POSIX filesystem、远程 Git/Shell/LSP、任意 browser automation、provider key 在浏览器安全、Session 与业务数据库原子提交、任意 Tool 的安全重试、完整 Desktop capability parity 或已经成为正式 DSH profile。

### 16.3 下一阶段建议

只有 PoC DoD 通过后，才评估是否把 Session backend 换成 PostgreSQL/对象存储、是否增加真实 provider route、是否新增正式 experimental package、是否提供 Cloud Workspace、是否支持跨 tab attach 或是否需要通用 Host bootstrap extension point。

后续每一个扩展都应先更新本目录的协议、故障矩阵和变更账本，再写代码；不要从一个通过的 `browser_echo` demo 直接推导出生产级 Agent 平台结论。

-----

## 十七、参考资料

以下链接是本规划所依赖的近距离代码和研究文档；本文件只保留实施所需的结论，不复制它们的完整内容。

- [DSH Browser-native Agent Loop 调研](../dsh-browser-native-agent-loop-research.md)——Browser-native 的定义、适用场景和 Agent Loop 驻留边界。
- [DSH Browser-native Agent 实施方案](../dsh-browser-native-agent-implementation-plan.md)——更广义的 capability、UI bridge、LLM route 和安全设计参考；本 PoC 取其中最小闭环。
- [DSH 浏览器原生运行时调研](../dsh-browser-native-runtime-research.md)——Worker runtime、VFS、preview fixture 和当前缺口的事实归纳。
- [DSH 云端 SaaS Agent 研究](../dsh-cloud-saas-agent-research.md)——Session ownership、Worker lifecycle、外部执行和 durability 的平台侧边界。
- [DSH Remote Durable Workspace 研究](../dsh-remote-durable-workspace-pgfs-research.md)——云端 workspace 的后续方向；本 PoC 不实现其中的 PGFS。
- [Desktop app README](../../../apps/desktop/README.md)——Desktop profile、Host process、IPC 和本机能力的参考实现。
- [WebWorker runtime README](../../../packages/experimental/webworker-runtime/README.md)——Worker image、tunnel、VFS 和浏览器限制。
- [WebWorker packer README](../../../packages/experimental/webworker-packer/README.md)——profile composition、image reachability 和 preview packing。
- [Agent Loop README](../../../packages/core/agent-loop/README.md)——创建、恢复、Tool lifecycle 和取消。
- [SessionPersistence README](../../../packages/session/session-persistence/README.md)——append、flush、single writer 和 fail-closed storage semantics。
- [LLM README](../../../packages/llm/llm/README.md)——`LlmAdapter`、`GenerateOptions` 和 `StreamChunk`。
- [Connection README](../../../packages/client/connection/README.md)——exact Fetch routes、browser trust 和 request cancellation。
- [Web preview bootstrap](../../../apps/web/src/preview.ts)——当前 Worker preview 的实际入口。
- [Preview E2E](../../../apps/web/tests/preview-boot.e2e.ts)——当前 preview 覆盖范围和 fixture 证据边界。

## Dev Note

本文在 2026 年 10 月 2 日基于当前 checkout 的源码、README 和测试入口编写。本文只记录规划，不记录“已经完成”的实现状态；实现开始后，必须把事实变化写回本目录的 README、协议、故障矩阵和变更账本，并删除过期的计划性措辞。
