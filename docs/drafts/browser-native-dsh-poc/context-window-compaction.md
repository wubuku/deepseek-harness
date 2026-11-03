---
description: "Browser-Native profile 显式声明 128k contextWindow 与 headroom，并在真实 Chrome 中验证 80% 压力线触发 compaction、刷新可重建且无 capacity 警告。"
---

# contextWindow 声明与 128k compaction 验证

## Summary

[compaction-context-window.e2e.mjs](tests/compaction-context-window.e2e.mjs) 让 backend 以 scripted 模式启动且**不声明** `contextWindow`，因此模型容量只能来自 profile 配置。Browser-Native profile 现在显式声明 `llm-browser-native` 的 `contextWindow: 131072`，并为 `compaction-basic` 声明 `headroomTokens: 16384`，压力线为 `min(0.8 × 131072, 131072 − 16384) = 104,857` tokens，即窗口的 80%。

真实 Chrome 156.0.8078.79 中，42 个 turn（每 turn 12,000 字符 prompt 加一次 `read` 工具）在第 **29** turn 首次触发压力 compaction，产生 1 组 `compaction/start`、`compaction/summary`、`compaction/end`，没有 error end；Session 633 个事件、durable JSON 1.78 MB。刷新后 634 个事件全部可直接重建（多出的一条是重新挂载写入的 `session/end-seed`），compaction 事件数量不变，最后一条 assistant marker 可见；随后第 43 turn 正常完成。全程 `no context capacity` 与 `headroom tokens` 警告均为 0，证明窗口来自 profile 而不是被 adapter 的硬编码默认值或 backend 兜底。

## 配置与解析规则

- `browser-native-profile.cordis.patch.yml` 与 `runtime-validation.cordis.patch.yml` 的 `llm-browser-native` 条目新增 `config: { contextWindow: 131072 }`。
- 产品 profile 的 `compaction-basic` 新增 `headroomTokens: 16384`（窗口的 1/8），使压力线落在 80% 而不是 50%。
- [browser-native-providers.ts](browser-native-providers.ts) 在 Cordis 配置边界校验 `contextWindow`：必须是正的安全整数，否则插件加载失败；不合法值不会被静默忽略。
- 解析顺序：backend 显式声明的真实模型容量优先；backend 未声明时使用 profile 声明；两者都没有时不提供 context 元数据，compaction 继续以 `no context capacity` 警告暴露缺配置。该顺序保证真实模型 smoke 可以用 `DSH_POC_CONTEXT_WINDOW` 指定实际容量，而 scripted/默认 PoC 不依赖 backend 环境变量。

## 证据

```json
{"result":"passed","browser":"156.0.8078.79","scope":"profile-context-window-compaction",
 "declaredWindow":131072,"turns":42,"fillerChars":12000,
 "eventCount":633,"durableBytes":1782188,"firstCompactionTurn":29,
 "compaction":{"starts":1,"summaries":1,"ends":1},
 "afterReload":{"events":634,"starts":1,"summaries":1,"lastMarkerVisible":true},
 "continuedTurn":43,"toolCalls":45,"turnLatencyMedianMs":291,"turnLatencyMaxMs":798,
 "capacityWarnings":[],"backendConfigWindows":[null,null,null,null],
 "externalRequests":0,"pageErrors":[]}
```

- `firstCompactionTurn=29`：12,000 字符 prompt 约 3,000 tokens，加工具结果与历史，约第 29 turn 累计越过 104,857 token 压力线。
- `backendConfigWindows` 全为 `null`：backend 没有返回 `contextWindow`，而 compaction 仍然触发，只能由 profile 声明解释。
- `capacityWarnings=[]`：`compaction-basic` 的“无 context capacity”警告不再出现在 mount 或 turn 中。
- 刷新前后 `starts/summaries` 数量一致：压缩摘要与压缩事件本身已进入权威 Session log，hydrate 不依赖浏览器侧缓存。
- `toolCalls=45` 高于 43 个 turn，因为 scripted stand-in 对包含 scale marker 的 compaction 摘要请求也返回一次 `read` 调用；测试只断言后续 turn 至少执行自己的工具调用，不把 scripted 摘要路径计为用户副作用。

## 判定

**128k 窗口必须由 profile 显式声明，并配置按窗口缩放的 headroom。** 没有 profile 声明时，scripted/默认 PoC 会在每次 mount 打印 `no context capacity` 且永不自动 compaction（见[会话规模曲线](session-scale-curve.md)）；有了声明，压力线在 80% 窗口处真实触发，且摘要与压缩事件刷新后可重建。真实模型仍必须由 backend 或 profile 给出该模型的实际窗口；adapter 不再猜测 128k。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/compaction-context-window.e2e.mjs
```

可用 `DSH_POC_WINDOW_TURNS`（默认 42）与 `DSH_POC_WINDOW_FILLER_CHARS`（默认 12000）降低或提高达到压力线所需的 turn 数。

## 限制

- 窗口值来自 profile，不是运行时从 provider 读到的真实容量；真实模型 smoke 仍需 backend 显式传入实际窗口。
- 只验证一个 128k 窗口与 80% 压力线，没有覆盖 32k/64k/200k 或不同 headroom 比例的曲线。
- scripted 摘要内容由 stand-in 生成，不代表真实模型摘要质量；压缩后的语义正确性未被评估。
- 42 turns 只触发 1 次 compaction，没有验证多次压缩后的事件增长、摘要链式引用或长期召回。
