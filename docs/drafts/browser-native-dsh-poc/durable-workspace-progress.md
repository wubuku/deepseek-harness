---
description: "记录 Browser-Native DSH durable Workspace PoC 的实施进度、命令、证据、阻塞和经验教训。"
---

# Browser-Native DSH Durable Workspace PoC 进度

## 状态

- **分支**：`research`
- **目标**：在不破坏既有文件级 Workspace PoC 的前提下，验证 OPFS/IndexedDB 本地 durable outbox 与真实 Browser-Native DSH 文件工具的兼容性。
- **当前阶段**：M0–M3 已完成首轮验证，M4 已补充上传失败和 commit unknown 的首轮 Chrome 验证；超时、存储损坏和 eviction 等故障仍未完成。
- **最后更新**：2026-10-21

## 里程碑

| 里程碑 | 状态 | 证据 | 备注 |
|---|---|---|---|
| M0 固定既有基线 | 已完成 | 既有 Workspace 单测、backend 测试、preview build | 默认 URL 仍使用内存模式 |
| M1 本地 durable store | 已完成首轮 | `durable-workspace.spec.ts`、Chrome OPFS/IndexedDB round-trip | OPFS bytes + IndexedDB metadata，孤儿 blob GC 尚未实现 |
| M2 pending 恢复与幂等 | 已完成首轮 | 15 项 Workspace 单测；真实 Chrome 503 故障恢复 E2E | 失败后的 operationId 保留由单测和真实刷新重试共同证明 |
| M3 真实 DSH 文件工具 | 已完成首轮 | 真实 Chrome + 真实 LLM：`read → write → read`、刷新后 `read`、Workspace commit | 验收使用 `/dsh/home/workspace`，证明了 Worker/DSH/VFS/mirror 链路 |
| M4 故障注入与证据 | 部分完成 | `durable-workspace-recovery.e2e.mjs` 和 `durable-workspace-failure-matrix.e2e.mjs`：真实 Chrome Worker、OPFS、IndexedDB、503、上传失败、commit 响应丢失、operation 查询和幂等恢复 | 上传失败与 commit unknown 已有首轮证据；commit 超时、缺 blob、损坏 snapshot、eviction 和 Safari/WebKit 仍未验证 |

## 实施记录

### 2026-10-21：规划

- 已阅读云端 Workspace 调研报告及既有 PoC 的实现与测试。
- 已确认当前 `VfsMutationSink.record()` 是同步 post-commit observer，不能直接承诺 journal-first durability。
- 本批次采用 `MemoryVfs` 运行时副本加 OPFS/IndexedDB durable store，不立即重写 Node-compatible VFS。
- 经验教训：先验证“本地可恢复”这一最危险的不变式，再做 chunking 或复杂多端协同；否则会把传输优化建立在易丢状态的本地层之上。

### 2026-10-21：首轮实现与验收

- 新增 `browser-native-workspace-store.ts`：Memory store 用于单测，Browser store 使用 OPFS 保存 content-addressed bytes，IndexedDB 保存 snapshot、pending 和 retry batch；相同 hash 不重复写 blob，损坏或缺失 blob 会拒绝恢复。
- `BrowserNativeWorkspaceMirror` 增加可选 durable store；默认仍为内存模式。恢复顺序是远端 manifest hydrate、回放本地 retry/pending、再允许 Worker Host 继续启动；`prepareVfs` 仍在 Cordis boot 前执行。
- `apps/web/src/preview.ts` 和 Worker 只增加 `browser-native-durable=1` opt-in；普通 `browser-native=1` URL 行为未改变。目录外接线已登记在 `change-ledger.md`。
- 单测通过：Workspace 原有 11 项，加 durable store/恢复 4 项，共 15 项；draft TS 定向检查通过；preview build 通过。
- 真实 Chrome storage E2E 通过：OPFS 写入/读回、IndexedDB 写入/读回、`persisted=false`（请求机制不是保证）、无 page error、无跨 origin 请求。
- 真实 Chrome + 真实 LLM durable E2E 通过：工具序列为 `read → write → read`，写入 `/dsh/home/workspace/browser-validation/output.txt`，刷新后文件仍可读，Session 57 events，`durableThroughSeq=56`，无 page error，LLM 只走同源 proxy。
- 真实故障注入首轮观察到 `/workspace/commit` 返回 503，刷新后页面继续工作并出现成功 commit；但同一脚本的后续真实模型探针多次遭遇上游 60/180 秒超时，不能把该轮写成完整 PASS。

### 2026-10-21：模型无关的 Chrome 故障恢复验收

- 新增 `tests/durable-workspace-recovery.e2e.mjs`，通过仅在 `browser-native-test=workspace-recovery` URL 下启用的 Worker MessagePort 测试接缝，直接在真实 Worker 的共享 `MemoryVfs` 写入 Workspace 文件；该脚本不调用 LLM，因此不把上游模型延迟混入故障恢复结论。
- 测试第一次 `/api/browser-native/workspace/commit` 强制返回 503；确认 IndexedDB snapshot 仍含 `retryBatch.operationId` 和 `recovery.txt`，OPFS 中仍有对应 content-addressed blob；随后刷新页面，新的 Worker 先 hydrate 远端 manifest，再恢复本地 retry，并以相同 `operationId` 成功提交。
- 真实 Chrome 结果通过：`commitAttempts=2`、`revisions=[0,1]`、无 page error、无跨 origin 请求；刷新后 IndexedDB 的 `pending=[]` 且没有 `retryBatch`，远端 manifest 和 blob 内容与本地写入一致。
- 该测试接缝只用于 PoC 自动化验收，不是产品 API；它证明的是 Worker/OPFS/IndexedDB/Workspace commit 的恢复链路，不替代真实 LLM `tool-fs` 闭环。

### 2026-10-22：高价值故障与并发验证

- `durable-workspace-failure-matrix.e2e.mjs` 在真实 Chrome Worker 中注入一次 blob upload 503，并在第二个文件的 commit 响应被连接重置后查询 operation receipt；最终 `uploadAttempts=3`、`commitAttempts=2`、`operationLookups=2`、revision `0 → 2`，无 page error 和跨 origin 请求。
- `workspace-v2.mjs` 增加显式 Workspace writer lease、fencing token 和 operation receipt query；它们只在 `browser-native-workspace-lease=1` 下由 Worker 使用，默认 Browser-Native 和内存 Workspace 行为不变。
- `workspace-writer-lease.e2e.mjs` 使用同一 Chrome context 的两个页面验证 claim 冲突、release/reclaim 和旧 token renew 被拒。该测试先续租，避免 preview 启动超过 30 秒时把自然过期误判为并发冲突。
- `browser-native-file-matrix.e2e.mjs` 验证 Worker VFS 的 mkdir、write、append、stat、list、chmod、rename、remove、Unicode、二进制和 atomic-write staging 过滤；`session-workspace-reconciliation.test.mjs` 只验证 receipt 协议和失败分类，尚未接入 DSH Agent Loop 的自动 receipt 写入。

## 实施经验

- `VfsMutationSink.record()` 是同步 post-commit observer；durable snapshot 只能在 mutation 已提交后异步写入。因此本批次只能承诺“snapshot 写入完成后可恢复”，不能宣称消除了 VFS commit 到本地 snapshot commit 的崩溃窗口。
- 本地 snapshot 的 `revision`、`retryBatch.baseRevision` 和 `operationId` 必须一起恢复。不能只恢复 bytes，否则重试会丢失 CAS/幂等语义。
- 远端 manifest hydrate 后再回放本地 dirty changes，才能同时保留远端基线和本地未提交内容；空远端 workspace 不能被当作干净状态。
- OPFS 与 IndexedDB 没有跨存储事务；先写 blob、后写 metadata 会留下可回收孤儿 blob，但不会让 metadata 指向不存在的已确认 blob。反向顺序会扩大恢复时的缺 blob窗口。
- 浏览器故障测试不能只看模型回合是否成功。Workspace commit 状态、local retry snapshot、remote revision 和 Worker 重建后的文件内容必须分别采集。

## 命令记录

本批次专属命令和结果：

```text
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts  # 15 passed
pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --lib ES2024,DOM --types node --skipLibCheck <durable workspace sources and test>  # passed
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview  # passed
DSH_POC_BROWSER=chrome ... node docs/drafts/browser-native-dsh-poc/tests/browser-storage-boundary.e2e.mjs  # passed
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-recovery.e2e.mjs  # passed: commitAttempts=2, revisions=[0,1], same operationId
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 ... node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs  # passed once; real provider has intermittent timeout
```

历史基线命令和结果见 `cloud-backed-workspace-sync-progress.md`；未执行的全套文档门禁在最终验证前不能写成通过。

## 阻塞与限制

- 已有模型无关 Chrome E2E 只覆盖一次性 commit 503；OPFS/IndexedDB 清除、缺 blob、损坏 hash、quota/eviction 和 commit 超时仍需要独立故障注入，Node 单测不能替代。
- 若不扩展 `MemoryVfs` 的 mutation 前置接缝，本批次只能保证“snapshot 持久化完成后可恢复”，不能消除 VFS commit 到 snapshot commit 之间的窗口；该差异必须在结果中明确。
- Safari/WebKit 不属于本批次首轮验收。

## 下一步

1. 为上传失败、commit 超时、缺 blob、损坏 hash、IndexedDB snapshot 损坏和 quota/eviction 增加可控 Chrome 故障测试。
2. 决定是否需要 `MemoryVfs` 的 mutation 前置接缝；在此之前不得宣称 journal-first 原子性。
3. 评估是否需要 blob GC、`navigator.storage.persist()` 请求和生产级 operation status query。
