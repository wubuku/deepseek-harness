---
description: "Browser-native DSH PoC v2 的自包含实施规格：复用现有 DSH Web UI 和 Cordis Host，把真实 Agent Loop 放入 Dedicated Worker，并通过同源后端提供正式 SessionPersistence 与 LLM 代理。"
---

# Browser-native DSH PoC v2 实施规划与当前状态

## Summary

本文是 `docs/drafts/browser-native-dsh-poc/` 的实施规格和当前实现参照，不是独立 Demo 的设计，也不是对普通 Web、Desktop 或 Headless profile 的重构提案。当前 checkout 已完成这份规格中的 v2 PoC：页面继续使用 `AppWebEntry` 和现有 Client 插件，Dedicated Worker 继续通过 `appBoot.boot()` 启动真实 DSH Host，`ctx.agentLoop` 在 Worker 中运行，Session 事件通过同源后端的正式 `SessionPersistence` provider 持久化，LLM 请求通过同源 backend proxy 转发到 scripted 或真实 provider。历史计划段落保留实施决策和约束；已验证事实以本文件、[README.md](README.md) 和 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md) 的当前状态为准。

旧版本 PoC 已在本目录的 checkpoint 中验证了同源 LLM proxy、JSON Session store 和浏览器 Worker 通信，但它使用独立 HTML、PoC-local agent loop 和自定义事件 DTO。那份实现不能作为本目标的完成结果，因为它没有运行 DSH 的 Cordis 插件组合，也没有让现有 Web UI 消费正式 Session、Agent 和 Remote API。旧实现保留在 checkpoint 中作为协议实验记录；v2 重新使用 DSH 的真实运行时。

本规格的第一原则是：**不复制 DSH UI，不重新实现 Agent Loop，不绕过 `ctx.sessionPersistence` 或 `ctx.llm`。** 只在无法通过现有扩展点表达时，才修改 DSH 核心；所有目录外改动都必须写入 [change-ledger.md](change-ledger.md)，并记录删除条件和上游同步方法。

## Table of Contents

- [一、问题和完成定义](#一问题和完成定义)
- [二、已核实的基线](#二已核实的基线)
- [三、目标拓扑](#三目标拓扑)
- [四、接入决策](#四接入决策)
- [五、Worker profile 和插件装载](#五worker-profile-和插件装载)
- [六、两个 DSH 插件](#六两个-dsh-插件)
- [七、Session backend 协议](#七session-backend-协议)
- [八、LLM proxy 协议](#八llm-proxy-协议)
- [九、页面、Worker 和 execution world](#九页面worker-和-execution-world)
- [十、失败恢复和安全约束](#十失败恢复和安全约束)
- [十一、实施顺序](#十一实施顺序)
- [十二、测试矩阵和退出条件](#十二测试矩阵和退出条件)
- [十三、预期文件和变更账本](#十三预期文件和变更账本)
- [十四、明确不宣称的能力](#十四明确不宣称的能力)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 一、问题和完成定义

### 1.1 要验证的问题

PoC 必须回答下面五个问题，而且每个问题都要由代码和浏览器测试观察，而不是由架构图推断：

1. 现有 DSH Web UI 能否在不替换页面组件的情况下连接到一个由 Dedicated Worker 承载的完整 DSH Host。
2. 真实 DSH `agent-loop` 能否在该 Worker 中创建 Agent、接收 UI prompt、调用 `ctx.llm`、写入正式 Session 事件并把结果投影回现有 UI。
3. Worker 中的 LLM adapter 能否只调用同源 `/api/browser-native/llm`，由后端持有 provider API key，并把后端的流式结果转换成 DSH `StreamChunk`。
4. Worker 中的 SessionPersistence provider 能否实现 DSH 正式的 `create`、`open`、`read`、`append`、`flush`、`close`、`stat` 和 `list` 语义，并在后端重启或 Worker 重启后重新打开同一个 Session。
5. 普通 DSH Web、Desktop 和 Headless profile 是否保持不变，且 PoC 的所有产品代码变化都有可追溯的上游同步路径。

### 1.2 完成定义

只有以下链路全部通过，才能称为“browser-native DSH PoC”：

```text
Browser page
  ├── existing AppWebEntry / existing DSH Web UI
  └── Dedicated Worker
        ├── appBoot.boot('dsh-webworker', ...)
        ├── real Cordis Host composition
        ├── real dsh-agent-loop / ctx.agentLoop
        ├── RemoteSessionPersistence plugin
        └── RemoteLlmAdapter plugin
              │ same-origin fetch
              ▼
        PoC backend
          ├── formal DSH Session event store
          └── provider API proxy
```

浏览器验收必须观察到：用户从现有 UI 创建或恢复 Session，发送 prompt 后出现真实 DSH assistant output；backend 收到 LLM 请求但浏览器网络和页面日志不包含 provider secret；backend 的 Session 文件包含 DSH 正式事件类型和连续 `seq`；终止 Worker 后重新启动可以恢复已 flush 的 Session 前缀；第二个写者被正式的 ownership refusal 拒绝。

### 1.3 明确不在本 PoC 中解决的问题

本 PoC 不实现 Cloud Workspace、完整 POSIX filesystem、远端 Shell、远端 Git、跨标签页多写者、任意插件安装、任意 JavaScript 执行、生产级租户认证、对象存储、跨区域灾备或把普通 `pnpm dsh web` 默认行为改成 browser-native。它只证明现有 DSH Host 和 Web UI 可以通过最小的同源 provider 接入真实的远端状态和模型服务。

## 二、已核实的基线

以下事实均来自当前 checkout 的源码、package manifest 或已存在测试；实施时若基线发生变化，先更新本节和 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)，再继续实现。

| 组件 | 当前事实 | 对 PoC 的影响 |
| --- | --- | --- |
| 页面入口 | [`apps/web/src/main.ts`](../../../apps/web/src/main.ts) 创建 `AppWebEntry`，没有自定义对话页面 | 页面必须保留该入口；不能用独立 HTML 代替 |
| Web boot | [`packages/client/web/src/boot.ts`](../../../packages/client/web/src/boot.ts) 创建 Client Cordis Context，加载 manifest，启动 client plugins，再调用 `mountClient` | 现有 UI 和客户端状态必须继续由该流程提供 |
| Worker preview | [`apps/web/src/preview.ts`](../../../apps/web/src/preview.ts) 使用 `chooseWorkerHostSource`、`connectWorkerHost` 和 `@deepseek-ai/dsh-experimental-webworker-runtime/worker` | v2 应复用 preview 的页面壳和 tunnel；必要时只替换 Worker entry |
| Worker Host | [`packages/experimental/webworker-runtime/src/worker-host.ts`](../../../packages/experimental/webworker-runtime/src/worker-host.ts) 读取 image/overlay，创建 `WorkerModuleLoader`，调用 `appBoot.boot()` 并捕获 Node HTTP listener | Host profile 可以通过 VFS image、overlay 和 static module 装载 |
| Worker tunnel | [`packages/experimental/webworker-runtime/src/transport/tunnel.ts`](../../../packages/experimental/webworker-runtime/src/transport/tunnel.ts) 与 [`client/client.ts`](../../../packages/experimental/webworker-runtime/src/client/client.ts) 把页面请求转成 Host 内部 HTTP | Host 的现有 API 和 UI Remote transport 不需要另造一套页面协议 |
| LLM seam | [`packages/llm/llm/src/index.ts`](../../../packages/llm/llm/src/index.ts) 的 `LlmAdapter.stream()` 是 provider 扩展点；`GenerateOptions` 和 `StreamChunk` 在 [`types.ts`](../../../packages/llm/llm/src/types.ts) | 实现 provider adapter，不修改 Agent Loop |
| Session seam | [`packages/session/session-persistence/src/index.ts`](../../../packages/session/session-persistence/src/index.ts) 定义正式 service；[`handle.ts`](../../../packages/session/session-persistence/src/handle.ts) 定义单 Session handle | 实现 `SessionPersistence` provider，不上传自定义 transcript |
| Agent loop | [`packages/core/agent-loop/src/index.ts`](../../../packages/core/agent-loop/src/index.ts) 创建并管理真实 Agent；base profile 已包含 `agent` 和 `agent-loop` | v2 必须让 UI 的 prompt 走现有 Session Controller 到该 loop |
| Host composition | [`packages/bundle/base/cordis.patch.yml`](../../../packages/bundle/base/cordis.patch.yml) 包含 `llm`、`session`、`agent`、`agent-loop`、`session-persistence-jsonl` 和 Web/API 相关插件 | v2 应以该 profile 为基线，只替换两个 provider 或其配置 |
| Image packer | [`packages/experimental/webworker-packer/src/bin.ts`](../../../packages/experimental/webworker-packer/src/bin.ts) 通过真实 CLI composition 生成 image，data overlay 只能覆盖 `home` 和 `workspace` | docs 内插件不能假设 packer 自动扫描；需要受控 static module 或最小 packer/runtime 变更 |
| Preview acceptance | [`apps/web/tests/preview-boot.e2e.ts`](../../../apps/web/tests/preview-boot.e2e.ts) 已验证真实 Web UI、Worker Host、VFS image 和 tunnel | v2 测试应在此基础上增加 Session/LLM/backend 断言，而不是重新造 UI 测试 harness |

当前 checkout 的 preview 基线命令由 [`apps/web/package.json`](../../../apps/web/package.json) 所有：`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 会构建 Worker runtime、packer、Web dist 和 VFS image，`pnpm --filter @deepseek-ai/dsh-web-frontend run serve:preview` 会在 `http://127.0.0.1:4173` 提供静态 preview。实施 Phase 1 前先运行这两个命令并执行现有 `apps/web/tests/preview-boot.e2e.ts` acceptance；若命令或输出路径因上游变化而不同，先更新本节和进度文件。

### 2.1 旧 PoC 的边界

同目录旧文件 [`backend.mjs`](backend.mjs)、[`public/index.html`](public/index.html)、[`public/worker.js`](public/worker.js) 和相关测试证明了一个独立协议可以工作，但它使用自定义 `user.message` 等事件格式和 PoC-local loop。v2 不复用它们作为 DSH runtime；实现时可以复用其中的端口解析、env-file 读取或测试隔离技巧，但每一处复用都必须改写为正式 DSH 类型和现有 UI 流程，并在进度文件中注明。

## 三、目标拓扑

### 3.1 运行时拓扑

```text
                         same origin
┌────────────────────────────────────────────────────────────┐
│ Browser                                                   │
│                                                            │
│  apps/web/preview.html                                    │
│      │                                                     │
│      ├── AppWebEntry → existing client plugins/UI          │
│      │        │                                            │
│      │        └── existing Connection/Remote tunnel       │
│      │                                                     │
│      └── Dedicated Worker                                 │
│           ├── real DSH Host Cordis tree                   │
│           ├── agent / agent-loop / session-controller      │
│           ├── RemoteSessionPersistence → backend          │
│           └── RemoteLlmAdapter → backend                  │
└────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    docs/drafts/.../backend
                    ├── /api/browser-native/session/*
                    └── /api/browser-native/llm
                               │
                               ├── local durable PoC store
                               └── OpenAI-compatible upstream
```

### 3.2 唯一事实来源

Host 内的 Session service、Agent service、Agent Loop 和 API session controller 仍然是唯一的运行时业务事实来源。页面只通过现有 Connection/Remote transport 观察 Host；页面不得自己折叠 Session 事件、自己启动第二个 loop 或直接调用 provider。

Backend 只负责两类边界：保存 `SessionPersistence` provider 请求提交的正式事件，以及代理经过 DTO 校验的 LLM 请求。Backend 不知道 Agent Loop 的轮次语义，不生成 assistant 事件，不替页面做 UI projection。

### 3.3 同源定义

PoC runner 必须让静态 Web 资源和 backend routes 由同一个 loopback HTTP server 提供，或者由同一 origin 的显式 reverse proxy 组合。Worker 内的 provider 和 persistence adapter 只能使用相对路径或当前 origin 生成的绝对 URL，例如 `/api/browser-native/llm`；不允许写死外部 provider URL，也不允许把 API key 注入 image、overlay、Worker env、页面 global 或 session event。

## 四、接入决策

### 4.1 方案比较

| 方案 | `/workspace`/Host 来源 | `ctx.fs` 和 Host API | 页面 UI | 首选性 |
| --- | --- | --- | --- | --- |
| 独立 HTML + 独立 loop | PoC 自己创建 | 不使用 DSH services | 自定义页面 | 禁止，已证明偏离目标 |
| 只新增 `ctx.fs` provider | 现有 Node/Worker Host | 只影响显式 filesystem consumer | 可以保留 | 不足以证明 real agent loop |
| 修改普通 Web server | Node Host | 可能覆盖完整 DSH | 可以保留 | 风险高，影响默认 Web |
| **现有 preview + custom Worker entry + docs-owned providers** | **Worker Host + existing tunnel** | **完整 DSH Host/API/Agent** | **现有 AppWebEntry UI** | **v2 采用** |

### 4.2 v2 的具体选择

v2 采用现有 `preview.html` 作为 browser-native 的实验入口，而不是修改普通 `dsh web` 的默认启动。`apps/web/src/main.ts` 保持不变；`apps/web/src/preview.ts` 只承担把现有 preview Worker 替换为 browser-native Worker entry 的最小接线。browser-native Worker entry 和两个 DSH provider 的源码、overlay 生成器、backend、测试和运行文档全部放在 `docs/drafts/browser-native-dsh-poc/`。

这样做的理由是：现有 preview 已经解决了完整 DSH Host 在 Worker 中的 module loader、HTTP listener 捕获、VFS image 和 page tunnel；普通 Web 入口则承担真实 Node Host、默认 profile 和更多平台能力。把实验接到 preview 可以把 PoC 的外部变更限制在一个实验入口，不会让普通 `dsh web` 获得隐含的浏览器限定行为。

### 4.3 统一 execution world 的硬性结论

只要 Shell、子进程、Git、LSP 和 Host API 没有共享同一个远端 namespace，就只能宣称“Worker Host + provider PoC”，不能宣称“所有现有 Agent 无需修改”。v2 的完成定义只要求 DSH UI、Session Controller、Agent 和 `ctx.agentLoop` 使用同一个 Worker Host；不把当前 Worker 的受限 shell 能力扩大为完整远端开发环境。

## 五、Worker profile 和插件装载

### 5.1 装载问题

当前 packer 扫描 `vendor`、`packages`、`native/system/packages` 和 `apps`，不会自动把 `docs/drafts` 当作 workspace package。仅在 docs 中新增一个 `package.json` 不能使它进入 Worker image。v2 必须使用一个明确的装载路径，不能依赖“源码刚好能被 Vite 打包”这一不透明行为。

### 5.2 首选装载路径：custom Worker static modules + profile overlay

实现首先尝试以下路径：

1. 在 docs 目录中写一个 browser-native Worker entry，复用 runtime 的 `createWorkerHost`、Node builtins、async-context、HTTP listener 和 shell role 逻辑。
2. Worker entry 只静态引入 docs-owned provider factory 和 Worker runtime helper。provider factory 的运行时代码不得静态导入 `@deepseek-ai/cordis` 或任何 `@deepseek-ai/dsh-*` 包；它在 `StaticModuleFactory` 首次执行时调用 `requireActiveModuleLoader()`，再通过该 loader 的 `requireFrom()` 获取 Worker VFS 中的 Cordis、`SessionPersistence`、`LlmAdapter` 和其他 DSH 运行时值。这样 provider class 继承的正是 Host 正在使用的 class，而不是 Vite bundle 里重复的一份。
3. 每个 static factory 必须在闭包中缓存 module namespace。`WorkerModuleLoader` 不会替 static factory 缓存返回值；重复 `require()` 必须得到同一个 namespace、同一个 provider class 和同一个 Service Definition identity。provider factory 允许使用 `import type` 作为编译期辅助，但禁止产生对 DSH runtime 包的 JavaScript import。
4. runner 生成一个合法的 VFS overlay，至少包含 browser-native profile patch 和必要的虚拟 package metadata。overlay 只能写入 `home`，不能替换基础 image 的 runtime module、manifest 或 `config` 根文件。static provider 的实现留在 Worker bundle；profile 只引用它的 exact static specifier。
5. profile patch 通过独立 row id 停用 `session-persistence-jsonl`，再装载 docs-owned `RemoteSessionPersistence` row；不得复用 `session-persistence-jsonl` 这个 id。Worker 的 `bootPatches()` 会无条件为该 id 注入 `compression: none`，复用它会把 JSONL 专用配置泄漏给远程 provider。默认 model route 使用另一个 docs-owned row，并保留 `agent`、`agent-loop`、`session-controller`、`api-remotes` 和现有 client 相关 rows。
6. 如果 app boot 或 plugin inventory 要求 static module 同时有可解析的 package manifest，overlay 必须提供最小 metadata；如果仍无法通过现有 loader 表达，则才进入 5.3 的最小核心改动门槛。组合测试必须证明最终 composition 中只有一个 `SessionPersistence` provider，且该 provider 的 class identity 来自 Worker loader。

### 5.3 核心改动门槛

只有出现以下可复现的阻塞，才允许修改 `packages/experimental/webworker-runtime`、`packages/experimental/webworker-packer` 或 `apps/web` 以外的核心文件：

- `WorkerHostOptions.staticModules` 已经能表达模块映射，但固定的 `worker.ts` 入口无法注入 docs-owned factory，且自定义 Worker entry 会重复不可维护的平台初始化代码；
- profile patch 可以表达 row 替换，但 loader 或 packer 没有受控的 static package metadata 入口；
- 现有 preview client 接线无法把 backend 的同源 route 提供给 Worker，且不改核心就只能创建第二套 UI transport。

每次核心改动必须先写 [change-ledger.md](change-ledger.md)，记录失败的最小复现、改动文件、为什么不能只改 docs、上游重放步骤和未来删除条件。禁止修改 `packages/core/agent-loop`、`packages/core/session`、`packages/llm/llm` 的主语义来服务 PoC。

### 5.4 Profile 行保留和替换

保留：`llm`、`session`、`agent`、`agent-loop`、`typert`、`typert-loader`、`typert-gateway`、`session-controller`、`api-remotes`、client module inventory 和现有 Web rows。

替换或停用：停用 `session-persistence-jsonl` row，新增独立 id 的远程 persistence provider；默认模型行改为 `browser-native` provider/model。不得通过同 id 替换 JSONL row，因为 Worker runtime 会给该 id 注入 JSONL 专用 `compression` 配置。会在 Worker 中要求真实 Node、原生网络、进程或桌面凭据的插件按现有 preview 限制保持禁用或显式失败。不得为了让 profile 启动而静默吞掉 provider 缺失；错误必须在 boot 或第一次使用时可见。

最终 composition 必须满足：`session-persistence-jsonl` 是 disabled，docs-owned remote row 是 enabled，`ctx.sessionPersistence` 只有一个 provider；`agent-loop`、`session-controller` 和 `api-remotes` 仍然来自现有 DSH rows。若 composition 结果同时激活 JSONL 和 remote provider，或 static provider 的 runtime import 没有经过 Worker loader，Phase 1 立即失败，不进入浏览器验收。

## 六、两个 DSH 插件

### 6.1 `RemoteSessionPersistence`

该模块是正式 `SessionPersistence` service 的 provider。它通过同源 JSON API 将 DSH 的 `SessionHeader`、`SessionEvent`、`SessionSeedEventState`、`SessionPersistenceRevision` 和 ownership 结果序列化传输。它不定义 `user.message`、`assistant.final` 或其它 PoC-only event type。

实现要求：

- `create` 发出 header 和 inherited event count，获得一个 write handle token；
- `open(id, 'read')` 获得只读 handle，不影响其他 writer；
- `open(id, 'write')` 由 backend 原子地 claim 单写者；已有 owner 时映射为 `SessionAlreadyOwnedError`；
- `read` 保持 offset/length 和 Session handle 的单调读取语义；
- `append` 只接受从 backend next seq 开始的 contiguous batch；
- `flush` 明确等待 backend 返回 durability receipt；
- `close` 释放 handle ownership，并等待 pending append/flush 结束；
- `stat` 和 `list` 不读取完整 event log；
- HTTP、JSON、schema、owner token、session id 和事件内容都在 wire boundary 做有限校验，拒绝超限、缺字段和错误 seq；
- provider 不在浏览器 localStorage、IndexedDB 或 Worker memory 中复制完整 Session 作为第二事实来源。

### 6.2 `RemoteLlmAdapter`

该模块继承 `LlmAdapter`，通过 `ctx.llm.registerAdapter(['browser-native'], adapter)` 注册一个 provider route。`stream(options)` 将 DSH `GenerateOptions` 的 model、messages、system、tools、toolHistory、reasoningEffort、temperature、maxTokens、stop、sessionId 和 purpose 转成 backend DTO，再把 backend 返回的 NDJSON 流逐行校验并还原成正式 `StreamChunk`。

adapter 必须遵循现有 `signal` 取消语义。Worker 终止、Agent abort 或 UI 取消会中断 fetch；backend 应中断上游请求或至少停止向已关闭的 client 写入。provider HTTP 状态、上游 request id、rate limit 和 schema refusal 映射为 DSH `LlmError` 可表达的 provider-neutral failure，不把上游凭据或完整 header 回传浏览器。

上游请求的产品归属由 backend 负责。现有 `LlmAdapter` 要求每个 provider HTTP request 都包含 `attributionHeaders()`；浏览器 Worker 不能把 `User-Agent` 当作可靠的自定义请求头发送，因此不能把这项责任交给 `RemoteLlmAdapter`。backend 发出的每个真实 provider request 必须使用当前 DSH `@deepseek-ai/dsh-llm` 的 `attributionHeaders()` 生成公开产品身份，或通过一个等价且版本受控的 backend bridge 调用同一实现；不得手写会随版本漂移的 product/version 值。这个 header 只能包含公开产品身份，不得包含 session id、request id、prompt、用户标识、路径、API key 或其他 secret。backend contract test 必须让 upstream mock 直接断言 attribution header 存在且值正确；real-provider E2E 只检查该公开 header 不含 secret，不把它误判为凭据泄漏。

model catalog 只声明 runner 配置允许的 model，至少支持一个 scripted provider 用于无 key 测试和一个 real provider 用于用户提供的 env-file 测试。真实 provider 的 key 选择发生在 backend，按显式 provider/model allow-list 选择，不接受浏览器传入任意 upstream URL 或任意 credential。

### 6.3 为什么不新增 loop plugin

Agent Loop 已经是 DSH 的正式插件和持久化生产者。v2 不增加一个 `browser-native-loop`，不复制 turn/step/assistant stream 的状态机，也不把 Worker message handler 当作 loop。所有新的行为必须通过 `SessionPersistence` 和 `LlmAdapter` 两个现有服务定义接入，必要的 browser-only capability 才另行注册独立插件。

## 七、Session backend 协议

### 7.1 DTO 规则

Backend wire DTO 不是 TypeScript same-process value，必须做运行时解析。DTO 使用 JSON-safe 的正式 DSH 值，保留 `type`、`seq`、`time`、`data`、`surfaceOp`、`sourceEventSeqs` 和 `ignorable` 等字段。品牌类型在 HTTP 上以原始 string/number 传输，进入 Worker provider 后重新通过 DSH 构造函数或已有 parser 进入 typed value。

单个请求和单个事件有明确大小上限。PoC 可以拒绝过大的 messages/events，而不能截断后继续写入。所有 session id、handle token 和 request id 都必须作为不透明值处理；路径拼接不使用用户输入。

### 7.2 最小 endpoint 表

| Route | Method | 请求 | 响应/语义 |
| --- | --- | --- | --- |
| `/api/browser-native/session/create` | POST | `header`, `inheritedEventCount`, `requestId` | write handle、header、next seq；重复 requestId 返回同一结果 |
| `/api/browser-native/session/open` | POST | `sessionId`, `access`, `requestId` | read/write handle；write 由 backend claim owner |
| `/api/browser-native/session/read` | POST | `handleToken`, `offset`, `length` | `eventState`, `events`, `revision` |
| `/api/browser-native/session/append` | POST | `handleToken`, contiguous `events`, `requestId` | accepted next seq；重复 requestId 不重复追加 |
| `/api/browser-native/session/flush` | POST | `handleToken`, `requestId` | `durableThroughSeq`, `revision`；这是 crash durability receipt |
| `/api/browser-native/session/close` | POST | `handleToken`, `requestId` | owner release；close 幂等 |
| `/api/browser-native/session/stat` | POST | `sessionId` | snapshot 或 not found |
| `/api/browser-native/session/list` | GET | bounded query | bounded snapshot list |

### 7.3 Backend storage

PoC backend 可以使用 `data-dir/sessions/<session-id>.json` 和原子替换写入，前提是存储格式包含正式 `header`、`inheritedEventCount`、`events`、`revision`、`durableThroughSeq` 和 owner metadata。POSIX 写入顺序必须是：创建同目录临时文件、写完整可恢复前缀、调用临时文件的 `fsync`、关闭临时文件、原子 `rename` 替换正式文件，再对父目录执行 `fsync`；不能把 `rename` 或普通 `close` 单独当成 crash durability barrier。Windows 使用当前 Node/文件系统可提供的句柄同步和原子替换语义，并在 README 中明确无法由该 PoC 证明断电级保证的部分。`flush` receipt 只承诺 backend 已完成这条本地提交顺序，并可在支持的主机上通过进程崩溃/重启恢复对应前缀；它不承诺备份、磁盘介质、跨主机复制或灾备。它不是生产数据库替代品；README 必须写明本地文件 store 的 crash、备份和多进程限制。

每次 append 先验证 next seq 和 owner token，再把事件放入当前 generation；`flush` 将完整的可恢复前缀写入临时文件并原子替换正式文件，随后返回 `durableThroughSeq`。backend restart 只恢复上一次成功 flush 的前缀。未 flush 的 append 可以丢失，但不能在 read 中返回一个跨重启后不存在的“已成功 durable”前缀。

### 7.4 Ownership 和幂等

owner 记录至少包含 `handleToken`、`sessionId`、`claimedAt`、`lastSeenAt` 和单调的当前进程 generation。PoC 不需要实现长期租约续期，但必须在 `close` 和 backend shutdown 时释放 owner；如果测试通过强制终止模拟遗留 owner，runner 必须提供显式 data-dir reset，而不是让 backend 自动把未知 owner 当成安全可接管。

每个 mutation 使用 client request id。backend 记录最近的 idempotency result，重复 `append`、`flush`、`close` 和 `create` 请求返回同一结果；同一个 request id 携带不同 body 必须拒绝。Session write ownership 与 Agent Loop ownership 是不同概念，provider 不能把一个 UI Session 的 owner 自动扩展成 workspace 或 browser tab 的全局锁。

## 八、LLM proxy 协议

### 8.1 Request DTO

`POST /api/browser-native/llm` 接受经过 schema 校验的 JSON：

```text
type BrowserNativeLlmRequest = {
  requestId: string
  provider: string
  model: string
  messages: readonly RequestMessage[]
  system?: string
  tools?: readonly ToolSchema[]
  toolHistory?: ToolHistory
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}
```

实际实现以当前 `@deepseek-ai/dsh-llm` 类型为准；上面的代码块是 DTO 轮廓，不得复制成漂移的独立类型源。Backend 只允许配置中的 provider/model，拒绝请求中携带的 URL、API key、Authorization header 或任意额外 provider options。

### 8.2 Stream DTO

Backend 使用 newline-delimited JSON，每行对应一个正式 DSH `StreamChunk` 的 JSON-safe 投影，至少支持 block start、text delta、reasoning delta、tool-call delta、block end、usage 和 finish。每行有最大字节数，流结束有明确 finish；上游半截响应必须转成失败而不是静默当作完成。

`RemoteLlmAdapter` 是唯一把 wire chunk 转成 `StreamChunk` 的地方。Backend 不生成 Session assistant events；Agent Loop 消费 chunk 后继续使用 DSH 现有的 message/attempt/step 事件生产逻辑。

### 8.3 Provider security

真实 provider key 只能从 runner 明确指定的 env-file 或环境变量读取。当前本机 real-provider 配置使用 `OPENAI_NEXT_GPT_BASE_URL`、`OPENAI_NEXT_GPT_COMPLETIONS_PATH`、`OPENAI_NEXT_GPT_MODEL`、`OPENAI_NEXT_GPT_API_KEY` 和 `OPENAI_NEXT_GROK_API_KEY`；实现不得把这些变量的值写入仓库，配置文件只作为本机输入。GPT route 使用显式 base URL、completions path 和 model；Grok route 使用后端维护的兼容 endpoint/model allow-list，不能让浏览器提交任意 upstream URL、model、API key、Authorization header 或额外 provider options。启动时只检查 key 存在和 provider allow-list，不把 key 打到日志；`/api/browser-native/config` 若存在，只返回 provider/model 名称和能力，不返回 key。Playwright 测试必须检查页面 console、performance resource、Worker message 和 Session log 不包含 key 的值或 `Authorization` header。

backend 的 upstream adapter 必须在生成 Authorization 或 provider-specific headers 后，再合并不可覆盖的 `attributionHeaders()`；调用方提供的同名 header 不能覆盖 DSH attribution。backend contract test 至少覆盖：正常 scripted/real route、上游返回错误、取消请求和错误 provider 配置，并在每个会实际调用 upstream mock 的路径上断言公开 attribution header；不需要真实 provider key 的测试也必须保留这一断言。若 docs-owned backend 不能直接加载已构建的 `@deepseek-ai/dsh-llm`，实施者必须先记录可重复的 source/artifact 加载方式或建立极小的、版本绑定的 bridge，不得静默复制一个未注明来源的常量。

## 九、页面、Worker 和 execution world

### 9.1 页面保持现有 UI

browser-native 入口必须继续由 `apps/web/src/main.ts` 的 `AppWebEntry` 挂载。不得创建新的聊天框、Start Worker 页面、browser_echo 页面或平行 transcript renderer 作为主体验。可以保留现有 preview 的 source chooser，但 browser-native 测试应在进入后看到现有 DSH Web UI 的 Session rail、composer、message/assistant surface 和已有 loading/error states。

### 9.2 Worker 运行真实 loop

custom Worker entry 只负责平台初始化和 `createWorkerHost` 组装；Host 通过现有 `appBoot.boot()` 启动 Cordis profile。测试必须从现有 Session Controller 的 prompt 入口触发工作，并从 UI 和 backend log 两侧确认使用了同一个 Session id。禁止在 Worker entry 中 import 一个新的 `runAgentLoop` 或维护一个 PoC-local `while`。

### 9.3 浏览器工具范围

第一版不新增 browser Tool。已有 Worker 可运行的工具继续按现有 profile 和 runtime 限制工作；不可用工具必须由现有 DSH capability/error surface 明确失败。若后续确实需要 Main Thread browser Tool，必须新增一个有 typed request/response、授权和 Session event 记录的 Cordis plugin，并单独证明它没有把页面任意函数调用暴露给 Agent。

### 9.4 页面和 Worker 的职责

| 责任 | Page | Worker Host | Backend |
| --- | --- | --- | --- |
| UI render | 是 | 否 | 否 |
| Agent Loop | 否 | 是 | 否 |
| Session event interpretation | Client projection | Host Session/Agent | 持久化和结构校验 |
| provider key | 否 | 否 | 是 |
| LLM upstream call | 否 | 只调用 same-origin route | 是 |
| Host API | 通过 tunnel 消费 | 真实 route owner | 否 |
| Session write ownership | 否 | provider handle | backend authoritative |

## 十、失败恢复和安全约束

### 10.1 Durability 状态

对 Session append 必须区分：

```text
accepted   append 已通过 seq/owner 校验并可被当前 backend instance read
flushed    backend 已原子替换 durable artifact，并返回 durableThroughSeq
recovered  backend restart 后重新读取同一 flushed prefix
```

`append` resolve 只能承诺 `accepted`；`SessionHandle.flush()` resolve 才能承诺 `flushed`。本 PoC 的可测 RPO 是：对已返回 `flushed` receipt 的 seq，在 backend 进程崩溃并重新打开同一 data-dir 后不得丢失；未 flush 的尾部允许丢失。它不定义跨主机或备份 RPO。RTO 只记录 backend 重新监听后完成 Session `open/read` 恢复所需的实际耗时，不将一次本地测试结果写成服务等级目标。Worker 终止后重启，测试只要求保留最后一次 flush 返回的前缀。UI 中正在流式生成的未 flush 尾部可以显示失败或重新生成，但不能伪装成已恢复。

### 10.2 Session 与 UI 恢复

恢复流程必须是：新 Worker 启动 → Host profile 启动 → RemoteSessionPersistence `open`/`read` 正式日志 → `session` 和 `session-controller` 重建 projection → Client Remote tunnel 重新连接 → UI 显示历史。Session event log 是恢复事实；页面内存状态和旧 Worker 的 transient stream 都不能成为恢复输入。

### 10.3 同源和 CSRF

runner 只监听 loopback；backend 检查 HTTP method、content type、origin/fetch metadata 和 bounded body。PoC 可以使用同源 cookie-less local session，但不得接受跨源的任意 Origin，也不得提供无认证的任意 provider proxy。错误 response 只返回稳定 machine code 和短消息，不返回 upstream headers、env、完整 prompt 或文件路径。

### 10.4 数据隔离范围

本 PoC 只有单个 local tenant，不应宣称 SaaS multi-tenancy。Session id、handle token、data-dir 和 provider allow-list 仍须被 backend 约束，以便未来增加 tenant/capability 时不会把浏览器输入当作授权。所有 backend routes 只能访问 runner data-dir 下的固定子目录，禁止通过 session id 形成任意文件路径。

## 十一、实施顺序

### Phase 0：文档和基线锁定

完成本文件、进度文件和变更账本；确认 checkpoint、当前 tag/base、现有 preview build 命令和测试命令。输出不得包含实现代码之外的假设；任何阻塞都先记录再修改规划。

退出条件：计划连续三轮只读检查无实质问题；`git status` 只包含计划范围内的 docs 变更。

### Phase 1：保留 UI 的 custom Worker 骨架

新增 docs-owned Worker entry，复用 runtime 的 Host assembly；只把现有 preview 的 Worker import 替换为该 entry。先继续使用现有 JSONL/fixture provider，证明页面仍是 DSH Web UI，Host tree 仍能 boot，现有 preview boot test 不回归。

退出条件：真实 Chromium 看到 existing Web UI；Worker console 报告真实 Host tree active；页面 API 请求仍由现有 tunnel 处理；普通 Web build 和 preview acceptance 不受影响。

### Phase 2：正式 SessionPersistence provider

实现 backend Session routes、docs-owned `RemoteSessionPersistence` 和 profile overlay。先运行 backend contract tests，再运行 Host Session Controller 的 create/list/prompt/reload browser test。使用一个确定的 fixture event sequence 覆盖 `turn/start`、`user/message`、assistant stream 相关事件和 `turn/end`，但不在 backend 生成它们。

退出条件：`create/open/read/append/flush/close/stat/list` 通过；第二 writer 得到正式 ownership error；backend 重启只恢复 flushed prefix；UI refresh 或 Worker restart 后 Session history 仍由 DSH projection 显示。

### Phase 3：RemoteLlmAdapter 和 scripted provider

实现 `/api/browser-native/llm` 的 deterministic scripted mode 和 DSH adapter。scripted response 必须返回正式 stream chunks，能触发 Agent Loop 的普通 assistant response；测试确认 provider request 来自 Worker adapter 而不是页面自定义 fetch。

退出条件：现有 UI composer 提交 prompt 后真实 `ctx.agentLoop` 完成一轮；Session log 由 DSH 产生正式事件；browser test 只需设置 backend mode，不需要 provider key。

### Phase 4：真实 provider 和恢复验收

加入 OpenAI-compatible backend proxy，读取显式 env-file/环境变量；用用户提供的 key 做一次真实 Playwright E2E，测试输出只报告 provider/model、事件类型、seq 和 latency，不打印 key、完整 prompt 或 upstream response。再终止 Worker、重载页面或重启 backend，验证 flush 后的 Session 能被现有 UI 恢复。

退出条件：真实 provider、正式 Session backend、existing DSH UI、real `ctx.agentLoop` 和 browser Worker 五者在同一条 E2E 中同时成立；失败时记录上游延迟或 provider refusal，不把偶发成功表述成 SLA。

### Phase 5：收口和上游同步说明

删除无用的旧独立 UI/loop 文件，或者把它们明确标为历史协议 fixture；更新 README、change ledger 和 progress。运行 docs gates、focused tests、build smoke 和 `git diff --check`，确认普通 profile 未被修改。

## 十二、测试矩阵和退出条件

### 12.1 纯 backend contract tests

覆盖：health、静态资源、Session create、duplicate create request、append contiguous check、read slice、flush durability、restart recovery、owner conflict、idempotency body mismatch、LLM scripted stream、unknown route、oversized body、provider allow-list、secret redaction。

### 12.2 Provider unit tests

覆盖：`RemoteSessionPersistence` handle lifecycle、read/write refusal、abort signal、HTTP error mapping、formal event round-trip、`RemoteLlmAdapter` chunk round-trip、stream abort、malformed NDJSON、finish missing、provider-neutral failure。测试通过 mock fetch 或 in-process backend，不依赖真实 key。

### 12.3 Host composition tests

覆盖：profile overlay 能解析两个 docs-owned static modules；两个 static factory 没有对 DSH runtime 包产生 JavaScript import，并且通过 `requireActiveModuleLoader()` 获取 Worker loader 的同一组 Cordis/DSH class；重复 require 返回同一 module namespace；`session-persistence-jsonl` 被停用、独立 remote row 被启用且没有第二个 `SessionPersistence` provider；`agent-loop` 仍被加载；默认 model route 是 `browser-native`；普通 web profile 的 composition snapshot 不变。测试还必须覆盖 `bootPatches()` 的 `compression: none` 注入不会到达 remote row。

### 12.4 Browser E2E

至少包含：

1. Existing UI boot：不是独立 HTML；检查现有 UI landmark、Session rail、composer 和 assistant surface。
2. Scripted real DSH loop：UI 输入 prompt，Worker Host 的真实 Session Controller 触发 `ctx.agentLoop`，scripted backend response 显示在 UI。
3. Backend persistence：读取 backend artifact，确认 header、正式 event type、连续 seq 和 `durableThroughSeq`。
4. Worker restart：保存 session id，关闭 Worker/刷新页面，重新读取同一个 Session，history 由 UI projection 恢复。
5. Real provider：使用显式 env-file；确认浏览器 request URL 只有同源 route，页面/Worker/Session log 没有 key。
6. Failure path：backend 返回 provider error 或 Session owner conflict，UI 显示 DSH error surface，页面不白屏，backend 不泄漏凭据。

### 12.5 构建和文档检查

按实际改动选择并记录：`pnpm run test:docs`、`pnpm run doc-sync`、相关 package typecheck/build、preview build、PoC backend tests、Playwright E2E、`git diff --check`。不把未运行的 full suite 或 real API tests 写成通过；外部 provider 超时必须单独记录。

## 十三、预期文件和变更账本

### 13.1 当前目录内文件和职责

下面是当前实现实际使用的文件。旧版 `backend.mjs`、`public/`、`protocol*`、`implementation-plan.md` 和 `progress.md` 保留为历史协议实验，不是 v2 的运行入口或完成证据：

```text
docs/drafts/browser-native-dsh-poc/
  browser-native-dsh-plan-v2.md
  browser-native-dsh-progress-v2.md
  change-ledger.md
  browser-native-worker.ts
  browser-native-providers.ts
  browser-native-session-persistence.js
  browser-native-llm.js
  browser-native-profile.cordis.patch.yml
  browser-native-profile-overlay.tar.gz
  backend-v2.mjs
  run-v2.mjs
  tests/backend-v2.test.mjs
  tests/browser-native-v2.e2e.mjs
```

如果测试 runner 或 Vite 对 `.ts`、`.mjs` 的入口要求不同，以当前仓库的既有 launcher 为准；不得为了方便新增一个绕过 `dsh` profile 约束的产品启动 bin。PoC runner 是 docs 目录内的实验脚本，不是发布包入口。

### 13.2 当前目录外改动

当前 checkout 只有一项运行时接线和一项文档门禁登记在 `docs/drafts` 之外：

- `apps/web/src/preview.ts`：保留上游 `chooseWorkerHostSource` 和 `connectWorkerHost`，仅在 `browser-native=1` 时加载 docs-owned Worker 与 profile overlay；默认 preview 路径不变。
- `scripts/translation-pairing.manifest.json`：登记本目录为中文 scratch 文档，避免为研究草稿伪造完整英文 counterpart。

没有修改 `packages/core/agent-loop`、`packages/core/session`、`packages/llm/llm`、普通 Web profile、Desktop profile 或 Headless profile。未来若必须增加 `packages/experimental/webworker-runtime` 或 packer 改动，必须先新增账本条目、写出最小复现和删除条件；当前实现不包含这类改动。

禁止把 provider 逻辑、backend route 或独立 UI 放入普通产品 package。每项目录外改动都要先登记 [change-ledger.md](change-ledger.md)，并写明：基线文件、最小差异、验证命令、upstream 重放方式、PoC 移除后的删除条件。

### 13.3 进度文件使用方式

[browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md) 记录当前阶段、最后一个可运行 checkpoint、已运行的命令、测试结果、未解决阻塞、目录外改动和恢复入口。每取得一个关键进展，先更新进度文件并提交或至少保存，再执行下一步；每次上下文恢复先读该文件和 change ledger。

## 十四、明确不宣称的能力

通过 v2 PoC 不能推出：浏览器可以运行完整 DSH Desktop 能力；Worker 具备任意 Node/native/process 能力；Session backend 已达到 PostgreSQL、S3 或生产多租户等级；LLM proxy 已提供高可用、计费、审计或跨区域灾备；现有任意 Agent 在没有统一 execution world 的情况下都能无修改运行；FUSE、CSI、WorkspaceFS 或远程 POSIX 语义已经实现。

可以宣称的范围只有：现有 DSH Web UI 可以连接到 Worker 内真实 DSH Host；真实 `ctx.agentLoop` 可以通过一个 browser-only provider profile 工作；Session 状态可以通过同源 backend 按正式 DSH persistence 语义保存和恢复；LLM provider key 留在 backend；该实验入口不改变普通 DSH profile。

## Further Exploration

- [旧版实施规划](implementation-plan.md)：旧协议 PoC 的历史规划；不作为 v2 的完成定义。
- [旧版进度](progress.md)：旧独立 loop 的运行记录；只用于追溯已验证的 backend/Playwright 技巧。
- [变更账本](change-ledger.md)：所有目录外改动的 owner、原因和删除条件。
- [`docs/architecture.md`](../../../docs/architecture.md)：DSH composition、Agent Loop 和 plugin extension point 的总览。
- [`docs/testing.md`](../../../docs/testing.md)：测试、snapshot、real API 和 source/artifact plane 规则。
- [`packages/experimental/webworker-runtime/README.md`](../../../packages/experimental/webworker-runtime/README.md)：当前 Worker 能力和明确限制。
- [`packages/session/session-persistence/README.md`](../../../packages/session/session-persistence/README.md)：正式 Session persistence provider contract。
- [`packages/llm/llm/README.md`](../../../packages/llm/llm/README.md)：正式 LLM adapter 和 stream contract。

## Dev Note

本文是研究分支中的 drafts 规格，同时保留已完成 v2 PoC 的设计依据。当前实现事实、已运行命令和限制必须与 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md) 和 [README.md](README.md) 保持一致；如果上游更新改变了任一引用入口，先核对源码、修订本规格和进度文件，再继续重放。目录外代码若无法在后续同步 upstream 时删除，必须停止并重新评估是否仍属于 PoC 的最小范围。
