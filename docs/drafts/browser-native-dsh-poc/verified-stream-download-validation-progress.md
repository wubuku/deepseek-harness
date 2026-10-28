---
description: "记录 Workspace 下载流的读取成本、完整性、取消与 GC 引用验证。"
---

# Workspace 验证下载流实施进度

## 当前状态

四个交付面完成。64 MiB 冷恢复实际 chunk 读取从 4 GiB 降到 128 MiB；损坏、截断和断网不发布 cache，重启后可重试。真实 Chrome/LLM 三轮也独立通过。起始 `research` 与远端同步，工作区干净且只有主 worktree。验证问题、候选与判据见[计划](verified-stream-download-validation-plan.md)，脱敏证据见[Chrome 工件](verified-stream-download-chrome-results.json)。

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 规划 | 完成 | 基于上一批 64 MiB / 4 GiB 实测，确定四个交付面 |
| M1 有界 reader 与引用 | 完成 | 59/59；64 MiB 顺序读取恰好 128 MiB，active reader 归零；含损坏、错序和 GC |
| M2 HTTP 与浏览器缓存 | 完成 | HTTP 22/22，helper 54/54；默认后端与块对象集成回归 109/109，客户端回归 39/39 |
| M3 完整性、取消、GC、冷恢复 | 完成 | 16/64 MiB 实际 Chrome 冷恢复；corrupt/truncate/abort 三条失败/重启/刷新恢复；强制旧 range 负对照按预期失败 |
| M4 真实 LLM 与归档 | 完成 | 三轮、8/8 模型 200、60 事件 durableThroughSeq=59；清 Workspace cache 保留 Session 后，单条新 stream 恢复真实工具文件 |

## 实现与结果

`workspaceVerifiedDownloads: true` 要求同时启用 `workspaceChunkObjects: true`。协商响应增加 `fileDownload: { version: 1, kind: 'verified-stream' }`，当前 Worker 仅在显式 CDC 模式已有能力查询时使用。下载前按当前 manifest 校验 Workspace 授权；无 descriptor 的旧完整 blob 以精确 `409 FILE_DOWNLOAD_UNSUPPORTED` 返回，客户端才允许改走旧 chunk 路径。损坏、未知版本和其他 HTTP 错误均不静默降级。

store 打开 reader 时捕获布局并完整验证一次，下载时逐块再次验证，EOF 增量校验 full hash，不再额外扫描。活动 reader 的布局作为 GC root；来源从 manifest 删除、descriptor 被 GC 后，正在下载的 chunks 仍保留。正常 EOF、异常、iterator return、取消和显式 close 都释放引用。HTTP 使用背压，网络发送期间不持全局 Workspace 锁；首次完整验证仍在锁内。默认全局最多 4 个下载、30 秒 deadline，可由 `workspaceDownloadMaxReaders` 与 `workspaceDownloadTimeoutMs` 修改。

浏览器把单条 Fetch 流转成顺序范围，传给已有 OPFS `cacheBlobFromChunks`；检查响应 hash、总长度、EOF 和完整 SHA-256 后才关闭 writable 并发布 VFS。普通下载不通过 Playwright `route.fetch()` 收集完整 body；仅 corrupt/truncate 故障注入在 Node 夹具中缓存 payload，这不属于产品内存证据。

| 冷恢复输入 | 旧 range 实际 chunk 读取 | 新 stream 实际 chunk 读取 | 旧 / 新耗时 |
|---|---:|---:|---:|
| 16 MiB + 64 KiB insert | 286,326,784 bytes | 33,685,504 bytes | 3.82 / 2.58 秒 |
| 64 MiB replace | 4,294,967,296 bytes | 134,217,728 bytes | 11.52 / 4.43 秒 |

两个模式使用独立新 dataDir 和相同确定性输入，OPFS/IndexedDB 清空后重新 hydrate；最终 hash/size 和 manifest revision 一致，activeReaders=0。64 MiB 磁盘 chunk 读取减少 96.875%，不是零读，也不包括 fallback 或文件系统 metadata I/O。耗时为单机诊断，部分测试与其他本批检查重叠，不是严格隔离的基准或 CI SLA。GC 后再读 hash 也一致。HTTP 服务器与客户端仍进行完整 hash 验证，没有为降低计数删除完整性检查。

## 失败、修复与经验

helper 初跑 52/54：非精确 409 错误的 JSON body 已被消费，清理又试图获取 reader，造成 `ReadableStream is locked` 掩盖原 HTTP 错误。修复只对尚未消费的 body 获取 reader；对应 4 项回归后，最终 54/54 全部通过。

64 MiB 首次 fixture 在文件已通过 OPFS/VFS 完整 hash 后，仍等待 Playwright 的 `requestfinished`，最终超时。该事件并非客户端完整文件确认。修正为断言单条 200/总长度、客户端 EOF 与完整 hash、真实 OPFS/VFS 文件和 reader 归零；请求生命周期事件只记录诊断。保留首次失败工件 `chrome-64m.json`，最终复跑为 `chrome-64m-final.json`；没有把失败当成 PASS。

OPFS 的 `getFileHandle(create: true)` 会先创建 canonical 空文件，后续 writable abort 并不必然删除它。网络失败后留下这个空条目会使下一次 openBlob 正确拒绝，但无法自动恢复。本批仅清理本次创建且 abort 后仍为空的条目；原有同大小损坏、错误长度等对象保留并 fail closed，不覆盖未知本地状态。Chrome corrupt、truncate、abort 均先得到 error，canonical hash 不存在，再同 dataDir 重启 backend、刷新新 Worker，可恢复相同文件和 revision；未重复 prompt、模型调用或文件提交。

## 实际命令与证据

本批日志根目录为 `/var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-verified-download-validation-Irpd5G`。仓库 JSON 省略逐条请求，保留 hash、计数、GC、故障、首轮 fixture 失败和单独真实模型结果。

| 命令 | 实际结果 |
|---|---|
| `node --test docs/drafts/browser-native-dsh-poc/tests/chunk-object-store.test.mjs` | 59/59，含 reader snapshot、GC、取消、损坏、空文件与重复块 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/verified-stream-backend.test.mjs` | 22/22，含未授权、严格 query、limit、验证期间取消、超时、背压、GC、server close、重启与 headers 后损坏 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/content-upload-backend.test.mjs docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs docs/drafts/browser-native-dsh-poc/tests/chunk-object-workspace.test.mjs` | 109/109 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/verified-download.spec.ts` | 最终 54/54 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/content-upload-client.spec.ts` | 最终 39/39 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；最终 TS 修复后重建 |
| `pnpm run build:check` | 2/2 |
| `pnpm exec tsx scripts/run-oxlint.ts docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts docs/drafts/browser-native-dsh-poc/browser-native-verified-download.ts docs/drafts/browser-native-dsh-poc/tests/verified-download.spec.ts` | 通过；`.mjs` 另经 Node 解析及测试 |
| `pnpm run doc-sync` | 43/43；最终归档后另做针对性文档检查 |
| `pnpm run lint` | 同样失败于未改的 `packages/core/tools/tests/json-schema.spec.ts:251`、`apps/web/src/browser-native-recovery.ts:62` 和 252；不把全仓 lint 说成通过 |

Chrome 对照命令：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
DSH_POC_VERIFIED_DOWNLOADS=1 DSH_POC_CONTENT_UPLOAD_SCENARIO=binary-64m-replace \
DSH_POC_RESULT_FILE=/tmp/dsh-verified-download-64m.json \
node docs/drafts/browser-native-dsh-poc/tests/content-upload-protocol.e2e.mjs
```

实际分别运行 `binary-16m-insert` 和 `binary-64m-replace`；故障测试在 16 MiB 场景分别设 `DSH_POC_DOWNLOAD_FAULT=corrupt`、`truncate`、`abort`。负对照设 `DSH_POC_DOWNLOAD_FORCE_RANGE=1`，以 `cold hydrate must use one verified HTTP stream: 0 !== 1` 非零退出，证明退回旧高读取路径不会误报成功。

真实 LLM 命令：

```sh
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 \
DSH_POC_CONTENT_UPLOAD=1 DSH_POC_CHUNK_OBJECTS=1 DSH_POC_VERIFIED_DOWNLOADS=1 \
DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

`gpt-5.6-sol` 三轮完成，首轮 `read → write → read`；卸载 Worker、清理 Workspace OPFS/IndexedDB、保留 Session outbox 和 cookie 后，以单条新 stream 恢复真实文件，再验证 Session 记忆与实际 read。8/8 模型 HTTP 200、两次 Workspace commit 200、60 events 且 durableThroughSeq=59；一个 75-byte chunk 和 descriptor 已写入，assembledWriteBytes=0，最终 activeReaders=0，无 pageerror。请求中的密钥扫描和同源代理断言通过；这项 smoke 使用真实模型，成本/故障矩阵不调用模型。已有 preview 附属 404、compaction capacity warning 和刷新 abort 噪声未在本批修复。

## 验收服务

当前真实模型服务使用 CDC、块对象和新下载流；先由系统分配端口，Chrome 已打开并保存截图。preview 初次默认工作区提示仍需用既有 in-page picker 选择 `/dsh/home/`，本批未修改 UI。

| 项目 | 当前值 |
|---|---|
| URL | `http://127.0.0.1:51059/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none` |
| worktree / branch | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness` / `research`，只有主 worktree |
| 端口 / PID | 51059 / 63922 |
| 日志 | 日志根目录下 `acceptance-server.log` |
| 数据目录 | 日志根目录下 `acceptance-data` |
| 停止方式 | `kill -TERM 63922` |
| 截图 | 日志根目录下 `acceptance.png` |

## 已知限制

不以单进程引用保护证明多实例安全。不改变旧 range 的完整性承诺，不默认启用块存储，不用模型随机行为触发故障切点。

`peakReadBufferBytes` 只统计 store 拥有的 chunk 读取缓冲，排除布局、HTTP/OS、浏览器和消费方持有的 bytes，不能解释成总 RSS。浏览器应用按最多 1 MiB 返回给 OPFS，但 Fetch 交付的单个网络 chunk 大小由浏览器决定。

捕获网络/校验异常可以 abort OPFS writable 并清除本次新建的空文件；这不证明 Worker 突然终止或 OS crash 时也能执行 finally。已有未确认 canonical cache 残留仍会 fail closed，不能仅凭刷新成功宣称完整 crash consistency。

取消会立即断开 HTTP，但已经进行的首次完整校验需要结束后才能释放迟到 reader/slot；它不是可随时中止的磁盘扫描。当前 full verify 上限 64 MiB，生产版仍需处理慢存储和跨实例引用。自然 eviction、OS crash、生产对象存储、多实例、Safari 与旧 CDC 在线迁移未验证。Dedicated Worker 仍受页面生命周期约束，不是页面关闭后的后台 Agent。
