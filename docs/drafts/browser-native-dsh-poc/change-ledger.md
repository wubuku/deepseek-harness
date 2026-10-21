---
description: "Browser-native DSH PoC 的目录外改动账本和重要目录内兼容性变更记录，保留必要性、验证和 upstream 重放或删除条件。"
---

# Browser-native DSH PoC 变更账本

## Summary

本文件是 `docs/drafts/browser-native-dsh-poc/` 的变更登记 owner。目录外接线必须登记；会影响协议兼容或恢复行为的目录内修改也在本文登记，便于后续复查。

任何修改 `docs/drafts` 之外文件的实施者，都必须在提交该修改前增加一条记录，写明当前 DSH 版本、文件、必要性、被检查过的扩展点、测试、上游同步步骤和删除条件。没有登记的目录外修改视为 PoC 未完成，而不是“实现细节”。

当前 PoC 的 backend、Worker、profile overlay、launcher 和测试均位于本目录；`apps/web/src/preview.ts` 与 `apps/web/src/browser-native-page-control.ts` 提供 preview 接线及页面生命周期 bridge，另有 `packages/core/tools` 跨浏览器 schema 兼容修复和中文 scratch 文档登记。上述目录外改动均有记录；当前没有 DSH Agent Loop、Session format、普通 Web profile、Desktop profile 或 Headless profile 的未登记修改。

## PoC 内部兼容性变更

### BN-V2-002：backend close 释放 keep-alive 连接

```text
changeId: BN-V2-002
upstreamBaseline: docs-owned v2 backend on 2026-10-20 / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs
reason: Playwright/Node fetch 在真实模型回合结束后会留下 HTTP keep-alive sockets；server.close() 等待这些 idle connections，使 E2E 已打印完整成功证据后仍不退出。
existingExtensionPointsChecked: backend 是本 PoC 独立 Node server，现有 close() 是唯一 teardown 入口；没有共享 DSH Host 或公开 package API 的生命周期要求。
whyDraftOnlyWasInsufficient: 退出等待发生在 docs-owned backend 的 server handle，不是浏览器 Worker teardown；测试 runner 无法从外部安全关闭其私有 sockets。
behaviorChange: close() 先调用 Node HTTP server.closeAllConnections()，再等待 server.close() 完成；仅影响显式关闭此 PoC backend 的时刻。
consumersUpdated: runtime-validation.e2e.mjs、runtime-lifecycle.e2e.mjs 和人工停止 backend 继续通过同一 close() 入口释放连接。
tests: 2026-10-21 backend/Symbol tests 9 passed；scripted Chrome/WebKit runtime 和 lifecycle E2E 通过；真实 Chrome/WebKit runtime E2E 均以退出码 0 输出完整 Session 与安全摘要。
syncReplaySteps: 从上游同步 backend 或 Node 运行时基线后，确认 closeAllConnections() 可用且 close() 不需保留响应连接；运行 backend-v2.test.mjs、runtime-validation.e2e.mjs 和 runtime-lifecycle.e2e.mjs。
deleteCondition: PoC backend 不再由该模块管理 HTTP server，或 teardown 改用具备等价 idle/active connection disposal 语义的生命周期 API。
status: implemented
```

### BN-P2-005：为 Worker Host 提供可持久化 VFS 和启动前恢复 seam

```text
changeId: BN-P2-005
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/experimental/webworker-runtime/src/worker-host.ts
file: packages/experimental/webworker-runtime/src/worker-host.ts; packages/experimental/webworker-runtime/src/index.ts; packages/experimental/webworker-runtime/README.md; packages/experimental/webworker-runtime/README.zh.md; packages/experimental/webworker-runtime/tests/*; apps/web/src/browser-native-page-control.ts; apps/web/src/locales/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/*
reason: Browser-Native Workspace 同步需要在同一个 Worker VFS 中装载只读 runtime image、恢复云端授权 Workspace，并观察后续 VFS 写入；现有 Worker Host 内部创建 VFS，调用方无法连接 mutation sink 或在 Cordis boot 前 hydrate。
existingExtensionPointsChecked: `MemoryVfs` 已接受 `VfsMutationSink`；`loadVfsImage()` 和 `loadVfsOverlay()` 可向传入的 VFS 静默 seed。Worker Host 组合点是 image/overlay mount 与 `WorkerModuleLoader` 建立之间。
whyDraftOnlyWasInsufficient: Workspace 持久化 adapter 位于 PoC 内，但 VFS 创建与启动时序由 runtime 包独占；在 PoC Worker 中旁路创建另一个 VFS 会使 Host 插件、Node fs proxy 和同步队列观察不同的文件系统。
behaviorChange: 新增可选的调用方 VFS 注入和异步启动前准备回调；默认不传时保留现有 Worker Host 行为。回调在镜像、overlay 和空目录 seed 后、模块加载及 Cordis boot 前运行；失败中止 Host 启动。Browser-Native 页面通过本地化的状态提示显示 Workspace 加载、dirty、同步、错误、冲突和已确认 revision。
consumersUpdated: Browser-Native Workspace PoC 注入带同步 sink 的 `MemoryVfs`，从 backend 恢复授权文件，再让同一 VFS 服务 Host 与插件；页面控制端接收并呈现同步状态。
tests: `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/tar.spec.ts packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts`; PoC workspace adapter specs; backend contract tests; runtime package typecheck/build; Chrome scripted/real Workspace E2E。
syncReplaySteps: 上游更新后重新核对 WorkerHostOptions、VFS mount 顺序、MemoryVfs mutation 与 seed 语义；若 runtime 已提供等价 VFS factory/hydrate hook，改用上游 API 并删除重复 seam；否则重放最小可选扩展，运行 webworker-runtime storage/host 测试、typecheck/build 与 Browser-Native Chrome E2E。
deleteCondition: Worker Host 已提供正式且等价的 VFS 注入和 boot 前 hydrate seam，且 PoC 与 package 测试不再依赖该改动。
status: implemented
```

### BN-V2-003：拒绝无内容的上游模型完成

```text
changeId: BN-V2-003
upstreamBaseline: docs-owned v2 backend before 2026-10-21 / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs
reason: OpenAI-compatible provider 可以在没有文本和工具调用的情况下返回 `finish_reason=stop`；旧 proxy 将其包装成空文本块，Session 因而记录成功完成，但用户没有收到回复。
existingExtensionPointsChecked: 行为位于 docs-owned LLM proxy 的上游 SSE 转换；DSH LLM adapter 会消费 proxy 的终止流事件，不需要改 Agent Loop 或 Session event 类型。
whyDraftOnlyWasInsufficient: 错误发生在真实 provider 响应转换处，UI 无法可靠区分有效空答复与 provider 空完成。
behaviorChange: 收到无文本、无工具调用的上游完成信号时，proxy 发出 `UPSTREAM_LLM_EMPTY` 错误，不再生成空 assistant completion。
consumersUpdated: backend contract test 覆盖该响应映射；真实 Chrome Stop/恢复脚本在该错误出现时只允许一次显式用户重试。真实 provider 后续复测没有再次自然触发此分支。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`; `node --test docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs` with real Chrome and the configured model backend.
syncReplaySteps: 更新 backend 后保留无 delta 但含 finish 的 SSE fixture，运行 backend contract tests；在真实 Chrome 运行 Stop/恢复 E2E，确认空 completion 以错误结束且用户重试能创建新的 DSH turn。
deleteCondition: 上游 provider adapter 或正式 LLM proxy 明确拒绝无内容的成功完成，并有同等 contract test 覆盖。
status: implemented
```

### BN-V2-004：返回系统分配的动态监听端口

```text
changeId: BN-V2-004
upstreamBaseline: docs-owned v2 backend before 2026-10-21 / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
reason: E2E 为隔离并行运行使用 `port: 0`；原 server 返回字面端口 `0`，而不是操作系统实际绑定的 loopback 端口，导致测试无法向 backend 发请求。
existingExtensionPointsChecked: 该值只由 PoC backend 的 `listen()` 向启动器返回；Node HTTP server 的 `address()` 是实际监听地址的来源。
whyDraftOnlyWasInsufficient: 端口分配发生在 backend 持有的 server socket 上，调用方无法从其外部获知实际分配端口。
behaviorChange: `listen()` 在 server 启动后从 `server.address().port` 返回实际端口；显式指定非零端口时仍返回实际监听 origin。
consumersUpdated: backend runtime E2E 和验证启动器可使用动态端口，不共享固定端口。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`，其中新增 `port: 0` 启动、返回端口和健康路由请求断言。
syncReplaySteps: 同步 backend 时检查监听回调是否返回真实绑定地址；运行 backend contract tests 中的动态端口用例及 runtime validation E2E。
deleteCondition: PoC backend 不再支持动态端口测试，或新的 server adapter 返回并验证等价的实际监听 origin。
status: implemented
```

### BN-V2-001：Session list 同时提供 Persistence snapshot 与 Controller items

```text
changeId: BN-V2-001
upstreamBaseline: docs-owned v2 backend before Session Controller list integration / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/README.md
reason: Browser-Native backend 的 session/list 原先只返回 Session Persistence 所需的 snapshots；正式 Client Session Controller 的 session.list consumer 读取 items，缺少该字段时无法从列表恢复已存在的 Session。
existingExtensionPointsChecked: 已核对 Worker-side SessionPersistence provider 对 snapshots 的读取、Client Session Controller 的 SessionListValue 消费以及正式 session/list Remote 类型；扩展保持在 PoC backend，不改变正式 wire type 或 Session format。
whyDraftOnlyWasInsufficient: 两个正式 DSH consumers 共用同一 PoC route，但分别需要 persistence snapshots 和 controller summaries；只保留任一字段都会破坏另一个 consumer。
behaviorChange: 仅在 docs-owned backend response 中新增 `items`，保留原有 `snapshots` 及其字段；items 提供 Controller 列表所需的 sessionId、updatedAt、running、blank、cwd 和 agentAvailable 值，其中 updatedAt 暂映射 header.createdAt，running 和 agentAvailable 固定为 false。
consumersUpdated: SessionPersistence 继续读取 snapshots；Session Controller 使用 items 建立可 retain 的 Session list；assistant-ui PoC 通过该列表恢复已记录的 Session id。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`；assistant-ui PoC Chromium E2E 验证刷新后只复用原 Session 并显示其持久化历史。
syncReplaySteps: 从 upstream 更新后重新核对 SessionPersistence 的 list response 和 Client Session Controller 的 SessionListValue；若两者仍复用该 route，保留两个字段并运行 backend-v2 tests 与 assistant-ui browser E2E；若 backend 改为正式 DSH route，删除此 docs-owned projection 并验证两个 consumer。
deleteCondition: SessionPersistence 和 Session Controller 不再共用本地 PoC session/list route，且替代 route 的兼容性测试通过。
status: implemented
```

## 当前登记

### BN-P1-001：preview 使用 docs-owned browser-native Worker entry

```text
changeId: BN-P1-001
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts; packages/experimental/webworker-runtime/src/worker.ts
file: apps/web/src/preview.ts
reason: 现有 preview 只加载上游固定 Worker bundle，无法把 docs-owned Remote Session/LLM provider 注入同一个 Worker Host；需要一个可替换的实验 Worker entry，同时保留现有 preview page、tunnel 和 AppWebEntry。
existingExtensionPointsChecked: 已核对 `createWorkerHost`、`WorkerHostOptions.staticModules`、`requireActiveModuleLoader`、preview 的 `?worker` import 和 `connectWorkerHost`；provider 仍通过后续 static module/profile overlay 接入，不修改 agent-loop、Session format 或普通 Web entry。
whyDraftOnlyWasInsufficient: Vite 入口必须位于当前应用的构建图中，单独把 Worker 文件放在 docs 目录不会自动替换 `preview.ts` 的 `?worker` import。
behaviorChange: 只改变 preview 实验入口使用的 Worker bundle；普通 `index.html`、`AppWebEntry`、Desktop 和默认 `dsh web` 启动保持不变。
consumersUpdated: `apps/web/src/preview.ts` 继续调用上游 `chooseWorkerHostSource` 和 `connectWorkerHost`；新增 Worker 复用相同的 init frame、image、overlay 和 request tunnel，并追加 browser-native profile overlay。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; 现有 `apps/web/tests/preview-boot.e2e.ts`; browser-native provider/backend contract tests; docs-owned Worker 的 TypeScript build path; `git diff --check`。
syncReplaySteps: 从 upstream 更新时重新对比 `apps/web/src/preview.ts` 和 `webworker-runtime/src/worker.ts` 的初始化顺序；优先把新增 static module seam 接回上游 Worker entry，若上游支持可配置 Worker factory 则删除本地复制的 entry，只保留 docs provider。
deleteCondition: v2 PoC 移除或上游 preview 提供等价的 Worker injection hook；删除该 import 后普通 preview boot acceptance 仍通过。
status: implemented
```

### BN-P1-002：Browser-Native preview 卸载时终止所属 Worker

```text
changeId: BN-P1-002
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts; packages/experimental/webworker-runtime/src/client/index.ts
file: apps/web/src/preview.ts
reason: Browser-Native preview 需要明确终止由页面拥有的 Worker，并将 teardown 期间特定的 boot-payload failure 与活动页面启动失败区分；此前报告的刷新 503 最终定位为 E2E 每轮执行两次导航造成，修复测试后连续刷新未复现。
existingExtensionPointsChecked: 已核对 `connectWorkerHost()` 的 boot payload handshake、`AppWebEntry.run()` 对 `__DSH_BOOT_READY__` 的等待、WorkerTunnel 和 Browser-Native `pagehide` owner close beacon；处理仅绑定 `?browser-native=1`，未改通用 Worker transport 或普通 Web/desktop 启动。
whyDraftOnlyWasInsufficient: `apps/web/src/preview.ts` 是 Vite preview 的 Worker 创建入口；只在 docs-owned page helper 中添加 listener 无法在 Worker 创建前捕获顶层 bootstrap rejection，也无法终止由 preview 页面创建的 Worker。
behaviorChange: Browser-Native preview 在非 BFCache 的 `pagehide` 时标记页面卸载并 terminate 页面拥有的 Worker；若该页面等待 boot payload 时因 teardown 收到匹配的 boot failure，则只结束正在卸载的 bootstrap。其他错误和活动页面中的相同错误仍会抛出。默认 preview 与 `browser-native=0` 路径保持原启动失败行为。
consumersUpdated: `apps/web/src/browser-native-page-control.ts` 的 page-control beacon 仍在正常 unload 时请求 Session close/flush；runtime-validation helper 在 `page.reload()` 后只等待已加载页面，不再再次 `page.goto()`；lifecycle E2E 复用同一等待逻辑。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; backend/Symbol tests 9 passed; scripted Chrome/WebKit runtime/lifecycle E2E; WebKit scripted five-refresh run; real Chrome/WebKit runtime E2E with two refreshes each; `git diff --check`。
syncReplaySteps: upstream 更新后重查 preview bootstrap、boot readiness rejection 和 Worker ownership；若上游提供页面销毁钩子，则迁移 terminate 行为到该钩子；保留仅 opt-in 的卸载处理，并运行默认 preview boot acceptance、Browser-Native scripted lifecycle 和真实 Chrome/WebKit refresh E2E。
deleteCondition: Worker connector 自行提供等价的 page teardown cancellation/cleanup，且移除此 opt-in 行为后 Chrome、WebKit 和目标 Safari.app 刷新没有未处理 boot error，也不遗留旧 Worker 请求。
status: implemented
```

### BN-P1-003：将 preview 页面 bridge 纳入 Web TypeScript 项目

```text
changeId: BN-P1-003
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/tsconfig.json; apps/web/src/preview.ts
file: apps/web/src/browser-native-page-control.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: `apps/web/src/preview.ts` 从 `docs/drafts` 直接导入 TypeScript 时，推送钩子执行的 `tsc -b tsconfig.client.json` 报告 TS6059 和 TS6307，因为草稿文件不在 Web 项目的 `rootDir` 和文件列表内。
existingExtensionPointsChecked: 已核对 Web 项目的 `rootDir`/include 配置、preview 的 Worker 注入入口和既有 pagehide owner-close 实现；没有扩大 TS 项目范围，也没有把 PoC Worker、backend、profile 或测试移入正式应用目录。
whyDraftOnlyWasInsufficient: preview 必须同步执行 owner-token MessagePort、刷新续接和 unload close beacon；其静态导入必须属于 `apps/web` TypeScript project 才能通过推送钩子的项目类型检查。
behaviorChange: 页面 bridge 代码位置从 docs-local 草稿移动到 `apps/web/src`，运行逻辑不变；PoC 配置、Worker、backend、测试和说明仍在 `docs/drafts/browser-native-dsh-poc`。
consumersUpdated: `preview.ts` 导入项目内 bridge；PoC README 链接到该源码；此账本记录目录外改动与 upstream 重放步骤。
tests: 2026-10-21 移动后 `pnpm run typecheck` 和 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过；`pnpm exec tsx scripts/run-oxlint.ts apps/web/src/preview.ts apps/web/src/browser-native-page-control.ts` 通过；Chrome scripted `runtime-lifecycle.e2e.mjs` 与 `runtime-validation.e2e.mjs` 在移动后通过。首次 typecheck 在移动前以 TS6059/TS6307 失败；移动后全仓类型检查确认错误消失。真实 Chrome Browser-specific E2E 在 bridge 移动前通过，详细记录见运行时验证报告。
syncReplaySteps: 更新 Web 项目时先检查 apps/web TS project root/include；如果 preview lifecycle bridge 仍由 `preview.ts` 导入，保留 bridge 在 `apps/web/src`，PoC 其余源码留在 docs；若上游提供正式 preview lifecycle hook，则迁移到该 hook 并删除本地 bridge。
deleteCondition: preview 使用正式生命周期 API 管理 Worker/Session owner，且移除本文件后 Web typecheck、刷新续接、pagehide close 和双标签 lease E2E 均通过。
status: implemented
```

### 目录外改动审计结论

当前 Browser-Native PoC 的运行时代码目录外接线位于 `apps/web/src/preview.ts`；它静态导入 docs-owned Worker，opt-in 页面装载 Browser-Native overlay、连接 owner control channel，并在正常 pagehide 时结束页面拥有的 Worker。其他已登记的目录外改动分别位于 core tool schema converter 和翻译 manifest。未来从 upstream tag 或 main 重放时，按各 changeId 检查上游是否已有等价 Worker、schema 或文档登记扩展点；移除可替代 patch 后运行默认 preview acceptance、package tests 和 Browser-Native Chrome/WebKit E2E。

### BN-P2-001：browser-native preview profile 与远程 provider

```text
changeId: BN-P2-001
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/experimental/webworker-runtime/src/worker-host.ts; packages/bundle/base/cordis.patch.yml; packages/bundle/web-app/cordis.patch.yml
file: apps/web/src/preview.ts
reason: 现有 Web profile 默认激活本地 JSONL SessionPersistence 和本地 LLM provider；browser-native PoC 需要在同一个 Worker Host 中改用正式远程 SessionPersistence/LlmAdapter，而不能在页面复制 Agent Loop 或自定义 UI。
existingExtensionPointsChecked: 已核对 Worker Host 的 `/dsh/home/cordis.patch.yml` home patch、`SessionPersistence`、`LlmAdapter`、`WorkerHostOptions.staticModules`、`AppWebEntry` 和 `connectWorkerHost`；未修改 agent-loop、Session event format、普通 Web entry 或 Desktop profile。
whyDraftOnlyWasInsufficient: profile patch 必须作为 VFS home overlay 随 Worker init frame 装载，static module provider 必须进入 Vite Worker bundle；仅在 docs 中放置 YAML/TS 文件不会被 Worker Host 读取。
behaviorChange: 仅 preview 实验入口追加 browser-native profile overlay；普通 `index.html`、默认 `dsh web`、Desktop 和 Headless profile 不改变。preview 仍由现有 `AppWebEntry` 渲染完整 DSH Web UI。
consumersUpdated: `browser-native-worker.ts` 合并 Node builtins 与 docs-owned static providers；`preview.ts` 追加 `browser-native-profile-overlay.tar.gz`；`home/cordis.patch.yml` 停用 JSONL row、通过 VFS-local relative plugin entry 注册 remote Session/LLM rows（LLM row 注入 `llm`），并覆盖 `agent-default-model`。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts`; backend/provider contract tests; scripted and real Playwright E2E; secret-redaction assertions。
syncReplaySteps: 从 upstream 更新时先对比 `preview.ts` 和 `worker.ts` 的 init/overlay 顺序；若上游提供 Worker profile/static-module injection hook，优先迁移到该 hook并删除本地复制；重新生成或校验 home overlay，再运行 preview boot 和 browser-native E2E。
deleteCondition: 上游 Web preview 能通过正式 injection hook加载等价 provider/profile，且删除本条接线后 browser-native E2E仍通过；否则保留并继续以 docs目录外最小接线维护。
status: implemented
```

### BN-P2-002：browser-native preview 使用显式 opt-in overlay

```text
changeId: BN-P2-002
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts
file: apps/web/src/preview.ts
reason: 无条件追加 browser-native profile overlay 会改变现有 preview acceptance 的默认 Worker 数据源契约；PoC 需要 provider overlay，但普通 Preview 必须继续使用上游 overlay 列表。
existingExtensionPointsChecked: 已核对 preview.html 的 query 入口、`chooseWorkerHostSource`、`connectWorkerHost` 和现有 `preview-boot.e2e.ts`；没有为普通 Web、Desktop 或 Agent Loop 增加 browser-specific 分支。
whyDraftOnlyWasInsufficient: Vite preview entry 必须读取浏览器 URL 才能选择 overlay；只在 docs 目录写入 profile 不会阻止默认 preview 加载它。
behaviorChange: 只有 URL 包含 `browser-native=1` 的 preview 才追加 browser-native profile overlay；默认 preview 保持原有 overlay 列表，但仍使用 BN-P1-001 引入的 docs-owned Worker entry。
consumersUpdated: browser-native PoC 启动说明使用 `preview.html?browser-native=1&preview-fixture=none`；默认 `preview.html?preview-fixture=none` acceptance 继续断言 `data overlays=0`。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts`; browser-native Playwright E2E 使用 opt-in URL。
syncReplaySteps: 从 upstream 更新时重新核对 preview query 解析和 overlay 顺序；若上游提供显式 profile/Worker injection 参数，迁移 PoC 到该参数并删除本地 query 分支；否则保留此最小接线并运行默认 preview 与 opt-in browser-native tests。
deleteCondition: browser-native PoC 改用上游正式 Worker/profile injection hook，且删除 query 分支后默认 preview 与 browser-native E2E 均通过。
status: implemented
```

### BN-DOC-001：browser-native PoC v2 重新规划

```text
changeId: BN-DOC-001
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts, packages/experimental/webworker-runtime
file: docs/drafts/browser-native-dsh-poc/browser-native-dsh-plan-v2.md; docs/drafts/browser-native-dsh-poc/browser-native-dsh-progress-v2.md; docs/drafts/browser-native-dsh-poc/README.md
reason: 旧 PoC 使用独立 HTML、PoC-local loop 和自定义事件，不能证明现有 DSH Web UI、Cordis 插件组合和真实 ctx.agentLoop 在浏览器 Worker 中运行。
existingExtensionPointsChecked: 已核对 AppWebEntry、preview Worker tunnel、appBoot.boot、WorkerHostOptions.staticModules、webworker packer、LlmAdapter 和 SessionPersistence；v2 首选通过 custom Worker entry、static modules 和 profile overlay 接入。
whyDraftOnlyWasInsufficient: 旧实现代码不能仅靠文档声明变成真实 DSH runtime，因此先新增自包含 v2 规格和恢复进度记录，再按规格重做实现。
behaviorChange: docs-owned v2 PoC 已经实现，但普通 Web、Desktop、Headless profile 和 DSH 核心运行时仍没有被修改；preview 始终加载实验 Worker entry，browser-native profile overlay 需要显式 opt-in。
consumersUpdated: 本 README 指向 v2 规划和进度；旧协议文档继续作为历史实验记录。
tests: 规划文档写入后运行 docs gates、Markdown link/budget 检查和 git diff --check；实现后运行 `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`、scripted/real browser-native Playwright E2E、preview build 和默认 preview acceptance。
syncReplaySteps: 从 upstream 更新时先保存本账本和 v2 tests，重新核对 preview/runtime/packer/LLM/Session 入口，再按 v2 规划重放最小 docs 外接线；若 upstream 提供正式 Worker plugin injection 或 remote persistence hook，则改用该入口并删除本地 seam。
deleteCondition: v2 实现已使用上游正式 hook，或 v2 PoC 被移除；删除 browser-native 专用目录外接线后普通 preview 和 Web tests 仍通过。
status: implemented
```

### BN-P2-003：增加 browser-native Session owner lease 与刷新续接

```text
changeId: BN-P2-003
upstreamBaseline: docs-owned v2 backend before owner renewal / backend-v2.mjs; browser-native-providers.ts; browser-native-worker.ts
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/run-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/assistant-ui-browser-native-dsh-poc/src/dsh-client.ts; docs/drafts/assistant-ui-browser-native-dsh-poc/tests/browser-native-ownership.e2e.mjs
reason: 页面崩溃、Worker 强制结束或刷新时，旧 owner 会阻塞同一 Session 的后续写入并产生 `already owned` 或 `missing write lease`；Browser-Native PoC 需要有限时写租约、续租和同一标签页的刷新续接。
existingExtensionPointsChecked: 已核对 Session Controller 的 open/retain/release 生命周期、Worker Host 的 disposer、backend session operation route、pagehide/sendBeacon 和 assistant-ui 页面内的 MessageChannel；实现保持在 docs-owned backend/Worker/client adapter，不改变 Session format 或正式 owner API。
whyDraftOnlyWasInsufficient: owner fencing 位于 backend route 和 Worker provider 的共同生命周期中，只修改页面提示无法回收 stale owner；只增加页面重试也无法避免跨标签页并发写入。
behaviorChange: v2 backend 默认提供 30 秒 owner lease，Worker 约每 10 秒 renew；正常卸载发送 close/flush；assistant-ui 在当前标签页 sessionStorage 保存 Session id 和 owner token，并在刷新后通过独立控制通道尝试续接；其他标签页仍收到 ownership conflict，过期 owner 会被 backend reclaim。
consumersUpdated: browser-native Worker/provider、assistant-ui client、owner error UI 和对应契约/E2E 测试共同使用 lease/renew/close 语义。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`; `pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:ownership`; real Chrome/Safari assistant-ui E2E；real Chrome browser-native v2 E2E。
syncReplaySteps: 从 upstream 更新后重新核对 Session Controller retain/release、Worker teardown 和 backend session route；若上游提供正式 owner lease/handoff capability，迁移 adapter 到该 capability 并删除 docs-owned renewal；重新运行 backend contract、ownership、Chrome 和 Safari real E2E。
deleteCondition: 上游提供等价的过期回收、续租、关闭释放和刷新续接语义，且 assistant-ui 与原生 Web UI 的 ownership E2E 不再依赖本目录实现。
status: implemented
```

### BN-P2-004：修复 Safari/WebKit 原生 JSON Schema 构造器识别

```text
changeId: BN-P2-004
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/core/tools/src/json-schema.ts
file: packages/core/tools/src/json-schema.ts; packages/core/tools/tests/json-schema.spec.ts; packages/core/tools/README.md; packages/core/tools/README.zh.md
reason: Safari/WebKit 对 `Function.prototype.toString()` 的原生 `Object`/`Array` 构造器格式与 Chromium 不同，工具参数 schema 被误判为不支持并阻止 Session 创建；修复必须让真实浏览器加载 DSH tool preset。
existingExtensionPointsChecked: 已核对 raw JSON Schema validator、parameter schema conversion 和 tool preset loading；只替换 intrinsic constructor 的检测方式，保留 schema subset、wire fields 和错误语义。
whyDraftOnlyWasInsufficient: schema conversion 在 DSH core package 内执行，PoC 页面或 backend 无法可靠绕过 tool preset 的同源校验；浏览器端错误会在 Agent Loop 启动前发生。
behaviorChange: `Object`/`Array` intrinsic constructor detection 以当前运行时原生函数的实际源码表示作比较，不依赖 Chromium 的固定字符串；非原生或跨 realm 的 constructor 仍被拒绝。
consumersUpdated: tool schema converter、WebKit formatting regression test、工具 package README 与 assistant-ui/browser-native real E2E 共同覆盖该兼容行为。
tests: `pnpm exec vitest run packages/core/tools/tests/json-schema.spec.ts`; assistant-ui real Chrome/Safari E2E；browser-native v2 real Chrome E2E。
syncReplaySteps: 从 upstream 更新后重新核对 `hasIntrinsicConstructor` 的安全条件和当前浏览器矩阵；保留跨 realm/不同 native formatting 测试，运行 tools tests、typecheck/build 和 browser real E2E。
deleteCondition: 上游 schema validator 接受 Safari/WebKit 原生 constructor formatting，且移除本修复及回归测试后所有工具 preset 和真实浏览器 E2E 仍通过。
status: implemented
```

### BN-DOC-000：将 PoC 草稿目录登记为中文 scratch 文档

```text
changeId: BN-DOC-000
upstreamBaseline: dsh-v0.2.0-rc.2 / scripts/translation-pairing.manifest.json
file: scripts/translation-pairing.manifest.json
reason: 本目录是中文单语的实施草稿，必须与现有 docs/drafts 研究文档保持相同的翻译门禁范围。
existingExtensionPointsChecked: 已检查 translation-pairing manifest、docs/i18n/README.md 和现有 docs/drafts 排除项；Markdown frontmatter 没有单文件 scratch 标记。
whyDraftOnlyWasInsufficient: 翻译门禁按仓库路径发现 Markdown，若不登记目录，任何新草稿都会被要求提交完整英文 counterpart 和 i18n record。
behaviorChange: 仅改变文档翻译门禁的范围；不改变 DSH runtime、package、profile 或生成物。
consumersUpdated: 无运行时 consumer；translation-pairing gate 读取该 manifest。
tests: pnpm run test:docs; pnpm run doc-sync; git diff --check
syncReplaySteps: 从 upstream 更新时保留该目录级排除；若该目录转为正式双语文档，先补齐每个文档的 .zh.md 和 .i18n.yaml，再删除本排除项。
deleteCondition: 本目录内所有文档都进入双语文档 corpus，且 translation-pairing gate 在移除排除项后通过。
status: implemented
```

## 登记模板

复制下面的模板创建新的 `changeId`。不要用提交 hash 代替 `upstreamBaseline`；仓库的上游版本、tag 或被核对的公开文件路径才是未来重放所需的事实。

```text
changeId: BN-P0-000
upstreamBaseline: 0.2.0-rc.2 / packages/<group>/<package>/src/<file>.ts
file: packages/<group>/<package>/src/<file>.ts
reason: <required>
existingExtensionPointsChecked: <required>
whyDraftOnlyWasInsufficient: <required>
behaviorChange: <required>
consumersUpdated: <required>
tests: <required>
syncReplaySteps: <required>
deleteCondition: <required>
status: proposed
```

## 登记规则

优先级必须按以下顺序尝试：本目录内的 adapter、fixture、独立 backend、exact route、PoC image、test composition，然后才是独立 experimental package，最后才是通用核心 extension point。

禁止为 PoC 在核心 Agent Loop、Session format、普通 `web` profile、Desktop profile 或 Connection trust fence 中加入 browser-specific 条件分支。若通用 extension point 确实必要，必须证明 Node、Desktop、Headless 和普通 Web 的旧行为不变。

`syncReplaySteps` 必须能指导未来从 upstream main 或 tag 更新当前分支：先保存本账本和测试，再应用上游版本，按文件顺序重放最小 patch，运行 ledger 中列出的 tests，最后检查 upstream 是否已经提供等价能力并决定保留、缩小或删除本地改动。

`deleteCondition` 必须是可观察条件，例如某个公开 hook 已经存在且 PoC 测试改用该 hook 后通过；不能写成“以后重构”或“等稳定”。

## Dev Note

本账本本身属于 PoC 草稿，不是 release note，也不是永久架构决策。若某项改动最终进入正式 DSH，应在完成上游化后把决定转移到对应 package README、architecture 文档或 Agent Note，并在本账本保留一条指向新 owner 的简短记录。
