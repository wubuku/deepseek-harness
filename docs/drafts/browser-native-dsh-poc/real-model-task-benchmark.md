# 真实模型任务基准：Worker 与 durable 对照

本基准用同一组 10 个贴近真实使用的小任务，分别在浏览器 Worker harness 与 durable 服务端 host 上以真实模型执行一次。它回答三个问题：任务能否端到端完成，失败应归因于模型、工具还是 harness，以及两侧的 token 差异来自哪里。

## 方法

- provider：LongCat-2.5（`OPENAI_BASE_URL` 的 OpenAI 兼容端点），真实请求，`llmIncludeUsage` 开启。
- 任务集：读写文件、工作区检索、创建后编辑、多文件写入、子代理委派、跨 turn 修改、导出 Session、审批确认、工具报错恢复、多文件摘要，共 10 个，每个任务使用新 Session（跨 turn 任务除外）。
- Worker 模式：preview roster `browser-benchmark`，加载 `tool-subagent` 与 `browser-native-tool-policy`（`write: ask`、其余 allow），`browser-native-test=subagent` 发布子代理 schema。广告 6 个工具：`read`、`write`、`edit`、`grep`、`glob`、`subagent`。`todo_write` 已从 roster 移除，`working_directory` 在基准 profile 中禁用；`list_subagent_models` 只在启用 subagent model selection 时注册，本 profile 未启用，因此从未进入 schema。每个任务新开一个 `BrowserContext`，避免 Workspace 锁与上一个页面争用。
- durable 模式：`real-durable-backend-process.mjs` 启动真实后端的 durable host，广告并执行 6 个工具：`read`、`write`、`grep`、`glob`、`edit`、`subagent`。`write` 与 `edit` 进入服务端审批；`subagent` 是有界只读子循环（最多 3 次模型请求，子代理可用 `read`/`grep`/`glob`，不能写入、编辑、再委派或递归）。
- 审批：基准自动点击 “Allow once” 或提交 durable 审批决定；审批延迟按首次观察到 pending 到最后一次决定计时，包含审批中间隔着模型步骤的跨度。
- 指标：成功率按任务通过/总数；模型轮次取 provider 请求数（`usage-audit` 增量），会话步数取 `step/start`；tokens 为 provider 上报的输入/输出合计；时长为交互开始到完成（浏览器页面启动单独计）；费用在有单价配置时才计算，本次未配置单价，故为 null。
- token 归因：每个真实模型请求在 `usage-audit` 条目中记录 system prompt 字符数、对话历史（含工具调用与结果的序列化）字符数、工具 schema 字符数、消息数与工具数；基准按模式用“字符总数 / provider 输入 tokens”换算，把输入 token 差拆成 system prompt、工具 schema、历史三项。
- 超时：每 turn 240 秒；审批轮询间隔 150 ms。

## 任务集

| ID | 任务 | 能力 | Worker 工具 | durable 工具 |
| --- | --- | --- | --- | --- |
| t1-read-write | 读固定文件并写出一行 | 读取 + 写入 | `read` `write` | `read` `write` |
| t2-search | 先建索引文件，再检索标记 | 工作区检索 | `write` `grep` `glob` | `write` `grep` `glob` |
| t3-write-edit | 创建文件后替换一个词 | 编辑 | `write` `edit` | `write` `edit` + 审批 |
| t4-multifile | 一轮写两个文件 | 写入 | `write` ×2 | `write` ×2 |
| t5-subagent | 委派一次子代理 | 子代理 | `subagent`（完整子 Session） | `subagent`（只读子循环） |
| t6-cross-turn | 两个用户 turn 内改值 | 跨 turn 修改 | `read` `write` `edit` | `read` `write` `edit` + 审批 |
| t7-export | 产出 JSON 并导出 Session | 导出 | `write` + `session/export` | `write` + `session/export` |
| t8-approval | 写入前确认一次审批 | 审批 | `write` + approval | `write` + approval |
| t9-missing-recovery | 读缺失文件后恢复创建 | 工具报错恢复 | `read` `write` `glob` | `read` `write` `glob` |
| t10-summarize | 读两个文件并摘要 | 读取 | `read` ×2 | `read` ×2 |

两侧工具面已对齐到同一组文件与委派能力；durable 的子代理范围更窄，差异记在限制中。

## 结果

| 指标 | 浏览器 Worker | durable 服务端 host |
| --- | --- | --- |
| 成功率 | 10/10（100%） | 10/10（100%） |
| 失败归因（模型/工具/harness） | 0 / 0 / 0 | 0 / 0 / 0 |
| 平均模型请求/任务 | 3.9（共 39） | 2.9（共 29） |
| 平均会话步数/任务 | 3.0 | 3.0 |
| 平均交互时长 | 22,448 ms | 12,835 ms |
| 审批次数合计 | 9 | 10 |
| 输入 tokens | 84,382 | 20,573 |
| 输出 tokens | 7,352 | 2,745 |
| 合计 tokens | 91,734 | 23,318 |
| 费用 | 未配置单价，null | 未配置单价，null |
| 模式总时长（含启动） | 248,538 ms | 128,530 ms |

逐任务结果：

| 任务 | Worker | durable | durable 说明 |
| --- | --- | --- | --- |
| t1-read-write | 通过（13.7 s，7,954 tokens） | 通过（10.3 s，2,301 tokens） | 1 次审批 |
| t2-search | 通过（17.0 s，11,946 tokens） | 通过（21.4 s，3,982 tokens） | 1 次审批，`grep` 两次 |
| t3-write-edit | 通过（22.7 s，12,851 tokens） | 通过（12.8 s，2,413 tokens） | 2 次审批（`write` + `edit`） |
| t4-multifile | 通过（10.9 s，5,606 tokens） | 通过（9.2 s，1,745 tokens） | 2 次审批 |
| t5-subagent | 通过（88.5 s，16,540 tokens） | 通过（19.1 s，1,780 tokens） | 子代理 1 次子请求 |
| t6-cross-turn | 通过（31.8 s，13,102 tokens） | 通过（15.5 s，3,824 tokens） | 2 次审批 |
| t7-export | 通过（5.2 s，5,090 tokens） | 通过（19.1 s，1,462 tokens） | 导出 2,479 字节 |
| t8-approval | 通过（11.5 s，5,054 tokens） | 通过（7.3 s，1,435 tokens） | 1 次审批 |
| t9-missing-recovery | 通过（14.9 s，7,908 tokens） | 通过（5.8 s，2,214 tokens） | 读错误后恢复 |
| t10-summarize | 通过（8.2 s，5,683 tokens） | 通过（7.9 s，2,162 tokens） | 无审批 |

Worker 的 `t7-export` 导出 22,179 字节，durable 为 2,479 字节：前者事件更多、工具结果更长，Session 体积随 Worker 工具面增长。

## 失败归因

本轮没有失败。两侧的模型都按任务要求调用所需工具，实际发出的工具调用全部成功（`t9` 的缺失读取是刻意制造的、随后恢复的错误）；没有 harness 错误、审批错误或 Session 读回错误。durable 在补齐 `grep`/`glob`/`edit`/`subagent` 后达到与 Worker 相同的 10/10。

## token 差异归因

Worker 合计 91,734 tokens，durable 23,318，前者是后者的 3.93 倍；输入 token 差为 63,809（84,382 对 20,573）。按请求字符组成换算，这一差值拆为三项，三项之和与观测差值一致：

| 来源 | Worker 输入 tokens | durable 输入 tokens | 差值 | 占输入差 |
| --- | --- | --- | --- | --- |
| system prompt | 29,540 | 0 | 29,540 | 46% |
| 工具 schema | 36,312 | 16,102 | 20,210 | 32% |
| 对话历史（含工具调用与结果） | 18,530 | 4,471 | 14,059 | 22% |

具体证据：

- Worker 的 39 次请求中，31 次携带 system prompt 与工具 schema，8 次是无 system、无工具的辅助请求（每任务约 1 次，输入很小）。durable 的 29 次请求全部不带 system prompt，全部携带 6 个工具。
- Worker 每个完整请求的 system prompt 为 4,270 字符，工具 schema 为 5,249 字符（6 个工具）；durable 的工具 schema 为 2,204 字符（6 个工具）。
- Worker 平均历史 2,129 字符，durable 612 字符。差异一部分来自多出的模型往返，一部分来自 DSH 工具调用/结果信封更宽；`t5` 的最终父请求需要把子代理结果送回父上下文。
- 请求数差为 10：其中 8 次是 Worker 的辅助请求，另外 2 次是工具往返差。辅助请求输入很小，对 token 差贡献不到 1%，主要增加延迟。

## token 削减：分步证据

按上轮归因顺序逐项实施，每项都在同一任务集、同一 LongCat-2.5 端点上重跑。除最后一行跑双侧外，其余均为 Worker 单侧，以便隔离变量：

| 步骤 | Worker 工具 | persona | pruner 阈值 | 请求数 | 输入 tokens | 合计 tokens | 平均时长 | 成功率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 基线 | 8 | 原始 | 2048 | 44 | 101,200 | 106,879 | 17,585 ms | 10/10 |
| 1 裁掉未用工具 | 6 | 原始 | 2048 | 46 | 105,208 | 110,927 | 19,474 ms | 10/10 |
| 2 压缩 per-roster 提示 | 6 | 压缩 | 2048 | 44 | 91,848 | 96,157 | 15,083 ms | 10/10 |
| 3 评估 pruner 阈值 1024 | 6 | 压缩 | 1024 | 46 | 103,756 | 109,965 | 17,906 ms | 10/10 |
| 最终双侧运行 | 6 | 压缩 | 2048 | 39 | 84,382 | 91,734 | 22,448 ms | 10/10 |

由于模型自身决定请求数（44 → 46 → 44 → 46 → 39），原始总量被请求数波动主导，不能直接当作单项削减的收益。稳定的结构性证据是每个完整请求的静态字符数：

| 项 | 基线 | 最终 | 变化 |
| --- | --- | --- | --- |
| system prompt 字符 | 4,456 | 4,270 | −186（−4.2%） |
| 工具 schema 字符 | 6,529 | 5,249 | −1,280（−19.6%） |
| 静态合计（每个完整请求） | 10,985 | 9,519 | −1,466（−13.3%） |
| 输入 tokens / 请求 | 2,300 | 2,163.6 | −136.4（−5.9%） |

各项结论：

1. 裁掉未用工具（`todo_write` 与 `working_directory`）把 schema 从 6,529 降到 5,249 字符，每个完整请求省 1,280 字符。未裁 `list_subagent_models`，因为它在未启用 model selection 的 profile 中本来就不注册；`todo_write` 与 `working_directory` 在 10 个任务中从未被调用。该步请求数增加到 46、总量反而上升，是模型行为波动，不是削减的反效果。
2. 压缩 per-roster system prompt 把静态提示从 4,456 降到 4,270 字符，并在同一 44 请求下把输入从 101,200 降到 91,848，合计 tokens 降 10.0%，时长降 14.2%。
3. pruner 阈值 1024 没有产生任何节省：本轮所有工具结果都小于 1024 字符，46 次请求中 **0** 条 prune 标记，说明阈值从未触发；历史字符的差异来自请求数波动，不是裁剪。阈值 512 更低，且 `headChars 512 + marker + tailChars 256 = 806 > 512` 违反加载期配置校验，preview 无法启动。因此保留 2048。
4. 最终双侧运行中 Worker 输入 84,382、合计 91,734，相对基线输入 −16.6%、合计 −14.2%；其中约 5 次请求的减少贡献了大部分差值，结构性收益仍是每完整请求 −1,466 字符。

结论：三项削减里只有前两项有可测的每请求收益，合计 −13.3% 静态字符；pruner 在本任务集上不触发，降低阈值只会带来裁剪真实长结果的风险，不值得改。Worker 与 durable 的剩余差距仍是 Worker 每次完整请求都携带 system prompt 与 6 工具 schema；历史份额从 17% 升到 22%，因为前两项变小而历史绝对量未变。费用仍无法断言，因为未配置单价。

## 解读

两侧 10/10。durable 的工具面和 Worker 对齐后，检索、编辑、子代理、审批、跨 turn、导出与错误恢复都可端到端完成；平均交互时长 durable 12.8 秒、Worker 22.4 秒，差值几乎全部来自 Worker 的 `t5` 一次 88.5 秒的子代理往返，其余任务两侧相当。单任务时长受模型非确定性影响，不能当作稳定性能结论。

durable 的合计 23,318 tokens、29 次请求，Worker 为 91,734、39 次；Worker 的固定成本仍是每次完整请求的 system prompt（4,270 字符）与工具 schema（5,249 字符）。历史占比从削减前的 17% 升到 22%，因为前两项缩小而历史绝对量未变。

## 限制

- 每个任务只跑一次，10 个任务不足以给出统计显著性；模型存在非确定性，逐任务时长与请求数会波动（本批五次运行的请求数在 39–46 之间），token 归因表的比例来自本次观测。原始 token 总量因此被请求数波动主导，削减收益以每个完整请求的静态字符数与输入 tokens/请求为准。
- 只测 LongCat-2.5。MiniMax-M3 探测一次即返回 `UPSTREAM_LLM_RATE_LIMITED`（HTTP 503），0 次模型请求、0 tokens，因此未跑 MiniMax 全量任务集；证据见 `real-model-task-benchmark-minimax-probe.json`。
- durable 的 `subagent` 是只读、最多 3 次模型请求的子循环，不复用 Worker 的完整子 Session、工具集与嵌套委派；两侧不是功能等价实现。
- Worker 与 durable 的系统提示与工具面不同，这是被测 harness 的真实差异，也是本轮的测量对象，不是受控的提示对照。
- durable 的文件内容正确性在 turn 结束后通过 Workspace manifest 与新增的 `GET /api/browser-native/workspace/blob/:hash` 读回；Worker 通过测试通道重新读取文件内容。
- Worker fixture 位于 `/dsh/home/browser-validation`，durable fixture 由基准经 Workspace commit 写入 `/dsh/home/workspace/browser-validation`，文件内容相同，路径按模式替换。
- Worker 使用测试 roster `browser-benchmark`；生产 profile 的默认审批与工具面可能不同。

## 复现

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
  node docs/drafts/browser-native-dsh-poc/tests/real-model-task-benchmark.e2e.mjs
```

`DSH_POC_BENCH_PROVIDER=minimax` 切换端点，`DSH_POC_BENCH_MODES=browser` 或 `durable` 只跑一侧，`DSH_POC_BENCH_TASKS=t6-cross-turn,t8-approval` 只跑指定任务，`DSH_POC_BENCH_PRUNER_CHARS=1024` 改 tool-result pruner 阈值以便对照（须满足 `headChars + marker + tailChars ≤ thresholdChars`）。结果写入 `real-model-task-benchmark-results.json`，每个任务完成后覆盖检查点，进程中断仍保留部分证据，`comparison.tokenAttribution` 给出按字符换算的 token 拆分，`settings` 记录本次 pruner 阈值与实际广告的工具名。设置 `DSH_POC_INPUT_PRICE_PER_MTOK` 与 `DSH_POC_OUTPUT_PRICE_PER_MTOK` 才会计算费用。
