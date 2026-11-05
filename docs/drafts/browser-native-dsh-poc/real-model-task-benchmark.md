# 真实模型任务基准：Worker 与 durable 对照

本基准用同一组 10 个贴近真实使用的小任务，分别在浏览器 Worker harness 与 durable 服务端 host 上以真实模型执行一次。它回答三个问题：任务能否端到端完成，失败应归因于模型、工具还是 harness，以及两侧的 token 差异来自哪里。

## 方法

- provider：LongCat-2.5（`OPENAI_BASE_URL` 的 OpenAI 兼容端点），真实请求，`llmIncludeUsage` 开启。
- 任务集：读写文件、工作区检索、创建后编辑、多文件写入、子代理委派、跨 turn 修改、导出 Session、审批确认、工具报错恢复、多文件摘要，共 10 个，每个任务使用新 Session（跨 turn 任务除外）。
- Worker 模式：preview roster `browser-benchmark`，加载 `tool-subagent` 与 `browser-native-tool-policy`（`write: ask`、其余 allow），`browser-native-test=subagent` 发布子代理 schema。广告 8 个工具：`read`、`write`、`edit`、`grep`、`glob`、`todo_write`、`subagent`、`list_subagent_models`。每个任务新开一个 `BrowserContext`，避免 Workspace 锁与上一个页面争用。
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
| 平均模型请求/任务 | 4.0（共 44） | 3.0（共 29） |
| 平均会话步数/任务 | 3.0 | 3.0 |
| 平均交互时长 | 17,585 ms | 12,482 ms |
| 审批次数合计 | 8 | 10 |
| 输入 tokens | 101,200 | 20,527 |
| 输出 tokens | 5,679 | 2,438 |
| 合计 tokens | 106,879 | 22,965 |
| 费用 | 未配置单价，null | 未配置单价，null |
| 模式总时长（含启动） | 199,922 ms | 125,006 ms |

逐任务结果：

| 任务 | Worker | durable | durable 说明 |
| --- | --- | --- | --- |
| t1-read-write | 通过（10.2 s，9,021 tokens） | 通过（19.8 s，2,470 tokens） | 1 次审批 |
| t2-search | 通过（27.0 s，19,829 tokens） | 通过（14.9 s，3,726 tokens） | 1 次审批，`grep` 两次 |
| t3-write-edit | 通过（7.3 s，8,593 tokens） | 通过（10.8 s，2,229 tokens） | 2 次审批（`write` + `edit`） |
| t4-multifile | 通过（8.0 s，6,149 tokens） | 通过（6.5 s，1,628 tokens） | 2 次审批 |
| t5-subagent | 通过（26.3 s，13,749 tokens） | 通过（9.7 s，1,828 tokens） | 子代理 1 次子请求 |
| t6-cross-turn | 通过（16.9 s，14,697 tokens） | 通过（33.0 s，3,649 tokens） | 2 次审批 |
| t7-export | 通过（39.5 s，6,007 tokens） | 通过（6.0 s，1,542 tokens） | 导出 2,479 字节 |
| t8-approval | 通过（6.7 s，5,859 tokens） | 通过（5.7 s，1,535 tokens） | 1 次审批 |
| t9-missing-recovery | 通过（25.9 s，16,466 tokens） | 通过（13.2 s，2,197 tokens） | 读错误后恢复 |
| t10-summarize | 通过（8.1 s，6,509 tokens） | 通过（5.4 s，2,161 tokens） | 无审批 |

Worker 的 `t7-export` 导出 25,205 字节，durable 为 2,479 字节：前者事件更多、工具结果更长，Session 体积随 Worker 工具面增长。

## 失败归因

本轮没有失败。两侧的模型都按任务要求调用所需工具，实际发出的工具调用全部成功（`t9` 的缺失读取是刻意制造的、随后恢复的错误）；没有 harness 错误、审批错误或 Session 读回错误。durable 在补齐 `grep`/`glob`/`edit`/`subagent` 后达到与 Worker 相同的 10/10。

## token 差异归因

Worker 合计 106,879 tokens，durable 22,965，前者是后者的 4.65 倍；输入 token 差为 80,673（101,200 对 20,527）。按请求字符组成换算，这一差值拆为三项，三项之和与观测差值一致：

| 来源 | Worker 输入 tokens | durable 输入 tokens | 差值 | 占输入差 |
| --- | --- | --- | --- | --- |
| system prompt | 33,727 | 0 | 33,727 | 42% |
| 工具 schema | 49,420 | 16,077 | 33,343 | 41% |
| 对话历史（含工具调用与结果） | 18,054 | 4,450 | 13,604 | 17% |

具体证据：

- Worker 的 44 次请求中，34 次携带 system prompt 与工具 schema，10 次是无 system、无工具的辅助请求（每任务 1 次，输入约 300 字符）。durable 的 29 次请求全部不带 system prompt，全部携带 6 个工具。
- Worker 每个完整请求的 system prompt 为 3,443 字符，工具 schema 为 6,529 字符（8 个工具）；durable 的工具 schema 为 2,204 字符（6 个工具），按 5.05k 对 2.20k 的平均值摊薄后仍约为 2.3 倍。
- Worker 平均历史 1,843 字符，durable 610 字符。差异一部分来自多出的模型往返，一部分来自 DSH 工具调用/结果信封更宽；`t5` 的最终父请求携带 6,797 字符历史，因为要把子代理结果送回父上下文。
- 请求数差为 15：其中 10 次是 Worker 的辅助请求，另外 5 次是工具往返差（`t2` +3、`t5` +2）。辅助请求输入很小，对 token 差贡献不到 1%，主要增加延迟。

可削减项按收益排序：

1. 工具 schema（差值 33.3k）：这是每次完整请求都重付的固定成本。本次任务集从未调用 `todo_write` 与 `list_subagent_models`；按 roster 裁剪未用工具，并缩短描述，可减少每个请求的 schema。即使裁剪到 6 个工具，Worker 仍会大于 durable，因为 durable 的工具描述本来就更短。
2. system prompt（差值 33.7k）：静态 3.4k 字符出现在 34 次请求上。压缩 per-roster 指令可直接减少 tokens；provider 侧 prompt caching 只能降低计费，不减少上报 token。
3. 历史（差值 13.6k）：降低 tool-result pruner 阈值或在子代理返回时先摘要再注入父上下文，可减少后续请求的重复工具输出。这是真正的“重复上下文”项，但只占输入差的 17%，不是主因。
4. 辅助请求：10 次无 system/无工具的请求可合并、延后或按需跳过，收益主要是延迟，不是 tokens。

结论：差异不是同一段上下文被重复注入，而是 Worker 每次完整模型请求都携带 DSH 的静态 system prompt 与 8 工具 schema，durable host 两者都不携带；历史重复只占 17%。削减顺序应是先裁工具 schema，再压缩 system prompt，最后处理历史。费用仍无法断言，因为未配置单价。

## 解读

两侧 10/10。durable 的工具面和 Worker 对齐后，检索、编辑、子代理、审批、跨 turn、导出与错误恢复都可端到端完成；平均交互时长 durable 12.5 秒、Worker 17.6 秒，Worker 的 `t2` 与 `t9` 各发生一次检索工具错误后重试，`t7` 的导出与渲染耗时也更高。单任务时长受模型非确定性影响，不能当作稳定性能结论。

durable 的合计 tokens 从上一轮的 13,623 升到 22,965：新增 `grep`/`glob`/`edit`/`subagent` 让工具 schema 从约 600 字符升到 2,204 字符，`t5` 又多一次子请求。Worker 从 85,310 升到 106,879，主要来自本轮 `t2` 用了 7 次请求（上一轮更少），属于模型行为波动；结构性的 system prompt 与工具 schema 成本不变。

## 限制

- 每个任务只跑一次，10 个任务不足以给出统计显著性；模型存在非确定性，逐任务时长与请求数会波动，token 归因表的比例来自本次观测。
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

`DSH_POC_BENCH_PROVIDER=minimax` 切换端点，`DSH_POC_BENCH_MODES=browser` 或 `durable` 只跑一侧，`DSH_POC_BENCH_TASKS=t6-cross-turn,t8-approval` 只跑指定任务。结果写入 `real-model-task-benchmark-results.json`，每个任务完成后覆盖检查点，进程中断仍保留部分证据，`comparison.tokenAttribution` 给出按字符换算的 token 拆分。设置 `DSH_POC_INPUT_PRICE_PER_MTOK` 与 `DSH_POC_OUTPUT_PRICE_PER_MTOK` 才会计算费用。
