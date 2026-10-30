---
description: "记录 Browser-Native DSH 运行中输入、取消保留、Session route 恢复和 fork 分支连续性验证的实际证据与限制。"
---

# Browser-Native DSH Session 连续性验证进度

## 当前状态

状态：M0-M4 完成。Chrome 156 的 scripted E2E 通过运行中追加输入、`keepInbox` 取消保留、Worker 内恢复历史 model route、闭合 turn fork 和运行中 text open-tail fork。真实 LLM 只完成普通文件与刷新 smoke，不把 scripted probe 写成真实模型自主排队、route 选择或 fork 能力。

## 实际证据

| 验证面 | 结果 |
| --- | --- |
| busy Agent 追加 next-turn | A 的第一轮由 backend barrier 保持在途；第二条输入进入 durable inbox，第一轮释放后只产生一次 A queued 模型请求，并在 Session 中只出现一次。 |
| `cancel({ keepInbox: true })` | B 在首轮请求保持在途时追加 queued 输入；取消终态记录为 `aborted`，queued message 保留；显式 wake 后 queued 与 wake 各运行一次，没有在取消期间产生 queued 模型请求。 |
| Worker resume route | A 首轮使用 `browser-native-route-a`；释放旧 Agent 后通过正式 `ctx.agents.resume()` 恢复，下一次请求仍使用 `browser-native-route-a`，没有回退到页面默认 route。 |
| closed-turn fork | A 的 child 使用正式 `buildForkSeed` 与 `ctx.agents.create()`；parent event 数保持 37，child header 含 `parentSession=continuity-a`、`isSeeded=true`，child 独立完成 follow-up。 |
| open text-tail fork | `continuity-open` 在模型请求保持在途时创建 child；child 记录 forked closer，继承 prompt 不触发 child 模型请求；释放 parent 后 parent 正常完成，child 随后可继续。open tool unknown 分支未在本批验证。 |

## Chrome E2E

运行命令：

```sh
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/browser-native-session-continuity.e2e.mjs
```

Chrome `156.0.8078.79` 通过，输出 9 个模型请求、parent event count 37、closed child event count 47、open child event count 28；页面错误、Worker 错误和跨源请求均为 0。请求列表确认没有重复执行 queued prompt，也没有向 open child 重发继承的 open-tail prompt。

## 真实 LLM smoke

运行命令：

```sh
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实 `gpt-5.6-sol` 通过普通 `read → write → read`、刷新和同 Session 续接：Chrome 156、57 个 Session events、`durableThroughSeq=56`、8/8 模型请求 HTTP 200、刷新后按当前非 durable 配置文件缺失。浏览器请求保持同源，未发现模型密钥；输出仍有既有 preview API 404、刷新期间 `ERR_ABORTED` 和 compaction context-capacity warning，因此不是零告警证明。

## 检查记录

已运行并通过：`pnpm exec tsc -b tsconfig.client.json --pretty false`、`pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-multi-agent-probe.spec.ts`（5/5）、preview build、`node --check docs/drafts/browser-native-dsh-poc/tests/browser-native-session-continuity.e2e.mjs` 和 `git diff --check`。多-Agent probe 单测覆盖正式 Agent registry 的相邻实现；Session continuity 的主要证据来自上述真实 Worker E2E。

## 限制与后续

本批没有验证 open tool 在 fork cut 上的 `TOOL_OUTCOME_UNKNOWN` 修复，也没有验证 Workspace bytes 的 fork snapshot/branch merge、页面关闭后的后台执行、跨设备恢复、生产多实例 backend、自然 eviction、OS/磁盘崩溃、Safari 或真实模型自主 fork/排队。`ctx.agents.resume()` 的 route 恢复只证明 route 已写入 Session request header；全局 model preference、provider catalog 和配额策略仍未验证。
