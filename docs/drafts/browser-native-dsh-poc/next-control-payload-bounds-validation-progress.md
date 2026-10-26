---
description: "记录 Browser-Native 控制通道严格 schema、载荷预算和真实 Chrome 故障注入的实施进度。"
---

# Browser-Native 控制通道载荷约束验证进度

## 当前状态

状态：M1–M3 已完成，M4 文档与提交前检查待完成。控制 receiver 现在拒绝额外字段、未知 notice、超长 UTF-8 字段、超过 16 KiB 的序列化 frame 和危险序列整数；只有 exact-key、plain-object、有限字段的帧才进入 JSON fingerprint。invalid 页面事件只含固定 reason code，不再携带原始 frame。

## 里程碑

| 里程碑 | 状态 | 验收证据 | 下一步 |
|---|---|---|---|
| M0：候选范围与 TUI 证据核查 | `complete` | `dsh-TUI` `provider.ts` 的 bounded JSON、深度和 unknown method 拒绝；Browser-Native 控制 receiver 的 schema/大小差距 | 实现有限 frame schema 与 payload budget |
| M1：validator 与单测 | `complete` | `browser-native-control-channel.spec.ts` 10/10；Web TypeScript check 通过 | 真实 Chrome 投递坏帧并检查恢复 |
| M2：真实 Chrome Worker 故障注入 | `complete` | 5 类 malformed frame 均 fail-closed；4096-byte text 接受，刷新建立新的 `channelId` 并恢复 synced Workspace；无 page/Worker error 或外站请求 | 运行真实模型 smoke |
| M3：真实模型 smoke | `complete` | 真实 Chrome `read → write → read`、59 个 Session events、`durableThroughSeq=58`、文件刷新后可读、8/8 LLM 请求 HTTP 200 | 更新 PoC 索引与兼容矩阵 |
| M4：文档与提交前检查 | `complete` | README、兼容矩阵、索引、change ledger 已更新；`test:docs` 21/21、`doc-sync` 43/43、change-scope 与 diff check 通过 | 提交并推送到 `research` |

## 验证记录

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts` | 1 个文件、10/10 通过。 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过。 |
| `node --check docs/drafts/browser-native-dsh-poc/tests/control-payload-bounds.e2e.mjs` | 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留既有 native-platform、tsdown deprecation 和 chunk-size warnings。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/control-payload-bounds.e2e.mjs` | 真实 Chrome Worker 通过；接受 4096-byte text，拒绝超长字段、JSON 转义后超 16 KiB、未知字段、未知 notice 和循环 extra；每次刷新均建立新 channel，`pageErrors=0`、`workerErrors=0`、`externalRequests=0`。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/control-channel-conformance.e2e.mjs` | 连续性回归通过；duplicate 去重、gap/conflict fail-closed、3 个不同 channel、无页面/Worker 错误或外站请求。 |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 `gpt-5.6-sol` Chrome smoke 通过；`read → write → read`、59 个 Session events、`durableThroughSeq=58`、刷新后文件可读、8/8 LLM HTTP 200、`pageErrors=0`。刷新时有预期的 aborted 请求和可选 UI route 404；另观察到 compaction context-capacity warning，turn 继续完成。 |
| `pnpm run test:docs` | 21 个 doc-quick gate 通过。 |
| `pnpm run doc-sync` | 43 个文档同步 gate 通过。 |
| `pnpm --silent run change-scope --base origin/research` | 本批文件均属于 PoC 与 Web preview/control adapter；没有其他 worktree 变更。 |
| `git diff --check` | 通过。 |

## 已知限制

- 计划中的 payload 上限是 Browser-Native PoC 控制协议限制，不是 DSH Session event、工具结果或模型上下文预算。
- scripted 注入只能证明确定性 validator 行为，不能估算自然浏览器故障率或真实攻击概率。
- Chrome 以外的浏览器、OS 级崩溃、生产代理和真实 SaaS 多租户授权不在本批验收范围。
- 16 KiB 是当前 PoC 的控制 JSON frame 上限，不代表 Session event、工具结果、VFS 文件或模型上下文的载荷预算。
- 真实模型 smoke 观察到现有 compaction 配置缺少 `contextWindow` 的 warning；该问题不阻断本次 turn，也不属于控制通道变更范围。
