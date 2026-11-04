---
description: "汇总 Browser-Native DSH PoC 已落档的验证结论、环境限制与必须的服务端依赖，给出面向正式立项的一页 go/no-go 判断。"
---

# Browser-Native DSH 产品就绪度：go/no-go

## 结论

**有条件 GO（PoC 立项为“浏览器 Worker 执行面 + 同源服务端权威”的试点形态），不建议 GO 纯浏览器、零服务端依赖的产品。**

- 已验证的核心闭环可以跑通：现有 DSH Web UI 与真实 `ctx.agentLoop` 在 Dedicated Worker 中运行，同源 backend 提供 Session 持久化与 LLM proxy，真实模型完成提问→只读拒绝→审批→写入→刷新→导出（[黄金路径](golden-path-e2e.md)，真实 turn 70,144 ms、刷新 5,006 ms）。
- 安全、恢复、审批、预算、检索与 16 Session UI 都有可判定证据（见下表），不是纸面设计。
- 但若干能力在浏览器内不可实现或本轮不可测：全文检索排名、租户级预算阻断、关页后的后台执行、跨主机 HA。这些必须由服务端承担，或缺省降级。

## 能力判定

| 能力 | 判定 | 证据与关键数字 |
| --- | --- | --- |
| 真实 Host/Agent Loop 在 Worker 运行 | GO | 现有 UI + Cordis 插件 + 真实 loop；真实 provider 双协议（LongCat/MiniMax）文本、工具、usage、取消均通过 |
| Session 持久化与恢复 | GO（依赖服务端） | create/append/close/list 分页、owner token/epoch、格式升级拒绝；重启恢复不重放模型或工具 |
| Durable Workspace（OPFS） | GO（有边界） | 配额失败无半份数据、未确认保存撤下工具、刷新 hydrate 后可重试；无三方合并、无块级 delta |
| 文件工具 | GO（受限 roster） | `read`/`write`/`edit`/`glob`/`grep`/`todo_write`/`working_directory` 已跑通；无 `bash`/`pwsh`/`web_*`/`browser_*` |
| 审批与策略 | GO（仅验证 roster） | deny 经 `ctx.tools.guard` 不可绕过、prepended allow 无效、真实模型被拒后继续；策略仅按工具名、无正式 profile 与 UI |
| Token 计量与预算 | GO（Session 级） | 真实用量 2,346 输入 / 16 输出与 backend 解析逐值相等；超限在 fetch 前拒绝并渲染 `TOKEN_BUDGET_EXCEEDED` |
| 多 Session 与准入 | GO（有上限） | 8 turn / 16 mount；16 路 turn 中位数 875–1,272 ms、p95 906–1,278 ms；第 17 个挂载 429 |
| 并发与性能 | 有条件 GO | 4 Session 冷启动 3.08 s、每页堆约 80 MB 稳定；300 turns hydrate 2.57 s；16 路冷启动 13.8 s、CPU 5.3–5.8 核 |
| 长转录 | GO（已修） | 300 turns 窗口化后 DOM 15,830 → 8,182、滚动 146.2 ms、追加 332.1 ms、0 长任务 |
| 会话检索 | 浏览器内部分 GO | 121 Session：列表 3.2 ms、cwd 过滤 2.6 ms、60/60 命中；全文检索仅线性回退 255.8 ms，SQLite 索引在 Worker 不可用 |
| 16 Session 仪表盘 | GO | reload 4,971 ms（Worker 启动主导）、展开 96 ms、打开 70 ms、切换 74 ms、失败后 38 ms、0 page error |
| 无头/后台执行 | NO（浏览器内） | 关页即回收 Worker；Service Worker 无法实例化 Host；后台续跑必须服务端 durable host |
| 跨主机 HA / 分布式租约 | 未验证 | 仅单进程 `dataDir` 锁 + owner token；`SIGKILL` 恢复通过，但无共享数据库、无跨实例 handoff |
| Safari / iOS 真机 | 未验证 | 移动仿真中 iOS `getDirectory()` 失败报 `OPFS_SYNC_ACCESS_UNAVAILABLE`；Android 仿真通过；无真机 WebDriver |
| 费用/账单 | 未实现 | 只有 token 计数与预算阻断；费用换算、跨 Session 租户聚合、账单对账未覆盖 |

## 必须的服务端依赖

1. **同源 Session backend**：`create`/`append`/`close`/`list` 分页与 owner fencing；浏览器 OPFS 只是本地副本，不是跨设备权威。
2. **LLM proxy**：API key 只存 backend；usage 计量的独立解析已与 provider 对账。
3. **会话检索索引与排名**：`node:sqlite.DatabaseSync` 在 Worker 不可用，部署默认 `openAt: never`；带排名/大语料的全文检索必须放服务端。
4. **egress 代理**：浏览器不是网络或凭据边界；外联需 capability + origin + pathPrefix + 方法授权，否则 CSP/凭据隔离不成立。
5. **durable turn host**：关页后的后台执行、审批与取消结算；当前只执行文本 turn，运行记录在内存，工具/审批/取消/重启恢复未全部闭环。
6. **租户预算聚合与费用换算**：当前预算插件仅在验证 roster，租户限额路径只在单 Session 内阻断。
7. **大附件/Workspace blob 服务**（可选）：16 MiB 分片上传已验证；S3/MinIO 仅 PoC 验证，无生产配额与多实例锁。

## 环境限制与不可测项

- 自动化浏览器只覆盖 Chrome 156 桌面（headless / 双标签同源页面）；Chrome 的 `Page.setWebLifecycleState('frozen')` 是 no-op，**自然后台节流/eviction 无法制造**。
- 真实 provider 仅 LongCat-2.5、MiniMax 与少量 gpt-5.6-sol smoke；配额耗尽、长时间限流、多区域端点未覆盖。
- OS 崩溃/断电、浏览器进程崩溃、跨主机 backend 重启与分布式锁未验证；`SIGKILL` 只覆盖单机 fork 子进程。
- 未覆盖 Safari/WebKit 真机、iOS 真机、IME/输入法、移动窄视口与软键盘；Safari 与移动浏览器由[支持矩阵](browser-support-matrix.md)排除，门禁在启动前拒绝。
- 内容检索的超时是“每批 1 秒、整次 30 秒”的 PoC CPU 预算，不构成完整 ReDoS 或通用 CPU quota；正则语义不等于 ripgrep。
- 未覆盖真实模型自主并发多 Agent、任意工具可抢占、600+ turns、单个超大 turn、页内查找与逐行虚拟列表。
- 指标计数在进程内存，重启归零；拒绝访问审计、provider usage 与最后一次 metrics 快照跨重启恢复，但拒绝审计仍限最近 200 条且不含原始凭据。

## 立项前的必做项

1. 把 Session 权威、检索索引、租户预算与费用结算、egress 代理、durable host 定为服务端交付物，并给出单实例/多实例边界。已完成：见[服务端交付物与单实例/多实例边界](server-delivery-boundaries.md)。
2. 为审批策略、排队位置、Session 冲突恢复、导出入口补齐正式 UI；审批卡现在对无 `command` 的工具展示完整参数，`session-conflict` 状态条提供重载恢复按钮，持有写租约后页面提供本地化导出下载（见[产品可见性](product-visibility.md)）；排队已在 `output[data-browser-native-queue-status]` 上显示实时位次并验证 2→1 变化（见[16 Session 仪表盘](session-dashboard-16.md)），但仍需并入正式 composer/会话状态区。
3. 明确浏览器支持矩阵：Worker + OPFS 路径限定 Chromium 桌面；iOS/Safari 若必须支持，只能走服务端 Host 执行 + UI-only。已完成：Worker 门禁仍拒绝 Safari/Firefox/移动浏览器；`/mobile` 的 UI-only 路径在 WebKit iPhone 13 描述符上移除 `navigator.storage` 后完成服务端 turn，`Worker` 构造 0 次，见[浏览器支持矩阵](browser-support-matrix.md)与[移动端 UI-only 策略](mobile-ui-only.md)。
4. 把 observability、审计与预算记录迁到持久存储，并定义重启后的对账口径。已完成：拒绝访问、provider usage 与最后一次 metrics 快照写入 `<dataDir>/observability`，`GET /api/browser-native/observability/reconciliation` 报告恢复条数、轮转/坏行、journal 健康与上进程快照（见[可观测性](observability.md#持久记录与重启对账)）。
5. 以“客户端执行、服务端权威”的安全模型做一次威胁建模；浏览器内 XSS、同机进程互认证与 preview origin 仍是已知未闭环项。已完成：14 项威胁逐项给出控制、证据与残余风险，并列出五项未闭环风险的关闭条件（见[威胁模型](threat-model.md)）；新增 `threat-model-invariants` 2/2 证明 provider key 不经 health/config/上游失败回显、审计只存 principal digest 且 API 无 CORS。

## 证据索引

- 运行时与恢复：[运行时验证报告](runtime-validation-report.md)、[durable host](durable-host-progress.md)、[重启恢复](durable-host-restart.md)
- 安全：[威胁模型](threat-model.md)、[egress 与凭据隔离](credential-isolation-proxy.md)、[principal 隔离](principal-scoped-session-isolation-progress.md)、[提示注入边界](prompt-injection-boundaries.md)、[本地后端加固](local-backend-hardening.md)、[Worker 隔离](worker-isolation-and-security.md)
- 性能：[性能基线](performance-baseline.md)、[会话规模曲线](session-scale-curve.md)、[多 Session 争用](multi-session-contention.md)、[长转录](long-transcript-rendering.md)
- 本批结论：[审批策略](approval-policy-configuration.md)、[token 预算](token-budget-metering.md)、[会话检索](session-query-browser-scale.md)、[16 Session 仪表盘](session-dashboard-16.md)
