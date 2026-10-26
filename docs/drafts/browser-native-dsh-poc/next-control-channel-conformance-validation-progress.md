---
description: "记录 Browser-Native DSH Worker 控制通道连续性验证的实施进度、Chrome 证据和限制。"
---

# Browser-Native Worker 控制通道连续性验证进度

## 当前状态

状态：已完成本批 PoC 实施与 Chrome 验收。控制通道现在有独立的 `control-ready` 基线、随机 `channelId` 和连续 `seq`；页面只投影通过验证的控制帧。Safari/WebKit 暂停，真实模型只做普通文件闭环 smoke。

本批控制通道只承载 owner、Workspace 状态、Workspace lease 和 pagehide ack。它不是 DSH Session event log，也不恢复 JavaScript Promise、模型流、工具调用或 HITL 等待。

## 里程碑

| 里程碑 | 状态 | 证据 | 结果 |
|---|---|---|---|
| M0：TUI 启发与现有桥接盘点 | `complete` | 控制通道当前承载 owner、Workspace、lease 和 pagehide 通知；Session event log 与页面控制状态保持分离 | 采用 channel baseline、live continuity 和 fail-closed 原则，不移植 TTY/Node 假设 |
| M1：控制帧 envelope 与 validator | `complete` | `browser-native-control-channel.spec.ts`，2 个测试文件共 13/13 通过 | `control-ready` 为 `seq=0`；正常帧从 `seq=1` 连续递增；重复同帧去重；同序冲突、跳号、通道变化、非法协议和基线缺失 fail-closed |
| M2：真实 Worker/page 接线 | `complete` | `control-channel-conformance.e2e.mjs`，真实 Chrome 通过 | 三次页面/Worker 建立不同 `channelId`；duplicate 不触发 invalid；gap 产生 `CONTROL_SEQUENCE_GAP`；conflict 产生 `CONTROL_SEQUENCE_CONFLICT`；刷新后重新建立基线；页面和 Worker 无错误、无跨源请求 |
| M3：真实 LLM smoke、文档与回归 | `complete` | `runtime-validation.e2e.mjs` 真实 provider smoke | 真实 `gpt-5.6-sol` 在 Chrome Worker 完成 `read → write → read`，刷新后文件可读；59 个 Session events，`durableThroughSeq=58`，8 个 LLM 请求均 HTTP 200 |

## 实施结果

Worker 绑定页面 `MessagePort` 时发送一个随机通道的 `control-ready` 帧。owner、Workspace、lease 和 pagehide ack 均由发送端统一包装为同一通道的递增 `control-frame`。页面端的 `BrowserNativeControlReceiver` 在基线、版本、通道身份、序列连续性和 payload 合法性通过前不应用状态；相同序号且完全相同的帧只被忽略一次，不重复写入 `sessionStorage` 或更新 UI。

PoC test port 增加了 URL-gated 的 `control-inject` seam，只用于发送重复、跳号和同序不同 payload 的故障帧。gap/conflict 使当前 receiver 锁定为 invalid；刷新会创建新的 receiver、Worker 和 `channelId`，旧通道的连续性状态不会被页面内存复用。

真实 LLM smoke 的输出包含既有刷新路径产生的 `ERR_ABORTED` 请求和若干可选 Web 路由 404；它们没有造成页面错误，所有 8 个 LLM 请求均由同源 backend 返回 200。该 smoke 只证明控制通道接线没有破坏普通 DSH 文件闭环，不证明真实模型能生成控制帧故障，也不把 abort/404 当作本批失败。

## 实际命令与结果

```sh
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
# passed

pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts
# 2 files, 13/13 passed

node --check docs/drafts/browser-native-dsh-poc/tests/control-channel-conformance.e2e.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
# passed; existing unsupported-native-platform, tsdown deprecation and chunk-size warnings remain

DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/control-channel-conformance.e2e.mjs
# passed; gap/conflict fail-closed, 3 channelIds, pageErrors=0, workerErrors=0, externalRequests=0

env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
  -u ALL_PROXY -u all_proxy \
  DSH_POC_LLM=real DSH_POC_BROWSER=chrome \
  DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 \
  DSH_POC_REFRESH_CYCLES=1 DSH_POC_LLM_TIMEOUT_MS=180000 \
  DSH_POC_TURN_TIMEOUT_MS=600000 \
  node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
# passed; real model, 59 Session events, durableThroughSeq=58, 8/8 LLM requests HTTP 200
```

## 已知限制

- 控制帧失序后页面保留最后一个已验证状态，并报告 invalid；本批没有实现自动重新订阅或从 Session event log 重放控制状态。
- MessagePort 连续性不等于 Session live/replay 连续性；Session 仍由独立的 DSH event log、Session outbox 和 backend watermark 负责。
- 刷新只证明新的 Worker 能建立新的控制通道；它不证明页面关闭后的后台 Agent、Cloud Worker handoff、跨存储原子事务、自然 eviction、OS/磁盘 crash、生产多实例 backend 或 Safari/WebKit。
- 注入的 gap/conflict 是确定性 PoC 故障，不是浏览器自然丢包或 MessagePort 重排概率的测量。
