---
description: "Browser-Native DSH v2 运行时验证命令、证据字段、人工检查和已知边界。"
---

# Browser-Native DSH 运行时验证说明

## Summary

本文是 `docs/drafts/browser-native-dsh-poc` v2 运行时验证的可复现实验手册。主线验证 DSH 是否能在真实 Dedicated Worker 中运行，而不是验证聊天气泡或 SaaS 业务编排。测试使用真实 DSH Web UI、真实 Worker Host、真实 `ctx.agentLoop`、同源 LLM proxy 和本地 Session backend；脚本模型用于协议和生命周期回归，真实模型用于工具、流式输出、窗口记忆和刷新恢复。

SaaS 联动不属于本手册的验收条件。Worker VFS、Session JSON 和用户本机文件系统是三种不同资源：Session 可以通过 backend flush 恢复，Worker VFS 文件在刷新后按本轮实测会消失。

本轮后续自动化只使用真实 Chrome；Safari.app 和 Playwright WebKit 的旧结果只作历史对照，暂停继续测试。

## Table of Contents

- [前置条件](#前置条件)
- [运行脚本](#运行脚本)
- [真实 Chrome 长回复流式 UI](#真实-chrome-长回复流式-ui)
- [浏览器存储能力](#浏览器存储能力)
- [人工验收](#人工验收)
- [证据解释](#证据解释)
- [当前结果](#当前结果)
- [已知边界](#已知边界)

## 前置条件

在仓库根目录执行。真实模型测试读取 `docs/drafts/.env`，该文件不能提交；API key 只由 Node backend 读取。外网不可达时，在同一 shell 设置本机代理，并让 Node 使用环境代理：

```sh
export https_proxy=http://127.0.0.1:9981
export http_proxy=http://127.0.0.1:9981
export all_proxy=socks5://127.0.0.1:9981
```

先构建真实 preview，并确认依赖可解析：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_PLAYWRIGHT_MODULE="$(node --input-type=module -e 'process.stdout.write(import.meta.resolve("playwright"))')"
```

## 运行脚本

### Chrome scripted 回归

```sh
DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

该测试断言 Browser-specific profile 的工具 roster、检查 scripted assistant DOM 多次更新，并确认 LLM 请求来自同源 backend。脚本模型每 120 毫秒发送一个文本块，使浏览器 UI 的可见更新可以被动画帧采样；这是测试节奏，不代表真实模型延迟。连续刷新可用 `DSH_POC_REFRESH_CYCLES=5`；刷新后只等待当前页面，不重复导航。Chrome 上两次刷新回归采到 8 次递增 DOM 更新，Session 文本块跨度约 966 毫秒。

### Chrome 真实模型工具与刷新

```sh
export DSH_POC_LLM=real
export DSH_POC_BROWSER=chrome
export DSH_POC_ROSTER=browser
export DSH_POC_ENV_FILE=docs/drafts/.env
export DSH_POC_LLM_TIMEOUT_MS=180000
export DSH_POC_TURN_TIMEOUT_MS=600000
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实用例要求 Agent 读取 VFS fixture，写入含随机 token 的文件，再读回；刷新页面后要求模型从 Session 记忆中回忆 token，并再次读取文件确认 Worker VFS 文件是否存在。通过条件同时检查工具事件的名称、参数、`callId` 对应的结果、Session durable sequence、流式事件、同源 LLM 请求和 secret redaction。多工具真实 turn 可能连续触发多次模型请求；`DSH_POC_TURN_TIMEOUT_MS` 是整轮等待预算，设为 600 秒，避免把尚在运行的后续模型步骤误判为 Agent Loop 失败。

真实模型 Stop/恢复单独运行：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs
```

脚本先提交一条要求长输出的真实模型消息，确认 Stop 按钮在同源 LLM 请求进行中可用并点击它；随后等待同一 Session 的 `turn/end` 为 `aborted`，再发送恢复消息。通过条件是恢复 turn 为 `completed`、durable JSON 已包含恢复 assistant marker、浏览器无 page error，且 provider secret 不在浏览器网络记录中。先前一次恢复请求收到无文本、无工具调用的 provider 完成信号，曾被 backend 记成空 assistant 成功；现在 backend 将此情况返回为 `UPSTREAM_LLM_EMPTY`，脚本只对该错误追加一次用户重试。一次测试只证明闭环，不代表取消延迟、吞吐或稳定性分布。

### 真实 Chrome 长回复流式 UI

本轮只继续测试 Chrome；Safari 长回复测试按用户要求暂停：

```sh
DSH_POC_LLM=real \
DSH_POC_BROWSER=chrome \
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_EVIDENCE_DIR=/tmp/dsh-browser-native-streaming-evidence-20261021 \
node --use-env-proxy \
  docs/drafts/browser-native-dsh-poc/tests/runtime-streaming.e2e.mjs
```

脚本通过 Playwright `channel: "chrome"` 启动已安装的 Chrome（headless），连接真实模型和真实 DSH Worker；在长回复期间记录递增 DOM 文本、输入草稿交互、Stop 状态、滚动位置与 long-task。2026 年 10 月 21 日使用 `gpt-5.6-sol` 的运行生成 9,523 个字符并记录 84 帧增长样本，采样跨度约 15.8 秒；输入草稿交互约 20 毫秒，滚动位置可变，未观察到 long task 或 page error，两个模型请求均为 HTTP 200，turn 以 `completed` 结束。截图与脱敏摘要留存在 `/tmp/dsh-browser-native-streaming-evidence-20261021/`。该单次结果证明这条 Chrome 路径逐步呈现且在探针期间可交互，不构成设备性能分布或 SLA。

### 浏览器存储能力

```sh
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/browser-storage-boundary.e2e.mjs
```

该实验只探测 `navigator.storage.estimate()`、持久化状态和 OPFS 临时文件往返，不把 OPFS 当作 DSH VFS 或 Session durability。Chrome 能完成 OPFS 往返；Playwright WebKit 旧记录中的 OPFS 读写返回 `UnknownError`。当前仅继续 Chrome，WebKit 结果不作为本轮复测项。

### 生命周期与失败恢复

```sh
DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/runtime-lifecycle.e2e.mjs
```

该测试使用 scripted LLM，覆盖刷新后继续、真实 UI Stop、写权冲突、一次注入的模型错误后继续、backend 重启后的 durable Session、强制终止 Worker 后 lease 回收和重新 claim。`turn/end` 的 `completed`、`aborted` 和 `error` 分别保留，不把所有情况压成一个成功标志。

### 后端与浏览器兼容性

```sh
node --test \
  docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/symbol-dispose.test.ts
```

该命令覆盖随机端口、Session sequence、owner fencing、lease reclaim、flush/restart、LLM stream、非法请求和 provider secret 不出现在响应中；`symbol-dispose.test.ts` 覆盖 WebKit 所需的幂等 symbol shim。

## 人工验收

1. 执行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`，再用 `run-v2.mjs --llm real --env-file docs/drafts/.env` 启动 backend，打开输出的 `preview.html?browser-native=1&preview-fixture=none`。
2. 发送“请读取 `/dsh/home/` 下的 fixture，并说明你实际拥有的工具；不要声称拥有 bash、web search 或 web fetch”。在 Session 事件或 backend 请求中确认工具清单与 Browser-specific overlay 一致。
3. 发送一个要求读取、写入、再次读取 VFS 文件的任务，观察工具卡、assistant 流式文本和最终 `turn/end`；不要只看最终气泡。
4. 在同一 Session 发送“记住刚才写入的随机 token，并只回复 token”，确认窗口记忆来自同一 Session。
5. 刷新同一页面并继续发送消息，确认历史和 token 仍可见；再要求重新读取刚才写入的文件，接受本轮实测的 `not found`，因为 Worker VFS 不是持久文件系统。
6. 点击 Stop，检查最新 `turn/end` 为 `aborted`；随后发送普通消息，检查 Session 可以继续。
7. 打开第二个标签页尝试写入同一 Session，确认返回 `SESSION_ALREADY_OWNED`；关闭原页面或等待 lease 过期后再重新 claim。
8. 关闭 backend、重启 backend，再打开同一 Session，确认只有已 flush 的 Session 事件恢复；不要期待 in-flight 模型流或 Worker 内存文件恢复。

## 证据解释

结果中的 `toolNames` 是模型请求实际收到的 schema 名称；`vfsToolSequence` 是 Session 中实际记录的 tool call 顺序；`durableThroughSeq` 是 backend 已写入 JSON 文件的事件前缀；`pageErrors` 是页面级未处理错误；`httpErrors` 中的 `/open-in-app/apps`、`/plugins/events`、`/api/changes.summary` 和 `/api/present.host` 404 是 preview 附属路由缺口，不等同于 Agent Loop 失败。

真实模型输出不能单独证明工具执行成功。必须同时检查 `tool/call`、对应 `tool/result`、`assistant/message`、`turn/end` 和 durable Session 文件。请求中没有 provider secret，且 `/api/browser-native/llm` 是唯一的模型网络出口，才算通过安全检查。

## 当前结果

2026 年 10 月 21 日的既有 Chrome/WebKit 对照已记录 Browser-specific VFS `read → write → read`、三轮记忆、刷新恢复与生命周期结果；之后按用户要求暂停 Safari/WebKit 新测试，只继续 Chrome。最新 Chrome Browser-specific 真实模型 run 完成三轮，执行 `read → write → read`，刷新后从 Session 回忆 token，并确认 Worker VFS 文件已不存在；Session 有 57 个事件、`durableThroughSeq=56`，8 个模型请求均为 HTTP 200。基础 Browser-Native E2E 另完成三轮、恰好一次 `todo_write`，Session 有 40 个事件、`durableThroughSeq=39`。Chrome scripted 生命周期覆盖刷新、停止、错误恢复、backend 重启、Worker terminate 和双标签写权冲突；真实 Stop/恢复最近一次 `turn/end` 为 `aborted → completed`，durable JSON 完整，page error 为空。

真实 Chrome 长回复实验生成 9,523 个字符，记录 84 帧增长样本和约 15.8 秒可见增长跨度；输入草稿交互约 20 毫秒、滚动位置可变、没有 long task 或 page error。流式证据截图和摘要位于 `/tmp/dsh-browser-native-streaming-evidence-20261021/`。此前一次多工具 run 在 240 秒总预算时仍处于第四个模型步骤，Session 已记录三次成功 VFS 工具调用且无 `turn/end`；将整轮测试预算增加到 600 秒后，重跑成功。该超时记录是测试预算不足，不是 DSH turn 失败。

真实 Stop/恢复曾观察到 provider 返回无文本且无工具调用的 `finish_reason=stop`；旧 backend 将其转换成空 assistant message 和 `completed`，导致恢复 marker 缺失。backend 现在把此上游响应归为 `UPSTREAM_LLM_EMPTY`，contract test 断言其被报告为错误；后续 Chrome 真实 Stop/恢复成功得到 marker。修复后真实测试没有再次触发空响应分支，因此该分支的端到端重试由脚本保留，尚未用真实 provider 强制复现。

Safari 26.6.2 真实 WebDriver 的旧记录完成工作区选择、真实 LLM 三轮记忆对话和刷新后继续；包含三个工具步骤的长 prompt 在 WebDriver `element/value` 上出现超过 60 秒的超时且没有生成 `user/message`，因此 Safari.app 的工具闭环仍未验证。早期 WebKit 503 与测试每轮重复导航同时出现；修正测试后既有刷新未复现。仍有取消中的辅助请求和 preview 附属 404，详见报告。

按当前工作安排，Safari 后续自动化与人工验收暂停；继续推进的运行时验证先使用 Chrome。Playwright WebKit 和 Safari.app 的已有观察保留为历史对照，不能互相替代。

## 已知边界

- Worker 不是页面关闭后继续运行的后台 Agent；in-flight 模型流、工具 Promise 和页面函数不能由 Session 日志自动迁移。
- 当前 backend 是本地 JSON PoC，owner lease 只在 backend 进程内有效；没有通用 requestId 去重、结果重放、跨进程 owner epoch、复制、备份或 HA。
- `append` 只表示当前 backend 接受事件；`flush`/`close` 才建立本地 durability receipt；未 flush 的尾部可能在重启后丢失。
- Browser-specific profile 是 docs-local overlay，不是默认 Browser-Native profile；原始 roster 仍可能暴露不适用的主机工具。
- Safari.app 工具输入、Safari 长回复流式表现、跨设备恢复、真实多租户授权、生产级配额治理和性能分布仍未验证；Chrome 长回复单次观测未发现 long task，不构成性能分布或 SLA；OPFS 仅完成能力探测，不能视为 DSH 持久化方案。
- preview 附属路由仍有 404；本轮不把它们扩展成 Browser-Native 主线功能。
