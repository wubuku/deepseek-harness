---
description: "规划 Browser-Native Worker 启动前的 IndexedDB、同源 backend readiness 与可选持久 Workspace 能力探测和 fail-closed 验证。"
---

# Browser-Native 运行期能力探测验证计划

## 目标

验证 Browser-Native Worker 能否在创建 DSH Host 前，实际检查 Session outbox、同源 backend readiness 和用户选择的 durable Workspace 前置条件；缺少必要能力时停止启动，不创建可见的可运行 Agent Loop，也不向模型发送请求或工具 schema。

本批只探测 PoC 启动必需的存储和 backend 接线。v2 backend 只在 SessionStore、WorkspaceStore 和 LLM 配置完成初始化后才开始监听；现有 `/health` 与 `/config` 不提供独立的存储健康字段，因此 Worker 校验 HTTP、协议版本和非敏感 LLM 配置字段，不把它们描述为后续写入保证。健康响应不代表真实模型上游可用；IndexedDB 事务完成不代表抵御 OS 崩溃或浏览器 eviction；当前静态 capability manifest 仍不是任意 Cordis profile 的动态扫描结果。

## 候选范围与取舍

| 候选验证点 | 价值 | 本批决定 | 原因 |
|---|---:|---|---|
| Worker 启动时真实验证 Session outbox 的 IndexedDB readwrite transaction | P0 | 纳入 | 当前 outbox 是每个 Session checkpoint 的必要依赖；仅构造 Worker Host 不能证明浏览器 profile 允许写入。 |
| 同源 backend 初始化完成与 LLM proxy 配置响应 | P0 | 纳入 | v2 backend 在 SessionStore、WorkspaceStore 和 LLM config 加载完成后才开始监听；探测验证当前 preview 连到兼容 backend，不读取 Session 或凭据。 |
| durable Workspace 模式下验证 OPFS SyncAccessHandle 可用 | P0 | 纳入 | 用户选择 durable 模式时，缺少 OPFS 不能延迟到第一次文件 mutation 才暴露。普通内存 Workspace 不依赖 OPFS。 |
| Probe 结果驱动 profile preflight，必要能力失败时 Host boot fail closed | P0 | 纳入 | 防止 Worker 出错后仍显示“已启动”或继续发送模型请求。 |
| 每个工具和插件都进行独立动态 service/method probe | P1 | 延后 | 需要 Cordis runtime service inventory、插件级 probe API 和对应产品配置；本批不伪造通用插件扫描能力。 |
| Worker/page Session history-before-live 的真实 UI 投影竞态 | P0 | 延后 | 已有纯状态 helper，但完整接线需要单独定义现有 Web UI 消费者与 Worker event source；不与启动能力探测混在一批。 |
| cancel/dispose outcome 接入真实 LLM、工具和 HITL 控制器 | P0 | 延后 | 现有 helper 尚未被调用；需要针对执行副作用与 DSH cancel receipt 单独设计，不将启动探测范围扩大。 |
| Session catalog stale/incomplete、bridge version continuity、跨 Worker observer/write 冲突 | P1 | 延后 | 已有分页、owner fencing 和 observer 的局部验证；缺少统一产品 UI 语义，本批不重复做 API-only 测试。 |
| Browser→Cloud Durable Worker handoff | P0（Cloud） | 延后 | 当前没有可运行的 Cloud Worker；模拟协议结果不能代替真实执行者接管证据。 |
| outbox 敏感数据加密、用户清除、自然 quota/eviction | P0 | 延后 | 需要 retention、密钥生命周期与用户身份决策；本批只验证启动时可写，不宣称掉电或 eviction 持久性。 |

## 实施范围

### M0：对齐现状与 readiness 语义

- 核对 Worker init、Session outbox 的数据库打开路径、backend `/health` 与 `/config`、durable Workspace OPFS 初始化顺序。
- 复用现有同源响应：`/health` 返回 `ok`、协议版本、LLM mode/model；`/config` 返回协议版本、LLM mode/provider/model。后端只在 SessionStore、WorkspaceStore 和 LLM 配置加载完成后开始监听；不新增伪装成独立存储检查的字段。
- 记录 readiness 的准确含义和不能代表的状态；不得把 model/provider 名称、协议可读或 route 可访问说成供应商可用或后续写入成功。

### M1：真实浏览器能力探针

- 为 Session outbox 增加可等待的 IndexedDB readwrite canary transaction；用随机 probe key 写入并在同一个事务中删除，只有 transaction complete 才报告可用。
- 由 preview 在 `connectWorkerHost()` 前向 Worker 发送专用 probe 请求；校验同源 backend `/health` 与 `/config` 的 HTTP 状态、协议版本和非敏感字段，不读取 Session 或凭据。
- durable Workspace 被显式选择时，验证 Worker 可打开 OPFS root 并创建、写入、读回、截断和删除临时 SyncAccessHandle 文件；不启用 durable Workspace 时不要求 OPFS。
- probe 错误只输出稳定错误类别，不输出响应正文、Session 内容或凭据。

### M2：Worker Host boot gate

- preview 等待 Worker probe 成功后才调用 `connectWorkerHost()`；Worker 收到 Host init 时再次要求此前请求的 probe 已通过，再运行现有 profile preflight 并调用 `createWorkerHost()`。
- 将实际 probe evidence 与静态声明区分；任何必要项失败时不构造 Host、不启动 Agent Loop，也不处理排队的 Host 消息。
- durable Workspace 的可选能力只在该模式选中时成为启动要求。
- 保持当前模型 tool roster 与 profile 配置一致；不宣称已对任意插件执行动态探测。

### M3：Chrome 故障矩阵

- 真实 Chrome Worker 中注入 IndexedDB transaction abort 和同源 readiness 503/错误版本，确认 Host 不启动、LLM 请求数为零且错误诊断不包含 secret。
- 在 durable Workspace 模式注入 OPFS probe 故障，确认 Host 不启动；普通内存模式不受这项可选能力影响。
- 依赖恢复后重新导航，验证 Host 正常启动、Session durable checkpoint、Workspace 文件操作及已有 outbox recovery 回归。
- 记录页面错误、Worker 错误、模型请求、Session/Workspace 状态与外部网络请求。

### M4：真实 LLM 冒烟与交付

- 使用同源 backend 从 `docs/drafts/.env` 读取真实模型凭据，运行 durable Workspace 模式的 `read → write → read`、刷新恢复和短续聊。
- 确认 backend route 源码与 contract tests 返回的 health/config 字段不含模型 secret；真实浏览器测试确认模型凭据不出现在浏览器请求中，模型请求只到同源 backend。
- 更新 README、兼容矩阵、change ledger、PoC 索引与本计划/进度，明确未验证边界。

## 验收矩阵

| 输入条件 | 预期行为 | 证据 | 不代表 |
|---|---|---|---|
| IndexedDB outbox readwrite transaction 可提交 | Worker 可继续 profile preflight 和 Host boot | Chrome Worker 初始化与 Session checkpoint | IndexedDB 可抵御 eviction、OS crash 或用户清除 |
| IndexedDB transaction abort | Worker fail closed，模型请求和业务工具副作用为零 | transaction abort 故障 E2E | 浏览器所有 quota 错误都以同一种异常返回 |
| backend health/config 不可用、响应无效或版本不兼容 | 页面不发送 Host init，Worker 不创建 Host、不发送 LLM 请求 | 同源 route 注入 E2E | Session backend 的每次后续 write 一定成功 |
| durable Workspace 模式且 OPFS probe 成功 | Worker 可继续启动并执行 durable 文件路径 | Chrome OPFS temporary-file probe 与真实 DSH 文件工具 | Workspace/backend 构成原子事务 |
| durable Workspace 模式且 OPFS probe 失败 | Worker fail closed | Chrome Worker E2E 在 probe seam 注入失败；成功路径另由真实 OPFS API probe 验证 | 失败注入不代表自然浏览器 API 故障或所有 OPFS 错误种类 |
| 普通内存 Workspace 且 OPFS 不可用 | 不因未选择的可选能力拒绝启动 | Chrome 对照场景 | 普通 VFS 文件可刷新持久化 |
| readiness 成功但真实上游模型不可用 | Host 可启动；首个真实模型请求按既有错误路径失败 | fake upstream/真实 LLM smoke 分别记录 | readiness 是供应商可用性或模型请求成功保证 |

## 安全与限制

- 本批复用现有 health/config 路由，不返回新字段；E2E 检查其响应不包含模型密钥。不得返回 Session 列表、租户信息或 backend 文件路径。
- Probe 事务只证明当前浏览器 Worker 能完成一次 IndexedDB transaction，不等价于 `navigator.storage.persist()` 获准或持久化承诺。
- Worker 启动后能力仍可能失效；每次 Session checkpoint、Workspace commit 和真实 LLM request 继续使用原有错误处理，不把启动快照当作永久保证。
- Chrome fault injection 不代表自然 eviction、操作系统断电、Safari/WebKit、多实例 backend 或生产云存储。
- Dedicated Worker 仍受页面生命周期约束，不是后台 Agent。
