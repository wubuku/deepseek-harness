---
description: "记录不可变块对象存储的实现、GC 和故障验证，以及真实浏览器和模型证据。"
---

# Workspace 不可变块对象存储实施进度

## 当前状态

四个交付面已完成。不可变块消除了 CDC 复用 staging 写入和完整目标文件组装；保守 range 完整性检查同时暴露严重读取放大，当前选项保持默认关闭。起始主 `research` 与 `origin/research` 同步、工作区干净，只有主 worktree。候选与判据见[验证计划](chunk-object-storage-validation-plan.md)，脱敏结果见[Chrome 工件](chunk-object-storage-chrome-results.json)。

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 候选与规划 | 完成 | 聚焦服务端实测写放大，四个交付面 |
| M1 不可变块与文件版本 | 完成 | 纯存储 30/30；有界 descriptor、完整 hash、range、损坏、fallback、GC 与累计物理 I/O |
| M2 上传、读取、pending GC | 完成 | HTTP 集成 16/16；默认 backend 三文件 93/93；completed status 损坏回归也已通过 |
| M3 Chrome 成本与重启恢复 | 完成 | 9 场景 14 runs；最终四阶段恢复、64 MiB 冷缓存/GC 复跑通过，强制退回 staging 的负对照按预期失败 |
| M4 真实 LLM 与交付 | 完成 | Chrome 原 DSH Loop 三轮、8/8 模型 200、60 个事件全部 durable；实际 chunk/descriptor 写入得到断言；验收服务见后文 |

## 实现与成本结论

`workspaceChunkObjects: true` 是显式 backend 选项，与外部 `workspaceBlobStore` 互斥；启用后的 dataDir 重启必须沿用选项。CDC chunk 先持久化，再完整校验文件 SHA-256 并原子发布 descriptor，最后仍由 manifest CAS 提交。默认 fixed、完整 blob fallback、授权来源与 writer fencing 不变。completed upload 的重放和查询也验证实际块，不能仅凭文件描述符返回 complete。

pending upload metadata 保护已确认 chunk，文件版本保护其引用；GC 在已有单进程 lifecycle 锁内处理所有 Workspace 的 roots，无法识别的 metadata 阻止 chunk sweep。单测覆盖来源删除、跨 Workspace 共享、pending、缺块、同大小损坏、错序布局、重复块、空文件、非法配置和重启。它不提供多实例互斥，也没有旧 CDC staging 到块存储的在线迁移。

同一确定性输入在独立全新 dataDir 比较 CDC staging 与块对象，修改阶段结果如下。上传量不是估算；计数来自实际 HTTP PUT 与落盘写入。

| 场景 | 两模式实际 PUT bytes | staging 完整组装 bytes | 块对象完整组装 / 复用 staging bytes |
|---|---:|---:|---:|
| binary 16 MiB insert | 168,315 | 16,842,752 | 0 / 0 |
| binary 16 MiB delete | 161,744 | 16,711,680 | 0 / 0 |
| text 16 MiB insert | 8,540,757 | 16,842,752 | 0 / 0 |
| text 16 MiB delete | 8,409,685 | 16,711,680 | 0 / 0 |
| binary 64 MiB replace | 216,594 | 67,108,864 | 0 / 0 |

块对象新增数据写入不超过缺块 PUT bytes，但完整校验仍读取文件，不是 O(修改大小) 的总 I/O。`chunkReadBytes` 包含 `chunkVerificationBytes`；输入校验和文件 hash 是另外的、不能相加的计数。fallback、文件系统 metadata I/O 未计入块计数。协议中的 manifest 校验 bytes 是源码推导值，不是独立观测计数。

64 MiB 场景 GC 前保留 source/target 两版本：完整 blob 为 134,217,728 bytes；块数据为 67,325,458 bytes，加两个 descriptor 共 89,550 bytes。GC 后完整 blob 仅剩 67,108,864 bytes，块对象仍有 408 块共 67,325,458 bytes 和一个 44,775-byte descriptor。completed upload metadata 保留 24 小时，会继续保护旧块；不能把保留两版本时的节省率当成长期稳态收益。

## 经验与限制

块对象仍由单进程本地 backend 管理；先验证持久化顺序和 pending root，再讨论生产对象存储。不会把前批 PASS 沿用为本批验证结果。

新增读取实现为保守完整性语义：每次 descriptor-backed range read 均验证完整文件。它能拒绝结构合法但内容错序的描述符，代价可能是大量额外读取；成本对照须单独记录，不能只报组装写入减少。

## 冷恢复发现的既有缺陷

64 MiB、随后 16 MiB 的完整 blob 基线在清空 OPFS/IndexedDB 后重建均失败：所有下载请求 200，但 Host boot 报 `LOCAL_METADATA_MISSING`。原因是 mirror 在下载到 OPFS 后才首次读取本地 snapshot，store 将本轮新下载的缓存误判为丢失 metadata 的本地残留；这不是块对象模式造成，也不是模型超时。首次失败工件为 `/tmp/dsh-chunk-object-validation.A3kuih/chrome-cold-read.json`，含错误提示的诊断复跑为 `chrome-cold-debug.json`。

修复先读取并验证原本地状态，再在首次有远端文件且无 snapshot 时保存无 pending 的干净 metadata，之后才下载缓存。不放宽原有“已有 OPFS bytes 却缺 metadata”的拒绝规则；metadata transaction 失败不得开始下载。新增两个定向单测并连同 Workspace、CDC client 共 39 项通过；Worker 代码改动后重建 preview，冷缓存及真实模型必须使用新产物。

修复后 64 MiB 完整 blob 与块对象两模式均通过清空 OPFS/IndexedDB 后下载、完整 hash 和 UI 恢复。最终含 GC 的复跑中，完整 blob 约 4.65 秒，块对象约 11.14 秒；后者的 64 次 range GET 实际读取 4 GiB chunk bytes，且 descriptor 读取 5,731,200 bytes。该开销是保守完整性实现的读取放大，不能由“写入为 0”掩盖；未解决前不建议产品默认启用块对象模式。耗时是单机诊断，不是 CI SLA。该实验先卸载 Worker，再人为清除 origin 的缓存，不能称为自然 eviction 或 OS crash。

## 实际验证

原始日志与完整请求证据位于 `/tmp/dsh-chunk-object-validation.A3kuih/`；仓库工件省略逐条请求，保留计数、hash、存储、恢复和负对照结果。主矩阵先于冷恢复修复；最终恢复及冷缓存矩阵使用重建后的 Worker。

| 命令 | 实际结果 |
|---|---|
| `node --test docs/drafts/browser-native-dsh-poc/tests/chunk-object-store.test.mjs docs/drafts/browser-native-dsh-poc/tests/chunk-object-workspace.test.mjs` | 46/46；后补 completed 校验及计数分类后，HTTP 集成 16/16 再通过 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/content-upload-backend.test.mjs docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs` | 默认 backend 回归 93/93 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/content-upload-client.spec.ts` | 39/39，含冷恢复顺序和 metadata 写失败拒绝下载 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过 |
| `pnpm run build:check` | Host/Client aggregate 2/2 |
| `pnpm exec tsx scripts/run-oxlint.ts docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 定向 TypeScript 通过；`.mjs` 不在仓库 oxlint 范围，另经 Node 检查与测试 |
| `pnpm run doc-sync` | 43/43；最终文档改动另跑针对性检查 |
| `pnpm run lint` | 失败于本批未改的三处：`packages/core/tools/tests/json-schema.spec.ts:251`、`apps/web/src/browser-native-recovery.ts:62`、同文件 252；没有把全仓 lint 称为通过 |
| `git diff --check`、`pnpm --silent run change-scope --base origin/research` | 通过；仅本 PoC 与 drafts 目录登记 |

Chrome 成本与恢复矩阵命令：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
DSH_POC_CHUNK_OBJECTS=1 DSH_POC_CONTENT_UPLOAD_SCENARIO=all \
DSH_POC_RESULT_FILE=/tmp/dsh-chunk-objects.json \
node docs/drafts/browser-native-dsh-poc/tests/content-upload-protocol.e2e.mjs
```

主矩阵 9 场景、14 runs 通过，191.92 秒。最终 `DSH_POC_CONTENT_UPLOAD_SCENARIO=recovery` 四阶段恢复复跑 83.29 秒：reuse/PUT/complete/commit 成功后丢响应，终止 Worker、同 dataDir 重启 backend、刷新，operationId/layout/hash 不变、revision 只增一次，无模型请求或 prompt 重放；随后 GC 和文件 hash 再校验通过。最终冷缓存实验另设 `DSH_POC_CONTENT_UPLOAD_SCENARIO=binary-64m-replace DSH_POC_CHUNK_OBJECTS_COLD_READ=1`，两模式通过。

设置 `DSH_POC_CONTENT_UPLOAD_SCENARIO=binary-16m-insert DSH_POC_CHUNK_OBJECTS_FORCE_STAGING=1` 的负对照按预期非零退出，错误为 `CDC chunk versions must not create full blob files: 2 !== 0`，证明验收不会把退回整文件 staging 当成块对象成功。

真实模型命令：

```sh
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 \
DSH_POC_CONTENT_UPLOAD=1 DSH_POC_CHUNK_OBJECTS=1 DSH_POC_ROSTER=original \
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

最终 `real-llm-final.log`：`gpt-5.6-sol` 三轮完成，首轮严格 `read → write → read`，刷新后记忆和实际文件读取成功；8/8 模型 HTTP 200、两次 Workspace commit 200、60 个事件且 durableThroughSeq=59。块计数断言记录 74-byte chunk、一次 descriptor 发布、assembledWriteBytes=0；不是仅设置配置就宣称走通新存储。所有模型流量经同源代理，浏览器请求密钥扫描通过，无 pageerror。已有 validation profile compaction capacity warning、附属 preview 404 和刷新/流关闭的 abort 噪声仍存在。前一次 smoke 仅观察到 durableThroughSeq=56；测试改为等待最后一个 Session 事件持久化后，本次复跑确认 59。

## 验收服务与交付限制

本节服务是该批次的历史记录，已被后续下载流批次替换并停止；当前可访问地址见[下载流进度](verified-stream-download-validation-progress.md#验收服务)。

新服务使用真实 backend 模型、CDC 与块对象；已分配未占用端口，不使用主机 Agent 执行进程。

Chrome 已打开实际地址并保存截图，无 pageerror。preview 初次默认 Workspace 创建仍会出现提示，由既有 in-page picker 选择 Worker 的 `/dsh/home/` 后可用；这是已有 preview 限制，本批未修改该 UI。

| 项目 | 当前值 |
|---|---|
| URL | `http://127.0.0.1:53675/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none` |
| worktree / branch | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness` / `research`，无其他 worktree |
| 端口 / PID | 53675 / 23036 |
| 日志 | `/tmp/dsh-chunk-object-validation.A3kuih/acceptance-server.log` |
| 数据目录 | `/tmp/dsh-chunk-object-validation.A3kuih/acceptance-data` |
| 停止方式 | `kill -TERM 23036` |
| 截图 | `/tmp/dsh-chunk-object-validation.A3kuih/acceptance.png` |

本批没有证明多实例 backend、生产对象存储、自然 eviction、OS 级 crash、Safari、旧 CDC 在线迁移或后台执行。Dedicated Worker 随页面生命周期结束。下一项高价值攻关是保留已发布文件与每个返回块完整性的同时，消除 range GET 重复全文件扫描；不能简单删除 hash 校验或以“不可变”代替损坏检测。
