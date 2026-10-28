---
description: "记录标准 DSH 文件工具在 OPFS 外置工作区上的资源、载荷和恢复验证结果。"
---

# OPFS 外置工作区标准工具资源包络验证进度

本文件记录[验证计划](opfs-standard-tool-envelope-validation-plan.md)在当前 checkout 的实际结果；脚本模型结果、真实 Chrome 结果和真实 LLM 结果分别统计。

## 基线

- 分支：`research`
- 开始时工作区：干净，与 `origin/research` 同步
- 隔离 worktree：无
- 浏览器主目标：Chrome；Safari/WebKit 本批暂停
- 实测环境：Chrome `156.0.8078.48`、macOS `26.6.2`、Node `v24.6.0`；本机单进程 PoC backend。
- 起点为前一批跨存储工具恢复交付后的已提交状态。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：核对近期实现与已有证据 | `complete` | 发现标准 `edit` 已经使用 OPFS copy-on-write；部分旧进度仍称其会完整 materialize，需按当前源码和新测试纠正。 |
| M1：计划和资源观测设计 | `complete` | 候选范围、交付面、通过条件和非目标见配套计划。 |
| M2：Worker/OPFS 与工具容量 E2E | `complete` | Chrome scripted DSH 工具闭环通过 12 MiB 单文件、64 MiB 单文件和 4×16 MiB 工作集；样本与采样限制见下表。 |
| M3：I/O 放大与 64 MiB unknown commit 恢复 | `complete` | 64 MiB 文件 edit 的 commit 响应丢失、Worker 终止、backend 重启和刷新后恢复均通过；operationId 相同、revision 只增加一次，单条 edit call/receipt。 |
| M4：真实 LLM smoke 与文档更新 | `complete with measurement gap` | Chrome + 真实 `gpt-5.6-sol` 使用 `original` roster 完成普通文件 `read → write → read` 与刷新恢复；8 个 LLM 请求均 HTTP 200，Session `durableThroughSeq=59`。已记录 runner 的 DOM/flush/结算时序；未完成首 body byte 与首 DSH chunk 的同钟拆解。 |
| M5：focused checks、最终 review、commit 和 push | `checks complete` | backend 48/48、Vitest 50/50、Web TypeScript、preview build、Chrome 容量/unknown commit/Stop/中断回归、真实 LLM smoke、`test:docs` 21/21、`doc-sync` 43/43、change-scope 与 diff 检查通过。全仓 lint 有下述既存错误；交付提交以 `research` 历史和远端 HEAD 为准。 |

## 实际验证

| 场景 | 实际结果 |
|---|---|
| Chrome 12 MiB 单文件 | `read → grep → edit → read` 与刷新后同 Session `read` 通过；VFS `residentBytes` 在 edit 期间增长 5,189 bytes；Worker heap 采样高水位为 168,312,220 bytes，同一采样的 backing storage 为 220,265,964 bytes；edit 后强制 GC 的 heap/backing storage 分别为 39,804,072/62,739,699 bytes。COW 累计读取 37,748,702 bytes、写入 12,582,912 bytes，完整新 blob 分 12 个 1 MiB chunk 上传。最大 Session/LLM body 分别为 13,438/12,689 bytes；revision 从 1 到 2，只有一个 edit receipt。 |
| Chrome 64 MiB 单文件 | `read → edit → read` 与刷新后同 Session `read` 通过；VFS `residentBytes` 增长 10,589 bytes；采样等待改为显式 Promise 后再次通过，edit/COW 约 2.93 s，58 个 Worker heap 样本的最大 `usedSize` 为 174,087,480 bytes，同一采样的 backing storage 为 464,230,130 bytes；强制 GC 后 heap/backing storage 分别为 39,696,748/62,745,059 bytes。COW 累计读取 201,326,558 bytes、写入及上传均为 67,108,864 bytes，上传分 64 个 1 MiB chunk。最大 LLM/Session body 分别为 12,249/13,428 bytes；revision 只增加一次。 |
| Chrome 4×16 MiB 工作集 | 4 个文件冷 hydrate 后以 64 MiB 逻辑工作集执行首文件 `read → grep → edit → read`；刷新后四个 hash 均与已提交 manifest 一致，未编辑路径保持不变。单次 edit 写入并上传 16,777,216 bytes（16 个 1 MiB chunk），revision 只增加一次；编辑期间 VFS `residentBytes` 增长 5,189 bytes。最终重跑 edit 约 673 ms、13 个 heap 样本高水位 174,686,056 bytes，同一采样的 backing storage 为 237,417,019 bytes；GC 后 heap/backing storage 为 39,902,456/62,739,935 bytes。 |
| 64 MiB unknown commit 恢复 | backend 完成 edit commit 后丢弃响应，测试终止 Worker、重启同一 `dataDir` backend 并刷新。相同 `operationId` 出现在首次 commit 和幂等 retry；三次 commit 请求包含 seed、首次 edit、同 operation retry，远端 revision 从 1 到 2；Session 只有一个 edit `tool/call` 和一个 receipt，结果以 `TOOL_OUTCOME_UNKNOWN` 结算，远端 blob 为 67,108,864 bytes 且 SHA-256 与 manifest 一致。 |
| CDP 采样限制 | Worker heap 通过 `Runtime.getHeapUsage` 每 50 ms 采样，并按 edit metrics 的开始/结束时间筛选；高水位是采样值，不是瞬时峰值、OS RSS 或 SLA。`backingStorageSize` 单独记录，不等同 JS heap；表中 backing storage 取自 heap 最大的样本，不是其自身最大值。强制 GC 后值只用于该次采样比较。`residentBytes` 只代表 VFS 节点驻留量。 |
| 真实 LLM smoke | Chrome + 真实 `gpt-5.6-sol`、`DSH_POC_ROSTER=original` 完成普通大小文件 `read → write → read`，刷新后同 Session 继续读取；8/8 LLM 请求与 2/2 Workspace commits 返回 HTTP 200，Session 有 60 个 events、`durableThroughSeq=59`。没有 page error 或跨源请求。日志中有非致命的 compaction context capacity warning，preview 的三个可选 API 返回 404，刷新期间有预期请求中止；这些未导致 turn 或恢复失败。该结果不覆盖 64 MiB 模型自主工具选择。 |

实际运行命令：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts
pnpm exec tsc --noEmit -p apps/web/tsconfig.json
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=12m node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=64m node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=workset node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TOOL_CANCELLATION_SCENARIO=stop-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TOOL_CANCELLATION_SCENARIO=crash-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
pnpm run change-scope --base origin/research
git diff --check
```

### 计数范围和时间线

表中 `bytesRead` 是 `replaceUtf8CopyOnWriteAsync()` 对源 hash、复制源区间和目标 hash 的累计计数，包含对目标文件的读取；它不包含此前 UTF-8 预检、marker 定位，以及之后 Workspace hash、缓存和上传读取。因此 64 MiB 样本的 201,326,558 bytes 不能称为一次 edit 的总读取量。`maxWorkingBytes=1,048,610` 只计算 COW buffer 加 replacement bytes，不包括 matcher/decoder 临时分配、OPFS、浏览器 fetch buffer 或 GC 尚未回收的对象；总资源成本以独立 CDP/存储采样和上传 body 计数补充观察。

真实模型 smoke 的 runner 观测首次可见 assistant 更新为发送后约 17.12 s，首 turn 结算为约 17.33 s，启动为约 2.52 s；同一 turn 的 Session flush 请求观测为 8–14 ms。脚本另记录 Session stream 自带的 `time0`，但它来自 Worker 时钟，不能与 runner 时间相减推断精确的投影延迟。本批没有新增上游首 body byte 或首个 DSH chunk 到达 runner 的探针，因此不宣称完成端到端流式延迟拆解；普通文件工具和刷新闭环的 PASS 不受此测量缺口影响。

### 回归与夹具经验

- backend contract tests 48/48、chunk editor/Workspace/durable store Vitest 43/43、file-tools Vitest 7/7 和 preview build 通过；构建保留既有平台、tsdown 和 bundle-size warning。
- 首次资源样本在 cold hydrate 后没有强制 GC，heap 中包含启动和先前搜索遗留分配；后续固定在工具调用前采样并强制 GC，分别报告 GC 前采样、GC 后基线、编辑期间采样和 GC 后留存。测试不会以采样值断言产品内存 SLA。
- unknown commit 夹具读取 Session 时必须带浏览器的 path-scoped principal cookie。测试使用 Node fetch 携带该 cookie 观察 backend 重启后的记录，没有放宽 Session 身份校验，也没有从页面额外发起用于观察的重启时序请求。
- 大文件 marker 采用 4 KiB 有界行，64 MiB 场景不执行受 32 MiB 扫描预算限制的 `grep`；4×16 MiB 场景仅 grep 首文件。测试不能把 64 MiB edit PASS 写成 64 MiB grep PASS。
- CDP 采样明确等待已发送请求的 Promise，并在 teardown 停止新采样后等待这些请求结算，不靠固定延时判断采样完成。工作集刷新逐项比对远端 manifest 的已提交 hash，不只检查内容发生过变化。
- 8 MiB `stop-edit` 与 `crash-edit` Chrome 回归通过：前者 UI Stop 至 terminal 观测约 149 ms、源文件/revision 不变；后者刷新后原调用结算为 interrupted/unknown、清理 staging 并继续同 Session。两项均无页面/Worker error 或跨源请求，不是 OS crash 证据。
- `pnpm run lint` 未通过：`packages/core/tools/tests/json-schema.spec.ts:251` 的 unbound method，以及 `apps/web/src/browser-native-recovery.ts:62` 的 unsafe assignment、`:252` 的 unnecessary condition。两文件相对本批起点均无改动；另有 `client-ui-cot-translation` 未使用 disable warning。本批未修改这些文件，未把全仓 lint 记为 PASS。

## 变更记录

- M1：新增本计划和进度，并实现可参数化 Chrome Worker 资源观测与 12/64 MiB、4×16 MiB 工具 E2E。
- M2/M3：扩展 commit-response-loss E2E 覆盖 64 MiB edit、完整 blob 校验、幂等 retry、backend 重启和 Worker 终止恢复。
- M4：真实 LLM smoke 通过，未将 scripted 大文件工具选择写成模型能力证据。
- 文档和验收已完成；主分支为 `research`，仅主 worktree，无隔离分支待吸收。提交和推送记录以 Git 为准。

## 阻塞与下一步

- 阻塞：无。
- 下一步：正式产品前继续测量完整 edit I/O 和低内存设备；本批不据局部 buffer 指标保证总内存恒定。首 body byte/DSH chunk 同钟时间线仍未验证。

## 用户验收服务

同源真实模型入口为 `http://127.0.0.1:5364/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`。启动检查确认端口未被占用；实际 backend health 返回 `llmMode=real`、`model=gpt-5.6-sol`、`llmTimeoutMs=180000`。Chrome 已打开页面、选择 Worker VFS 工作区并确认聊天输入框可见、Workspace `synced`。这是普通工作区手动入口，容量和故障注入仍用上述 E2E。

- worktree：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness`；分支 `research`。
- 进程 PID：`28839`；停止方式：`kill -TERM 28839`，等待该进程退出；不要终止其他已有服务。
- 数据目录：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-opfs-envelope-acceptance-p4FpGU/data`。
- 日志与 PID 文件：同级 `server.log`、`server.pid`；Chrome 截图：同级 `acceptance-chrome.png`。这些本机临时文件不进入 Git，系统清理临时目录后不保证保留。
- 验收镜像目录：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-browser-runtime-image-M4ZgCj/dist`，通过现有 `createRuntimeValidationDist({ roster: 'original' })` 生成，与真实 LLM smoke 使用相同 profile。
- 实际启动参数：`node docs/drafts/browser-native-dsh-poc/run-v2.mjs --port 5364 --dist-root <上述镜像目录> --data-dir <上述数据目录> --llm real --env-file docs/drafts/.env --llm-timeout-ms 180000`；模型密钥只由 backend 读取。
- 初次直接使用共享 preview 内嵌 overlay 的手动入口出现账户 onboarding 弹窗，阻止选择工作区；改为当前源码生成的私有 `original` overlay 后 Chrome 输入框与 Workspace 就绪。不覆盖或清理共享 dist/cache，也不把 backend health 单独当作页面可用证明。

## 已知限制

- Worker heap 指标取决于本机 Chrome CDP 能否稳定采样；本次记录的是每 50 ms 的 heap 采样，不是精确峰值或进程 RSS，也不以 VFS `residentBytes` 代替 heap。
- 测试 backend 使用本地 PoC `dataDir`，不是生产对象存储或多实例服务。
- 单机基准不能构成浏览器内存 SLA、自然 eviction 或 OS crash 证据。
