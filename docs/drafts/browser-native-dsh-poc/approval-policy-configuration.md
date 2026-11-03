---
description: "Browser-Native PoC 的 profile 工具策略（allow/ask/deny）验证记录：配置来源、即时生效、deny 单调性与审计证据。"
---

# Browser-Native profile 工具策略验证

本记录验证三个产品问题：危险工具策略能否按 profile 配置而不是写死在代码里；策略变更是否在同一个 Session 内即时生效；`deny` 是否不可被其他 pre-execute 监听器或审批结果绕过。结论来自真实模型与真实 Chrome Worker，不是类型或静态配置推断。

## 实现位置与配置

验证 roster `browser-tool-policy` 在 `runtime-validation.mjs` 里插入 `browser-native-tool-policy` 静态模块，profile `config` 为 `tools: { write: ask, edit: deny, read: allow }`、`default: allow`。插件是 [browser-native-tool-policy.ts](browser-native-tool-policy.ts)，只存在于验证镜像，正式 product profile 不注册。`allow` 与 `ask` 走 `tools/pre-execute` waterfall；`deny` 同时注册 `ctx.tools.guard`，因此在任何 waterfall 返回 `allow` 之后、以及审批 `allowed-once` 之后仍会被复核。

每次决策在开启的 turn 内追加 `tool-policy/decided` Session 事件，字段为 `tool`、`callId`、`policy`。`ask` 路径仍产生既有 `approval/asked` 与 `approval/decided` 对，审计可同时按 callId 关联工具结果、策略决策与审批结果。

## 真实模型证据

`tests/approval-policy.e2e.mjs` 在一个 Session 内完成四次模型请求：启动 READY、deny、allow、ask。运行输出：

```json
{
  "profilePolicy": { "tools": { "write": "ask", "edit": "deny", "read": "allow" }, "default": "allow" },
  "turns": { "deny": 2, "allow": 3, "ask": 4 },
  "audit": { "deny": 1, "allow": 1, "ask": 1 },
  "approvedCard": "Waiting for approval\ntool \"write\" requires approval under the profile tool policy\nReject\nAllow once",
  "files": { "denyAbsent": true, "allow": "POLICY_REAL_ALLOW_OK\n", "ask": "POLICY_REAL_ASK_OK\n" }
}
```

deny turn 先通过 Worker test port 注册一个 prepended `allow` 监听器（模拟另一个插件放行），再在同一 Session 内把 `write` 从 `ask` 改为 `deny`；模型仍然收到 `Error: tool "write" is denied by the profile tool policy`，文件不存在，`approval/asked` 为 0。该 turn 的 `tool-policy/decided` 恰好一条且 `policy` 为 `deny`，因为 guard 在 prepended allow 之后执行。模型在工具拒绝后继续产生一条 assistant 文本并正常结束 turn。

allow turn 把 `write` 改为 `allow`，模型调用成功、文件字节一致、无审批请求，审计为 `allow`。ask turn 把 `write` 改为 `ask`，审批卡展示策略原因并出现 `Allow once`；点击后 `approval/decided` 为 `allowed-once`，工具成功，审计为 `ask`。三次变更都没有重启 Worker 或重新加载 profile。

运行命令：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/approval-policy.e2e.mjs
```

## 残余缺口

- 策略只按工具名匹配，没有参数、路径、命令内容或 agent scope 规则；`fs_write` 写入工作区外的控制仍由 sandbox/审批层负责。
- 策略来源是验证 profile 的 `cordis.patch.yml`；正式产品 profile 尚未注册该插件，也没有用户可编辑策略的 UI。
- test port 的 `setPolicy` 替换内存快照，证明即时生效，但不等于正式配置热加载；没有策略版本号或审批记录关联的配置摘要。
- `deny` 的单调性依赖 `ctx.tools.guard`；已证明一个 prepended allow 监听器不能绕过，但没有覆盖恶意插件移除或替换 guard 注册、或绕过 `ctx.tools` registry 直接执行工具的场景。
- 审计事件只落在 Session log，客户端没有专门的策略决策视图；`tool-policy/decided` 在 `SessionEventMap` 中由 PoC 模块声明，删除 PoC 后这些历史事件应仅作为普通日志保留。
- 真实模型对拒绝的后续文本不保证提及原因（个别运行只回复约定 marker）；E2E 因此断言“拒绝结果 + 非空后续文本”，不断言具体措辞。
