---
description: "Browser-Native PoC 的 profile 工具策略（allow/ask/deny）验证记录：配置来源、即时生效、deny 单调性与审计证据。"
---

# Browser-Native profile 工具策略验证

本记录验证三个产品问题：危险工具策略能否按 profile 配置而不是写死在代码里；策略变更是否在同一个 Session 内即时生效；`deny` 是否不可被其他 pre-execute 监听器或审批结果绕过。结论来自真实模型与真实 Chrome Worker，不是类型或静态配置推断。

## 实现位置与配置

验证 roster `browser-tool-policy` 在 `runtime-validation.mjs` 里插入 `browser-native-tool-policy` 静态模块，profile `config` 为 `tools: { write: ask, edit: deny, read: allow }`、`default: allow`。插件是 [browser-native-tool-policy.ts](browser-native-tool-policy.ts)，只存在于验证镜像，正式 product profile 不注册。`allow` 与 `ask` 走 `tools/pre-execute` waterfall；`deny` 同时注册 `ctx.tools.guard`，因此在任何 waterfall 返回 `allow` 之后、以及审批 `allowed-once` 之后仍会被复核。

每次决策在开启的 turn 内追加 `tool-policy/decided` Session 事件，字段为 `tool`、`callId`、`policy`；路径规则命中时还带归一化后的 `path` 与命中的 `allowedPaths`。`ask` 路径仍产生既有 `approval/asked` 与 `approval/decided` 对，审计可同时按 callId 关联工具结果、策略决策与审批结果。

## 路径范围规则

`browser-native-tool-policy` 的 profile `config` 还接受 `paths`：按工具名声明允许的路径前缀与越界决策。目标路径先做 `.`/`..` 归一化，再按段比较前缀，因此 `allowed/../forbidden.txt` 不会被当作允许路径；缺少路径参数或参数不是字符串也按越界处理。允许前缀内的目标沿用该工具的 `tools` 决策，前缀外使用 `outside`。

```yaml
tools:
  write: allow
  read: allow
paths:
  write:
    allow: ['/dsh/home/workspace/allowed']
    outside: deny
    # argument: file_path  # 默认值；参数名不同的工具可覆盖
```

越界拒绝的模型可见原因同时给出目标与允许路径，例如 `tool "write" is denied by the profile tool policy: "/dsh/home/workspace/forbidden/report.txt" is outside the allowed paths; use one of: /dsh/home/workspace/allowed`，模型据此可以改写到允许目录。`outside: ask` 时审批卡原因同样列出允许路径。

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

## 实测：真实模型越界写后改用允许路径

`tests/approval-policy-paths.e2e.mjs` 在 `browser-tool-policy` roster 上把策略替换为 `write` 仅允许 `/dsh/home/workspace/allowed`、其余 `deny`。真实模型按提示先写 `/dsh/home/workspace/forbidden/policy-paths-denied.txt`，收到拒绝原因后按原因中的允许路径重写；两次调用都来自同一个 turn 的真实模型请求。

```json
{
  "scope": "real-model-path-scoped-tool-policy",
  "turns": { "pathPolicy": 2 },
  "writeCalls": 2,
  "deniedReason": "Error: tool \"write\" is denied by the profile tool policy: \"/dsh/home/workspace/forbidden/policy-paths-denied.txt\" is outside the allowed paths; use one of: /dsh/home/workspace/allowed",
  "audit": { "deny": 1, "allow": 1, "deniedPath": "/dsh/home/workspace/forbidden/policy-paths-denied.txt" },
  "files": { "deniedAbsent": true, "allowed": "POLICY_PATHS_ALLOWED_OK\n" },
  "pageErrors": 0
}
```

越界文件不存在，允许目录文件内容正确；拒绝调用只有一条 `tool-policy/decided`，且该事件带归一化 `path` 与 `allowedPaths`。路径匹配与校验的单元测试为 `tests/browser-native-tool-policy.spec.ts`。

## 残余缺口

- 策略只按工具名与文件路径匹配，没有命令内容、进程参数或 agent scope 规则；工作区外的控制仍由 sandbox/审批层负责。
- 路径规则只认一个参数名（默认 `file_path`），不覆盖一次调用涉及多个路径的工具；也没有符号链接解析，允许前缀内的符号链接指向外部时仍按字面前缀放行。
- 策略来源是验证 profile 的 `cordis.patch.yml` 或 test port；正式产品 profile 尚未注册该插件，也没有用户可编辑策略的 UI。
- test port 的 `setPolicy` 替换内存快照，证明即时生效，但不等于正式配置热加载；没有策略版本号或审批记录关联的配置摘要。
- `deny` 的单调性依赖 `ctx.tools.guard`；已证明一个 prepended allow 监听器不能绕过，但没有覆盖恶意插件移除或替换 guard 注册、或绕过 `ctx.tools` registry 直接执行工具的场景。
- 审计事件只落在 Session log，客户端没有专门的策略决策视图；`tool-policy/decided` 在 `SessionEventMap` 中由 PoC 模块声明，删除 PoC 后这些历史事件应仅作为普通日志保留。
- 真实模型对拒绝的后续文本不保证提及原因（个别运行只回复约定 marker）；E2E 因此断言“拒绝结果 + 非空后续文本”，不断言具体措辞。
