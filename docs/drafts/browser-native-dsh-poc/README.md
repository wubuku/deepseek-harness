---
description: "Browser-native DSH PoC 的 v2 规划和历史协议实验：保留 DSH Web UI、真实 Host/Agent Loop，并通过同源 Session backend 和 LLM proxy 接入浏览器 Worker。"
---

# Browser-native DSH PoC

## Summary

本目录包含两个阶段的研究材料。旧版是协议级独立 loop 实验；当前目标是 v2：保留现有 DSH Web UI、Cordis 插件组合和真实 `ctx.agentLoop`，只把 Host 运行到 Dedicated Worker，并通过同源 backend 提供正式 Session persistence 和 LLM proxy。实施入口是 [browser-native-dsh-plan-v2.md](browser-native-dsh-plan-v2.md)，进度入口是 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)。v2 尚未完成可运行入口；在 v2 实现文件出现并通过浏览器验收前，不能把本 README 下面的旧 `run.mjs` 命令当作 v2 启动方式。

旧实现验证了 Browser-native transport、Session durability、owner fencing、真实后端 LLM streaming、Tool bridge 和 Worker resume，但 Worker 使用目录内的 PoC-local loop adapter；它**没有**宣称现有 DSH `ctx.agentLoop` 已经在浏览器 Worker 中运行。旧版 [implementation-plan.md](implementation-plan.md)、[progress.md](progress.md) 和独立 HTML/loop 文件只用于追溯该协议实验，不能作为 v2 完成证明。

## v2 当前状态

v2 的目标入口必须使用现有 `AppWebEntry`、现有 DSH Web UI 和由 Worker 承载的真实 Host，具体启动命令要在 Phase 1 实现后根据实际 preview/custom Worker 接线补入。当前不要通过旧 `run.mjs`、`public/index.html` 或旧版浏览器测试宣称 v2 已经运行；这些文件属于下方标明的历史协议实验。

## 历史协议实验：运行

以下命令只运行旧版独立 HTML、PoC-local loop 和自定义事件协议，用于复现历史 transport/backend 实验，不是 v2 的启动或验收步骤。

在仓库根目录执行：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs --port 4175 --data-dir /tmp/dsh-browser-native-poc
```

上面的命令启动确定性的 scripted model。要启动真实后端 LLM 代理，使用只存在于本机的 `.env` 文件：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs \
  --port 4175 \
  --data-dir /tmp/dsh-browser-native-poc-real \
  --llm real \
  --env-file /path/to/deepseek-harness/docs/drafts/.env
```

`--env-file` 只由 Node backend 读取。API key 不会发送给浏览器、Dedicated Worker、Session event、页面状态或日志；页面只看到 `real` mode、provider 和 model 名称。real mode 的 GPT 默认使用配置文件中的 `OPENAI_NEXT_GPT_MODEL`，并把 `reasoning_effort` 默认设为 `low`；Grok 可以通过对应的环境变量和 model 选择使用。

然后打开 `http://127.0.0.1:4175/`，点击 `Start Worker`。预期流程是：

```text
opening-session
→ model-request-1
→ browser tool: browser_echo
→ model-request-2
→ completed
```

点击 `Close Worker` 验证 graceful close；它会先 flush 并释放 owner。点击 `Terminate Worker` 则模拟没有执行 `close` 的 Worker crash；等待约 15 秒让 owner lease 过期后，再点击 `Resume Session`。页面应从 backend 读取已 flush 的 Session events，并显示 `resumed-from-flushed-session`。强制 terminate 不能当作 graceful shutdown。

## 历史协议实验：测试

后端 contract tests 不需要安装新增依赖：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs
```

浏览器测试需要仓库现有 Playwright 依赖；当前独立 worktree 不复制 `node_modules`。运行时可从拥有依赖的仓库 checkout 提供模块路径：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
  node docs/drafts/browser-native-dsh-poc/tests/browser.e2e.mjs
```

真实 provider 的浏览器端到端测试必须显式提供本机 `.env` 和 Playwright：

```sh
DSH_POC_ENV_FILE=/path/to/deepseek-harness/docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/playwright@<version>/node_modules/playwright/index.mjs \
  node --test --test-timeout=360000 docs/drafts/browser-native-dsh-poc/tests/browser.real.e2e.mjs
```

该测试使用真实 Chromium、真实 backend、真实上游模型请求和真实 Session 持久化；它不 mock LLM response。测试输出只报告 mode、provider、model、event types 和 durable sequence，不打印凭据或完整 prompt。

## Scope

backend 使用目录内的 JSON 文件作为 PoC durability store。`append` 后事件对当前 backend 可见；`flush` 通过临时文件加原子 rename 写入 durable file；backend 重启只读取已 flush 事件。owner token 和 lease 只在 backend 进程内有效，重启后由新 Worker 重新 `open('write')`。scripted mode 固定返回一次 `browser_echo` call 和一次 final response；real mode 将同一组受限消息转换为 OpenAI-compatible tool call，解析上游 SSE，再转换为浏览器协议的 NDJSON。

本目录没有加入根级 npm script、package manifest、Web profile、Desktop profile 或正式 DSH package。旧版命令和测试不证明 v2 的 DSH Host、正式 Session provider 或真实 `ctx.agentLoop`。若后续证明必须修改目录外代码，先按 [change-ledger.md](change-ledger.md) 登记原因、扩展点、测试和 upstream 重放步骤。

## Dev Note

这是可运行的 PoC，不是正式产品入口。实现事实、已运行命令和限制必须同步写入 [progress.md](progress.md)；不要把目录内 loop adapter 的通过结果写成 DSH 核心 Agent Loop 已完成浏览器化。
