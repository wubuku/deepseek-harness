---
description: "验证 Browser-Native 运行期能力退化时，DSH 的模型工具 schema、Session 记录和执行授权是否保持一致并可恢复。"
---

# Browser-Native 运行期能力发布验证计划

## 目标

验证 Worker 启动后的 Workspace 本地持久化失败能否撤销所有依赖该 Workspace 的模型工具，并阻止同批迟到调用产生文件副作用；能力恢复后，新请求能否重新发布工具，而不重放旧 prompt 或工具调用。

本批同时核实 DSH `request/header` 中的工具定义与同一次真实模型请求的 schema 是否一致。能力失效只影响本地 Workspace 工具组；同源云端提交暂时 pending 但本地文件已 durable 时，不得误撤销该工具组。

## 候选范围与取舍

| 验证点 | 价值 | 决定 | 理由 |
|---|---:|---|---|
| Worker 请求未经过成功启动 probe 时仍可 boot | P0 | 纳入 | 当前 init 只拒绝“已运行但失败”的 probe；缺少 probe 时也会放行，违反启动门的 fail-closed 语义。 |
| DSH 实际 tool schema 与 Browser 发布清单不一致 | P0 | 纳入 | LLM adapter 当前静默过滤未登记工具；`request/header` 在 adapter 过滤前记录工具，可能与模型实际看到的 schema 不同。 |
| OPFS/本地 Workspace 保存失败后撤销依赖 Workspace 的工具 | P0 | 纳入 | 启动 probe 不能保证后续存储可用；当前文件工具会报告未确认保存，但 bash、文件工具和工作目录仍可能继续出现在后续请求。 |
| 一批模型工具调用中途发生持久化退化 | P0 | 纳入 | 已返回的同批工具调用不能因 schema 后续变化而绕过执行门；必须检查 dispatch 前 guard，且不回滚已进入的调用。 |
| 刷新后重新探测并恢复工具发布 | P0 | 纳入 | Worker 重建后须依据新的真实 probe 状态恢复工具，且不能重放失败 turn 或再次执行旧副作用。 |
| 云端 commit pending 与本地 durable failure 的区分 | P1 | 纳入 | 两者可见错误相似，但前者仍有本地 durable 文件与可重试 receipt，不能被误判为 VFS 不可用。 |
| 用户权限动态撤销、重新授权与 UI 提示 | P1 | 延后 | 当前 Browser profile 没有受浏览器权限 API 控制的 Workspace 授权；需要先有产品授权来源和用户交互语义。 |
| 任意 Cordis 插件、service、method 的运行期动态发现 | P1 | 延后 | PoC manifest 不是通用插件 registry；自动发现需要正式 capability declaration API，本批不伪造该能力。 |
| backend 多版本滚动升级、跨 Worker capability snapshot 协商 | P1 | 延后 | 当前同源 PoC 使用固定协议版本和单 Worker；需要独立的版本部署与接管实验。 |
| Session catalog、observer 或 Cloud Worker capability handoff | P2 | 延后 | 不影响当前 Browser Worker 的 Workspace 工具发布闭环，且没有真实 Cloud Agent 执行者。 |

## 设计与验收

### M0：锁定现有语义

- 复核 `browser-native-capabilities.ts`、Worker boot gate、`browser-native-providers.ts`、工具注册/限制扩展点和 Session `request/header` 写入时序。
- 把受 Workspace 本地 durable 状态约束的工具列为一个明确工具组：`bash`、文件读写/编辑/搜索和 `working_directory`；`todo_write` 与问答工具不依赖该组。
- 定义状态：启动 probe 未通过时不发布；probe 通过后发布；本地保存未确认时将 Workspace 工具组设为 degraded；新 Worker 的 probe 再通过后才恢复。

### M1：一个状态来源驱动发布与执行

- 在 PoC 目录新增运行期 capability publication 状态，作为 Worker Host、工具限制、执行 guard 和 LLM adapter 的共享对象。
- 通过 agent scope 的 `tools.restrict()` 按当前状态更新模型工具 schema；通过 `tools.guard()` 在实际 dispatch 前再次检查状态。
- LLM adapter 不再静默过滤未知工具。只发送 DSH 当前 header 中已经发布的 schema；发现未登记、重复或已撤销工具时，在发送网络请求前明确失败。
- 仅在 runtime probe 成功后激活 publication；Worker Host init 必须要求 probe report 明确成功，不能把“未执行 probe”当作通过。
- 利用 DSH 已有 `request/header` 和 tool-registry 更新事件记录每个请求实际发布的工具集合，不另造第二份模型历史。

### M2：本地 durability 失败与同批调用防护

- 在真实 DSH 文件工具的本地 Workspace flush 失败路径将 Workspace 工具组降级；诊断不包含凭据或原始 backend body。
- 降级不撤销 `todo_write` 和问答工具；云端 commit pending、但本地保存成功时仍保留 Workspace 工具组。
- scripted LLM 在一个响应中返回两个有序文件写调用。第一个触发一次性 OPFS quota 故障，第二个必须被当前 capability guard 拒绝，不能写入 VFS 或提交 Workspace。
- 同一 DSH turn 继续结算错误结果；后续模型请求 schema 不含 Workspace 工具，Session `request/header` 与 backend 实际收到的工具名一致。

### M3：真实 Chrome 刷新恢复

- 使用真实 Chrome Dedicated Worker、OPFS、IndexedDB、DSH Host 和同源 backend；在失败前持久化一份 baseline 文件。
- 断言 quota 故障 turn 没有重发 prompt、重复工具副作用或 Workspace commit；volatile failed write 在刷新后不冒充 durable 文件。
- 刷新重建 Worker，重新通过启动 probes 后提交一个新的用户 prompt；工具 schema 恢复，baseline 文件仍可读，旧 prompt 不自动重放。
- 检查 Session 中失败工具结果、连续 request header、工具调用数、Workspace revision、backend 请求计数、页面/Worker 错误和跨源请求。

### M4：真实模型冒烟与文档交付

- 真实 LLM 只运行普通 Chrome `read → write → read` 和刷新恢复 smoke，确认此次 adapter/schema 改动未破坏实际模型协议；真实模型不负责触发不稳定的 quota 故障时序。
- 更新 PoC README、兼容矩阵、`docs/drafts/README.md`、change ledger 和本计划/进度；更正上一批能力探测进度中的提交状态。
- 运行针对性 Vitest/backend/E2E、preview build、文档门禁、typecheck 与 pre-push 检查；所有记录仅写实际执行结果。

## 验收矩阵

| 场景 | 必须观察到 | 不代表 |
|---|---|---|
| Host init 没有成功 runtime probe | init 被拒绝；没有 Session、LLM 或工具副作用 | 非 Browser-Native Worker 也必须执行 Browser probe。 |
| 当前 DSH schema 全部已登记且 live | backend wire schema 与对应 Session `request/header` 的模型可见字段一致 | 所有可能的 Cordis profile 均已动态发现。 |
| schema 含未知或重复工具 | LLM 请求发送前 fail closed，并记录可定位诊断 | 未知插件可自动获得权限或执行能力。 |
| 本地 OPFS 保存失败 | 当前调用按失败语义结算；后续 Workspace 工具从 schema 隐藏且执行 guard 拒绝迟到调用 | 已开始的 mutation 可由 Worker 自动回滚。 |
| 本地保存成功、云端 commit pending | Workspace 工具仍发布；既有 receipt/retry 语义保持不变 | 云端 revision 已提交。 |
| 新 Worker probes 成功、发起新 prompt | Workspace 工具重新发布；baseline 数据可读；旧 prompt 和副作用没有自动重放 | 页面关闭后 Worker 可继续运行。 |

## 非目标与限制

- 本批只动态撤销当前 PoC 中依赖本地 Workspace durability 的工具组，不实现任意插件热插拔、用户权限系统或跨 Worker 通用 capability protocol。
- `request/header` 记录 DSH 组装的完整工具 schema；adapter 必须保留相同的模型可见名称、描述和参数。adapter 专用传输字段（如本地 defer 标记）不属于模型 wire schema。
- OPFS quota 通过一次性 fault seam 注入；Chrome E2E 不代表自然 eviction、OS 断电、其他浏览器 quota 分类或生产云对象存储行为。
- 当前 PoC backend 是同源单实例测试服务；本批不验证多实例或 Cloud Durable Worker。
