---
description: "增量验证 assistant-ui 作为聊天层、Browser-Native DSH 保留 Agent Loop 与 Session 事实的隔离 PoC。"
---

# assistant-ui + Browser-Native DSH PoC

## Summary

本目录不另建 Worker、LLM provider、Session Persistence 或 DSH Agent Loop，而是复用既有 Browser-Native DSH PoC，并在 docs-owned 代码中增加恢复所需的 `session/list.items` 投影和页面卸载 owner 释放通道。它验证 assistant-ui 作为聊天呈现和交互层，Browser-Native DSH Worker 继续运行真实 `ctx.agentLoop`，DSH Session 继续作为模型可见事件、执行结果和恢复事实的唯一来源。

这个 PoC 使用 assistant-ui 的 `useExternalStoreRuntime`，不是 `useLocalRuntime`、AI SDK runtime 或 assistant-ui Cloud history；因此 assistant-ui 只消费 DSH Session 投影，并把文本输入回调到 DSH `Session.prompt()`，不会建立第二个 Agent Loop 或第二份模型历史。

本 PoC 的产品前提是：SaaS 已经有业务 GUI，但原来没有聊天层。它只验证 assistant-ui 作为新增的唯一聊天层如何接入 DSH；它不替换、复制或验证 SaaS 原有业务页面，也不证明复杂业务表单、业务 action、授权、receipt 或跨轮次 Agentic UI 已经接通。若采用本路线，页面应由 assistant-ui 承担聊天呈现职责，不应再同时挂载 DSH 原生 Web UI；DSH 保留的是 Worker、Agent Loop、Session 和执行事实，而不是另一套可见聊天界面。

## Reading Path

1. 先读 [`browser-native-dsh-poc/README.md`](../browser-native-dsh-poc/README.md)，了解 Worker、profile overlay、Session backend 和正式 DSH WebWorker Client 的 owner。
2. 再读本页的[架构](#architecture)和[事实归属](#fact-ownership)，确认 assistant-ui 与 DSH 的职责分界。
3. 需要追踪代码时，从 [`src/dsh-client.ts`](src/dsh-client.ts) 看启动和 Session retain，从 [`src/dsh-session-adapter.ts`](src/dsh-session-adapter.ts) 看事件投影和输入适配。
4. 需要判断已验证范围时，阅读 [`tests/dsh-session-adapter.test.ts`](tests/dsh-session-adapter.test.ts) 和 [`tests/browser-native-assistant-ui.e2e.mjs`](tests/browser-native-assistant-ui.e2e.mjs)。
5. 需要人工验收两个 UI 时，使用共用的[Browser-Native DSH PoC 手动验收说明](../browser-native-dsh-poc/manual-acceptance.md)。

## Run

前置条件是根仓库已经完成依赖安装，并且已经生成 `apps/web/dist/preview/vfs-image.tar.gz`；这一步复用既有 Browser-Native PoC 的 preview 构建，不复制 VFS image 或 Worker runtime。

在仓库根目录执行：

```sh
pnpm --ignore-workspace --dir docs/drafts/assistant-ui-browser-native-dsh-poc install
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run build
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4197 \
  --data-dir /tmp/dsh-assistant-ui-browser-native-poc \
  --llm scripted
```

打开 `http://127.0.0.1:4197/assistant-ui-poc/index.html`。页面第一次打开会在固定 PoC workspace `/dsh/home/` 创建一个 Session，并把 Session id 放入 URL 和当前标签页的 `sessionStorage`；刷新同一页面会重新 retain 并从 DSH Session baseline 恢复历史。

真实 provider 仍按既有 v2 launcher 的规则只由 backend 读取环境文件：

```sh
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4197 \
  --data-dir /tmp/dsh-assistant-ui-browser-native-poc-real \
  --llm real \
  --env-file docs/drafts/.env
```

本机真实 provider 配置文件是仓库根目录下的 `docs/drafts/.env`；该文件只供 backend 读取，不得提交。

## Architecture

```text
assistant-ui primitives
        ↕
useExternalStoreRuntime
        ↕
DshSessionAdapter (rebuildable chat read model)
        ↕
DSH Client Session Controller
        ↕
existing Browser-Native Worker Host
        ↕
DSH ctx.agentLoop
        ↕
existing SessionPersistence + LlmAdapter backend
```

`src/dsh-client.ts` 复用现有 Worker entry 和 profile overlay，但不实例化 `AppWebEntry`，所以页面不挂载现有 DSH Web UI。它从正式 client manifest 启动非 UI 的连接、Remote 和 Session Controller entries，并排除会自动恢复 Workspace/Conversation 导航的 UI entries；否则聊天层 PoC 会在后台再创建一个默认 Session。Session Controller 和 Remote stream 仍走正式 client composition。

`src/dsh-session-adapter.ts` 将 DSH 的 durable `user/message`、`assistant/message` 和 Client-only `assistant/live-chunk` 转换为 assistant-ui `ThreadMessageLike`。流式行只是可丢弃的 read model；最终 assistant message、输入消息和工具事实仍来自 Session event window。

页面与 Worker entry 在加载 DSH 模块前补齐旧浏览器缺少的 `Symbol.dispose` 和 `Symbol.asyncDispose`；它们使用 `Symbol.for()` 注册的共享 symbol，使 DSH 编译后的显式资源管理代码可运行。自动化 E2E 会在 page 和 Worker realm 中模拟缺少这两个 symbol，防止兼容性回归。

Worker 通过独立 `MessageChannel` 将当前 owner token 交给页面内存；页面同时把它保存到当前标签页的 `sessionStorage`，使刷新可以尝试续接同一写 owner。页面正常卸载时用 `sendBeacon` 请求 backend `close`，让 backend flush Session 并释放 owner。`open` 遇到卸载请求尚未到达的短暂 owner 冲突时会在 5 秒内重试。owner token 不进入 URL、`localStorage` 或 Session log；默认 30 秒 lease 由 Worker 每 10 秒续租，浏览器崩溃、进程被杀或强制终止 Worker 后，写权会在 lease 到期时回收。

assistant-ui 的 `onNew` 只提取文本、调用一次 `beginSubmission()` 和一次 `Session.prompt()`；`Session.prompt()` 的 accepted 只表示输入被 DSH 接纳，不表示模型已经完成。后续 Agent Loop、LLM streaming、tool lifecycle、Session append/flush 都继续由 DSH 负责。

## Fact Ownership

| Subject | Owner | PoC behavior |
| --- | --- | --- |
| Chat rendering, composer keyboard interaction, message list | assistant-ui | 通过 `AssistantRuntimeProvider` 和 `useExternalStoreRuntime` 渲染，不持久化 DSH 事实。 |
| Agent Loop and model requests | DSH Worker | Worker 内启动现有 Cordis composition 和真实 `ctx.agentLoop`。assistant-ui 不调用 `/api/browser-native/llm`。 |
| Session event history and recovery | DSH Session Controller + backend | Client 从 Session event source 重建聊天；刷新后通过同一个 Session id 重新 open。 |
| Prompt admission and cancellation | DSH Session | adapter 调用 `beginSubmission`、`prompt` 和 `cancel`，不直接写 Session backend。 |
| Browser-native transport and provider injection | existing Browser-Native PoC | 本目录复用 Worker、overlay、backend 和 v2 protocol；共享 backend 的兼容性增量及验证见既有 PoC 的 [README](../browser-native-dsh-poc/README.md) 和 [change ledger](../browser-native-dsh-poc/change-ledger.md)。 |

## Verified Scope

- assistant-ui 页面可以启动 Dedicated Worker、正式 DSH Client composition 和 Session Controller。
- 文本输入经过 `Session.prompt()` 进入真实 DSH `ctx.agentLoop`，由 Worker-side `LlmAdapter` 请求既有 backend route。
- Session event window 中的 durable user/assistant events 映射为 assistant-ui messages，`assistant/live-chunk` 映射为可替换的 running assistant row。
- 首次创建只产生一个 Session；adapter 对同一个 in-flight message object 做去重，避免重复挂载或重复回调形成重复 prompt。
- 页面刷新会 retain 已保存的 Session id，并从 DSH Session baseline 重建历史；assistant-ui 自己没有独立 history store。
- 同一 Session 只允许一个写 owner；当前 v2 backend 默认以 30 秒 lease 回收异常退出留下的 owner，Worker 每 10 秒续租。无法取得写权时，页面禁用发送、保留 composer 草稿，并可在关闭原标签页或 lease 到期后重新连接。
- 自动化 E2E 覆盖 Playwright Chromium、已安装的 Google Chrome、Playwright WebKit 和真实 Safari.app；real 模式在一个 Session 中验证工具调用、多个相关轮次、窗口记忆、一次受控模型失败及其恢复、刷新后继续发送、正式 Session 事件和落盘序号。
- Chrome 和 Safari 的 real E2E 观察浏览器中的未完成 assistant 文本，再核对 backend `assistant/message` stream chunk；Safari 使用 WebDriver 与 live-DOM MutationObserver 记录部分文本先于最终回复出现，响应过快时以同一 Session 的真实 text chunks 补足证据。静态 preview 未挂载 Host 时，`/open-in-app/apps` 与 `/plugins/events` 的 404 是预期降级，不影响聊天；[preview boot E2E](../../../apps/web/tests/preview-boot.e2e.ts) 覆盖这两个响应。
- Playwright E2E 检查浏览器请求不含 provider key；Safari.app 使用 macOS `safaridriver` 驱动，首次运行前需执行 `safaridriver --enable` 并完成 macOS 认证，不能用 Playwright WebKit 结果代替 Safari.app 验收。
- E2E 的刷新验证不代表 backend 进程重启后的 crash recovery，也不是对生产 HA、租户隔离或可用性的证明。

## Deliberate Limits

本 PoC 只实现 text-only `queue`/`steer` prompt、cancel、older-history callback 和基础 assistant/tool-call message projection；页面已经提供用于验收的基础 tool card（工具名、参数、状态和结果），但没有实现附件上传、编辑、fork、branch picker、业务 action、HITL continuation、frontend tool ownership、复杂 tool card 或多 Session sidebar。为避免 DSH 原生 Web UI 的默认导航副作用，PoC 还显式裁剪了 Workspace/Conversation 相关 client entries；assistant-ui 是唯一挂载的聊天呈现层。

不能把 assistant-ui runtime 的 `messages` 当作 DSH Session log，也不能把它的 `state` setter 当作业务提交成功；任何需要授权、副作用或模型续跑的动作都必须回到 DSH capability 和 Session event owner。

既有 v2 backend 的限制仍然有效：`requestId` 只是关联字段，没有 request deduplication/replay ledger；owner 虽有 renew 和 expiry，但仍没有跨进程 owner epoch；本地 JSON store 不是生产级多租户、HA、备份或灾备实现。当前 E2E 验证正常页面卸载后重新取得同一 Session 的写权并继续发送，契约测试覆盖 lease 到期后的 stale owner reclaim；这些测试不代表生产 HA，也不恢复未落盘操作。详见既有 [`browser-native-dsh-poc/README.md`](../browser-native-dsh-poc/README.md)。

## Validation

适配器单测不需要启动 Worker：

```sh
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc test
```

浏览器 E2E 会自行启动 backend，使用临时 Session 目录与系统分配的本地端口；先完成 preview 和 assistant-ui build，再从仓库根目录执行：

```sh
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:real
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:chrome:real
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:ownership
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:webkit
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:webkit:real
pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:safari:real
```

`test:e2e`、`test:e2e:webkit` 使用 scripted provider；`test:e2e:real`、`test:e2e:chrome:real`、`test:e2e:webkit:real` 和 `test:e2e:safari:real` 使用 `docs/drafts/.env` 中的真实模型，最多等待四分钟，并要求一次成功的 `todo_write` 工具调用。Chromium/WebKit/Chrome 测试会模拟 page 和 Worker 缺少 dispose symbols；Safari.app 测试直接运行本机 Safari 引擎。Playwright real tests 还会核对浏览器请求与 Session log 不含 provider key；所有测试都会检查消息标签、composer 提示、placeholder、footer 和禁用按钮的文本对比度至少为 4.5:1。2026 年 10 月 17 日已用真实 Chrome 和 Safari.app 分别完成本地 backend 与运行中的 `4197` backend 验收，覆盖多轮记忆、真实 `todo_write`、失败后恢复、刷新续接、流式文本和落盘 Session。真实测试会产生 provider 调用费用和网络延迟；也可通过 `DSH_ASSISTANT_UI_POC_ENV_FILE` 指定其他本机配置。配置 HTTP(S) 代理时，real E2E 会在 Node 支持时自动启用 `--use-env-proxy` 并排除本地地址；Playwright 从仓库 `apps/web` 依赖解析，独立 worktree 若缺少该依赖可设置 `DSH_POC_PLAYWRIGHT_MODULE` 指向已有 Playwright entry。

### Acceptance Record (2026-10-17)

| Browser/backend | Real acceptance | Observed evidence |
| --- | --- | --- |
| Google Chrome + self-started backend | passed | 5 submitted turns; one real `todo_write`; memory token; injected failure recovery; refresh continuation; visible tool card; progressive text; durable Session. |
| Google Chrome + running `http://127.0.0.1:4197` | passed | Same multi-turn/tool/memory/refresh assertions against the user-facing service and its `/tmp/dsh-assistant-ui-browser-native-acceptance-real-2026-10-17` Session store. |
| Safari.app 26.6.2 + self-started backend | passed | 5 submitted turns; WebDriver-driven live DOM trace; tool, memory, failure recovery, refresh continuation, contrast and durable Session checks. |
| Safari.app 26.6.2 + running `http://127.0.0.1:4197` | passed | 4 real turns including tool call, memory, refresh continuation, visible progressive text and durable Session. |
| Original Browser-Native DSH Web UI + Google Chrome | passed | 3 real turns; `todo_write`; window memory; stream chunks; durable Session and LLM status 200. |

The two preview probes `/open-in-app/apps` and `/plugins/events` still return 404 in the static preview, matching the existing preview boot acceptance; they are not chat or Agent Loop failures. The Safari test records live DOM mutations so a fast response cannot be mistaken for a missing stream; it also cross-checks the same turn's durable `assistant/message` text chunks.

### Manual Acceptance

两个 PoC 共用的真实浏览器验收步骤、对话脚本、Session 证据和故障排查见[Browser-Native DSH PoC 手动验收说明](../browser-native-dsh-poc/manual-acceptance.md)。assistant-ui 的专属入口是 `http://127.0.0.1:4197/assistant-ui-poc/index.html`；该说明同时给出原生 DSH Web UI 入口，便于在相同 backend 和相同验收脚本下做 UI 对照。

## Dev Note

这是一个 docs-owned 增量 PoC，不是正式 package、Web profile 或产品入口。它没有修改既有 Browser-Native PoC、`packages/core/agent-loop`、Session format、普通 Web profile 或 `apps/web/src/preview.ts`；后续若要把 adapter 生产化，应先为完整 event projection、tool UI、业务 action、恢复协议和租户安全建立正式 capability seam 与测试。
