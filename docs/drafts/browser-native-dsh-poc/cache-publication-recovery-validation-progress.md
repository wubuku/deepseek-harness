---
description: "记录 Workspace 缓存发布恢复的实施、强制终止实验、真实模型验证及限制。"
---

# Workspace 缓存发布恢复进度

## 当前状态

四个交付面完成：完整 DSH Host 的 Chrome 恢复 5/5，直接存储双 Worker 9/9，真实 LLM 三轮独立通过。起始为主工作区 research，与远端一致，工作区干净且没有隔离 worktree。[计划](cache-publication-recovery-validation-plan.md)定义判据，[脱敏工件](cache-publication-recovery-chrome-results.json)区分实际强杀、重建负对照和模型结果；双完整 Host 的组合竞争没有完成，不计入通过项。

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 候选与验收规划 | 完成 | 缓存发布、互斥、dirty 保护和真实强杀四面 |
| M1 journal 与本地互斥 | 通过 | journal 90/90；严格事务、版本、重复意图拒绝和身份枚举 |
| M2 启动恢复与保护 | 通过 | 恢复 74/74、下载回归 54/54；含 metadata 缺失、dirty/retry、CAS 和失败收束 |
| M3 Chrome 强杀和竞争 | 通过 | 完整 Host 5/5、直接 store Worker 9/9；六项重建负对照按预期失败 |
| M4 真实 LLM、归档与交付 | 通过 | 最终存储版本三轮、8/8 模型 200、60 事件 durableThroughSeq=59；服务和工件已登记 |

## 实施记录

Workspace 存储操作使用同 Workspace 的 Web Lock；恢复先读严格验证的 journal 和 snapshot，再决定是否清理。下载只在 metadata 已登记后创建意图，且意图 transaction complete 先于 OPFS 创建；close 完成且 hash 正确后删除意图。即使完整文件被 pending/retry 引用，也保守拒绝自动结算该意图。独立 journal 不升级现有 Workspace metadata 或 Session 格式。

并发审查用真实 Chrome 双 Worker 复现三项既有问题：旧实例 save 可覆盖新 pending；cacheBlobFromRanges 与 save 之间的 GC 可删除尚未登记的外部引用；Promise.all 提前 reject 后其他编码写入仍可越过锁继续。本批扩展修复：锁内比较最后成功读取/保存的完整 metadata，新增 LOCAL_SNAPSHOT_CONFLICT；提交前流式验证外部引用；pending 与 retry 编码串行完成后才释放锁。只剩 journal 的 Workspace 也在 identity 请求前登记，避免 metadata/cookie 丢失时静默生成新身份。

最终真实 Chrome/LLM 使用同源代理与 original roster，模型 gpt-5.6-sol；首轮 read→write→read，三轮共 60 事件、durableThroughSeq=59、8/8 模型 HTTP 200、两次 Workspace commit 200，清 Workspace cache 而保留 Session 后文件仍可读，无 pageerror。模型输入、页面、Session 和日志的既有密钥扫描通过，浏览器模型请求只到本次同源代理。保留既有 compaction capacity warning、附属 preview 404 和流结束/刷新时 ERR_ABORTED，不将 HTTP 200 等同于没有任何诊断。

Web tsc、preview 构建、build:check 2/2、客户端回归 20/20、定向 oxlint 和 doc-sync 43/43 已通过。全仓 lint 仍有三处既有未改错误：packages/core/tools/tests/json-schema.spec.ts:251、apps/web/src/browser-native-recovery.ts:62 和 :252；本批不混入无关修复。

## Chrome 结果与经验

完整 Host 在 intent-durable、entry-created、first-chunk-written、published 四个切点强杀。前三个新 Worker 恰好重新下载一次；published 完整 hash 一致，复用现有缓存且零重新下载。四个切点均实际审计 IndexedDB、OPFS 和 Web Locks。删除意图却保留空 canonical 的负对照显示 local-corrupt，Host boot 拒绝，bytes 和 metadata 保留，零重新下载；没有通过清空浏览器存储使恢复通过。五项模型请求均为零。

直接 store 的两个实际 Dedicated Worker 用 held/pending lock 和不同 clientId 确定性证明重叠，再强杀持锁者。entry-created 接管读取源一次，published 接管读取源零次；分别约 38/48 ms，最终 hash 正确且 intent、held/pending 锁归零。它们连同 stale snapshot、未 load 保存、GC、事务 abort、journal-only、pending/retry 编码共九项通过。这里的 Worker 直接调用存储，不宣称是完整 DSH Host；DSH Host 由前述五项和真实模型另证。

重建负对照只在临时 bundle 中恢复审查时的旧行为，六项缺陷断言失败，其余事务控制项通过。它不是历史 checkout，也没有修改共享构建输出。原始 bundle、源码、完整结果和 comparison.json 保存在独立工件目录。

首次测试曾因 principal cookie fixture 错误失败；pause 消息进入正式 tunnel 也触发 unknown frame，修正为测试代理仅拦截精确测试消息。负对照向启动失败的 Host 请求 stat、等待附加测试通知均超时，最终改验正式 local-corrupt 状态、实际 Host boot 失败和 OPFS 保留。双完整 Host 组合竞争等待超过五分钟后终止，未得出原因，不计 PASS；删除该未完成测试路径，跨 Worker 存储竞争由独立九项脚本完整承担。已有五项 Host 恢复和业务功能保留。

最终客户端并行回归曾有一项计算密集的 CDC 用例超过既有 10 秒预算；同一断言隔离重跑 3/3，原其余 73 项通过。未调大超时、弱化断言或改实现掩盖失败。外部引用新增完整 hash 校验有 O(bytes) 的安全成本，编码串行也可能增加耗时；本批没有 RSS、低内存设备或吞吐 SLA 结论。

新增引用校验后，另跑实际 Chrome 的 16 MiB 中部插入回归，range/stream 两种上传、提交和冷恢复均通过，最终 16,842,752 bytes 与 hash 一致。冷恢复单机约 3.168/2.651 秒；这是当前版本路径对照，不是本批保存性能的前后基准。日志根 large-file-regression.json 保留 HTTP/IO 计数。

## 实际命令

在仓库根执行；Chrome、依赖和私有 env 沿用本机已有配置，没有重新安装依赖或清理共享缓存。

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/download-journal.spec.ts
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/cache-publication-recovery.spec.ts
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/verified-download.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/content-upload-client.spec.ts
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/content-upload-client.spec.ts
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm run build:check
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_CACHE_RECOVERY_ARTIFACT_DIR=/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-cache-publication-validation.HMrPamY2Zk DSH_POC_CACHE_RECOVERY_KEEP_DATA=1 node docs/drafts/browser-native-dsh-poc/tests/cache-publication-recovery.e2e.mjs
DSH_POC_STORE_CONCURRENCY_ARTIFACT_DIR=/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-store-write-concurrency-e7Cggd DSH_POC_STORE_CONCURRENCY_LABEL=after9 node docs/drafts/browser-native-dsh-poc/tests/store-write-concurrency.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_CONTENT_UPLOAD_SCENARIO=binary-16m-insert DSH_POC_CHUNK_OBJECTS=1 DSH_POC_VERIFIED_DOWNLOADS=1 DSH_POC_RESULT_FILE=/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-cache-publication-validation.HMrPamY2Zk/large-file-regression.json node docs/drafts/browser-native-dsh-poc/tests/content-upload-protocol.e2e.mjs
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_CONTENT_UPLOAD=1 DSH_POC_CHUNK_OBJECTS=1 DSH_POC_VERIFIED_DOWNLOADS=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DATA_DIR=/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-cache-publication-validation.HMrPamY2Zk/real-final-data DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
pnpm exec tsx scripts/run-oxlint.ts docs/drafts/browser-native-dsh-poc/browser-native-worker.ts docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts docs/drafts/browser-native-dsh-poc/browser-native-download-journal.ts docs/drafts/browser-native-dsh-poc/tests/verified-download.spec.ts docs/drafts/browser-native-dsh-poc/tests/cache-publication-recovery.spec.ts docs/drafts/browser-native-dsh-poc/tests/download-journal.spec.ts
pnpm run doc-sync
pnpm run lint
git diff --check
```

journal、恢复、下载分别 90、74、54 项通过；相邻客户端 20 项也通过，最后一轮并行超时与隔离结果如上。完整 Host 五项约 47.6 秒，Chrome 156.0.8078.48。doc-sync 最终归档前一次 43/43；归档后的 verify-md-wrap、verify-md-links、doc-typecheck 均通过，100 个代码块编译。完整实际命令与重建负对照命令见工件目录 comparison.json/comparison9.json。

## 验收服务与工件

- URL：`http://127.0.0.1:55697/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none`。
- 主工作区：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness`，research；无隔离 worktree。
- 端口：55697，listen(0) 原子分配；PID 11014；停止：`kill -TERM 11014`。
- 日志根：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-cache-publication-validation.HMrPamY2Zk`；服务日志 acceptance-server.log，数据 acceptance-data，配置 acceptance.json，截图 acceptance.png。
- 完整 Host 工件：日志根的 dsh-cache-recovery-iRYyHu/results.json 与十张切点/恢复截图；真实模型 real-final.json、real-final.log、real-final-data；初始失败目录均保留。
- 并发工件：`/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-store-write-concurrency-e7Cggd`，after9-results.json、negative-results.json、comparison9.json 及临时 bundle。

服务使用同源真实模型代理、CDC、chunk objects 和 verified downloads。Chrome 已打开验收截图，状态 synced r0，无 pageerror；首次页面仍可能有既有默认 Workspace 提示，按界面选择 `/dsh/home/`。仅停止前两次由本任务启动的旧服务，未触碰其他人的服务。

## 限制

Worker 强制终止不是自然 eviction 或 OS crash。本地 journal 不构成云端 commit 回执，不改变 Session/Workspace 跨存储非原子事实。相同记录 ABA、任意旧 owner 继续写入的完整 fencing、两个完整 DSH Host 的组合竞争、生产多实例和低内存长时压力仍待验证；现有 backend lease 继续承担远端写权。缺少意图的旧损坏缓存不能自动修复。严格 IndexedDB durability 只请求浏览器更强提交策略，不是物理介质保证；Dedicated Worker 仍随页面结束，不是后台 Agent。

## Dev Note

本文件随里程碑更新，保留失败和修正，不把模型无关测试称为真实 LLM PASS。
