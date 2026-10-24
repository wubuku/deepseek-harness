---
description: "按真实 Chrome Worker 执行、同源 backend 提供、明确排除和未验证分类 Browser-Native DSH 的模块兼容范围。"
---

# Browser-Native DSH 插件与模块兼容矩阵

## Summary

当前 checkout 已在 Chrome 中运行真实 DSH Host 与 `ctx.agentLoop`，并验证部分文件工具、受限 Bash、用户问答、工作目录切换、Session/LLM backend 和 Workspace durable store。该证据只覆盖表中列明的调用路径；preview 中存在模块、模块能 import 或插件能启动，都不能单独证明插件可以工作。

## 状态定义

| 状态 | 含义 |
|---|---|
| Chrome Worker 已执行 | 真实 Chrome 页面启动真实 Dedicated Worker/DSH Host，并执行了该行列明的操作。 |
| 同源 backend 提供 | 浏览器通过 PoC 同源 API 调用服务端实现；不是浏览器 Worker 内的本地 Node 能力。 |
| 明确排除 | 当前 Browser PoC 的 profile/schema 不暴露此能力；不表示对应 package 无法构建或加载。 |
| 尚未验证 | 当前证据不足以判断行为是否兼容，不能按“已支持”使用。 |

## 矩阵

| 模块或能力 | 当前状态 | 当前 checkout 的证据 | 不能据此推断 |
|---|---|---|---|
| Web preview bootstrap、Dedicated Worker、真实 Cordis Host 与 DSH `ctx.agentLoop` | Chrome Worker 已执行 | [默认能力 E2E](tests/default-profile-capabilities.e2e.mjs)、[真实模型运行时 E2E](tests/runtime-validation.e2e.mjs)、[Worker Host](../../../packages/experimental/webworker-runtime/src/worker-host.ts) | 所有 DSH 插件都能在该 Host 内工作。 |
| Browser-Native capability manifest 与 boot 前预检 | Chrome Worker 已执行 + 静态预检单测 | [能力预检进度](browser-capability-preflight-progress.md)；Worker 在创建 Workspace/Host 前检查默认插件、工具及不支持的主机能力；单测覆盖缺失 capability 和重复声明 | 任意 Cordis profile 会被动态扫描；manifest 已经是正式 package capability service；预检通过就等于每个插件的全部运行路径已通过。 |
| DSH 文件工具和 Worker VFS | Chrome Worker 已执行（选定操作） | 独立 validation roster 的真实模型 E2E 执行 `read → write → read`；默认 Browser profile 的 scripted shell 和真实 todo 另见对应 E2E。durable Workspace 与文件工具的更广操作矩阵见 [Workspace 验证记录](high-value-validation-progress.md) 和 [恢复边界记录](recovery-boundary-validation-progress.md)。 | 完整 Node `fs` 行为、权限模型、文件 watcher 或任意第三方文件工具都兼容。 |
| DSH 文件工具访问 Browser Worker VFS | Chrome Worker 已执行（有界 fallback） | [Browser 文件工具 E2E](tests/browser-native-file-tools.e2e.mjs)验证 `grep`/`glob` 在 Worker 内不启动主机子进程，并覆盖 include、regex、结果上限、非法正则、二进制文件、超长 edit 和失败后继续；[下一批文件工具进度](browser-file-tools-next-validation-progress.md)另记录显式栈遍历、分块 UTF-8 读取、glob 5,000 路径上限和真实 OPFS backing 回归；`browser-native-file-tools-cancel.e2e.mjs`验证取消 helper 后真实 DSH turn 仍可继续。 | 这是 PoC 专用的 JavaScript fallback，不是完整 ripgrep 语法或任意容量搜索；仅限制在 `/dsh/home/workspace`，结果、扫描字节、文件数、命中行、pattern、行长和 edit 载荷均有上限。正则复杂度防护是有限启发式，不是完整 ReDoS 保证；helper 取消不是模型自主取消。 |
| DSH 文件工具访问 OPFS 外置大文件 | Chrome Worker 已执行（scripted 工具选择）；真实 LLM 已执行普通文件闭环 | [OPFS 文件工具 E2E](tests/opfs-agent-file-tools.e2e.mjs)在 12 MiB 冷 hydrate 文件上经真实 DSH 工具运行 `read → grep → edit → read`，并验证单次 Workspace receipt、载荷大小和刷新后同 Session 读取；[真实 LLM E2E](tests/runtime-validation.e2e.mjs)另执行普通大小文件 `read → write → read` 并刷新恢复。 | 大文件序列的工具选择由 scripted handler 固定；本批 fallback 只证明受限 Browser-native 搜索，不证明真实模型会选择它。`edit` 会完整 materialize 文件；10 MiB 单行曾导致 Session body 超限，未验证任意行长、多文件 heap 峰值或大型真实模型参数。 |
| Worker Bash | Chrome Worker 已执行（受限命令） | [默认能力 E2E](tests/default-profile-capabilities.e2e.mjs) 通过实际 `printf`、`printf | tr`、文件重定向、`cat` 和不支持命令失败，并检查 DSH `tool/call`、`tool/result` 与 Session checkpoint；工具实现由 Worker runtime 固定命令表提供。 | 它是主机 shell、可执行任意二进制、可运行 Node、后台进程或可访问用户硬盘；本批只验证列明的命令语义。 |
| Session persistence | 同源 backend 提供 | [Browser provider](browser-native-providers.ts) 将 Session 写入同源 backend；[运行时 E2E](tests/runtime-validation.e2e.mjs) 检查多轮与刷新后事件；本批修复并验证 `session/flush` 等待远程 writer flush。 | Session JSONL 可直接放进只支持 append 的浏览器存储，或与 Workspace 组成原子事务。 |
| LLM 调用 | 同源 backend 提供 | [运行时 E2E](tests/runtime-validation.e2e.mjs) 使用真实 provider；凭据从本机 `docs/drafts/.env` 由 Node backend 读取。 | 浏览器持有模型密钥、可绕过服务端授权，或任意模型/provider 配置已验证。 |
| Durable Workspace | Chrome Worker 已执行 + 同源 backend 提供 | [配额 E2E](tests/browser-quota-enforcement.e2e.mjs)、[进程重启 E2E](tests/chrome-process-restart.e2e.mjs)、[容量 E2E](tests/operational-capacity.e2e.mjs) 覆盖选定 OPFS/IndexedDB 和 manifest/blob 操作；[缓存清除 E2E](tests/durable-workspace-cache-reset.e2e.mjs)证明清除本地存储后可重建；[backend outage E2E](tests/workspace-cache-backend-unavailable.e2e.mjs)证明 manifest 503 时状态保持 `error`；[OPFS VFS 驻留 E2E](tests/opfs-vfs-residency.e2e.mjs)证明刷新 hydrate 后已提交文件可通过同步 range backing 读取；[冷 hydrate E2E](tests/cold-hydrate-integrity.e2e.mjs)验证缺少本地 blob 时分块写入 OPFS 并校验 hash。 | backend 是生产云存储；自然 eviction、跨设备冲突或无限容量已经解决。durable 冷 hydrate 使用分块读写，fallback store 仍可能组装完整字节；外部 backing 不是零拷贝或完整 OPFS 文件系统。503 场景由路由注入，不是停止真实 backend 进程。 |
| OPFS orphan blob 回收 | Chrome Worker 已执行（保守回收） | [orphan reconciliation E2E](tests/orphan-blob-reconciliation.e2e.mjs)在 metadata transaction abort 后删除无引用 blob，保留 manifest 引用；删除 IndexedDB metadata 后状态为 `local-corrupt` 且不回收。 | 未验证自然 eviction、长期远端 blob GC、跨设备引用扫描或生产恢复包导入。 |
| durable `pagehide` 本地屏障 | Chrome Worker 已执行 | [pagehide barrier E2E](tests/pagehide-local-barrier.e2e.mjs)验证页面离开先等待本地 snapshot/blob flush，再收到 ack 或超时终止 Worker；`persisted=true` 保留 Worker。 | 不保证 Session/云端 commit、不提供页面关闭后的后台 Agent；1.5 秒超时后的本地状态取决于已完成的 durable 操作。 |
| Session/Workspace/lease 组合恢复 | Chrome Worker 已执行（scripted） | [receipt recovery](tests/agent-workspace-receipt-recovery.e2e.mjs)验证 outbox 只追加一条 receipt；[unknown commit recovery](tests/agent-workspace-unknown-commit-recovery.e2e.mjs)验证 backend 重启后唯一 revision；[writer expiry](tests/workspace-writer-expiry.e2e.mjs)验证旧 fencing token 的 resume、renew、commit 和 release 被拒。 | 三个状态分别验证，不证明 Session、Workspace 和 lease 存在跨存储原子事务；真实模型、跨主机 HA 和后台执行仍未验证。 |
| Workspace 大文件分块传输 | Chrome Worker 已执行 + 同源 backend 提供 | [大文件 E2E](tests/large-file-scale.e2e.mjs)验证 16/64 MiB 文件以 1 MiB chunk 上传、staging 损坏补传、响应丢失后的幂等恢复、backend 重启、刷新 hydrate 和 hash/bytes；[千文件 E2E](tests/many-small-files-scale.e2e.mjs)验证 1,000 个小文件的本地 snapshot 合并和单次 Workspace commit。 | 只限制 Workspace blob 的 HTTP body；`MemoryVfs` 与最终下载仍整体持有文件，Session/tool-call JSON 仍有独立上限；不代表块级 delta、生产对象存储、自然 eviction 或任意容量。 |
| 可写 chunk-backed 局部编辑原型 | Chrome Worker 已执行（PoC-only OPFS probe） | [可写分块编辑 E2E](tests/chunk-backed-edit.e2e.mjs)在 Worker 内生成 64 MiB 文件，使用 1 MiB buffer 完成跨 chunk UTF-8 替换；成功结果 hash 与独立复算一致，`maxWorkingBytes=1,048,620`；`copy-prefix`、`copy-suffix`、replacement、truncate、hash、publish 六个故障点都保持源文件不变。 | 这是独立存储原型，不经过 DSH Agent Loop、`MemoryVfs` mutation sink、Workspace manifest 或 Session receipt；不是块级云同步、零拷贝、进程 RSS SLA 或正式 `edit` 能力。真实 DSH 对照仍会 materialize 16 MiB 文件。 |
| 大型 Agent 工具参数 | Chrome Worker 已执行（scripted LLM） | [大型参数 E2E](tests/large-tool-arguments.e2e.mjs)验证 768 KiB `write` 完整执行；Browser LLM adapter 在一次响应累计参数超过 1 MiB 时中止流，6/9 MiB 参数未成为 Session `tool/call`、未派发工具，同 Session 后续 turn 成功。最大观测 Session append body 为 3,147,323 bytes。 | 1 MiB 是 PoC adapter 的硬上限，不是 Session 事件规范；更大的合法参数被拒绝。真实模型生成大型参数、精确 Session body 极限和较大事件的分块存储未验证。 |
| S3-compatible Workspace blob | Chrome Worker + 同源 backend + 本机 MinIO | [MinIO E2E](tests/workspace-s3-minio.e2e.mjs)验证 2,097,189-byte staging 文件流上传、流式 SHA-256 校验、1 MiB Range 读取、服务 outage 503、上传后对象丢失时 commit 409、刷新后从本地 retry 补传，以及 backend 重启读回。 | 默认 launcher 仍用本地文件 blob store；只有测试 constructor 注入 S3 adapter。Session、manifest、identity、lease 和 operation ledger 保持本地 JSON；真实云对象存储、云权限、生命周期和跨进程写入未验证。 |
| backend 共用 `dataDir` 的并发 | 单写者 fail-closed；强杀后可接管 | [多实例与强杀恢复 E2E](tests/workspace-backend-multi-instance-characterization.e2e.mjs)启动两个独立 Node PID，第二个在 `listen()` 前因 `BACKEND_ALREADY_RUNNING` 失败；第一进程 `SIGKILL` 后新进程冷启动恢复 Session event、Workspace revision 和原 operation receipt。 | 锁只覆盖同一主机的本地 `dataDir`；不提供跨主机 HA、共享 metadata 事务或 OS/磁盘 crash durability。旧双 backend 并发接受写入的负面结果保留在历史进度中。 |
| Chrome 进程 `SIGKILL` 后身份和本地 retry | Chrome 进程已执行（隔离 profile） | [强杀恢复 E2E](tests/chrome-process-crash-recovery.e2e.mjs)对唯一 profile 强杀 7 个 Chrome PID；OPFS/IndexedDB retry 保留，但匿名 identity cookie 未自动恢复。测试桩注入旧 cookie 后，同一 operation 只提交一次。 | 不覆盖 OS、文件系统或断电崩溃；cookie 测试桩注入不代表产品可自动找回旧 Workspace 身份。 |
| OPFS blob / IndexedDB metadata 单侧丢失 | Chrome 页面与 Worker 已执行（定向删除） | [局部丢失 E2E](tests/workspace-partial-storage-loss.e2e.mjs)只删除其中一侧数据；OPFS 缺失时页面报告 `local-corrupt` 和缺失 hash，metadata 缺失时拒绝把孤儿 bytes 当作空 Workspace，并可按 hash 导出。 | 这是定向故障注入而非浏览器自然 eviction；metadata 丢失后原文件路径和 operation 关联不能恢复。 |
| lazy archive 首次加载、失败重试和成功缓存 | Chrome Worker 已执行 | [Lazy archive E2E](tests/lazy-archive-runtime.e2e.mjs) 让第一次归档请求连接失败、第二次成功、后续读取不再请求。运行时校验归档内容的登记路径和文件字节数。 | 所有懒加载 package 都能运行；归档文件具有已验证的密码学 checksum 或签名。 |
| `tool-todo` | Chrome Worker 已执行（单次新增） | 真实模型 [默认 Web UI E2E](tests/browser-native-v2.e2e.mjs) 执行一次 `todo_write`，并核对 durable Session 中恰有一条 pending task。 | 所有 todo 修改操作、并发写入、取消或刷新中断都已验证。 |
| `tool-ask-user` / `ask_user_question` | Chrome Worker 已执行（问答闭环、刷新中断与新 turn 续聊） | [交互工具 E2E](tests/default-interaction-tools.e2e.mjs)在真实 Web UI 中显示问题、提交用户选择、记录 DSH `tool/result` 并继续同一 Agent turn；[刷新恢复 E2E](tests/ask-user-refresh-recovery.e2e.mjs)证明刷新会将丢失的等待结算为 `TOOL_OUTCOME_UNKNOWN` 和 interrupted turn，不保留旧问题卡、不自动重跑；用户之后可在同一 Session 发起新 turn。 | 原 Promise 跨 Worker 刷新恢复、迟到答案 inbox、真实模型选择和取消/超时均未验证；新 turn 不是旧审批答案。 |
| `working_directory` | Chrome Worker 已执行（切换后相对写入） | 同一[交互工具 E2E](tests/default-interaction-tools.e2e.mjs)记录 `working-directory/change`，再用相对路径调用 `write`；远端 manifest 中的文件位于所选子目录。 | 任意工作目录、目录权限变化、刷新后 cwd 恢复和所有路径工具均已验证。 |
| `read_image` | 明确排除于当前 Browser profile | [Browser profile](browser-native-profile.cordis.patch.yml)将 `tool-fs.readImage` 设为 `false`；Browser LLM adapter 的 `resolveModel()` 未声明 `inputModalities`，而正式工具拒绝未知 image input route；默认能力与[交互工具 E2E](tests/default-profile-capabilities.e2e.mjs)均断言 schema 不含 `read_image`。 | 该模型或其他 Browser profile 永远不支持图像；图像能力本身无法通过可信模型元数据启用。 |
| Workspace writer lease 续租和交接 | Chrome Worker 已执行（单 backend、测试 TTL） | [heartbeat E2E](tests/workspace-writer-heartbeat.e2e.mjs)在 20 秒 TTL 下等待两个以上 TTL，注入一次 renew 503 后观察到恢复续租、竞争 claim 409，最终同一问答 turn 完成 DSH `write`；[启动失败 E2E](tests/workspace-writer-startup-failure.e2e.mjs)注入 manifest 503，确认失败 Worker 不再续租且服务端 lease 到期后可接管；[Worker handoff E2E](tests/workspace-worker-handoff.e2e.mjs)验证页面关闭后的 fencing 交接。 | Workspace prepare 失败后服务端 lease 保留至 TTL 到期；页面冻结期间 heartbeat、浏览器进程崩溃、多实例 backend 和生产 lease SLA 未验证；活动标签页测试不代表后台 Agent。 |
| IndexedDB 前向 schema 与恢复导出 | Chrome 页面已执行（v2 数据库由 v1 PoC 读取） | [前向版本 E2E](tests/indexeddb-forward-version-export.e2e.mjs)确认 v2 database version、Workspace metadata 和未知 store 内容不变；页面 fail closed 并导出已识别的 metadata、store 名称及 hash 校验通过的 OPFS bytes。 | 不自动迁移未知 schema；未知 object store 记录不导出，也未验证更高版本数据库格式的语义兼容性。 |
| Agent `write` 未知 commit 与 backend restart | Chrome Worker 已执行（scripted LLM、单 backend） | [未知 commit E2E](tests/agent-workspace-unknown-commit-recovery.e2e.mjs)在 Workspace commit 持久化后丢弃响应、终止 Worker 并以相同 dataDir 重启 backend；刷新后沿用 operation 查询恢复唯一 revision/receipt，原 DSH 调用记录为 `TOOL_OUTCOME_UNKNOWN`。 | 多实例存储原子性、跨服务事务、真实模型选择和任意副作用重放均未验证。 |
| Web search、web fetch | 明确排除 | [Browser profile](browser-native-profile.cordis.patch.yml) 不注册这些工具；默认能力 E2E 断言模型 schema 不含 `web_search` / `web_fetch`。 | Browser-Native 本身绝不可能通过经过设计和授权的 backend adapter 提供网络工具。 |
| PowerShell、subagent、后台 jobs | 明确排除 | Browser profile 不注册这些工具；默认能力 E2E 检查 schema 中不存在对应工具名。 | 所有相近的业务协作或服务器任务能力都应该由 Worker 模拟。 |
| Worker Node builtin shim 与动态模块解析 | 尚未验证（逐插件行为） | [Worker runtime Node 实现](../../../packages/experimental/webworker-runtime/src/node/)及 [module loader](../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts) 提供受限实现；本批 E2E 不逐项调用 builtin 或第三方依赖。 | Node API 完整兼容，或凡是 import 成功的 plugin 就可正确运行。 |
| `fs.watch` / 长期文件 watcher | 尚未验证 | 本批容量、重启、工具和 archive 测试均未创建或断言 watcher 生命周期。 | Worker 被挂起、页面关闭或浏览器重启后 watcher 会继续。 |
| 真实子进程、原生 addon、主机二进制 | 明确排除于 Browser Worker 执行模型 | Browser profile 的 Bash 是 Worker 固定命令表；本批没有宿主进程桥接。 | “受限 Bash”可以代替系统 shell、PTY、native addon 或主机侧进程监管。 |

## 解释和复跑

测试使用真实 Chrome，但除明确标记真实模型的 Session/LLM 路径外，能力和故障验收使用 scripted LLM。`default-profile-capabilities.e2e.mjs` 验证 Browser profile 的实际 schema 与受限 Bash 调用；`default-interaction-tools.e2e.mjs` 验证问答与工作目录闭环；`runtime-validation.e2e.mjs` 的真实模型文件读写序列使用独立 Browser validation roster。因此，不要把这些测试合并表述成“真实模型已验证 Browser profile 中每个工具”。

运行命令、Chrome 版本、测试结果和未验证范围见[运行范围验证进度](operational-envelope-validation-progress.md)。矩阵针对本 PoC 当前 checkout，不能替代 DSH package README、runtime API 文档或生产兼容性承诺。

## Dev Note

矩阵只列高价值能力类别，不是穷尽的 package 清单。要提高某一插件的状态，至少需要在目标 Chrome Worker/profile 中验证其真实输入、外部依赖、成功结果、失败语义和 Session/存储行为；单元测试、模块解析成功或构建产物计数不足以升级状态。
