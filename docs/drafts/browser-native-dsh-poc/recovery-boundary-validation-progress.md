---
description: "记录 Browser-Native DSH 恢复边界验证的实施进度、真实 Chrome 证据和未覆盖限制。"
---

# Browser-Native DSH 恢复边界验证进度

## 当前状态

状态：R1、R2、R3 均通过真实 Chrome 与 scripted LLM。计划、范围和退出条件见[恢复边界验证计划](recovery-boundary-validation-plan.md)。本批修改限于 PoC、preview page bridge、对应 locale、导航和变更账本；未发现隔离 worktree。

| 验证点 | 状态 | 证据 | 未完成项 |
|---|---|---|---|
| VFS mutation 到本地 durable snapshot 的 Worker crash | `passed` | `agent-workspace-crash-window.e2e.mjs`：before-save 刷新后远端 revision 0 且文件丢失；after-save 刷新后沿用 durable retry，只 commit 一次；DSH Session recovery 写入 `TOOL_OUTCOME_UNKNOWN`，同 Session 可继续 | 不消除 mutation 先于异步 snapshot 的窗口；测试不模拟 OS/browser 进程崩溃 |
| 本地 corruption 恢复包 | `passed` | `durable-workspace-corruption.e2e.mjs`：invalid metadata、missing blob、hash mismatch 均可主动下载本地 JSON 包；包保留原始记录/可读 bytes 并列明缺失或损坏 hash；远端 revision 不变 | 下载上限 64 MiB；浏览器已清除或不可读 bytes 无法恢复；不提供自动修复/导入 |
| 双标签 writer lease 等待/重试 | `passed` | `workspace-writer-expiry.e2e.mjs`：第二真实 preview 显示冲突倒计时；首 tab 续租期间重试仍被拒；释放后第二 tab 获 fencing token 2，旧 token 的 resume/renew/commit/release 被拒 | scripted backend 使用 5 秒测试 TTL；backend 当前为单进程 PoC；Safari 未测 |

## 实际验证

在 `research` 工作区执行，Playwright 使用本机 Chrome channel；三项 E2E 均使用真实 Dedicated Worker、DSH Host、OPFS、IndexedDB、同源 PoC backend 和 scripted LLM。

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-corruption.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs
```

结果：preview build 通过；三项 Chrome E2E 均输出 `result=passed`，无 page errors 或跨源请求。R1 两个 crash point 均只有一个原始 DSH write call、恢复后没有自动重放模型请求；before-save 后 revision 0，after-save 后 revision 1/commit count 1；两者都以 `TOOL_OUTCOME_UNKNOWN` 结算且第二轮继续成功。R2 三种故障的 JSON 下载可由 Playwright 读取；正确 blob 的 bytes 与 hash、缺失 blob 清单、损坏 blob 实际 hash 均正确，IndexedDB 原值未被改写，远端 revision 保持 0。R3 的 claim/renew/release 结果为冲突期间 409、释放后 claim 200/fencing token 2；旧 fencing token 操作均为 409。

其他实际检查：`pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts` 通过（2 个文件、21 个测试）；`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 通过（15 个测试）；`pnpm run verify-client-ui-i18n` 通过（938 个 Client UI 源文件）；`pnpm run test:docs` 通过（21/21）；`pnpm run doc-sync` 通过（43/43）；`pnpm run typecheck` 通过。

`pnpm run lint` 完成构建阶段，但 lint 因未修改的 `packages/core/tools/tests/json-schema.spec.ts:251` 的 `typescript(unbound-method)` 报错退出；重跑 `pnpm run lint:contracts-ready` 后确认这是唯一错误，本批修改文件未报告 lint 问题。preview build 和三项 Chrome E2E 在修复本批 lint 项及 lease E2E 的异步请求关联后再次通过。预览构建还输出既有的 native package 平台告警和 Vite chunk 大小提示；构建成功。

## 经验与限制

- `MemoryVfs` 在 mutation 已提交到内存后同步通知 sink；OPFS/IndexedDB 保存异步完成。before-save crash 会丢失仅在 Worker 内存中的 bytes；DSH Session 明确记录 `TOOL_OUTCOME_UNKNOWN`，不伪造成功，也不自动重放可能有副作用的调用。after-save crash 会保留本地 retry 并异步完成一次 Workspace commit。
- DSH Session recovery 为 unmatched `tool/call` 合成的 `TOOL_OUTCOME_UNKNOWN` 是已有正式恢复语义；本批只用真实 Worker E2E 验证它与 Browser Workspace 的实际交互，没有修改 Agent Loop 或 Session format。
- R2 恢复包是本地用户发起的诊断导出，不等价于自动修复或导入；超过 64 MiB 时导出失败，浏览器已驱逐或不可读的 bytes 不能声称可恢复。文件可能含敏感内容，界面明确提示保管责任。
- R3 倒计时是 backend 冲突响应时剩余租期的估算。租约持有者继续续租时，第二次 retry 会再次失败并刷新倒计时；每次 claim 都服从 backend fencing。PoC 当前没有空闲期自动续租验证，不能据此宣称活动浏览器标签永久持有写权。
- 本批未运行真实模型、Safari/WebKit、OS 级浏览器进程崩溃、真实存储 eviction 或生产级多实例/授权测试。
