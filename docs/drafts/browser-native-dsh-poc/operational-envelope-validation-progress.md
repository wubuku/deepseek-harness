---
description: "记录 Browser-Native DSH 运行范围、容量和存储恢复验证的实际结果与限制。"
---

# Browser-Native DSH 运行范围验证进度

## 当前状态

本批四个交付面均已实施，并在下述范围内完成 Chrome 验证：默认 Browser preset schema 与 scripted 受限 shell 调用、插件与模块兼容矩阵、容量基线、浏览器配额错误及正常进程重启恢复。实际默认 Browser profile 的真实模型完整工具闭环尚未通过；真实模型 validation roster 的文件工具闭环通过。结论只适用于当前 checkout 的 PoC，不代表已发布能力、生产 SLA 或所有 DSH 插件兼容。

验证基线为 `research` 分支已合并的上游 release tag `dsh-v0.2.1-rc.2`；本批改动仍在主工作区 WIP，没有创建隔离 worktree。浏览器验证仅使用 Chrome 155.0.8059.85（macOS/darwin）；Safari/WebKit 暂停。

## 交付状态

| 交付面 | 状态 | 结果 |
|---|---|---|
| 默认 Browser preset 与模型 schema | 已完成（scripted shell 与真实模型 todo/多轮） | PoC overlay 显式限定 Browser 工具；Chrome scripted E2E 检查 schema 并实际执行 Worker shell `printf`。真实 Web UI 三轮 Chrome E2E 在此 profile 中真实执行一次 `todo_write`，验证同 Session 记忆和 durable Session。真实 `read → write → read` 专项 E2E 使用独立 validation roster，未在默认 Browser profile 完成。 |
| 插件/模块兼容矩阵 | 已完成 | [兼容矩阵](operational-compatibility-matrix.md)区分真实执行、同源 backend 提供、明确排除和未验证；模块可加载不视为插件可用。 |
| Chrome 容量基线 | 已完成 | 三类确定性工作负载各跑三次真实 Chrome；记录启动、VFS/OPFS/IndexedDB 写入、Workspace commit、刷新 hydrate、帧间隔和存储估算。九组原始样本保存在 [operational-capacity-chrome-results.json](operational-capacity-chrome-results.json)。 |
| 存储配额与进程重启 | 已完成（限定范围） | Chrome CDP quota override 触发真实 OPFS quota 错误并验证 fail-closed；持久 Chrome profile 与 PoC backend 正常关闭/重启后恢复 OPFS、IndexedDB 和远端 manifest。自然 eviction 和 OS 级崩溃仍未验证。 |

## 本批修复

真实 Worker 验收发现 Session 的 `session/flush` 只提交 Workspace receipt，却没有 flush 对应远程 Session writer。现在该事件也等待 Session writer flush；Chrome E2E 检查当前用户消息 append 后、对应 LLM 请求前确实发生 flush，并检查 tool/call 在执行前 durable、tool/result 在 checkpoint 后追加。此修复只作用于 PoC provider 和测试。

容量 E2E 首次增加每次 commit 的脱敏元数据后，写入压力偶发 `local persistence is still pending`。原因是等待期间另一个 Worker mutation 已把 `localPersistVersion` 前推，并在旧 promise 完成后追加了下一次保存；原 `awaitLocalPersist()` 只等待一次当时捕获的 chain，误把仍在排队的快照当成失败。现在它循环等待到已持久化版本追上当前版本，并继续在真实 store error 时 fail closed；新增受控并发单测覆盖“首个 save 等待时新增 mutation”的时序。

运行真实模型时发现继承的 `{{cwd}}` 不是当前 prompt registry 支持的变量，会在发出模型请求前令 turn 失败；已从 PoC overlay 移除。另修正 MessagePort test response 的 `requestId` 覆盖问题，并为 Workspace identity cookie 设置一年 `Max-Age`，使持久 Chrome profile 重启后仍能识别原 PoC Workspace。该 cookie 是 PoC 身份标识，不是 SaaS 用户认证；生产环境仍须由服务端认证/授权，并设计身份撤销和数据保留策略。

## 验证记录

以下结果来自本批实际执行；真实模型失败样本也保留，不把单次超时隐藏在通过结果之外。

| 命令或检查 | 结果 |
|---|---|
| `pnpm run build:artifacts` | 通过；生成 Host、Client、Web 及相关 artifact。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；构建输出有既存平台依赖警告、tsdown deprecation 和大 chunk 提示。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 11 项测试通过，包括新增的并发本地 snapshot 等待回归。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs` | scripted Chrome 在真实 Web UI 中创建 Session 并完成消息闭环；观察到 preview 附属 `/open-in-app/apps` 返回 404，已由[手动验收说明](manual-acceptance.md)标为 backend 未实现的非阻塞 UI 路由；页面无未处理异常。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=600000 DSH_POC_TURN_TIMEOUT_MS=900000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs` | 真实 Chrome、真实模型和当前 Browser profile 三轮通过；实际执行恰好一次 `todo_write`，Session 中保存 pending task，后两轮正确回忆随机 token 与任务标题。浏览器观察到非阻塞 `/open-in-app/apps` 404，所有 LLM HTTP 状态为 200，无 pageerror。第一轮耗时约 149 秒，后两轮分别约 11 秒和 9 秒。 |
| `node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs` | 真实 Chrome Worker/DSH shell `printf` 调用通过；工具 roster、DSH tool/result、Session checkpoint、无外站请求和无页面异常均断言通过。 |
| `node docs/drafts/browser-native-dsh-poc/tests/lazy-archive-runtime.e2e.mjs` | 真实 Chrome 中首次 lazy archive 请求失败后成功重试；读取同一已加载归档文件时命中内存缓存，无第二次网络请求。归档 runtime 校验路径登记与文件长度，不代表验证归档 SHA-256。 |
| `node docs/drafts/browser-native-dsh-poc/tests/browser-quota-enforcement.e2e.mjs` | Chrome CDP `Storage.overrideQuotaForOrigin` 降低配额后，OPFS 写入返回 quota 错误；Agent 文件工具 fail-closed，刷新后已提交 anchor 可读、失败文件不在 manifest。此为实际浏览器存储拒绝，不是自然 quota exhaustion 或 eviction。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-durable-ack.e2e.mjs` | 真实 Chrome DSH `write` 遇到 IndexedDB abort 时返回失败；刷新后同 Session 显式 retry，Workspace 只 commit 一次并获得 receipt；无 pageerror 或外站请求。 |
| `node docs/drafts/browser-native-dsh-poc/tests/chrome-process-restart.e2e.mjs` | 持久 Chrome profile 和 backend 正常关闭并重启后，原 Workspace revision、IndexedDB 记录和 OPFS blob 恢复；同源请求、无页面异常。不是浏览器 crash 测试。 |
| `DSH_POC_RESULT_FILE=docs/drafts/browser-native-dsh-poc/operational-capacity-chrome-results.json node docs/drafts/browser-native-dsh-poc/tests/operational-capacity.e2e.mjs` | 九组 Chrome 样本均通过；每个独立 browser context 完成写入、远端提交、刷新 hydrate 和文件内容核对，所有 commit 请求均返回 HTTP 200。commit 请求数分别为：64 个小文件 `20 / 2 / 17`，8 个中型文件 `1 / 1 / 1`，2 个大文件 `1 / 1 / 2`。异步提交批次数随运行变化，当前样本没有验证其成因或承诺固定批次数；原始记录保留在 JSON。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实模型 Chrome E2E 通过。`gpt-5.6-sol` 执行 `read → write → read`，同一 Session 多轮记忆、刷新后续聊、Session 事件 durable 和浏览器不接触凭据均通过；57 个 Session event 已 flush。密钥仅由 backend 读取。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 未通过。Worker 成功执行首个 `read`，后续模型输出的 `write` tool-call 在 180 秒上游请求截止前未完成，turn 以 `UPSTREAM_LLM_TIMEOUT` 结束；没有成功 write/result。 |
| 同一 `roster=original` 命令将 `DSH_POC_LLM_TIMEOUT_MS` 调至 `600000`、`DSH_POC_TURN_TIMEOUT_MS` 调至 `900000` | 未通过。Session 完成多个 turn，但首个 turn 没有生成脚本要求的 `read → write → read` 工具序列，刷新后的文件探测确认文件不存在；脚本按预期失败。未将其归因为 Worker 错误或上游服务故障。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=600000 DSH_POC_TURN_TIMEOUT_MS=900000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs`（首次运行，旧测试匹配逻辑） | 三个真实 turn、todo 和多轮记忆都完成，但测试 harness 将带 JSON 字符串转义的 prompt 做原始子串匹配，错误报告未观察到 LLM 请求。修复匹配逻辑后同命令重跑通过；首次结果不算完整通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 15 项 backend tests 通过，包括 identity 重启恢复、Session durability、Workspace commit、fencing 和 secret redaction。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 2 个文件、21 项测试通过。 |
| `pnpm run verify-md-wrap` / `pnpm run verify-md-links` / `pnpm run doc-typecheck` | 分别通过；检查 2,128 个 Markdown 文件、2,091 个文档链接、100 个 fenced type blocks。 |
| `pnpm run test:docs` | 首次运行因本进度文档直接写入 commit hash 而失败；替换为 release tag 后重跑通过，最终 21 个 doc-quick gates 全通过。 |

同一真实模型场景曾有一轮第三 turn 遭遇上游约 60 秒超时；该轮不计入通过。之后按表中完整命令再次运行并通过。最近一次在修正逐轮 flush 断言后再次完成三轮，第一轮约 7 秒、后续两轮约 3 秒和 4 秒，Session 共 41 个事件。真实模型的成功结果不替代脚本模型对工具调度、配额及进程重启的独立断言。

实际 Browser profile 的真实文件序列专项测试保留失败样本：一次明确是上游请求超时，另一次模型没有遵循 `read → write → read` 要求。独立的默认 Web UI 测试后来通过真实 `todo_write` 和三轮记忆，证明真实模型可以使用默认 profile 中的一项工具；它不替代文件读写序列证据。两类失败都不能证明 Worker 实现错误，也不能被真实 todo 测试抹去。

## 容量样本摘要

以下为九组样本的中位数，时间单位为毫秒。`many-small` 为 64 个 256 B 文件，`multi-medium` 为 8 个 16 KiB 文件，`few-large` 为 2 个 512 KiB 文件；每种负载总字节分别为 16 KiB、128 KiB、1 MiB。

| 负载 | 本地 VFS/OPFS/IndexedDB 写入中位数 | Workspace 同步阶段中位数 | 刷新 hydrate 中位数 | 三次样本的 commit 请求数 |
|---|---:|---:|---:|---:|
| 64 个小文件 | 3,475.8 | 95.4 | 1,127.5 | 20 / 2 / 17 |
| 8 个中型文件 | 74.5 | 346.5 | 240.5 | 1 / 1 / 1 |
| 2 个 512 KiB 文件 | 108.4 | 229.2 | 309.9 | 1 / 1 / 2 |

表中时间单位为毫秒；同步阶段计时从显式 `flush-workspace` 开始，可能等待此前已启动的异步 commit。小文件样本的本地写入耗时和 commit 请求数波动明显；这组测试只检查所有文件最终提交并在刷新后恢复，不保证一次 flush 对应一次 commit，也没有定位批次数变化的原因。JSON 保存每个 commit 的 `operationId`、base revision、变更路径数、状态和耗时，不包含文件内容。样本来自单台 macOS 机器和 Chrome 155.0.8059.85，包含进程/机器负载波动；不是大文件上限、并发容量、SLA 或跨设备网络性能结论。原始样本也包含浏览器启动时间、frame interval、存储估算和每次测量值，汇总方法与脚本见 [operational-capacity.e2e.mjs](tests/operational-capacity.e2e.mjs)。

## 尚未验证

- Chrome 自然 storage eviction、不同浏览器的 quota 计算及真实设备磁盘耗尽。
- OS 级 Chrome 强制崩溃、断电或未正常关闭后的恢复；本批只验证正常关闭与重启。
- Safari/WebKit、移动浏览器、跨设备网络、生产对象存储、多租户授权、真实并发容量和 SLA。
- 所有 DSH 插件逐包兼容性、所有 Node builtin shim、动态模块解析、`fs.watch`、原生 addon 和后台进程行为。
- lazy archive 内容的密码学完整性；当前实测只证明已注册路径/长度核对、请求失败后重试和成功后的缓存。
- 当前默认工具集合中 todo、问答等非本批核心工具的完整业务语义；出现在 schema 中不等于本批逐项执行通过。

详细兼容性证据见[矩阵](operational-compatibility-matrix.md)，复跑命令见[验证计划](operational-envelope-validation-plan.md)和[PoC README](README.md)。
