---
description: "Browser-native DSH PoC 的零上下文现状入口：当前架构结论、一键回归与关键测试入口、已验证硬结论、未闭环项与下一批候选。"
---

# 现状入口（新 Agent 从这里开始）

这是 Browser-native DSH PoC 的交接页：只给当前事实、可执行入口和边界，深入证据按链接跳转。读完本页即可接手，不需要历史上下文。

## 一句话定位

Browser-native DSH PoC 把正式 DSH Web UI、Cordis 插件组合与真实 `ctx.agentLoop` 跑在 Chrome 里；当前架构结论是 **durable-first**：正式 Web preview 的主 composer 默认由服务端 durable host 执行 turn，浏览器 Dedicated Worker 只作纯浏览器降级与离线路径，降级原因在界面固定状态条显示。

## 先跑起来

```sh
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --prepare
```

`--prepare` 只在 preview 产物缺失时补跑 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；之后同一条命令即可重复执行。门禁顺序运行合同测试、默认产品路径 E2E、性能守门与混沌套件，逐项打印 PASS/FAIL 与耗时，失败即以非零退出。详细名单与选择参数见[一键全量回归](poc-gate.md)。

| 入口 | 覆盖 | 耗时预算 |
| --- | --- | --- |
| `tests/poc-gate.mjs` | 38 合同测试 + 10 默认 E2E + perf + chaos | 2026-11-04 基线 50/50、总 784.0 s（contract 68.1 s / e2e 134.5 s / perf 523.2 s / chaos 58.2 s） |
| `tests/durable-composer.e2e.mjs` | 新 Session 主 composer 提交、刷新续跑、durable 路由 | 浏览器 E2E，按分钟级预留（单项上限 300 s） |
| `tests/durable-ui-approval.e2e.mjs` | 正式 UI 审批卡：Enter 批准写文件、Escape 拒绝不写 | 同上 |
| `tests/retry-panel-send.e2e.mjs` | 失败重试面板不遮挡 Send；1440/390/320px + Enter 提交 | 同上 |
| `tests/product-visibility.e2e.mjs` | 会话冲突、导出、失败分类、准入排队 | 同上 |
| `tests/accessibility-audit.e2e.mjs` | axe 全页扫描（仅 serious/critical 阻断） | 同上 |
| `tests/first-use.e2e.mjs` | 首用空态引导与首轮后抑制 | 同上 |
| `tests/durable-feature-alignment.test.mjs`、`tests/durable-host-restart.test.mjs` | durable 功能对齐、进程重启结算 | Node 测试，秒级 |

浏览器 E2E 统一使用 `DSH_POC_BROWSER=chrome`；Playwright 不在默认解析位置时用 `DSH_POC_PLAYWRIGHT_MODULE` 指过去。`poc-gate --group` / `--filter` / `--list` 可只跑单项。

## 已验证硬结论

- **durable-first 执行面**：同一 10 任务真实模型基准两侧 10/10；durable 29 请求 / 23,318 tokens / 12.8 秒，Worker 39 请求 / 91,734 tokens / 22.4 秒，durable 输入约为 Worker 的 24.4%；工具面对齐为 6 个（`read`/`write`/`edit`/`grep`/`glob`/`subagent`）。见[真实模型任务基准](real-model-task-benchmark.md)。
- **token 削减**：上述基准的输入 token 归因与分步削减是本轮依据；24.4% 是同一 10 任务口径的比例，不是通用压缩承诺。
- **主 composer 与刷新续跑**：`durable-composer.e2e` 证明新 Session 首条 composer 提交得到 durable turn 并 `completed`，刷新后同一 `sessionId` 继续，第二 turn 完成、`turn/start` 计 2、两条 prompt 落库、`pageErrors=0`。
- **审批主 UI**：`durable-ui-approval.e2e` 在正式 preview 键盘批准后落盘、键盘拒绝无写入，两次均为 11 个事件、seq 0–10，`pageErrors=0`；失败时面板提供可操作建议与“重试该轮”。见[审批进度](durable-host-progress.md)与[失败 turn 的界面重试](turn-retry.md)。
- **重试面板不再遮挡 Send**：`retry-panel-send.e2e` 在 1440/390/320px 下断言面板与 composer、Send 均不相交，Send 中心点命中自身，面板可见时 Enter 提交仍得到 `completed` turn；此前失败的 `product-visibility.e2e` 已真正通过。
- **关页续跑与重启结算**：`durable-host-restart.test.mjs` 覆盖宿主被杀后结算未完成 turn（`DURABLE_HOST_RESTARTED`），恢复 1 个 turn，重启后模型请求与工具调用均为 0，owner epoch 1→2，下一 turn 正常完成。见[重启恢复](durable-host-restart.md)。
- **可达性**：`accessibility-audit.e2e` 无 serious/critical axe 违规、无页面错误；窄屏 320px 与 390px 渲染已由伪本地化与重试面板 E2E 覆盖。见[无障碍审计](accessibility-audit.md)。

结论总账与逐条替代关系在[产品就绪度 go/no-go](product-readiness-go-no-go.md)；durable 功能对齐的逐项状态在[durable host 进度](durable-host-progress.md)。

## 未闭环与不可测项

| 项目 | 状态 | 关闭条件 |
| --- | --- | --- |
| composer 附件上传走 durable start | 未闭环：附件仍由 Worker 上传 | 把上传结果接到 durable start 的 `attachments`，并跑一条图片附件 E2E |
| 同页并发提交 steer | 未闭环：只串行排队 | 定义 steer 协议并覆盖排队改道、取消与落库 |
| 待决审批跨重启恢复 | 未验证 | 重启前后同一 `approvalId` 可决策一次且不重放 |
| 16 Session 仪表盘视觉回归 | 未做专门截图基线 | 增加 16 项 durable 会话的截图校验 |
| durable 事件的服务端全文索引 | 仅线性全文回退 | 接上 SQLite 索引并跑检索规模 E2E |
| 归档自动调度 | 仅管理员显式归档 | 接保留期调度器并验证归档后打开 |
| 跨主机 HA / 跨节点关页接管 | 不可本地闭环：单进程 `dataDir` 锁 + owner token | 多实例共享存储、分布式租约与 fencing 压测 |
| Safari / iOS 真机执行面 | 不可本地闭环：无真机 WebDriver，iOS `getDirectory()` 失败 | 真机 WebDriver，或明确只做 UI-only 的产品决策 |
| KMS/HSM、多实例密钥轮换 | 不可本地闭环 | 托管密钥服务与跨实例轮换演练 |
| 租户硬阻断与账单结算 | 部分闭环：限额来源已统一，硬阻断/账单未实现 | 服务端硬配额与 provider 对账；账单依赖外部结算 |
| 自然浏览器崩溃、掉电、OS 崩溃 | 不可本地闭环：只能注入 SIGKILL 与磁盘错误 | 真实设备故障或长稳观察 |

更多不可测边界见[产品就绪度·环境限制](product-readiness-go-no-go.md#环境限制与不可测项)。

## 下一批候选（按价值排序）

1. **附件接 durable start**（高价值，当前环境可闭环）：补齐主 composer 的唯一功能缺口。
2. **待决审批跨重启恢复**（高价值，可闭环）：直接决定关页/重启后的审批可信度。
3. **并发 steer 或排队改道**（中高，可闭环）：消除“只串行排队”的产品落差。
4. **服务端检索索引接 durable 事件**（中，可闭环）：把线性全文回退换成 SQLite 索引。
5. **16 Session 仪表盘截图基线 + 归档调度**（中，可闭环）：视觉与治理两块低成本欠账。
6. **跨主机 HA / 跨节点接管**（最高价值，但当前环境不可闭环）：需多实例基础设施。
7. **Safari/iOS 真机**（高价值，不可闭环）：需真实设备矩阵。

## 约定

- 真实验证统一用 `DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env`，端点与模型取自该文件；运行时若环境代理干扰，按既有命令清理 `HTTPS_PROXY` 等变量。
- 文档、日志与提交里不写 provider 密钥；只记录请求数、token、耗时与错误码。
- 本页只做摘要；数字与结论以链接文档为准，改结论先改拥有该事实的详细文档。
- 只改与任务相关的文件；纯文档改动跑 `pnpm run verify-md-links` 与 `pnpm run verify-md-wrap`，不跑全量 gate。
