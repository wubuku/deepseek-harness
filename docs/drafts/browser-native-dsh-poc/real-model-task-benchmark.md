# 真实模型任务基准：Worker 与 durable 对照

本基准用同一组 10 个贴近真实使用的小任务，分别在浏览器 Worker harness 与 durable 服务端 host 上以真实模型执行一次。它回答两个问题：任务能否端到端完成，以及失败应归因于模型、工具还是 harness。

## 方法

- provider：LongCat-2.5（`OPENAI_BASE_URL` 的 OpenAI 兼容端点），真实请求，`llmIncludeUsage` 开启。
- 任务集：读写文件、工作区检索、创建后编辑、多文件写入、子代理委派、跨 turn 修改、导出 Session、审批确认、工具报错恢复、多文件摘要，共 10 个，每个任务使用新 Session（跨 turn 任务除外）。
- Worker 模式：preview roster `browser-benchmark`，加载 `tool-subagent` 与 `browser-native-tool-policy`（`write: ask`、其余 allow），`browser-native-test=subagent` 发布子代理 schema。每个任务新开一个 `BrowserContext`，避免 Workspace 锁与上一个页面争用。
- durable 模式：`real-durable-backend-process.mjs` 启动真实后端的 durable host，只广告并执行 `read` / `write`；每次 `write` 都进入服务端审批。
- 审批：基准自动点击 “Allow once” 或提交 durable 审批决定；审批延迟按首次观察到 pending 到最后一次决定计时，包含审批中间隔着模型步骤的跨度。
- 指标：成功率按任务通过/总数；模型轮次取 provider 请求数（`usage-audit` 增量），会话步数取 `step/start`；tokens 为 provider 上报的输入/输出合计；时长为交互开始到完成（浏览器页面启动单独计，平均 2.23 秒）；费用在有单价配置时才计算，本次未配置单价，故为 null。
- 超时：每 turn 180 秒；审批轮询间隔 150 ms。

## 任务集

| ID | 任务 | 能力 | Worker 工具 | durable 工具 |
| --- | --- | --- | --- | --- |
| t1-read-write | 读固定文件并写出一行 | 读取 + 写入 | `read` `write` | `read` `write` |
| t2-search | 先建索引文件，再检索标记 | 工作区检索 | `write` `grep` | 仅 `write`，无检索 |
| t3-write-edit | 创建文件后替换一个词 | 编辑 | `write` `edit` | 仅 `write`，无 `edit` |
| t4-multifile | 一轮写两个文件 | 写入 | `write` ×2 | `write` ×2 |
| t5-subagent | 委派一次子代理 | 子代理 | `subagent` | 无子代理 |
| t6-cross-turn | 两个用户 turn 内改值 | 跨 turn 修改 | `read` `write` | `read` `write` |
| t7-export | 产出 JSON 并导出 Session | 导出 | `write` + `session/export` | `write` + `session/export` |
| t8-approval | 写入前确认一次审批 | 审批 | `write` + approval | `write` + approval |
| t9-missing-recovery | 读缺失文件后恢复创建 | 工具报错恢复 | `read` `write` | `read` `write` |
| t10-summarize | 读两个文件并摘要 | 读取 | `read` ×2 | `read` ×2 |

durable 的三项缺口是基准刻意保留的：host 没有检索、编辑与子代理工具。失败因此记为 harness 能力缺口，而不是模型或工具错误。

## 结果

| 指标 | 浏览器 Worker | durable 服务端 host |
| --- | --- | --- |
| 成功率 | 10/10（100%） | 7/10（70%） |
| 失败归因（模型/工具/harness） | 0 / 0 / 0 | 0 / 0 / 3 |
| 平均模型轮次/任务 | 4.0（共 37） | 2.6（共 26） |
| 平均会话步数/任务 | 3.0 | 3.0 |
| 平均交互时长 | 10,619 ms | 13,038 ms |
| 输入 tokens | 81,307 | 9,440 |
| 输出 tokens | 4,003 | 4,183 |
| 合计 tokens | 85,310 | 13,623 |
| 费用 | 未配置单价，null | 未配置单价，null |
| 模式总时长（含启动） | 129,947 ms | 130,553 ms |
| 平均页面启动 | 2,228 ms | 不适用 |

逐任务结果：

| 任务 | Worker | durable | durable 说明 |
| --- | --- | --- | --- |
| t1-read-write | 通过（14.6 s） | 通过（8.1 s） | 1 次审批 |
| t2-search | 通过（10.3 s） | harness（40.4 s） | 无检索工具，调用先 write 后 read |
| t3-write-edit | 通过（18.4 s） | harness（11.6 s） | 无 `edit`，只有 `write` |
| t4-multifile | 通过（9.2 s） | 通过（5.7 s） | 2 次审批 |
| t5-subagent | 通过（5.8 s） | harness（23.8 s） | 未广告子代理，模型未发起调用 |
| t6-cross-turn | 通过（15.0 s） | 通过（11.6 s） | 2 次审批 |
| t7-export | 通过（11.2 s） | 通过（6.4 s） | 导出 2,479 字节 |
| t8-approval | 通过（7.2 s） | 通过（5.5 s） | 1 次审批 |
| t9-missing-recovery | 通过（8.3 s） | 通过（10.2 s） | 读错误后恢复 |
| t10-summarize | 通过（6.1 s） | 通过（7.0 s） | 无审批 |

Worker 的 `t7-export` 导出 27,325 字节，durable 为 2,479 字节：前者事件更多、工具结果更长，Session 体积随 Worker 工具面增长。

## 失败归因

- durable 的 3 个失败全部是 harness 能力缺口：`workspace-search`、`file-edit`、`subagent`。host 的模型调用、审批、写入与 Session 读回都正常，失败来自没有对应工具，不能算模型或工具错误。
- 两侧都没有模型失败（没有漏掉必需工具、标记错误或答非所问），也没有工具失败（所有实际发出的工具调用都返回成功，`t9` 的缺失读取是刻意制造的、随后恢复的错误）。
- 若把 durable 的 3 个失败按“模型不会用工具”记，就会误判；基准因此检查广告的工具面再分类。

## 解读

在两者都支持的 7 个共享任务上，Worker 与 durable 全部通过。durable 的差距是工具覆盖，不是模型可靠性或写入正确性。durable 写入、审批、跨 turn 修改、导出和错误恢复路径可用。

Worker 的 token 是 durable 的 6.3 倍（85,310 对 13,623），主要因为 37 次请求都携带完整的 Worker 系统提示与工具 schema，且多出一轮工具往返；durable 的 26 次请求只携带 `read`/`write`。这里只能比较 tokens，不能断言费用，因为未配置单价。

平均交互时长 Worker 10.6 秒、durable 13.0 秒。durable 的平均值被 40.4 秒的检索失败与 23.8 秒的子代理拒绝抬高；只看 7 个通过任务，durable 平均约 7.8 秒，Worker 为 10.6 秒。两种模式的测量都排除了浏览器页面启动（平均 2.23 秒）与服务端进程启动。

## 限制

- 每个任务只跑一次，10 个任务不足以给出统计显著性；模型存在非确定性。
- 只测 LongCat-2.5。MiniMax-M3 探测一次即返回 `UPSTREAM_LLM_RATE_LIMITED`（HTTP 503），0 次模型请求、0 tokens，因此未跑 MiniMax 全量任务集；证据见 `real-model-task-benchmark-minimax-probe.json`。
- Worker 与 durable 的系统提示与工具面不同，这是被测 harness 的真实差异，不是受控的提示对照。
- durable 的文件内容正确性由写入工具结果与 Workspace manifest 佐证；host 没有 turn 后独立读取内容的 HTTP 端点。Worker 通过测试通道重新读取文件内容。
- Worker fixture 位于 `/dsh/home/browser-validation`，durable fixture 由基准经 Workspace commit 写入 `/dsh/home/workspace/browser-validation`，文件内容相同，路径按模式替换。
- Worker 使用测试 roster `browser-benchmark`；生产 profile 的默认审批与工具面可能不同。

## 复现

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
  node docs/drafts/browser-native-dsh-poc/tests/real-model-task-benchmark.e2e.mjs
```

`DSH_POC_BENCH_PROVIDER=minimax` 切换端点，`DSH_POC_BENCH_MODES=browser` 或 `durable` 只跑一侧，`DSH_POC_BENCH_TASKS=t6-cross-turn,t8-approval` 只跑指定任务。结果写入 `real-model-task-benchmark-results.json`，每个任务完成后覆盖检查点，进程中断仍保留部分证据。设置 `DSH_POC_INPUT_PRICE_PER_MTOK` 与 `DSH_POC_OUTPUT_PRICE_PER_MTOK` 才会计算费用。
