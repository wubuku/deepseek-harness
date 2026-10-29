---
description: "记录 Browser-Native DSH Session projection 的基线、Session 过滤、reseed、卸载和同源写权观察验证结果。"
---

# Browser-Native DSH Session Projection 与写权观察验证进度

## 当前状态

状态：本批实施和验证完成，待提交与推送。工作区基线为 2026-10-29 的干净 `research` checkout；只有主 worktree，没有隔离 worktree。Safari/WebKit 按当前安排暂停。范围和验收标准见[验证计划](session-projection-authority-validation-plan.md)。

## 交付结果

| 交付面 | 状态 | 结果 |
|---|---|---|
| Session-scoped projection store | `complete` | 新增 PoC-local `BrowserNativeSessionProjectionStore`；`attach`/`bind` 先读取 baseline，`update` 按 Session 过滤，重复 raw 引用不重复通知，`reseed` 能清除已删除值。 |
| detach/re-attach 生命周期 | `complete` | source detach 清除当前可见值并取消订阅；重新 attach 后从 source snapshot 重新 seed；未重新 attach 的迟到更新不会进入投影。 |
| Worker 真实执行入口 | `complete` | Dedicated Worker 新增 URL-gated `session-projection-probe`，验证投影适配器确实进入 Browser Worker bundle；普通 preview 不启用该 probe。 |
| Session observer 与 writer authority | `complete` | 只读页面可读取同一 Session 的 durable event，但没有 owner token 的 append 返回 `409 SESSION_OWNERSHIP_LOST`；并发 write claim 只有一个 `200`，另一个为 `409 SESSION_ALREADY_OWNED`。 |
| 真实 LLM 接线回归 | `complete` | Chrome 同源后端代理运行真实 `gpt-5.6-sol`，完成标准 `read → write → read`、刷新后同 Session/Workspace 恢复；这不是 projection 多 Session 或真实模型自主 observer 时序证明。 |

## 实际验证

### Projection 单测

`BrowserNativeSessionProjectionStore` 的 4 项 Vitest 通过，覆盖 baseline seed、跨 Session update 过滤、A/B 切换时先清旧值、重复更新去重、删除后 reseed、detach/re-attach 以及读取失败时保留稳定值并只报告一次。

### Chrome Worker 与 authority E2E

`session-projection-authority.e2e.mjs` 使用 Chrome 156.0.8078.48、真实 Dedicated Worker、同源 PoC backend 和 scripted DSH route。projection probe 的 baseline、foreign update、live update、duplicate、切换、late update、remove、detach 和 re-attach 全部通过；observer `append` 为 `409 SESSION_OWNERSHIP_LOST`，两个并发 claim 的状态为 `[200, 409]`，最终 Session `nextSeq=1`。页面错误和跨源请求均为 0。

这次首次执行曾因 probe 重复断言把“切换后被清空”的中间状态误判为失败；修正断言以区分 baseline seed、切换清空通知和重新 seed 后重建值，未改变运行时实现，修正后完整重跑通过。

### 真实 LLM smoke

实际命令使用本机 `docs/drafts/.env`，模型凭据只由 backend 读取：

```sh
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 \
  DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env \
  DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_LLM_TIMEOUT_MS=180000 \
  DSH_POC_TURN_TIMEOUT_MS=600000 \
  DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

结果：`gpt-5.6-sol` 完成 3 turns，标准 DSH 文件工具序列为 `read → write → read`；刷新后同一 Session 的 Workspace 文件仍可读。Session 有 59 个事件，`durableThroughSeq=58`，两个 Workspace commit 均为 HTTP 200，8/8 LLM 请求为 HTTP 200，页面没有 page error；模型请求只到同源 backend。测试日志仍包含刷新导致的旧请求 `ERR_ABORTED`、PoC 未实现 route 的 404 和 compaction capacity warning；这些是已知测试噪声，不影响本次通过，也不应描述为全栈零告警。

## 经验教训

- 页面 read model 必须先按 Session 建立 baseline，再接收 live update；只过滤 live event 会让切换后的页面短暂保留旧 Session 内容。
- `reseed` 的“值不存在”必须区别于 snapshot 读取失败：前者清除旧值，后者保留最后稳定值并报告诊断，避免暂时性 authority 故障伪装成空状态。
- projection store 只能提供展示读取，不能授予 Session append、Workspace lease 或模型执行权；observer 仍必须通过 backend 的 owner authority 明确拒绝写入。
- Worker probe 适合证明适配器实际进入浏览器执行位置，但不能把 PoC-local projection store 描述为正式多 Session UI、Session 事实源或后台 Agent。

## 证据边界与后续限制

本批证明的是单同源 PoC backend、同一 Chrome BrowserContext、两个独立 Session 和当前匿名 identity cookie 下的 projection 与单 writer/多 observer 语义。它没有实现正式多 Session UI，没有证明同一 Worker 内多个真实 Agent Loop，也没有验证真实模型自主选择 observer 操作、跨设备授权、生产多实例 HA、自然 eviction、OS/磁盘 crash、Safari/WebKit 或云端 executor handoff。`parked` 或 detach 都不表示页面关闭后 Worker 仍在后台运行；projection continuity 也不等于 durable execution。

## 实际命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-projection.spec.ts` | 通过，1 个文件、4 项。 |
| `node --check docs/drafts/browser-native-dsh-poc/tests/session-projection-authority.e2e.mjs` | 通过。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-projection-authority.e2e.mjs` | 通过，Chrome 156；projection 全部断言通过，observer append 409，claim `[200,409]`，page error/cross-origin request 均为 0。 |
| 真实 LLM 命令（见上） | 通过，3 turns、59 events、`durableThroughSeq=58`、8/8 LLM HTTP 200、2 个 Workspace commit HTTP 200；保留既有 404、`ERR_ABORTED` 和 compaction warning。 |

## Dev Note

本记录是 `docs/drafts/` 下的验证草稿。它记录当前 checkout 的实测事实，不改变正式 Session、Workspace、Agent Loop 或 Web UI API 的产品承诺。
