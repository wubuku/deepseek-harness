---
description: "运行目录内 Browser-native DSH PoC 的协议级实现，验证同源 Session backend、LLM proxy、Dedicated Worker loop 和 Main Thread Tool bridge。"
---

# Browser-native DSH PoC

## Summary

本目录包含一个不修改 DSH 核心代码的协议级 PoC。页面启动 Dedicated Worker，Worker 运行目录内的 Agent-loop adapter；同源 Node backend 提供 Session 状态存储和 scripted LLM proxy；页面 Main Thread 只执行 allowlisted `browser_echo` Tool。所有代码和运行数据约束都在本目录内，实施决策见 [implementation-plan.md](implementation-plan.md)，wire 语义见 [protocol.md](protocol.md)，进度和当前限制见 [progress.md](progress.md)。

当前实现验证的是 Browser-native transport、Session durability、owner fencing、LLM streaming、Tool bridge 和 Worker resume。Worker 使用目录内的 PoC-local loop adapter；它**没有**宣称现有 DSH `ctx.agentLoop` 已经在浏览器 Worker 中运行。真实 DSH Agent Loop 接入仍是后续独立评估项。

## Run

在仓库根目录执行：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs --port 4175 --data-dir /tmp/dsh-browser-native-poc
```

然后打开 `http://127.0.0.1:4175/`，点击 `Start Worker`。预期流程是：

```text
opening-session
→ model-request-1
→ browser tool: browser_echo
→ model-request-2
→ completed
```

点击 `Close Worker` 验证 graceful close；它会先 flush 并释放 owner。点击 `Terminate Worker` 则模拟没有执行 `close` 的 Worker crash；等待约 15 秒让 owner lease 过期后，再点击 `Resume Session`。页面应从 backend 读取已 flush 的 Session events，并显示 `resumed-from-flushed-session`。强制 terminate 不能当作 graceful shutdown。

## Tests

后端 contract tests 不需要安装新增依赖：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs
```

浏览器测试需要仓库现有 Playwright 依赖；当前独立 worktree 不复制 `node_modules`。运行时可从拥有依赖的仓库 checkout 提供模块路径：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
  node docs/drafts/browser-native-dsh-poc/tests/browser.e2e.mjs
```

## Scope

backend 使用目录内的 JSON 文件作为 PoC durability store。`append` 后事件对当前 backend 可见；`flush` 通过临时文件加原子 rename 写入 durable file；backend 重启只读取已 flush 事件。owner token 和 lease 只在 backend 进程内有效，重启后由新 Worker 重新 `open('write')`。scripted LLM 固定返回一次 `browser_echo` call 和一次 final response。

本目录没有加入根级 npm script、package manifest、Web profile、Desktop profile 或正式 DSH package。若后续证明必须修改目录外代码，先按 [change-ledger.md](change-ledger.md) 登记原因、扩展点、测试和 upstream 重放步骤。

## Dev Note

这是可运行的 PoC，不是正式产品入口。实现事实、已运行命令和限制必须同步写入 [progress.md](progress.md)；不要把目录内 loop adapter 的通过结果写成 DSH 核心 Agent Loop 已完成浏览器化。
