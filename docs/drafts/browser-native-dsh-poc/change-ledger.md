---
description: "Browser-native DSH PoC 的目录外改动账本：记录所有不得默认留在核心分支中的必要改动，以及未来从 upstream 重放或删除它们的步骤。"
---

# Browser-native DSH PoC 变更账本

## Summary

本文件是 `docs/drafts/browser-native-dsh-poc/` 的变更登记 owner。默认状态是：PoC 只修改本目录，不需要登记目录外改动。

任何修改 `docs/drafts` 之外文件的实施者，都必须在提交该修改前增加一条记录，写明当前 DSH 版本、文件、必要性、被检查过的扩展点、测试、上游同步步骤和删除条件。没有登记的目录外修改视为 PoC 未完成，而不是“实现细节”。

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
behaviorChange: 只有 URL 包含 `browser-native=1` 的 preview 才追加 browser-native profile overlay；默认 preview 保持原有 overlays、Worker Host 和 UI 行为。
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
behaviorChange: docs-owned v2 PoC 已经实现，但普通 Web、Desktop、Headless profile 和 DSH 核心运行时仍没有被修改；只有 opt-in browser-native preview 会加载该实验接线。
consumersUpdated: 本 README 指向 v2 规划和进度；旧协议文档继续作为历史实验记录。
tests: 规划文档写入后运行 docs gates、Markdown link/budget 检查和 git diff --check；实现后运行 `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`、scripted/real browser-native Playwright E2E、preview build 和默认 preview acceptance。
syncReplaySteps: 从 upstream 更新时先保存本账本和 v2 tests，重新核对 preview/runtime/packer/LLM/Session 入口，再按 v2 规划重放最小 docs 外接线；若 upstream 提供正式 Worker plugin injection 或 remote persistence hook，则改用该入口并删除本地 seam。
deleteCondition: v2 实现已使用上游正式 hook，或 v2 PoC 被移除；删除 browser-native 专用目录外接线后普通 preview 和 Web tests 仍通过。
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
