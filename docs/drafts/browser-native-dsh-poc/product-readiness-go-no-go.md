---
description: "汇总 Browser-Native DSH PoC 已落档的验证结论、环境限制与必须的服务端依赖，给出 durable-first 生产路径建议与可直接用于立项判断的 go/no-go 条件清单，并标注被新证据替代的旧结论。"
---

# Browser-Native DSH 产品就绪度：go/no-go

## 结论（2026-11-05 durable-first 更新，替代同日的 Worker-first 版）

**有条件 GO：可立项为“durable 服务端 host 主执行 + 浏览器 Worker 纯浏览器降级/离线”的单节点试点；不 GO 纯浏览器、零服务端依赖的产品，也不 GO 把多实例 HA、Safari/iOS 执行面、计费或跨节点关页接管列入首期目标。**

- 生产路径证据来自同一 10 任务真实模型基准（LongCat-2.5，两侧均 10/10）：durable 29 次请求、23,318 tokens、平均 12.8 秒；Worker 39 次请求、91,734 tokens、平均 22.4 秒。durable 输入约为 Worker 的 24.4%，时长约为 57%，工具面（`read`/`write`/`edit`/`grep`/`glob`/`subagent`）与审批已对齐。
- Worker 因此不再是主执行面：它保留同一 6 工具 roster，承担断网、离线与纯浏览器降级，以及本地 OPFS Workspace 的体验；关页后继续执行由 durable host 承担，而不是 Worker。
- 数据可信度已从“设计 + 局部验证”升级为强证据：AES-256-GCM 落盘加密、密钥在线轮换、60 次跨阶段 SIGKILL、ENOSPC/EROFS/IO 超时故障注入、Session 归档与按需加载、1,000 Session 启动测量全部有可复跑套件。
- 产品可见性已补齐：预算限额单一来源、失败码到可操作建议的映射、预算条/失败建议/归档标记/协作提示/移动端的 axe 复查与 zh/en 文案复查。
- 仍未闭环、且会直接改变结论的项：跨主机 HA、跨节点关页接管、Safari/iOS 真机执行面、费用结算与租户级硬阻断、企业级全文检索排名、KMS/HSM 与多实例密钥轮换、归档自动调度。
- 单节点容量按 50 事件/Session 约 14,000 个 Session；事件数上升后显著下降（200 事件约 4,000、500 事件约 1,400）。这是“现在能立项”的规模前提，不是无界承诺。

## 生产执行路径：durable 主路径与 Worker 降级

产品默认把 turn 交给同源服务端的 durable host 执行，浏览器只负责 UI、上传校验、审批展示，以及在无法连接服务端时降级到 Worker。两条路径共享同一套工具语义与 Session 事件，定位不同：

| 维度 | durable 服务端 host（主路径） | 浏览器 Worker（降级/离线路径） |
| --- | --- | --- |
| 执行位置 | 同源服务端进程；浏览器关闭后 turn 继续 | 页面内 Dedicated Worker；关页即回收 |
| 工具面 | `read`/`write`/`edit`/`grep`/`glob`/`subagent`，写操作需审批 | 同一 6 工具 roster；`todo_write` 与 `working_directory` 已从基准 roster 移除 |
| 真实模型基准 | 10/10；29 请求、23,318 tokens、12.8 秒 | 10/10；39 请求、91,734 tokens、22.4 秒 |
| 输入成本 | 每请求 709.4 tokens；无 system prompt | 每请求 2,163.6 tokens；完整请求带 4,270 字符 system prompt 与 5,249 字符工具 schema |
| Session 权威 | 服务端持久化，浏览器只是视图 | 同源 backend 仍是权威，Worker 持有执行副本 |
| 离线能力 | 不可用（需要网络与服务端） | 离线时保留 UI 与本地 OPFS 副本、重连后续跑；模型 turn 仍需服务端 LLM 代理 |
| 边界 | 单节点、运行记录在内存；跨主机接管未验证 | 无 bash/`web_*`/`browser_*`；Safari/iOS 不启动 |

## 立项判断清单（可直接勾选）

以下 6 项全部为“是”，才可按当前试点形态立项：

- [ ] durable 服务端 host 是主执行路径，Session 权威、LLM proxy、egress、检索索引都在同源服务端；浏览器 Worker 只作纯浏览器降级/离线路径与 UI。
- [ ] 首期只支持 Chromium 桌面；Safari/iOS 若要支持，只走服务端执行 + UI-only，不在浏览器内跑 Worker。
- [ ] 单节点容量不超过约 14,000 Session（50 事件）；若平均事件数更高，按 200 事件约 4,000、500 事件约 1,400 重新定容。
- [ ] 密钥来自部署密钥文件或环境变量并收紧权限；不要求 KMS/HSM、多实例同时轮换或跨地域密钥托管。
- [ ] 首期不承诺按 token 计费、租户级硬配额、企业语料全文检索排名、跨节点关页接管；单节点关页续跑已由 durable host 承担。
- [ ] 归档由运维显式触发即可，不要求自动保留期调度；归档索引条目数受控。

以下范围项给出当前判定；任何标 **NO** 的项若进入首期范围，结论立即变为 **NO**，直到该项关闭。单节点关页续跑已纳入基础范围（见上表），不属于 NO 项。

| 首期若包含 | 当前状态 | 关闭条件 |
| --- | --- | --- |
| 多实例/跨主机 HA | NO：只有单进程 `dataDir` 锁与 owner token，无共享数据库、无跨实例 handoff | 共享权威存储、跨实例租约与交接验证 |
| Safari/iOS 真机执行面 | 未验证：移动仿真仅 UI-only，iOS `getDirectory()` 失败 | 真机 WebDriver 或明确的 UI-only 产品决策 |
| 按 token 计费/对账 | 未实现：只有 usage 计数与 Session 级阻断 | 价格表、租户聚合、账单对账与退款口径 |
| 租户级硬配额 | 部分：预算读取租户汇总，执行阻断仍是 Session 级 | 服务端租户配额拦截与跨 Session 一致性 |
| 关页后后台执行（同一节点） | GO 边界：durable host 已在服务端持有 turn，关页后继续、重开接管，文本 turn 续跑已验证；本轮基准补齐服务端文件工具、审批与子代理 | 关页中途正在执行的工具 turn 未专门重跑；跨节点接管见下一行 |
| 关页后跨节点接管 | NO：单进程内存运行记录，无跨实例 handoff | 共享权威存储、跨实例租约与交接验证 |
| 企业语料全文检索排名 | 部分：仅线性回退，SQLite 索引在 Worker 不可用 | 服务端索引、排名、超时与配额 |
| 超过单节点容量上限 | 未验证：启动随 Session 线性增长 | 分片、归档自动调度或服务端存储拆分 |
| 集中式密钥管理/KMS | 未实现：仅密钥文件热更新 | KMS/HSM 集成、多实例轮换与审计 |

## 能力判定

| 能力 | 判定 | 证据与关键数字 |
| --- | --- | --- |
| 真实 Host/Agent Loop 在 Worker 运行 | GO（降级路径） | 现有 UI + Cordis 插件 + 真实 loop；真实 provider 双协议文本、工具、usage、取消均通过；同一 10 任务基准 10/10 |
| durable 服务端 host 作主执行路径 | GO（单节点） | 同一 10 任务基准 10/10；29 请求、23,318 tokens、12.8 秒；`read`/`write`/`edit`/`grep`/`glob`/`subagent` 与 10 次审批在服务端完成；文本 turn 关页续跑已验证 |
| Session 持久化与恢复 | GO（强证据，依赖服务端） | AES-256-GCM 信封加密；缺钥/损坏密文显式拒绝；在线轮换期间读操作可用、写操作排队；60 次随机 SIGKILL 后日志可读、seq 单调无重复、结算一次、无孤儿临时文件、审计链可验证；ENOSPC/EROFS/IO 超时按面归一为 `STORAGE_*` 并保留可重试状态 |
| Durable Workspace（OPFS） | GO（有边界） | 配额失败无半份数据、未确认保存撤下工具、刷新 hydrate 后可重试；无三方合并、无块级 delta |
| 文件工具 | GO（同一 6 工具 roster） | 两侧均跑通 `read`/`write`/`edit`/`glob`/`grep`/`subagent`；基准 roster 已移除 `todo_write`、禁用 `working_directory`；无 `bash`/`pwsh`/`web_*`/`browser_*` |
| 审批与策略 | GO（仅验证 roster） | deny 经 `ctx.tools.guard` 不可绕过、prepended allow 无效、真实模型被拒后继续；策略仅按工具名、无正式 profile 与 UI |
| Token 计量与预算 | GO（单一来源，Session 执行） | 限额只由部署配置一处注入，`/config` 与 Worker `budget-state` 同步为 12,000/24,000，改一处两侧同变为 15,000/30,000；未传限额在 probe 阶段拒绝启动。租户汇总只读，硬阻断仍限 Session |
| 错误码与可操作建议 | GO | 失败码映射到 `retry`/`reload`/`request-access`/`contact-admin`/`diagnostics` 五类动作；预算超限不提供盲重试；未知码保留一次重试并附诊断包；`browser-native-failure-guidance.spec.ts` 7/7 |
| 多 Session 与准入 | GO（有上限） | 8 turn / 16 mount；16 路 turn 中位数 875–1,272 ms、p95 906–1,278 ms；第 17 个挂载 429 |
| 启动与单节点容量 | GO（单节点） | 1,000 Session（每个 50 事件、4 Workspace、12 附件、1,000 审计）：`store.load()` 133.8 ms / 17.9 MiB、冷启动 231.4 ms、首个 turn 35.4 ms；250→1,000 增长 3.97 倍（线性）；堆约 18.3 KiB/Session；上限约 14,000（50 事件）、4,000（200）、1,400（500） |
| Session 归档与按需加载 | GO（手动触发） | 300 Session 中归档 250 个后 `load()` 41–65 ms → 8–11 ms、堆 5.5 → 1.0 MiB；列表/搜索仍可发现，打开/导出按需解压，附件恢复，审计与 usage 字节不变，误删可从归档恢复 |
| 长转录 | GO（已修） | 300 turns 窗口化后 DOM 15,830 → 8,182、滚动 148–152 ms、追加 316–359 ms、0 长任务 |
| 会话检索 | 浏览器内部分 GO | 121 Session：列表 3.2 ms、cwd 过滤 2.6 ms、60/60 命中；全文检索仅线性回退 255.8 ms，SQLite 索引在 Worker 不可用 |
| 16 Session 仪表盘 | GO | reload 4,851 ms（Worker 启动主导）、展开 94 ms、打开 65 ms、切换 79 ms、失败后 49 ms、0 pageerror |
| 无障碍与双语 | GO（覆盖新增状态） | axe 12 个状态 0 `serious`/`critical`，无 pageerror；键盘覆盖 Tab 顺序、可见焦点环、Esc 关闭菜单、Enter 打开/触发；zh/en 在 320px 伪本地化与 390px 真实视口下无溢出或截断，`verify-client-ui-i18n` 通过 |
| 无头/后台执行 | GO（单节点，服务端） | 浏览器内关页即回收 Worker；durable host 在服务端持有 turn，关页后继续、重开接管；跨节点接管未验证 |
| 主路径成本 | durable 约为 Worker 的 1/4 | 同一基准：23,318 vs 91,734 tokens；输入/请求 709.4 vs 2,163.6；Worker 每次完整请求额外携带 4,270 字符 system prompt 与 5,249 字符工具 schema |
| 跨主机 HA / 分布式租约 | 未验证 | 仅单进程 `dataDir` 锁 + owner token；SIGKILL 恢复与故障注入都限单机 |
| Safari / iOS 真机 | 未验证 | 移动仿真中 iOS `getDirectory()` 失败报 `OPFS_SYNC_ACCESS_UNAVAILABLE`；Android 仿真通过；无真机 WebDriver |
| 费用/账单 | 未实现 | 预算条可读 provider usage 与配置价格，但无计费、账单、租户对账与退款口径 |

## 被新证据替代的旧结论

| 旧结论 | 新状态 | 替代依据 |
| --- | --- | --- |
| “Session 持久化与恢复：GO（依赖服务端）”，只覆盖 create/append/close/list 与格式拒绝 | 升级为 **GO（强证据）** | 加密、轮换、磁盘故障、崩溃模糊测试与归档纳入判定；旧结论的验证面已被覆盖并扩大 |
| “SIGKILL 恢复通过，但只覆盖单机” | 仍限单机，但证据升级为 **60 次跨 turn/附件/审计/轮换强杀** | 旧单次重启结论不再作为恢复证据；跨主机仍未验证 |
| “启动恢复是否线性、单节点上限未知” | 由**实测线性 + 明确容量上限**替代 | 1,000 Session 数据替代旧 4/16 Session 的启动数字作为容量判据；旧数字仍只说明浏览器启动开销 |
| “Token 计量与预算：GO（Session 级）”，未提限额来源 | 升级为 **GO（限额单一来源）**，租户硬阻断仍未闭环 | `/config` 与 Worker 同步变化的双启动测试替代“两处配置可能漂移”的旧假设 |
| 旧版没有无障碍与 i18n 判定 | 新增 **GO** | axe 12 状态 0 serious/critical、键盘检查、zh/en 文案与溢出复查 |
| “浏览器 Worker 作执行面，服务端只承担权威与代理” | **被 durable-first 替代**：durable 服务端 host 主执行，Worker 作纯浏览器降级/离线路径 | 同一 10 任务基准两侧均 10/10；durable 23,318 tokens vs Worker 91,734，平均 12.8 vs 22.4 秒；durable 工具面已与 Worker 对齐 |
| “关页后后台执行 NO：关页即回收 Worker” | 单节点升级为 **GO 边界**；跨节点仍 NO | durable host 在服务端持有 turn，关页后继续、重开接管；文本 turn 续跑已验证，本轮补齐服务端文件工具、审批与子代理 |
| “Worker 106,879 tokens / durable 22,965”“Worker 广告 8 工具” | 由削减后运行替代：**91,734 / 23,318**，双方 6 工具 | 移除未使用的 `todo_write` 与 `working_directory`、压缩 per-roster 提示后重跑同一基准；每完整请求静态字符 10,985 → 9,519 |
| “会话检索：浏览器内部分 GO（121 Session）” | **未被替代** | 1,000 Session 只证明启动与容量，不外推到全文检索规模或排名质量 |
| “跨主机未验证”“Safari/iOS 未验证”“费用/账单未实现” | **未被替代** | 新证据不覆盖跨主机、真机与计费 |

## 必须的服务端依赖

1. **同源 Session backend**：create/append/close/list 分页与 owner fencing；浏览器 OPFS 只是本地副本，不是跨设备权威。
2. **LLM proxy**：API key 只存 backend；usage 计量已与 provider 对账，并作为预算唯一来源。
3. **会话检索索引与排名**：`node:sqlite.DatabaseSync` 在 Worker 不可用，带排名/大语料的全文检索必须放服务端。
4. **egress 代理**：浏览器不是网络或凭据边界；外联需 capability + origin + pathPrefix + 方法授权。
5. **durable turn host（主执行路径）**：默认 turn 在服务端执行，浏览器只作视图与降级；单节点已验证文本 turn、`read`/`write`/`edit`/`grep`/`glob`/`subagent`、审批、幂等重放与关页续跑；运行记录在内存，跨节点接管未实现。
6. **租户预算执行与费用结算**：预算读取已聚合租户，但硬阻断与账单仍需服务端。
7. **归档调度与冷存储治理**：当前只有管理员显式归档接口，无保留期自动调度、无分片索引。
8. **密钥管理**：单实例可用密钥文件轮换；多实例/KMS/HSM 与跨地域托管仍需服务端交付。
9. **大附件/Workspace blob 服务**（可选）：16 MiB 分片上传已验证；S3/MinIO 仅 PoC 验证。

## 环境限制与不可测项

- 自动化浏览器只覆盖 Chrome 156 桌面；Chrome 的 `Page.setWebLifecycleState('frozen')` 是 no-op，自然后台节流/eviction 无法制造。
- 真实 provider 仅 LongCat-2.5、MiniMax 与少量 gpt-5.6-sol smoke；配额耗尽、长时间限流、多区域端点未覆盖。
- 崩溃套件用真实 fork + SIGKILL，覆盖进程被杀，不等于掉电、OS 崩溃、浏览器进程崩溃或跨主机重启；磁盘故障用注入的 ENOSPC/EROFS/IO 超时，不是物理坏盘。
- 归档无自动保留期调度，索引读取随归档条目线性增长；归档包与活跃文件会短时并存，附件按引用重复占用。
- 静态加密不覆盖 Workspace 上传暂存、manifest/identity 元数据与备份包本身；密钥文件热更新之外无 KMS/HSM。
- 未覆盖 Safari/WebKit 真机、iOS 真机、IME/输入法；移动窄视口已用 320px 伪本地化与 390px 中文视口验证渲染，但不是真机。
- 内容检索的超时是“每批 1 秒、整次 30 秒”的 PoC CPU 预算，不构成完整 ReDoS 或通用 CPU quota。
- 未覆盖真实模型自主并发多 Agent、任意工具可抢占、600+ turns、单个超大 turn。
- 指标计数在进程内存，重启归零；拒绝审计限最近 200 条且不含原始凭据。

## 立项前必做项（更新）

1. 把 Session 权威、检索索引、租户预算与费用结算、egress 代理、durable host 定为服务端交付物，并给出单实例/多实例边界。已完成：见[服务端交付物与单实例/多实例边界](server-delivery-boundaries.md)。
2. 为审批策略、排队位置、Session 冲突恢复、导出入口补齐正式 UI。已完成部分：见[产品可见性](product-visibility.md)与[16 Session 仪表盘](session-dashboard-16.md)；仍待并入正式 composer/会话状态区。
3. 明确浏览器支持矩阵。已完成：见[浏览器支持矩阵](browser-support-matrix.md)与[移动端 UI-only 策略](mobile-ui-only.md)。
4. 把 observability、审计与预算记录迁到持久存储并定义重启对账。已完成：见[可观测性](observability.md#持久记录与重启对账)。
5. 完成“客户端执行、服务端权威”的威胁建模。已完成：见[威胁模型](threat-model.md)；新增 `threat-model-invariants` 2/2。
6. 完成数据可信度闭环：落盘加密与在线轮换、磁盘故障处置、崩溃一致性、归档与容量测量。已完成：见[托管部署的加密/轮换/磁盘/崩溃章节](hosted-deployment.md#静态数据加密)、[启动规模](startup-scale.md)、[Session 归档](session-archive.md)。
7. 完成产品可见性闭环：预算单一来源、错误可操作建议、axe 与 zh/en 复查。已完成：见[预算限额单一来源](token-budget-metering.md#预算限额单一来源)、[错误码与可操作建议](failure-guidance.md)、[无障碍审计](accessibility-audit.md)、[伪本地化窄屏](pseudo-localization-narrow.md)。
8. 立项后按目标市场逐项关闭：多实例 HA、跨节点关页接管、Safari/iOS 真机、计费与租户硬配额、企业检索排名、KMS/HSM、归档自动调度；未关闭前不得对外承诺对应能力。单节点关页续跑已由 durable host 承担。

## 证据索引

- 运行时与恢复：[运行时验证报告](runtime-validation-report.md)、[durable host](durable-host-progress.md)、[重启恢复](durable-host-restart.md)
- 执行路径对比：[真实模型任务基准](real-model-task-benchmark.md)（同一 10 任务、两侧 10/10、token 归因与分步削减）、[服务端交付物](server-delivery-boundaries.md)
- 数据可信度：[托管部署](hosted-deployment.md)、`tests/at-rest-encryption.e2e.mjs`、`tests/at-rest-key-rotation.e2e.mjs`、`tests/disk-fault-resilience.e2e.mjs`、`tests/crash-consistency.e2e.mjs`
- 容量与归档：[启动规模](startup-scale.md)、[Session 归档与按需加载](session-archive.md)、[会话规模曲线](session-scale-curve.md)
- 产品可见性：[预算单一来源](token-budget-metering.md#预算限额单一来源)、[错误码与可操作建议](failure-guidance.md)、[无障碍审计](accessibility-audit.md)、[伪本地化窄屏](pseudo-localization-narrow.md)
- 安全：[威胁模型](threat-model.md)、[egress 与凭据隔离](credential-isolation-proxy.md)、[principal 隔离](principal-scoped-session-isolation-progress.md)、[提示注入边界](prompt-injection-boundaries.md)、[本地后端加固](local-backend-hardening.md)、[Worker 隔离](worker-isolation-and-security.md)
- 性能：[性能基线](performance-baseline.md)、[多 Session 争用](multi-session-contention.md)、[长转录](long-transcript-rendering.md)
- 本批结论：[审批策略](approval-policy-configuration.md)、[token 预算](token-budget-metering.md)、[会话检索](session-query-browser-scale.md)、[16 Session 仪表盘](session-dashboard-16.md)
