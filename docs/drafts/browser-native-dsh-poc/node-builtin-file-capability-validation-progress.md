---
description: "记录 Browser-Native DSH 文件工具、Node builtin 方法调用与明确拒绝路径的实施和验证进度。"
---

# Browser-Native 文件能力与 Node API 调用验证进度

## 当前状态

状态：M0–M3 完成；Chrome scripted Worker E2E、真实模型文件工具 smoke 和 preview build 通过。文档门禁与提交前检查待执行。批次开始时 `research` 与 `origin/research` 同步，主工作区干净，只有主 worktree；没有隔离 worktree。验收范围见[验证计划](node-builtin-file-capability-validation-plan.md)。

本批只运行 Chrome；Safari/WebKit 暂停。真实 LLM 凭据仍只由 backend 从 `docs/drafts/.env` 读取。

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：代码路径与证据范围 | `complete` | 已核对 Worker module loader、静态 Node shim、DSH 文件工具、PoC test port 和既有 OPFS 大文件 E2E。标准 DSH `read` 直接调用 `ctx.fs.streamText/readText`，不经过 Node shim；属性读取代理不能证明函数执行且可能改变 namespace 身份，因此观察器位于 VFS Node shim API 入口。 | 完成真实 Worker trace 与 stub 拒绝验收。 |
| M1：有界方法调用 trace | `complete` | runtime 与 PoC 定向单测通过；observer 默认关闭，不包装 namespace/function；Promise wrapper 委托内部同步实现时不重复计数；记录只含 builtin/member 与计数。首轮新测试因空 VFS 没有 `/dsh` 目录失败，修正为递归建目录后通过。 | 扩展到真实 Chrome DSH 文件工具 E2E。 |
| M2：Worker stub 与 DSH 文件工具 | `complete` | Chrome scripted 12 MiB OPFS E2E 通过真实 DSH `read → grep → edit → read`、刷新后同 Session 再读、`node:fs/promises.readFile` 测试通道读取已提交 marker，以及 `node:net.createServer()` 明确拒绝。Worker trace 显示 first turn 为 0 次、刷新 turn 为 2 次、隔离 shim probe 恰为 1 次；turn 级调用数只作诊断，不作工具归因。编辑只上传 1 MiB、复用 11 MiB；Workspace revision 从 1 到 2，刷新未重放 edit；page/worker errors 与跨源请求均为 0。 | 更新兼容矩阵、文档索引和变更账本。 |
| M3：真实 LLM smoke | `complete` | Chrome + original roster + 同源 backend + `docs/drafts/.env` 的真实 `gpt-5.6-sol` 完成 `read → write → read`、流式文本、多轮记忆、刷新恢复与刷新后再次 DSH read。Session 60 events，`durableThroughSeq=59`；8/8 LLM HTTP 200，Workspace 两次提交均 HTTP 200。浏览器只向同源 LLM proxy 发模型请求，secret 检查和 page-error 断言通过；模型未用于 12 MiB scripted 大文件场景。 | 保留真实模型与 scripted 大文件证据分开陈述。 |
| M4：文档、提交与推送 | `in-progress` | PoC README、兼容矩阵、drafts 索引、runtime 中英文 README 与 pairing sidecar 已更新。`test:docs` 21/21、`doc-sync` 43/43、本批 Oxlint 和完整 `pnpm run build` 9/9 通过；完整 lint 有两处未修改文件错误，hygiene 有三项仓库既有失败。最终 diff、change-scope、提交与 push 待完成。 | 完成变更账本和 pre-push 检查，再提交并推送 `research`。 |

## 实际命令

实际运行命令与结果：

```sh
pnpm exec vitest run packages/experimental/webworker-runtime/tests/node/fs-member-observer.spec.ts packages/experimental/webworker-runtime/tests/node/fs.spec.ts packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-builtin-member-trace.spec.ts
pnpm exec tsc -b packages/experimental/webworker-runtime/tsconfig.json --pretty false
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_OPFS_ENVELOPE_SCENARIO=12m DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
pnpm run verify-translation-pairing packages/experimental/webworker-runtime/README.md
pnpm run test:docs
pnpm run doc-sync
pnpm exec oxlint packages/experimental/webworker-runtime/src/storage/active.ts packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs.ts packages/experimental/webworker-runtime/src/worker-host.ts packages/experimental/webworker-runtime/src/index.ts packages/experimental/webworker-runtime/tests/node/fs-member-observer.spec.ts docs/drafts/browser-native-dsh-poc/browser-native-worker.ts docs/drafts/browser-native-dsh-poc/browser-native-builtin-member-trace.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-builtin-member-trace.spec.ts docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
pnpm run lint
```

结果依次为 runtime 3 files/93 tests、PoC 1 file/3 tests、TypeScript build 通过、preview build 通过、Chrome 12 MiB E2E `passed`、真实模型 smoke 完成、README 配对一致、`test:docs` 21/21、`doc-sync` 43/43 和本批文件 Oxlint 通过。`doc-sync` 首次运行指出新增 export 缺少两个 `@param`，补齐后全过。最终完整 `pnpm run lint` 仍失败于未修改的 `apps/web/src/browser-native-recovery.ts` 两项和 `packages/core/tools/tests/json-schema.spec.ts` 一项；本批文件的 Oxlint 通过。真实模型日志包含非致命 compaction capacity warning、preview API 404 和刷新时 `ERR_ABORTED`；文件闭环、Session 持久化、模型请求状态和页面断言均通过。首次 E2E 曾因动态 `requestId` 严格比较失败；修正后证明 `node:net.createServer()` 拒绝。源码核对发现标准 DSH `read` 走 `ctx.fs` 而非 Node shim；随后发现 Worker 范围 trace 会混入同 turn 的其他文件读取，不能对单个工具归因。最终 E2E 分别验证真实 DSH 工具、同一已提交文件的隔离 Node shim 读取和 stub 拒绝。

`pnpm run build` 9/9 通过。`pnpm run hygiene` 18 项通过、3 项失败：vendor rescope 有 20 条既存 residue，workspace constraints 检出 13 个嵌套目录缺少 package.json，client route resolution 指向未修改的 `apps/web/src/browser-native-page-control.ts`。这些路径不在本批变更范围；未为其修改或清理。

## 风险与限制

方法调用 trace 不包装函数或记录参数；它只覆盖显式插桩的 API，不覆盖静态 ESM import 或完整 Node conformance。真实模型结果与 scripted 大文件工具结果分别记录，不互相代替。
