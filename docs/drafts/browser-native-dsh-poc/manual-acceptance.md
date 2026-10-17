---
description: "Browser-Native DSH v2 及 assistant-ui 增量 PoC 的真实浏览器手动验收说明、故障排查和开发经验。"
---

# Browser-Native DSH PoC 手动验收说明

## Summary

本文是两个当前 PoC 的共同手动验收入口：原生 DSH Web UI 的 Browser-Native v2 PoC，以及 assistant-ui 作为聊天层的增量 PoC。

两个入口复用同一个 Browser-Native DSH Worker、profile overlay、真实 `ctx.agentLoop`、Session backend 和 real LLM proxy；验收时应分别打开两个入口，但不要让两个标签页同时写同一个 Session。

本文只证明本地 PoC 的可运行闭环，不证明生产级高可用、多租户授权、跨进程 owner fencing、长期任务 handoff 或业务 UI capability 已经完成。

## Table of Contents

- [一、准备和启动](#一准备和启动)
- [二、两个访问入口](#二两个访问入口)
- [三、核心手动验收](#三核心手动验收)
- [四、两套 UI 的对照观察](#四两套-ui-的对照观察)
- [五、Session 和后端证据](#五session-和后端证据)
- [六、故障排查](#六故障排查)
- [七、开发过程中的经验](#七开发过程中的经验)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

## 一、准备和启动

在仓库根目录确认已经安装依赖，并生成 `apps/web/dist/preview/vfs-image.tar.gz`。

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run build
```

使用 scripted provider 进行无费用验收：

```sh
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4197 \
  --data-dir /tmp/dsh-browser-native-manual-acceptance \
  --llm scripted
```

使用真实 LLM 进行完整验收；API key 只由 backend 读取 `docs/drafts/.env`，不要打印、提交或复制这个文件的内容：

```sh
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4197 \
  --data-dir /tmp/dsh-browser-native-manual-acceptance-real \
  --llm real \
  --env-file docs/drafts/.env
```

如果本机上游请求需要代理，给 Node backend 设置 HTTP(S) 代理，并让 loopback 请求绕过代理：

```sh
export https_proxy=http://127.0.0.1:9981
export http_proxy=http://127.0.0.1:9981
export all_proxy=socks5://127.0.0.1:9981
export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost
```

启动后先检查 `GET /api/browser-native/health` 返回 `ok: true`、`llmMode` 和预期 model；浏览器只应访问同源的 Browser-Native route，不应看到 provider API key。

## 二、两个访问入口

原生 DSH Web UI：

`http://127.0.0.1:4197/preview.html?browser-native=1&preview-fixture=none`

assistant-ui 增量 PoC：

`http://127.0.0.1:4197/assistant-ui-poc/index.html`

原生 Web UI 首次进入可能要求选择 workspace，使用 `/dsh/home/`；assistant-ui PoC 使用固定的 `/dsh/home/`，不会挂载原生 DSH Web UI 的 workspace 导航。

每个入口首次打开都会创建或恢复一个 Session，并把 `sessionId` 写入 URL 或当前标签页的 `sessionStorage`。对照两个 UI 时，分别使用新 Session；不要把同一个 `sessionId` 同时交给两个写标签页。

如果标签页恢复了旧 Session，点击 assistant-ui 的 `New Session`，或关闭旧标签页后在新的无痕窗口打开入口，避免旧 owner lease 造成干扰。

## 三、核心手动验收

下面的消息顺序用于验证工具调用、窗口记忆、流式输出和刷新续接。第一条中的 token 应替换为当前验收唯一值，例如 `MANUAL_DSH_MEMORY_7F31`。

### 3.1 工具调用和首轮回复

```text
Use the todo_write tool to add exactly one pending task titled "Browser-native tool-call E2E proof". Remember this exact token for my next message: MANUAL_DSH_MEMORY_7F31. After the tool succeeds, reply with exactly this marker: ASSISTANT_UI_BROWSER_NATIVE_E2E_OK
```

确认用户消息保留在窗口中，模型先产生工具调用，工具结果显示成功，随后出现最终 assistant 回复 `ASSISTANT_UI_BROWSER_NATIVE_E2E_OK`。

assistant-ui 页面应显示 assistant-ui tool card；原生 DSH Web UI 应显示现有 DSH tool presentation。两者显示样式可以不同，但后端 Session 都应记录工具调用、工具结果和完成的 turn。

### 3.2 窗口记忆

```text
What exact token did I ask you to remember? Reply with only the token, no quotes or explanation.
```

预期回复为 `MANUAL_DSH_MEMORY_7F31`，且页面仍保留第一轮的任务标题和对话历史。

### 3.3 相关多轮上下文

```text
Reply with exactly three lines: MANUAL_DSH_FOLLOWUP_OK, the remembered token MANUAL_DSH_MEMORY_7F31, and the earlier task title Browser-native tool-call E2E proof. Do not add anything else.
```

确认回复包含三行：`MANUAL_DSH_FOLLOWUP_OK`、记忆 token 和任务标题；不要把一次能回答问题误认为已经验证了多轮窗口记忆，必须验证第二、第三轮都来自同一个 Session。

### 3.4 流式输出和刷新续接

发送任意较长但无工具要求的消息，观察 assistant 文本是否先出现部分内容，再逐步增长，最后形成完整的 assistant message。

刷新页面后确认历史仍在、URL 中的 `sessionId` 不变，然后发送：

```text
Reply with exactly this marker: MANUAL_DSH_REFRESH_CONTINUATION_OK
```

确认刷新后的同一个 Session 可以继续生成新回复；不要只检查页面历史，还要确认新消息对应新的 `turn/end` 和持久化事件。

## 四、两套 UI 的对照观察

两套 UI 的执行内核应一致：相同的 DSH Agent Loop、LLM provider、工具生命周期、Session 事件和窗口记忆。

两套 UI 的可见层不要求像素级一致：原生 UI 使用 DSH 自己的聊天和工具组件，assistant-ui 使用 `DshSessionAdapter` 将 DSH Session 投影为 assistant-ui message parts。

如果一个页面无回复，先读取对应 Session，而不要只根据页面判断执行是否成功：Session 已有 `assistant/message` 而页面没有显示，优先怀疑 UI projection；Session 没有完成的 `turn/end`，优先检查 Agent Loop、LLM、工具或 owner 状态。

## 五、Session 和后端证据

从页面 URL 取出 `sessionId`，在启动命令的 `--data-dir` 下打开 `sessions/<sessionId>.json`，至少确认下列事件存在且顺序合理：`user/message`、`assistant/attempt`、`tool/result`、`assistant/message`、`turn/end`；使用工具的首轮还应有对应工具的持久化事件，例如 `todo/write`。

每个持久化事件的 `seq` 应连续，`durableThroughSeq` 应覆盖最后一个已验收事件；真实 provider 的 API key 不应出现在 Session JSON、浏览器请求或页面错误中。

测试成功的必要条件不是“发送按钮接受了输入”，而是同一 Session 中出现最终 assistant message 和完成或明确失败的 `turn/end`；`Session.prompt()` 被接受只表示输入进入 DSH，不表示模型已经完成。

## 六、故障排查

### Session 已被其他 writer 占用

关闭仍打开该 Session 的其他标签页；如果无法确定 owner，等待默认 30 秒 lease 到期后重新连接。不要同时在两个标签页发送消息，也不要在 owner 冲突时重复刷新制造更多写者。

### 页面出现 `Symbol.dispose is not defined`

重新构建 assistant-ui PoC 并硬刷新页面；当前增量 PoC 会在页面和 Worker realm 安装共享的 `Symbol.dispose`/`Symbol.asyncDispose` shim，自动化测试也会主动模拟缺失 symbol。

### 用户消息出现后消失，没有 assistant 回复

先查看 Session JSON 是否有 `turn/end`。有明确错误的 turn 应在 assistant-ui 页面显示错误并允许下一轮继续；没有完成事件且 backend 长时间保持 running 时，检查 `/api/browser-native/llm` 状态和 backend timeout。当前 v2 backend 默认对上游模型请求设置 60 秒 deadline，不能无限等待。

### 工具失败后模型没有立即停止

DSH 默认 Agent Loop 会把工具错误写入 Session 并交给模型进行下一步判断；它不是“工具失败一次后固定立即结束”的 loop。模型可能改用其他工具、调整参数、说明无法完成，或在新的模型请求失败后结束。验收时要区分“模型正在恢复”与“无限挂起”，并以最终 `turn/end`、错误信息和 timeout 为准。

### 页面出现 `/open-in-app/apps` 或 `/plugins/events` 的 404

静态 preview 没有完整 Host presenter 时，这两个 preview probe 的 404 是已知降级现象；只要 chat route、Session route、LLM route 和当前验收场景正常，不把它们当作 Agent Loop 失败。

## 七、开发过程中的经验

- 旧版独立 HTML 和 PoC-local loop 能证明 transport，不足以证明真实 DSH Agent Loop；当前验收必须使用 `run-v2.mjs` 和正式 Session/Client composition。
- 浏览器里的 live text 是可丢弃的 read model；最终 assistant message、工具结果和恢复事实必须从 DSH Session 重建。
- `Session.prompt()` 的 accepted 与 turn 完成是两个状态；自动化和人工验收都要等待 `assistant/message` 与 `turn/end`，不能只等待用户气泡。
- 一个 Session 只能有一个 active write owner；页面卸载、刷新、崩溃恢复和 lease reclaim 必须作为独立生命周期问题验证。
- assistant-ui 作为聊天层不应建立第二份 history 或第二个 Agent Loop；它只负责 composer、message rendering 和 DSH event projection。
- Browser-Native 只把当前交互放入 Worker；provider secret、业务授权、权威副作用和长期任务仍应留在 backend 或 durable execution 层。

## Further Exploration

- [Browser-native DSH PoC README](README.md)：v2 当前实现、运行方式、验证范围和历史文件边界。
- [Browser-native DSH v2 规划](browser-native-dsh-plan-v2.md)：完成定义、架构决策、协议要求和未宣称能力。
- [Browser-native DSH v2 进度](browser-native-dsh-progress-v2.md)：实施过程、失败记录、修复原因和已运行验证。
- [assistant-ui 增量 PoC README](../assistant-ui-browser-native-dsh-poc/README.md)：第三方聊天层的职责分界和专属测试。
- [PoC 变更账本](change-ledger.md)：目录外接线、删除条件和 upstream 重放要求。
- [docs/drafts 总索引](../README.md)：Agentic UI、Browser-Native、Cloud/Durable Agent 和框架评估的阅读路线。

## Dev Note

本文是两个 Browser-Native PoC 的手动验收和经验入口；稳定运行时语义仍由源码、测试、v2 README 和进度记录共同约束，旧版协议文档不覆盖本文的 v2 验收结论。
