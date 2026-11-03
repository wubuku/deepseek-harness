---
description: "记录真实模型自主调用 subagent 后在父 Session 停止时的取消传播、结算与恢复证据。"
---

# 真实模型自主委托与父停止取消传播验证

## Summary

本验证回答组合问题：当模型不是被 scripted 强制，而是由真实 LLM 自行决定调用 `subagent` 时，用户停止父 Session 是否仍然递归取消子 Agent、是否只结算一次、是否留下继续执行的子 turn 或模型请求。结论是肯定的：真实模型自主发起委托后，父子两条模型流同时进行时对父 Session 执行 `Agent.cancel(user)`，父 turn 结算为 `aborted/user`，子 turn 结算为 `aborted/parent`；之后没有新的模型请求、没有第二个 turn、没有第二个 Session；子 Agent 的结算通知进入父 Agent inbox，并在下一次用户 prompt 之前回放；恢复后的 turn 正常完成。

## 环境与凭据

| 项 | 值 |
|---|---|
| 浏览器 | Chrome `156.0.8078.79`（Playwright `channel: chrome`） |
| Roster | `browser-subagent`（`tool-subagent`，`provider: spawn`，`maxDepth: 1`） |
| 模型 | `LongCat-2.5`（真实托管模型，OpenAI-compatible） |
| 上游 | `docs/drafts/.env` 中的第二组 OpenAI-compatible 端点 |
| 主 GPT 组 | 已耗尽配额：直接请求返回 `403 用户 [4912] 配额不足`，本批不可用 |

凭据只由测试进程从 `docs/drafts/.env` 读入内存并传给 PoC backend；不打印、不复制、不落盘，也不进入 Session 或请求日志。

主 GPT 组配额不足是外部环境限制，不是代码失败。为继续完成组合验证，本测试使用 `.env` 中另一组真实模型端点；`backend-v2.mjs` 新增显式 `llmBaseUrl` / `llmCompletionsPath` / `llmApiKey` / `model` 覆盖，仅在 real 模式下生效，默认行为仍读取 `OPENAI_NEXT_GPT_*`。该路径已用真实模型跑通，符合“改到 LLM 相关代码必须真实冒烟”的要求。

## 测试与判定

测试：[tests/real-subagent-cancel.e2e.mjs](tests/real-subagent-cancel.e2e.mjs)。

```sh
DSH_POC_LLM=real DSH_POC_LLM_ALT=1 DSH_POC_LLM_TIMEOUT_MS=240000 \
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
node docs/drafts/browser-native-dsh-poc/tests/real-subagent-cancel.e2e.mjs
```

驱动方式只有 prompt：父 prompt 要求模型“用 subagent 工具一次、原样传入子 prompt，随后写一篇 700 词文章”，子 prompt 要求写一篇 800 词文章且不使用工具。没有 scripted 分支、没有强制工具选择。测试等待：

1. 父 Session 出现真实 `tool/call subagent` 且工具结果包含 `started subagent <childId>`；
2. 子 Session 出现 `turn/start`；
3. 父、子各至少一条模型请求同时处于 open 状态（`openStreamsAtStop: {parentOpen: 1, childOpen: 1}`）；
4. 此时调用 Worker 测试通道的 `cancel-session`，即公开的 `Agent.cancel()` 用户停止路径。

输出摘要：

```json
{"result":"passed","browser":"156.0.8078.79","model":"LongCat-2.5",
 "scope":"real-model-autonomous-delegation-then-parent-stop","verdict":"supported",
 "delegatedWithoutScriptedModel":true,"childSessionId":"3a71e0c6-3eba-4322-bf2d-ee7897af63e0",
 "openStreamsAtStop":{"parentOpen":1,"childOpen":1},
 "parentTurnEnd":{"kind":"aborted","reason":{"kind":"user"}},
 "childTurnEnd":{"kind":"aborted","reason":{"kind":"parent"}},
 "settlementNoticeQueued":1,"settlementNoticeReplayedBeforeResume":true,
 "modelRequestsAtStop":3,"modelRequestsAfterResume":4,"sessionCreates":2,
 "pageErrors":[],"workerErrors":[],"externalRequests":[]}
```

判定项：

- `delegatedWithoutScriptedModel=true`：委托来自真实模型对 prompt 的自主选择。
- `parentTurnEnd` / `childTurnEnd`：父停止沿 ancestry 传播，子记录 `parent` 原因。
- `modelRequestsAtStop=3`（父 2 次 + 子 1 次），停止后等待 2 秒仍为 3：没有续跑请求。
- `sessionCreates=2`：停止与恢复都没有创建第三个 Session。
- `settlementNoticeQueued=1` 且在恢复 prompt 之前回放：已停止的 turn 不被通知唤醒，但下一次用户输入能看到子 Agent 结果。
- 恢复 turn 产生唯一新增请求（3→4）并返回 marker；页面、Worker、跨源错误均为 0。

## 语义决策

1. **委托方式不影响取消语义。** 无论子 Agent 来自 scripted 还是真实模型选择，用户停止顶层 Session 都递归取消活动后代。
2. **取消只结算一次。** 父 `aborted/user`、子 `aborted/parent` 各一条 `turn/end`；不重放被切段的模型流。
3. **子 Session 保留可继续。** 取消不删除子 Session；其结算通知只进入父 inbox，不唤醒已停止的 turn，下一次用户 prompt 前回放。
4. **Provider 覆盖是显式选项。** PoC backend 的入口、路径和密钥只能通过显式参数覆盖；默认仍读取原 `OPENAI_NEXT_GPT_*`，不改变既有部署行为。

## 限制与未覆盖

- 本批真实模型是 `LongCat-2.5`；主 GPT 组因配额不足未参与，因此不能把结论外推为“所有真实模型都同样选择委托或同样延迟”。
- 单次样本；模型自主性不可复现为固定工具选择，测试以“是否出现真实 `subagent` tool/call”为门槛，失败时会输出 turn 事件类型与上游错误。
- 取消发生在两条模型流式输出期间；未在本测试中覆盖子 Agent 正在执行真实 `bash` 时的切断（该场景的父 Session 版本见 [real-stop-during-tool](tests/real-stop-during-tool.e2e.mjs)，子 Agent 版本仍未验证）。
- 未覆盖跨标签 Stop、进程外/SSH subagent provider、页面关闭、浏览器崩溃或 OS 挂起与真实委托的组合。
- 上游模型超时默认 60 秒；该真实模型在长 prompt 下会超过默认值，必须显式提高 `DSH_POC_LLM_TIMEOUT_MS`，这不改变产品超时语义。
