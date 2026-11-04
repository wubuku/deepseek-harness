---
description: "把 Browser-Native DSH 的 Session 权威、检索索引、租户预算与费用、egress 代理和 durable host 定为服务端交付物，并逐项给出单实例边界与多实例前置条件。"
---

# 服务端交付物与单实例/多实例边界

本页是[产品就绪度 go/no-go](product-readiness-go-no-go.md) 立项前第 1 项的决策记录：哪些能力必须由服务端承担、每一项在试点期交付什么、单实例下已证明什么、哪些条件满足后才允许声称多实例可用。

## 结论

- **试点期只支持单实例同源服务**：一个 backend 进程持有一个 `dataDir`，同时服务多个浏览器标签页。这是当前所有证据成立的前提。
- **多实例不在交付范围**：共享 `dataDir`、多进程写同一 Session、跨主机接管、跨实例 handoff 都未实现也未验证；不得以“部署两个进程”冒充 HA。
- **浏览器侧只保留执行面与本地副本**：Workspace/OPFS 是本地缓存与工具执行目录，不是 Session、检索、预算或凭据的权威；关页即回收 Worker。
- **服务端交付物由五部分组成**：Session 权威、检索索引、租户预算与费用、egress 代理、durable turn host。它们共享同一套 owner fencing 与审计口径。

## 交付物与边界

| 服务端交付物 | 权威内容 | 试点期交付物 | 单实例已验证边界 | 多实例前置条件 | 证据/缺口 |
| --- | --- | --- | --- | --- | --- |
| Session 权威 | Session 头、事件序列、`durableThroughSeq`、owner token/epoch、附件元数据 | 同源 `session/create`、`append`、`close`、`read`、`list`、`handoff`；进程内单写者锁与 owner epoch 拒绝旧写者 | 单进程独占 `dataDir`；多标签页并发经 owner lease 串行化；同一 Session 第二标签页得到 `session-conflict`；`SIGKILL` 后重启从已 flush 事件恢复，不重放模型/工具 | 共享事务数据库（Session 行 + 事件表 + 单调 epoch）、跨实例 owner lease、原子 append 与读游标、跨实例 handoff 的 token 重放防护 | [Session 持久化](session-persistence.md)、[principal 隔离](principal-scoped-session-isolation-progress.md)、[handoff 安全](next-handoff-security-and-recovery-progress.md) |
| 检索索引 | 列表/过滤/全文索引与排名、事件检索游标 | 可选 SQLite 索引；部署默认 `openAt: never`，浏览器内退化为线性扫描 | 121 Session 列表 3.2 ms、cwd 过滤 2.6 ms、全文 255.8 ms 且 60/60 命中；单 Session 内检索 1.9 ms | 服务端 SQLite/OpenSearch 等索引进程、增量写入与重建、租户过滤、跨实例一致的索引版本 | [会话检索规模](session-query-browser-scale.md)；Worker 无 `node:sqlite.DatabaseSync` |
| 租户预算与费用 | Session/租户输入输出 token、限额、超限审计；费用换算与账单对账 | 验证 roster 的 token meter + fetch 前阻断；`budget/exceeded` 事件 | 真实 provider 用量逐值相等（2,346 输入 / 16 输出）；Session 与租户限额都在发出上游请求前拒绝 | 追加式用量账本（按 tenant/session/request 幂等）、跨实例原子扣减、价格表版本化、账单导出与对账 | [token 预算](token-budget-metering.md)；费用换算与跨 Session 生产聚合未实现 |
| egress 代理 | 外部 origin/路径/方法/凭据授权、限流、允许与拒绝审计 | 同源 `POST /egress/fetch` + 静态 capability 白名单；CSP `connect-src 'self'` | Worker 无密钥；白名单外的 host/path/method 被拒；不跟随重定向；响应脱敏；capability 级固定窗口限流 | capability 持久化与动态授权、per-tenant 配额（共享计数器）、集中审计、凭据轮换 | [egress 与凭据隔离](credential-isolation-proxy.md)；审计默认内存 200 条，限流是单进程窗口 |
| durable turn host | 关页后仍在执行的 turn、运行状态、幂等结算 | `POST/GET /session/durable`，`turnId` 幂等，模型经同源 `/llm` | 关页后 turn 完成、重开可读；重复提交不产生第二次模型请求；完成后释放 owner 供重开接管 | 持久运行队列（跨重启）、租约续期与失效、工具/审批/取消结算、跨实例 claim 与幂等键存储 | [durable host 进度](durable-host-progress.md)、[重启恢复](durable-host-restart.md)；工具调用仍以 `DURABLE_TOOL_UNSUPPORTED` 结算 |

## 共同不变量

1. **同源与凭据边界**：API key 只存在于 backend 进程；浏览器 Worker 无密钥，所有上游访问经 egress 代理。页面 CSP 与 backend 回环 Host/Origin 准入共同构成第一层边界。
2. **单写者 + 单调 epoch**：任何 Session 写入都必须持有当前 owner token 且 epoch 不落后；旧 token/epoch 的 append、renew、LLM 请求一律拒绝。进程重启后 epoch 只增不减。
3. **模型可见 ⟺ 可重建**：任何进入模型请求的输入必须先追加为 Session 事件并 flush；durable host 的 `turnId` 幂等键以已持久化的 `turn/start` 为准。
4. **预算先于出网**：超预算在 fetch 之前判定并写 `budget/exceeded`；不允许先请求上游再取消。
5. **审计可追溯**：允许与拒绝记录 capability、request id、principal 与目标；不含原始凭据。试点期审计是进程内存环形缓冲，重启归零（见第 4 项必做）。

## 部署拓扑（试点）

```text
浏览器页面 ── Dedicated Worker（Host/Agent Loop、工具、OPFS 副本）
      │ 同源 HTTP（Session / LLM / egress / durable）
      ▼
单实例 backend 进程 ── 单写者 Session 存储（dataDir）
      │                  ├─ token meter 与限额
      │                  ├─ egress capability 白名单 + 内存审计
      │                  └─ durable turn host 运行表（内存）
      ▼
上游模型 / 外部服务（仅经 egress 或 LLM proxy）
```

## 多实例放行条件

在以下条件全部满足并逐项有可判定证据之前，产品与部署文档都不得声称支持多实例：

- Session 事件追加、owner claim/handoff 与读游标在共享存储上原子完成；跨实例 handoff 的旧 token 重放被拒绝。
- 检索索引有明确的写入顺序、版本与重建路径，跨实例查询结果一致。
- 租户用量账本按 `(tenant, session, requestId)` 幂等扣减，费用换算使用版本化价格表，账单可对账。
- egress 授权与限流进入持久/共享存储，审计集中且可追溯；凭据轮换不要求重启所有实例。
- durable turn 的运行队列与幂等键持久化，实例崩溃后由其他实例接管且不重复请求模型。
- 明确跨主机时钟、租约与故障检测语义；`SIGKILL` 之外的断电、网络分区与存储损坏有恢复口径。

## 非目标

- 本页不实现上述多实例设施，也不改变当前 PoC 的单进程结论。
- 纯浏览器、零服务端依赖的产品形态保持 **NO**：关页回收 Worker、检索索引不可用、租户预算无法聚合、凭据不能进入浏览器。
- 费用换算、账单、集中审计属于后续立项范围，不因本页存在而被视为已交付。

## 证据边界

本页结论来自单机 Chrome 156、单 backend 进程、本地 `dataDir` 与既定 roster；未覆盖 Safari/iOS 真机、生产对象存储、多实例数据库、跨主机网络与真实计费系统。多实例数值（吞吐、接管时延、故障窗口）一律未测，不得引用。