---
description: "Workspace 本地写权与代际批次的实际命令、证据、失败和限制。"
---

# Workspace 本地写权与代际验证进度

## 当前状态

实施和验收完成，正在提交推送。本批从干净的 research 主工作区开始，只有一个 worktree；无需合并或清理额外 worktree。计划见[本地写权与代际验证](local-writer-fencing-validation-plan.md)，脱敏摘要见[验收结果](local-writer-fencing-chrome-results.json)。

| 里程碑 | 状态 | 证据与下一步 |
|---|---|---|
| M0：候选评估与规划 | complete | 核对 DSH-TUI 的单写者原则、store record CAS、mirror lease 和上一批未完成 Host 组合；先落档再编码 |
| M1：反例与本地代际 | complete | 两个旧行为反例均使目标断言失败；修复后 ABA、clear/recreate、失败事务代际一致性均通过真实 Chrome 验证 |
| M2：本地写权与升级 | complete | schema 2 增加 control store；snapshot 保持 version 1；legacy pending/retry/receipt/bytes 保留、blocked upgrade、未知版本导出和损坏 control 均验证 |
| M3：完整 Chrome Host | complete | 最终双 Host 通过且 cleanupErrors=[]；observer、原 operation 接管、迟到保存拒绝、后继 pending/bytes 保护与四次唯一 commit 均有证据；既有 observer 和五个下载强杀场景通过 |
| M4：真实模型与交付 | complete | 最终真实 LLM、文档与受影响构建检查通过；验收服务已启动。提交推送结果由 Git 记录和会话交付报告确认，既有全仓 lint 错误保留说明 |

## 已核对事实

- 当前每次 OPFS/IDB 操作有 Workspace Web Lock，但它不覆盖整个 Worker 生命周期。
- store 比较最后成功 load/save 的完整 record，未提供独立的本地写入代际；源码明确排除 identical-record ABA。
- observer 不 load shared snapshot，writer 会在 prepare 时恢复本地 pending/retry；远端 lease 与本地 store 之间尚无绑定身份。
- 上一批完整 Host 下载切点恢复 5 项与 direct-store 并发 9 项通过；额外完整双 Host 竞争未完成，不计作通过。本批需定位等待原因。

## 命令、结果与限制

旧行为反例已执行：设置 DSH_POC_STORE_CONCURRENCY_SCENARIOS=identical-record-aba,clear-recreate-aba，运行 tests/store-write-concurrency.e2e.mjs，使用上一批保留的 after9-store-bundle.js。两个断言实际得到成功 save，而预期 LOCAL_SNAPSHOT_CONFLICT，脚本退出 1；这是预期负对照，不是修复后的通过。工件为 /var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-store-write-concurrency-NfHcmf/before-local-generation-results.json。

新设计将 control 与 Workspace snapshot 放在同一 IndexedDB 数据库；generation 与 snapshot 在同一事务提交，writerEpoch 与 writerId 负责实例接管。每次本地操作仍在 Workspace Web Lock 内核对身份；生命周期 invalidate 会立即撤销当前实例。它不持有整个 Worker 生命周期的本地锁，避免失去远端 lease 但未退出的 Worker 永久阻挡合法接管。无 backend lease 的模式仅验证同源本地写权，不能外推跨设备。

不把 scripted 模型用于确定故障顺序的测试等同真实 LLM 验证。所有密钥仅由 backend 读取 docs/drafts/.env，工件不保存密钥或 writer token。

## 实施结果与经验

- 本地数据库 schema 2 的 control 记录包含 version、workspaceId、writerId、writerEpoch 和 generation。generation 与 snapshot put/delete 在同一 strict durability 事务提交；abort 不前移已提交代际。clear 保留 control 以拒绝旧实例，不能把数据库记录删除解释为从未写入。
- acquire 只能绑定一次；旧实例 load 不恢复权限。save、cache、open、恢复和 GC 都在同一 Workspace 操作锁内核对身份；invalidate 立即拒绝排队操作并中止本实例在途 metadata 写事务。OPFS 已发出的调用无法同步撤销，仍须等待它结算后才能释放锁。
- 本地接管不能只在等待锁前检查 backend lease。锁内重新进行远端 renew，事务 put 前同步复核授权；不复用锁前启动的 renewal。没有 backend lease 时仅提供同源本地 fencing，不能外推跨设备。
- 独立审查复现并修复两处回归：有效 lease 内的本地保存不应强制成功续租网络，否则断网会把已授权修改留在内存；异步只读写权核对返回后必须再检查 invalidate，否则 release 可与工具授权交错。回归测试与完整浏览器验收分别负责这些时序。
- 既有 E2E 的只读 helper 不应固定打开 schema 1；本批只将这类读取改为当前版本，真正的升级夹具仍明确创建 schema 1，前向版本负例为 schema 3。未知版本在 identity 之前拒绝时，现有页面按恢复集合导出，而不是单 Workspace envelope；断言继续检查 metadata、未知 store 和完整 bytes 没有变化。

## 当前已执行检查

| 命令或入口 | 实际结果 |
|---|---|
| tests/store-write-concurrency.e2e.mjs | 15/15 真实 Chrome 存储场景通过；额外两个锁内授权探针通过；增强的事务 abort generation 断言通过 |
| tests/local-writer-fencing.e2e.mjs | 最终 58.181 秒通过，cleanupErrors=[]；两个真实 DSH Host 的 owner→observer→successor，local epoch 1→2、generation 6→14；四个成功 commit 的 operationId 唯一，原 retry operation 恰一次，两个 Session 各一份工具 receipt，迟到保存未增加旧 owner commit，后继 pending/retry/control/OPFS 全量审计不变，无 pageerror/跨源请求 |
| Vitest cache-publication-recovery、verified-download、durable-workspace | 最终覆盖分别为 122/122、54/54、26/26，共 202 项通过；另有 browser-native-workspace/content-upload-client 22/22。中间一轮 API 参数断言过时已修正，未调整行为断言或 timeout |
| tests/shared-workspace-observer.e2e.mjs | 双 Session 已提交读取、pending 隔离、stale 拒绝、显式刷新和 fencing 通过；12 个 scripted 模型请求、3 个成功 operation、prompt 各一次、无 pageerror/跨源请求 |
| tests/cache-publication-recovery.e2e.mjs | 最终代码前一版 5/5 通过，含四个 Worker 强杀切点和 missing-intent 负对照；不以 finally 执行代证强杀 |
| tests/indexeddb-forward-version-export.e2e.mjs | schema 3 拒绝启动、恢复集合导出与未知数据保留通过；初次夹具仍期待单 Workspace envelope 而失败，已修正 envelope 断言 |
| tests/runtime-validation.e2e.mjs，real/original/CDC/chunk/verified-download | 最终审查修复后 3 turns、8/8 HTTP 200、60 events、durableThroughSeq=59，两次 Workspace commit 200；read→write→read、记忆和清 Workspace cache 后刷新均通过，模型 gpt-5.6-sol，无 pageerror，浏览器 LLM 请求只到本次同源代理 |
| Web tsc、build:preview、build:check | 最终审查修复后全部通过；build:check 为 2/2 |
| pnpm run doc-sync | 43/43 通过 |
| pnpm run test:docs | 最终 21/21 通过，含 wrap、links 与 translation pairing |
| pnpm run lint | 失败为三个既有未改文件错误：packages/core/tools/tests/json-schema.spec.ts:251；apps/web/src/browser-native-recovery.ts:62、252。改动文件使用显式 --no-ignore 的定向 oxlint 通过，不扩大本批修复范围；未把忽略目录或 No files found 算作 lint 通过 |

工件主目录为 /tmp/dsh-local-writer-final.lhRi53；最终保留的真实 backend 数据位于 real-final-data。direct-store 工件分别为 dsh-store-write-concurrency-8G4Hrc、dsh-store-write-concurrency-vpHnjT、dsh-store-write-concurrency-giMkkY，位于本机临时目录。所有结果须以最终记录为准，运行中项目不计通过。

最终模型工件为 real-final.json、real-final.stderr.log 和 real-final-data；Chrome 强杀工件为 dsh-cache-recovery-vMg36j/results.json 与截图；前向版本结果为 forward2.json。早期真实模型尝试均未伪装为故障 E2E；本批故障主测试仍使用 scripted 响应来控制时序。

最终双 Host 工件为 dsh-local-writer-fencing-wK1jGs/results.json、backend-itx3kl 与四张截图，入口输出为 full-host-final3.json/stderr.log。中间一轮实际正确拒绝为“writer lease was released”，夹具只接受“local writer”字样而失败；最终断言接受明确的本地或远端写权撤销，仍拒绝仅以 snapshot 内容变化代证。各个本地 mutator 的 epoch 拒绝由 direct-store 测试独立验证。

锁内授权还运行了第二组旧行为负对照：使用本批增加 authorize 参数前保存的 local-fencing-store-bundle.js，两项新断言均预期失败，证据为临时目录 dsh-store-write-concurrency-cxvcQA/before-authorized-acquire-results.json；修复后相同断言通过。它是本批捕获的旧 bundle，不是历史 checkout，也不是最终通过项。

最终真实 LLM 保留了附属 preview API 的既有 404、流结束或刷新时的 ERR_ABORTED，以及 compaction 配置 warning；8/8 模型 HTTP 200 和 pageErrors=[] 不等于没有任何诊断。模型输入、页面、Session 与输出的既有密钥扫描通过；未将私有 env 复制入前端或提交。

## 可复跑命令

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/cache-publication-recovery.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/verified-download.spec.ts
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/store-write-concurrency.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/local-writer-fencing.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/indexeddb-forward-version-export.e2e.mjs
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_CONTENT_UPLOAD=1 DSH_POC_CHUNK_OBJECTS=1 DSH_POC_VERIFIED_DOWNLOADS=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_DATA_DIR=/tmp/dsh-local-writer-final.lhRi53/real-final-data DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
pnpm exec tsc --noEmit -p apps/web/tsconfig.json
pnpm run build:check
pnpm run doc-sync
pnpm run lint
```

Playwright 路径是本机已安装依赖，其他机器应改为本机入口或省略以使用默认模块解析；真实模型的重跑使用新的私有 dataDir，避免混淆本批保留证据。完整 E2E、预览服务和故障工件只使用各自私有目录，未清共享构建缓存。

完整 Host 初次业务断言通过后，Chrome 清理的自设 5 秒截止先于其退出；整次仍记 failed。之后换成普通 launch 和单一 browser.close。另有目录选择器夹具在路径编辑按钮加载完成前检查 isVisible，或在 preview notice 出现前打开选择器；改为等待通知完成和控件的显式可见状态，不通过扩大业务 timeout 隐藏失败。上一批完整 Host 下载竞争 hang 的历史工件不足以确定最后 await，本批不将该夹具问题反推为上一批确切根因。

## 验收服务

- URL：http://127.0.0.1:56838/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&preview-fixture=none
- worktree：/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness；分支 research，仅主工作区。
- 端口：56838，listen(0) 分配；PID：40727。
- 日志：/tmp/dsh-local-writer-final.lhRi53/acceptance-server.log；数据：同目录 acceptance-data；启动脚本 acceptance-server.mjs，登记 acceptance.json。
- 停止：kill -TERM 40727。旧批次验收服务 PID 11014 已停止，仅操作本任务持有的进程。
- 真实 Chrome 页面检查为 synced r0、pageErrors=[]；截图 acceptance.png。首次打开先确认 preview notice 并选 /dsh/home/。后端使用真实模型配置，密钥不进入浏览器。

## 限制与未完成

本地 Web Locks 与 epoch 只约束合作的同源实例，不抵御恶意同源脚本，也不替代服务器 principal 校验。未知版本保持拒绝；旧版页面升级后不可降级写入。observer 的大文件 resident 内存、自然 eviction、OS crash、电源中断、跨设备写权、多 backend 事务和生产 HA 本批未测。启动等待锁期间真实 lease 过期的完整 Host 组合尚未单独跑过，锁内授权机制已有直接 Worker 探针，不能混称完整 Host 证据。
