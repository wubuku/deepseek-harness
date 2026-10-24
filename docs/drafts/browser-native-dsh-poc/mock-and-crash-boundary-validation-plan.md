---
description: "规划 Browser-Native DSH 的局部浏览器存储丢失、Chrome 强杀、backend 多进程、超大工具参数和 S3 兼容 blob 存储验证。"
---

# Browser-Native DSH 故障边界与存储后端验证计划

## Summary

本批针对 Browser-Native DSH 尚未覆盖、但可由隔离故障注入或本机真实进程复现的状态风险。验证 OPFS 与 IndexedDB 局部丢失、Chrome 进程强杀后恢复、两个 Node backend 共用 `dataDir` 时的并发语义、DSH `tool/call` 参数超过 Session HTTP body 上限时的实际结果，并通过本机 MinIO 检查可替换的对象 blob 存储是否能接入现有 Workspace 协议。

这些实验不把故障注入称为自然 eviction，不把 Chrome 强杀称为操作系统或磁盘崩溃，不把两个进程的 PoC 结果外推为生产 HA，也不把 scripted LLM 生成的参数称为真实模型行为。MinIO 结果只覆盖 S3 兼容的 blob API；Workspace manifest、身份、lease、operation ledger 和 Session 仍由 PoC 本地 `dataDir` 管理。

## 候选盘点

| 候选 | 当前证据 | 本批处理 | 证据边界 |
|---|---|---|---|
| OPFS 单 blob 丢失、IndexedDB retry metadata 保留 | 已有全量缓存清除、坏 snapshot/blob 和前向版本测试；没有只删一侧的矩阵 | 纳入 | 通过真实 Chrome 定向删除 OPFS blob 或 IndexedDB 行模拟局部数据丢失，不称自然 eviction。 |
| Chrome 进程强杀后复用 profile | 已有正常 Chrome 关闭与重启；Worker terminate 也已有测试 | 纳入 | `SIGKILL` 仅覆盖浏览器进程非正常退出，不覆盖 OS、文件系统或断电崩溃。 |
| 两个 backend 进程共享 `dataDir` | 现有明确限制为单 backend；互斥锁和 writer lease 均驻留进程内 | 纳入 | 使用独立 Node 子进程竞争 Session append/owner 和 Workspace 同 revision commit；若观察到双重接受或覆盖，作为当前实现不支持多实例的负面证据，不实现分布式协调。 |
| 大型 DSH 工具参数与 Session append 限制 | Workspace blob 已支持 64 MiB 分块；Session JSON 请求上限为 8 MiB，尚无大型 `tool/call` 的安全验证 | 纳入 | scripted stream 经真实 DSH Worker 覆盖 768 KiB 成功调用和 6/9 MiB 超限调用；超限参数应在 Browser LLM adapter 内被拒绝，不能进入 Session 或工具执行。 |
| S3 兼容对象 blob 存储 | `WorkspaceStore` 直接管理本地文件，尚无 blob-store 注入点；Docker 和本地 MinIO 镜像可用 | 纳入最小集成原型 | 增加仅限本 PoC 的 blob store 适配点，以隔离依赖连接 MinIO，并通过真实 Workspace HTTP 路径写入、读取和 backend 重启验证；不迁移 manifest/CAS/lease 到对象存储，不称生产对象存储。 |
| 浏览器自然 storage eviction | 已有 CDP quota override、显式清缓存和局部数据删除可用 | 不模拟自然策略 | 浏览器不提供可重复的“自然 eviction”触发器；本批定向删除只验证丢失后的恢复和错误语义。 |
| OS/磁盘级崩溃 | 本机可终止 Chrome，但不能安全、可重复地让宿主机断电或模拟文件系统崩溃 | 不执行 | Chrome 强杀提供较窄的进程崩溃证据；OS、设备和文件系统级持久性仍须专门虚拟机或故障实验环境。 |
| 生产对象存储与真实云服务 | 当前没有生产云配置、对象存储适配器或部署凭据 | 不连接生产服务 | MinIO 验证协议和本地 adapter 集成，不验证 AWS/GCS/Azure 权限、region、服务故障、成本、SLA 或生产身份模型。 |
| 真实 LLM 生成超大工具参数 | 真实模型请求延迟和工具选择不可确定，且不能保证生成所需体量 | 不作为主验收 | scripted stream 可确定性覆盖 DSH、Session 和 Workspace 的字节路径；模型生成质量另行验证。 |

## 交付面

### 1. 局部浏览器存储丢失

先让真实 Worker 形成一个尚未提交到远端的 durable retry，确认 IndexedDB metadata 与 OPFS bytes 均存在，再分别只移除 OPFS blob 和只移除 IndexedDB retry row。刷新后记录 Workspace 状态、Session/远端 revision、是否能读取文件、恢复导出中可用/缺失的数据，以及是否发生自动重放或错误的 `synced` 结论。

验收必须保留原始 OPFS/IndexedDB 组合状态和远端 manifest 作为对照。若只删除 metadata 后剩余 OPFS bytes 不可关联到可恢复操作，报告这是本地索引丢失造成的不可判定孤儿数据；不得宣称可恢复，也不得自动把这些 bytes 提交到云端。

### 2. Chrome 进程强杀和恢复

使用只供本测试使用的 Chrome profile 和临时 backend 目录。在本地 retry 已 durable、远端 commit 被暂时阻断时，记录 profile 中的 OPFS/IndexedDB 状态和同源匿名身份 cookie，强制终止所有命令行带该唯一 profile 路径的 Chrome 进程，再以同 profile 重启 Chrome。先判断浏览器自动恢复的身份是否仍指向原 Workspace；如果 cookie 丢失而本地 OPFS/IndexedDB 仍保留旧 Workspace retry，则记录该身份恢复缺口，再由测试桩注入原 cookie，单独确认相同 `operationId` 可完成一次 commit。

进程筛选必须匹配本测试生成的完整唯一 profile 路径，并在结束时确认该路径下的 Chrome 进程均已退出；禁止按通用 Chrome 进程名杀进程。该测试不终止宿主机、Docker daemon 或其他浏览器。测试桩注入旧 cookie 只用于隔离验证 OPFS/IndexedDB retry，不能作为用户可用的自动恢复能力。

### 3. 同一 `dataDir` 的多 backend 竞争

由父测试启动两个独立 Node 子进程，确认它们各自完成 `WorkspaceStore` 和 `FormalSessionStore` hydrate 后，再使用相同 principal/Session 分别 claim 写权并同时 append 相同 `expectedNextSeq` 的不同事件；另对同一 Workspace revision 提交不同文件变更。停止两进程后启动第三个实例读取持久化结果，并对照每次请求的 HTTP 状态、两进程返回值和最终事件/manifest。

本项是限制确认实验，不要求当前 PoC 多实例通过。若两个实例都接受同一序号、各自认为 commit 成功但重启后只有一份结果，最终结论应标记为“共享目录多实例不安全”；修复生产协调需要共享数据库的事务、唯一约束或对象条件写，不在本批手写替代实现。

### 4. 大型工具参数与 Session append 安全

通过 Browser-specific validation roster、真实 Chrome Worker、真实 DSH `ctx.agentLoop` 和 scripted LLM stream 生成大型 `write` 参数。覆盖一个可完整持久化并执行的 768 KiB 参数，以及 6 MiB、9 MiB 参数在 adapter 累计参数上限处被拒绝。采集模型流、Session append 请求大小/状态、Session event、工具调用、Workspace revision、turn 终态和同 Session 后续普通消息。

adapter 必须在发出完整的超限工具调用前拒绝参数，避免 Agent Loop 把大参数写入 Session 或派发给工具。若只靠 Session backend 的 8 MiB body rejection，工具参数可能形成反复失败的 append；不能把它当作足够的保护。测试还要在同一 Session 发送普通后续消息。

### 5. MinIO S3 兼容 blob adapter

保持默认文件系统 backend 行为不变，在 PoC Workspace backend 加入可注入的 immutable blob store 接口；本地测试 adapter 用 pinned AWS SDK 和 MinIO 测试凭据写入 content-addressed blob。分块 staging 完成后，backend 以文件流上传对象并以流式 SHA-256 校验已存内容；SDK 可选请求/响应 checksum 不作为完整性来源。manifest、CAS、operation ledger、身份和 writer lease 暂留本地 JSON `dataDir`。

真实 Chrome Worker 经同源 Workspace API 上传分块、完成 blob、commit manifest、Range 下载并验证内容；随后停止并重启 backend，验证本地 manifest 与 MinIO blob 能共同恢复。另注入 MinIO 暂不可达，以及上传完成后、manifest commit 前对象被删除；检查 API 不确认 commit，并验证刷新后本地 retry 会重新上传缺失对象。容器必须用随机名称、临时数据目录、动态 loopback 端口；只删除本测试创建的容器和目录。

## 实施顺序

1. 新增两个单独的计划/进度记录并完成基线核对；记录已有测试和目标边界。
2. 实现 OPFS/IndexedDB 局部丢失 Chrome E2E，先复现两种单侧丢失的当前行为。
3. 实现隔离 profile 的 Chrome 强杀脚本，先验证进程定位只匹配测试 profile，再验证 restart/retry。
4. 实现双 Node 子进程的 Session 与 Workspace 竞争 characterization，保存冷启动重读证据。
5. 扩展 scripted LLM、实现大工具参数 E2E；如果参数写入 Session 前置失败，断言工具零副作用并尝试同 Session 续聊。
6. 增加 PoC-only blob store 注入与 S3 adapter，使用临时 MinIO 容器执行 Worker/Workspace/backend restart E2E。
7. 更新 PoC README、兼容矩阵、`docs/drafts/README.md` 和进度；运行受影响的构建、单测、Chrome E2E 与文档门禁。
8. 检查完整 diff，提交到 `research` 并 push；确认远端与本地一致且工作区干净。

## 退出条件

- OPFS 单 blob 丢失和 IndexedDB 单记录丢失均有真实 Chrome 的状态与远端对照记录；结果明确区分可恢复、可导出、不可恢复和未知。
- Chrome 强杀测试只触及唯一临时 profile，确认进程实际被强制结束，并分别报告身份 cookie、OPFS/IndexedDB retry 的自动恢复结果；若需测试桩重新注入 cookie 才能提交，必须将结果标为有限恢复而非端到端自动恢复。
- 双 backend 实验确实使用独立 Node 进程，并从第三个冷启动实例检查落盘结果；结论不与多实例 HA 混淆。
- 超限参数不产生工具副作用，768 KiB 样本覆盖完整 Session/tool/Workspace 闭环，且同一 Session 后续消息行为有明确结果；adapter 的 1 MiB 累计参数上限与 Session 8 MiB body 上限分别说明。
- MinIO 测试只把已接入的 S3-compatible blob 操作标为通过；manifest JSON、租约和 CAS 的本地单实例限制继续显式保留。
- 文档标明本批所有 scripted、故障注入、本地服务证据；自然 eviction、OS/磁盘 crash、真实 LLM 大参数生成和生产云存储仍保留为未验证项。
- 所有测试资源在退出时关闭；只移除本轮独占创建的临时 Chrome profile、Docker 容器和数据目录。

## 证据边界

当前 PoC Session backend 的 JSON 请求上限为 8 MiB，Workspace 分块 API 的上限和 Session `tool/call` JSON 体积不是同一个限制。Chrome 强杀高于普通页面 reload/Worker terminate 的进程级证据，但不覆盖操作系统缓存刷新、文件系统一致性或断电语义。MinIO 是 S3-compatible 本地服务；这项接入原型不构成生产对象存储、多 backend 一致性或云安全验证。
