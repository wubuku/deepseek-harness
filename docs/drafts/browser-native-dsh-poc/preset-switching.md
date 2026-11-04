---
description: "Browser-Native DSH 的 preset 切换验证：按 Session 切换工具集、模型 route 与审批策略，并证明切换不串到正在运行的 Session。"
---

# Preset 切换：工具集、模型与审批

## 结论

浏览器端的三类切换都已可执行并即时生效：工具集走 per-Session preset（下一请求的 schema 立即变化），模型走 Session route selection（idle 后下一轮使用新 route），审批走 profile tool policy（下一次工具调用立即应用）。切换按 Session 隔离；对正在运行的 Session 切模型被 `MODEL_SWITCH_ACTIVE` 拒绝，且其他 Session 的工具集变化不会改写它已发出的请求或后续工具执行。

| 子能力 | 入口 | 生效时机 | 证据 |
| --- | --- | --- | --- |
| 审批策略 | `tool-policy-set` | 下一次工具调用 | `approval-policy.e2e.mjs`：同 Session `write` 走 ask→deny→allow→ask，deny 由 `ctx.tools.guard` 兜底 |
| 权限预设 | `permission-state` + 正式 `permissionPresets` | 下一次工具调用 | `permission-approval-lifecycle.e2e.mjs`：三种 preset，`permissionEventCount=10` |
| 模型 route | `session-orchestration-switch-route` | idle 后下一轮；运行中拒绝 | `browser-native-session-orchestration.e2e.mjs`：运行中 `MODEL_SWITCH_ACTIVE`，恢复 route 写入 `model-selection` notice |
| 工具集 | `profile-preset-set` / `profile-preset-state` | 下一请求 schema 与下一次工具调用 | 本文 E2E |

## 工具集预设的实现

`browser-native-profile-preset.ts` 是 validation-only 的内存状态：全局默认 `full`，Session 级覆盖存在 map 中。`full` 不额外限制；`read-only` 拒绝 `write`、`edit`、`bash`。

限制同时落在两处：

- `agent.ctx.tools.restrict({ deny })`：与 `publication.unavailableWorkspaceToolNames()` 取并集，未注册的名称先过滤，避免 `restrict` 因未知工具失败。restriction 按 Agent 作用域安装，因此只影响目标 Session 的请求 schema。
- `ctx.tools.guard()`：即使 scripted 模型在 schema 之外直接发出 `write` 调用，也会返回 `tool "write" is denied by the active profile preset`，证明 schema 撤下不是唯一防线。

预设变化通过订阅通知每个 Agent 重新计算 restriction；没有跨 Session 的全局改写。

## 在跑 Session 的隔离验证

E2E 同时启动两个 scripted Agent，Session A 的首个模型请求用 `barrier-tool-call` 保持 `running`。在 A 被挂起期间对 Session B 做三件事：切到 `read-only`、把 route 切到 `browser-native-recovery`、activate B 后连续 followup。观察结果：

- A 的首个请求保有 7 个工具（含 `write`/`edit`）；B 切换后其请求降为 5 个（`write`/`edit`/`bash` 撤下）。
- B 的 `write` 调用被 preset guard 拒绝；B 的下一轮请求 model 为 `browser-native-recovery`，且 preset 在 idle route 切换后仍生效。
- 对 A 的 route 切换返回 `MODEL_SWITCH_ACTIVE`；A 保持 `running`，期间没有发出新请求。
- 释放 barrier 后 A 的 `write` 正常执行（`isError=false`），续接请求仍含 7 个工具，turn 正常结束，工作区文件可见。

审批策略是全局 profile 配置（不是 per-Session），所以组合验证放在 A 结束之后：`write: deny` 使 B 的下一次 `write` 返回 `denied by the profile tool policy`，Session 追加 `tool-policy/decided` 审计事件；随后恢复默认。这个语义在真实产品里若要求 per-Session 审批，需要独立的策略作用域，PoC 不声称已实现。

## 实测输出

```text
{"result":"passed","browser":"156.0.8078.80","scope":"per-session-toolset-model-route-and-approval-preset-switching","sessionATools":7,"sessionBToolsBefore":7,"sessionBToolsAfter":5,"bRouteModel":"browser-native-recovery","bWriteDeniedByPreset":"Error: tool \"write\" is denied by the active profile preset","bPolicyAuditEvents":2,"pageErrors":0}
```

`bPolicyAuditEvents=2` 来自同一次 deny：`tools/pre-execute` waterfall 与单调 guard 各追加一次 `tool-policy/decided`。

## 限制

- 工具集 preset 是验证通道的内存状态，不是正式 profile 热加载；没有配置版本、摘要或持久化。
- 只验证单 Worker 内两个 Session；不做跨标签、页面关闭后执行、多实例或多租户结论。
- 模型切换沿用 orchestration probe 的 route selection，不改正式 LLM 注册或模型目录。
- scripted 模型由测试注入 `scriptedLlmFault`；真实模型下的工具集切换只影响请求 schema 与 guard，未证明真实模型会因工具减少而改变行为。
- 审批策略全局生效，上述组合阶段在所有 Session idle 后执行。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/profile-preset-switching.e2e.mjs
```
