---
description: "记录 Browser-Native DSH 交互工具、浏览器存储清除恢复和 Worker 写权生命周期验证结果。"
---

# Browser-Native DSH 交互与恢复验证进度

## 当前状态

本批按[计划](browser-runtime-integrity-validation-plan.md)推进；只记录当前 checkout 实际执行的 Chrome 与 scripted DSH Agent Loop 证据。源码考古确认 storage-reset 成功重建和 snapshot 前/后 crash-window 已有独立 E2E，因此只对它们做当前 HEAD 回归，不新增重复脚本。三个新增交付面和两个既有恢复路径均已在真实 Chrome/Worker 中通过；未运行真实模型。

验证基于已合并上游 release `dsh-v0.2.1-rc.2` 的 `research` checkout。当前没有隔离 worktree；不修改正式 package、默认 Web profile 或 PoC 目录外的实现。

## 交付状态

| 交付面 | 状态 | 验收结果 |
|---|---|---|
| 默认交互工具闭环 | 通过（scripted LLM） | `default-interaction-tools.e2e.mjs` 实际显示问答 UI、提交 Yes、记录 `ask_user_question` result、执行 `working_directory` 和相对 `write`，Workspace revision `1 → 2`；`read_image` 不在模型 schema。 |
| 本地缓存清除时 backend 不可用 | 通过（manifest 503 注入） | `workspace-cache-backend-unavailable.e2e.mjs` 保留 identity cookie 和 Workspace identity，清除 OPFS/IndexedDB 后让 manifest 返回 503；用户可见状态和 Worker 状态均为 `error`，不报告空 Workspace 已同步。preview 记录一条预期 boot rejection。 |
| 双标签页 Worker 写权交接 | 通过（10 秒测试 lease） | `workspace-worker-handoff.e2e.mjs` 首 Worker 真实 DSH `write` 后关闭页面；第二页等待 lease 到期，经重试取得 fencing token `1 → 2`，续接相同 Session 并完成第二次 DSH `write`；旧 token renew/commit 均为 409。 |
| VFS mutation/snapshot 中断窗口 | 当前 checkout 回归通过 | `agent-workspace-crash-window.e2e.mjs` 保存前/后两种终止均没有原始成功 `tool/result`；恢复后以 `TOOL_OUTCOME_UNKNOWN` 结算且不重放工具调用。保存前远端 revision 保持 0；保存后 durable mutation 提交一次并恢复为 revision 1。 |

## 实施与验证记录

| 命令 | 结果 |
|---|---|
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；仅有已存在的 unsupported native platform、tsdown deprecation 和大 chunk 警告。 |
| 新增和修改的 5 个 `.mjs` 文件 `node --check` | 通过；覆盖 backend、修改后的默认能力测试和三条新增 E2E。 |
| `DSH_POC_BROWSER=chrome ... node tests/default-interaction-tools.e2e.mjs` | 通过；一次首次运行只因测试读取路径重复拼接前缀而失败，修正 harness 后通过；问答/目录/相对文件工具闭环，5 个模型请求，0 pageerror/外站请求。 |
| `DSH_POC_BROWSER=chrome ... node tests/workspace-cache-backend-unavailable.e2e.mjs` | 通过；清除本地 OPFS/IndexedDB 后 manifest 返回 503，cookie 不变、Workspace 可见状态为 `error`；一条预期的 `preview boot payload failed with HTTP 503` pageerror，无外站请求。 |
| `DSH_POC_BROWSER=chrome ... node tests/workspace-worker-handoff.e2e.mjs` | 通过；同一 Session、fencing `1 → 2`、manifest revision 2、两次业务 commit，刻意提交的 stale-token commit 与 renew 均返回 409；无 pageerror/外站请求。 |
| `DSH_POC_BROWSER=chrome ... node tests/default-profile-capabilities.e2e.mjs` | 通过；Browser schema 含 `ask_user_question` 和 `working_directory`、不含 `read_image`，受限 Bash `printf` 返回成功。 |
| `DSH_POC_BROWSER=chrome ... node tests/durable-workspace-cache-reset.e2e.mjs` | 通过；删除本地 OPFS/IndexedDB 后从同一 Workspace identity 恢复 revision 1 文件，未产生重复 commit。 |
| `DSH_POC_BROWSER=chrome ... node tests/agent-workspace-crash-window.e2e.mjs` | 通过；保存前 crash 恢复 revision 0/commit 0，保存后 crash 恢复 revision 1/commit 1；两种状态均记录 `TOOL_OUTCOME_UNKNOWN` 并允许显式后续 turn。 |
| `pnpm run test:docs` | 通过；21 个文档门禁全部通过。 |
| `pnpm run doc-sync` | 通过；43 个文档同步门禁全部通过。 |
| `pnpm run lint` | 未通过；`packages/core/tools/tests/json-schema.spec.ts:251` 报 `typescript(unbound-method)`，不是本批修改文件；另有未使用 oxlint disable warning。 |

## 经验教训与限制

首次 handoff 尝试使用 1.5 秒 lease，短于真实 Worker 初始化和首次文件工具提交所需时间；backend 正确拒绝过期 fencing token。验证改用 10 秒测试 lease并等待第二页 UI 倒计时，不能据此推断生产 lease 时长。第二页恢复的是共享当前 Session，测试必须把新 prompt 关联回原 `sessionId`；scripted 模型也必须按最新用户消息选择 marker，不能被同一 Session 历史里的旧 prompt 误导。缓存清除后的 offline 场景会触发一条可见的 status=`error` 和一条预期 preview boot rejection；验收同时检查可见状态和 error text，不把空 VFS 当成成功恢复。`agent-workspace-crash-window.e2e.mjs` 已覆盖两个 save barrier 阶段，本批只回归该脚本。

## 后续

本批使用 scripted LLM，不验证真实模型选择问答或文件工具；manifest 故障由 Playwright 返回 503 注入，不是停止真实 backend 进程；没有验证自然 eviction、Chrome OS crash、Safari/WebKit、多实例 backend 或长模型请求期间的 Workspace lease 续租。复跑命令、准确限制和后续状态见[实施计划](browser-runtime-integrity-validation-plan.md)及[兼容矩阵](operational-compatibility-matrix.md)。
