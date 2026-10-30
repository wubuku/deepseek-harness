---
description: "记录 Browser-Native 单 Worker 多真实 DSH Agent 与 Session 并行验证的执行证据、失败和限制。"
---

# Browser-Native 单 Worker 多 Session 并行验证进度

## 当前状态

状态：本批实现与验证完成。工作位于 `research` 主工作区；没有隔离 worktree。本批只使用 Chrome，Safari/WebKit 暂停。

## 基线

| 项目 | 当前状态 |
| --- | --- |
| 分支 | `research`。 |
| DSH-TUI 参考 | 已阅读当前本机 checkout 的 `AGENTS.md`、Session Mount Runtime、mount ledger 与 heartbeat；TUI 进程的 Agent roster 可同时托管多个活动 Session，进程退出时结束执行。 |
| PoC 基线 | 多 Session coordinator 的 Chrome probe 只覆盖投影/身份状态；真实并发 Loop 已在两个页面/Worker 中验证；Worker placement 容量测试中每 context 一个 Host Worker。 |
| 本批判断 | 单 Worker Host 的 `ctx.agents` 与 DSH Session persistence 是否支持多条并行 Loop，此前缺少真实 Worker E2E。 |

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
| --- | --- | --- | --- |
| M0：候选评估与计划 | `complete` | 已比较单 Worker 多 Loop、单页多 Worker、并发公平性、Session/owner 隔离、Workspace 写权和页面生命周期；本批选择多 Loop、取消隔离与 Session 事实隔离。 | 已完成。 |
| M1：多 Agent probe 与单测 | `complete` | validation-only 插件经正式 `ctx.agents.create()` 建立 DSH Agent；Vitest 3/3 通过，覆盖并行输入、单 Agent 取消、重复身份、重复 owner、部分创建失败后的回滚和 dispose。 | 已完成。 |
| M2：同 Worker Chrome 并发 E2E | `complete` | Chrome `156.0.8078.79` 中一个 Dedicated Worker 承载三个真实 DSH Agent Loop；backend 测试 hook 同时挂起三条请求，取消 B 只关闭 B 的请求，A/C 完成；每个 Session 只记录自己的 prompt 一次，三个 Agent 均 dispose，无页面/Worker 错误或跨源请求。 | 不外推为容量或 CPU 并行结论。 |
| M3：真实 LLM smoke | `complete` | Chrome `156.0.8078.79`、`gpt-5.6-sol` 完成普通 `read → write → read` 与刷新后的 Session 上下文回忆；57 个 Session events、`durableThroughSeq=56`、8/8 模型请求 HTTP 200。此 smoke 使用非 durable Workspace，刷新后文件缺失是预期；它不验证多 Agent 真实模型并发或文件持久化。 | 记录 warning 与验证边界。 |
| M4：文档与交付 | `complete` | 计划、进度、PoC README、兼容矩阵、drafts 索引与 ledger 已更新；`test:docs` 21/21、`doc-sync` 43/43 和最终 whitespace 检查通过。 | 本批验证记录完整。 |

## 候选选择依据

DSH-TUI 将 Session 事实、Agent 生命周期和终端视图分开：一个 TUI 进程维护多个 live Agent，park 只改变当前显示，进程关闭才终止其执行。Browser-Native DSH 不能照搬 Node 进程，但可以直接检验同一 DSH Host 的 `AgentRegistry` 是否能承载多个 Session。现有 browser mount coordinator 只模拟投影生命周期；现有真实双 Loop 测试则使用两个 Browser Worker，因此两者都没有证明一个 Worker 内多 Agent Loop 的真实服务、取消和持久化隔离。

本批不测 Worker pool 吞吐或同步 CPU 工具公平性。先确认单 Worker 的 Agent/session 隔离语义；这项通过后，再依据 Chrome 资源数据决定是否需要独立的容量和 admission-control 批次。

## 执行记录

| 日期 | 命令/操作 | 结果 | 下一步 |
| --- | --- | --- | --- |
| 2026-10-31 | 阅读 dsh-TUI Session Mount Runtime、参考架构 memo、DSH AgentRegistry/AgentLoop 源码与 PoC 并发/容量记录 | 确认 DSH Agent API 有 `ctx.agents.create()`、`Agent.followup()`、`whenIdle()` 和 per-Agent `cancel()`；当前 PoC 的并发 Loop 测试分布在两个页面/Worker，mount probe 不是 DSH Loop。 | 用 validation profile 创建同 Host 多个真实 Agent。 |
| 2026-10-31 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-multi-agent-probe.spec.ts` | 1 个文件、3/3 tests 通过。 | 执行 Chrome E2E。 |
| 2026-10-31 | `node --check docs/drafts/browser-native-dsh-poc/tests/same-worker-multi-session.e2e.mjs`；`node --check docs/drafts/browser-native-dsh-poc/runtime-validation.mjs` | 两个脚本语法检查通过。 | 执行 Chrome E2E。 |
| 2026-10-31 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/same-worker-multi-session.e2e.mjs` | Chrome `156.0.8078.79` 通过。三个不同 Session 的模型请求同时到达一个 Worker 的 backend barrier；每条请求包含一个工具；B 请求单独关闭，终态为 A/C completed、B aborted；显式 prompt 各记录一次；Agent dispose 计数 3/3；worker count 1、page/worker errors 0、external requests 0。 | 更新 PoC 文档和矩阵。 |
| 2026-10-31 | `DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TURN_TIMEOUT_MS=900000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | Chrome `156.0.8078.79` 使用 `gpt-5.6-sol` 通过；完成三轮普通 Session 流程，工具序列为 `read → write → read`，Session 57 events、watermark 56，模型请求 8/8 HTTP 200，模型调用均经同源 backend。刷新后继续使用 Session 记忆；默认非 durable Workspace 的文件在刷新后缺失，符合该 smoke 配置。记录到已知 compaction context-capacity warning、若干预览 API 404 和刷新时被中止的旧请求；没有页面错误，模型凭据未进入浏览器请求。该 smoke 不是多 Agent 并发证据。 | 记录 warning 和结论边界。 |
| 2026-10-31 | `pnpm run build`；`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 实施期间 `build` 通过全部 9/9 gates，preview build 通过。真实模型 smoke 曾在全局 build 覆盖 preview 产物后因缺少 VFS fixture 未启动；重新构建 validation preview 后重跑并通过。 | 执行文档门禁。 |
| 2026-10-31 | `pnpm run test:docs` | 21 passed，0 failed，0 skipped。 | 执行完整 `doc-sync`。 |
| 2026-10-31 | `pnpm run doc-sync` | 43 passed，0 failed，0 skipped。 | 本批验证记录完整。 |

## 已知限制

- 同源 backend 的确定性响应 barrier 证明三个真实 DSH Agent Loop 能在单 Worker Host 中同时等待异步模型响应，并隔离取消与 Session event；它不证明并发真实模型推理。
- 真实 LLM smoke 只证明普通文件工具和 Session 刷新续接；它使用非 durable Workspace，不能证明文件刷新持久化。
- 一个 Worker 内的 JavaScript CPU 工作仍共享事件循环；通过异步模型请求并发不代表 CPU 密集工具并行或公平。
- 当前不声明生产并发上限、后台执行、多个 Host Worker 的页面调度或用户可见多 Session UI。
