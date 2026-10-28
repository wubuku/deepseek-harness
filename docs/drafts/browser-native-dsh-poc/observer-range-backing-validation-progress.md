---
description: "只读 Workspace range backing 的实施、命令、实际证据与限制。"
---

# 只读 Workspace range backing 验证进度

## 当前状态

实施与验收完成；提交推送状态由 Git 记录和会话交付报告确认。工作位于 research 主工作区，只有一个 worktree，无额外分支需要合并。计划先于编码，见[本批计划](observer-range-backing-validation-plan.md)；脱敏数据见[Chrome 验收摘要](observer-range-backing-chrome-results.json)。

| 里程碑 | 状态 | 验收要求 |
|---|---|---|
| M0 候选与规划 | complete | 十二类候选，选择大 Workspace 多观察者资源成本与隔离 |
| M1 私有 backing 与预算 | complete | 10 项专项单测；完整 hash、alias 独立关闭、file/byte admission、短 IO、quota、空文件、失败清理 |
| M2 生命周期与 Chrome Worker | complete | 真实 Dedicated Worker 在第二块下载处强杀；后继回收 orphan、保留活实例并能继续读；所有测试目录显式 dispose 后消失 |
| M3 完整 Host | complete | 16 MiB 文件三路径 alias，单次 stream，VFS resident 增量 58 bytes；read/grep/stale、shared metadata 不变和 release 清理通过 |
| M4 真实模型与交付 | complete | 三轮真实模型、刷新与冷恢复、构建和文档通过；验收服务运行中；全仓 lint 既有错误单列，提交推送由 Git 记录确认 |

## 已核对事实

实施前 mirror 的 observer 分支直接调用 downloadBlob 并 vfs.seed；writer 使用 store.openBlob 与 seedExternal。共享 store.openBlob 必须核对 writer epoch，因此不能直接让 observer 调它。MemoryVfs 支持同步 backing 与 usage.residentBytes；现有文件工具有 range 读取和 revision 前后核对。当前 durable observer 改用私有 cache，不修改共享 IDB schema，不恢复 writer pending，不取得云端写权；volatile observer 保留原路径。

## 执行记录

| 命令或入口 | 实际结果 |
|---|---|
| Vitest observer-cache、browser-native-workspace、durable-workspace、verified-download | 109/109；最终两份改动测试再次通过 29/29，不重复计为额外覆盖 |
| Vitest cache-publication-recovery | 122/122；共享 writer cache 和 journal 回归保持通过 |
| tests/observer-range-backing.e2e.mjs | 最终 Chrome 156.0.8078.48 通过，业务步骤约 21.027 秒，cleanupErrors=[]，pageErrors=[]、无跨源请求；完整 Host 与 direct Worker 证据分开记录 |
| 同脚本 DSH_POC_OBSERVER_VOLATILE_CONTROL=1 | 预期失败；同一预算断言观察到约 48 MiB 文件驻留，不能计为通过或称历史 bundle 负对照 |
| tests/shared-workspace-observer.e2e.mjs | 既有双 Session dirty/retry 隔离、stale、刷新接管和 fencing 通过，12 个 scripted 模型请求、3 个成功 operation、无 pageerror |
| tests/runtime-validation.e2e.mjs，real/original/CDC/chunk/verified-download | 两次正常真实模型 smoke 通过；保留数据的最终一次为 gpt-5.6-sol，3 turns、8/8 HTTP 200、60 events、durableThroughSeq=59；read→write→read、记忆、刷新并清 Workspace cache 后冷恢复通过，两次 Workspace commit 200 |
| pnpm exec tsc --noEmit -p apps/web/tsconfig.json | 通过 |
| 新 cache 和 fixture 的 standalone tsc --strict --exactOptionalPropertyTypes | 通过；需 --ignoreConfig、DOM/WebWorker 和 node types，完整命令见下 |
| build:preview、pnpm run build:check | 通过；受影响 preview 重建，build:check 2/2 |
| pnpm run doc-sync | 43/43；最后文档调整另跑 quick gates |
| pnpm run test:docs | 最终文档 21/21 通过，含 wrap、links、登记和翻译豁免检查 |
| 定向 oxlint --no-ignore | 改动 TypeScript 与 E2E 文件通过；不把默认忽略 docs 当作通过 |
| pnpm run lint | 两次均为三个既有错误：apps/web/src/browser-native-recovery.ts:62、252；packages/core/tools/tests/json-schema.spec.ts:251；另有既有 unused disable warning，未修改这些文件 |

主要工件目录为 /tmp/dsh-observer-final.JzxbXm。最终完整 Host 结果为 dsh-observer-range-DTuyq7/results.json，截图 observer-stale.png；真实模型结果为 real.json、real.stderr.log，持久化数据在 real-data。首次真实模型 smoke 的 /tmp/dsh-observer-real.log 也通过，但该脚本自动删除其私有 backend 数据，不将它冒充保留了持久化记录。最终采用显式 DSH_POC_DATA_DIR 保留 Session 和 Workspace 文件。

完整 Host 的基线 VFS residentBytes 为 34,504,135，observer 为 34,504,193；三路径逻辑文件量为 50,331,648 bytes，私有缓存只有一个 16 MiB blob 和一次 verified-stream 请求。read 与 grep 后仍在基线加 1 MiB 的断言范围内；Session/config 的其他 VFS 写入使总计数少量变化，因此不要求全 VFS 总量精确不变。direct Worker 的单文件 logical bytes 为 4 MiB、residentBytes=0，四次下载范围的最大值为 1 MiB。二者均不是整个浏览器 heap/RSS 的测量。

## 失败与经验

- Worker 的异步 import 完成之前发送首个测试消息可能丢失。首轮夹具未握手且缺少错误超时，被显式终止本任务 Chrome 后记为失败；第二轮增加超时明确报 create timeout。最终先收到 ready 再发送，并处理 Worker error，不靠 sleep 或扩大业务 timeout。
- observer 的 lease-info.ok=false 表示没有 writer token，并非 Host 启动失败；测试应检查 accessMode，而不能要求每个测试端口调用都持有写权。
- 首次 grep fixture 的短行超过既有 250,000 行搜索预算，正确返回受限错误。最终仍使用 16 MiB 文件，但行长约 132 bytes，落在原预算内；没有扩大搜索限额。route 回调中的断言曾触发未处理拒绝，最终只在回调捕获结果，在拥有流程中断言，保证 finally 执行。
- 一次总 residentBytes 精确相等断言失败，是 Session/config 合法增长约 689 bytes；改为明确的基线加 1 MiB 文件驻留预算。volatile 对照仍实际失败，证明预算没有掩盖整文件 materialization。
- standalone tsc 初次调用缺少 --ignoreConfig，第二次缺少 Worker/node 类型；修正命令后通过。额外启用 noUncheckedIndexedAccess 暴露未改的 browser-native-sha256.ts 既有数组访问诊断，未扩大本批修复，也不声称整个 PoC 已满足该额外检查。

真实模型 smoke 验证正常 writer 文件闭环，不证明模型自主选择 observer 的并发与故障顺序；这些由 scripted 完整 Host 和模型无关 Worker 控制。模型记录保留 compaction headroom warning、附属 preview API 404，以及刷新或流结束附近的 ERR_ABORTED；8/8 HTTP 200 和 pageErrors=[] 不等于没有诊断。既有 smoke 对页面、Session 与浏览器网络做密钥扫描，未发现模型密钥；浏览器 LLM 请求只到本次同源 backend。

## 可复跑命令

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/observer-cache.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/verified-download.spec.ts docs/drafts/browser-native-dsh-poc/tests/cache-publication-recovery.spec.ts
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/observer-range-backing.e2e.mjs
DSH_POC_OBSERVER_VOLATILE_CONTROL=1 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/observer-range-backing.e2e.mjs
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_CONTENT_UPLOAD=1 DSH_POC_CHUNK_OBJECTS=1 DSH_POC_VERIFIED_DOWNLOADS=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_DATA_DIR=/tmp/dsh-observer-final.JzxbXm/real-data DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
pnpm exec tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2023,DOM,DOM.Iterable,WebWorker --types node --allowImportingTsExtensions docs/drafts/browser-native-dsh-poc/tests/observer-cache.spec.ts docs/drafts/browser-native-dsh-poc/tests/observer-cache-fixture.ts
pnpm run build:check
pnpm run doc-sync
```

负对照命令预期退出 1。其他机器修改本机 Playwright 入口；重新测试使用新的私有 dataDir，避免覆盖保留的验收证据。下载写入、完整 hash 和 source.close 均在实例内部；私有缓存从不宣称 cloud commit、Session durability 或离线 outbox。

## 验收服务与停止

- URL：http://127.0.0.1:56846/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&preview-fixture=none
- worktree：/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness，research 主工作区；端口 listen(0) 分配，无新增 worktree。
- PID：68973；停止：kill -TERM 68973。
- 日志：/tmp/dsh-observer-final.JzxbXm/acceptance-server.log；数据：同目录 acceptance-data；登记 acceptance.json，启动脚本 acceptance-server.mjs。
- 使用同目录 acceptance-dist 私有构建副本，避免后续共享 preview 重建使当前验收资源失效。真实 Chrome 页面 synced r0、pageErrors=[]，截图 acceptance.png，检查记录 acceptance-check.json。
- 后端 real/gpt-5.6-sol，凭据只从 docs/drafts/.env 读取。首次打开确认 preview notice 并选择 /dsh/home/。旧批服务 PID 40727 已停止，仅操作本任务持有的进程。

## 限制与下一步

每个 observer 仍提前下载全部已提交内容；只在本实例复用相同 hash，不跨实例共享磁盘缓存。预算按唯一文件与 bytes 计算，不覆盖整个 origin、目录/alias metadata、Chrome heap 或 RSS，也不保证 4096 个同步句柄在所有设备均可同时打开。大规模 lazy hydrate、共享只读 pin/GC、全局空间回收和低内存设备需要另批验证。

私有缓存可丢弃，不是离线事实源；后继回收要求同一 Workspace 再次启动 observer，未访问的旧 Workspace 仍可能遗留目录。未验证自然 eviction、OS crash、电源中断、Safari、跨设备、生产身份清理、多实例 backend 或云端后台执行；Worker 仍随页面生命周期终止。完整 Host 等待本地锁期间真实远端 lease 过期的组合仍未在本批补测，不用 direct Worker 证据替代。
