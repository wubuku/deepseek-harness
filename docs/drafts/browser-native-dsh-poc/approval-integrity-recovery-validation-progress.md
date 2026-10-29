---
description: "记录 Browser-Native DSH 审批 projection、一次性 claim、Session replay 和 Worker 刷新恢复的实际验证。"
---

# Browser-Native DSH 审批完整性与 Worker 恢复验证进度

## 状态

本批实现和 Chrome 验证完成，结论为 `complete-with-limitations`。新增的 projection 只读一个已按 Session 隔离的事件流，拒绝没有未结算 `tool/call` 锚点的审批请求；UI claim 明确不是 durable decision。真实 Worker E2E 验证正式 DSH 审批拒绝、Session `approval/asked`/`approval/decided`/`tool/result` 对账，以及审批等待期间刷新后的未知结果收束。

## 实现

`browser-native-approval-projection.ts` 从 `tool/call`、`tool/result`、`approval/asked` 和 `approval/decided` 重建 FIFO pending queue、有限参数摘要、终态和 fail-closed diagnostics。它拒绝重复 request id、未知或已结算 call、tool 名称不一致、重复 decision 和非单调事件输入；`claim()` 只改变本地 ephemeral view 并返回 `durable:false`，不会调用 `ctx.approval` 或追加 Session event。

Worker 新增 URL-gated `approval-projection-probe`，Preview 只在 `browser-native-test=approval-integrity` 时开放该测试通道。普通 preview 和默认 Browser-Native 入口不启用该 probe。正式 DSH approval service、权限 preset、Agent Loop 和 Session event schema 未修改。

## 实际验证

projection Vitest 4/4 通过，覆盖 FIFO、参数摘要上限、一次性 claim、durable replay、重复/未知/不匹配/已结算/迟到事件和非单调输入。`node --check docs/drafts/browser-native-dsh-poc/tests/approval-integrity-recovery.e2e.mjs` 通过。

Chrome 156.0.8078.48 E2E 使用真实 Dedicated Worker、真实 DSH Host、同源 scripted backend 和同源 Session API：Worker probe 得到两个 FIFO pending requests，`claimIsDurable=false`，重复 claim 被拒绝，replay 后 `allowed-once` 只来自 `approval/decided`；伪造、重复、未知和迟到输入生成六类 diagnostics，包括 tool/result 后的迟到决定。正式权限路径产生一次 `approval/asked`，Reject 后产生一条 `approval/decided(rejected)` 和错误 `tool/result`，Workspace 没有审批文件。

同一 E2E 在第二个审批请求等待期间刷新页面。刷新后原调用被结算为 `TOOL_OUTCOME_UNKNOWN`，turn reason 为 `interrupted`，审批卡数量为 0，刷新前后 LLM 请求数相同，Workspace 没有 recovery 文件。该结果证明刷新不会恢复原 Worker Promise、重发 prompt 或盲目执行受保护副作用。

真实 Chrome LLM smoke 使用 `gpt-5.6-sol` 完成普通 Browser-Native `read → write → read`、刷新恢复和同 Session/Workspace 读取：59 个 Session events、`durableThroughSeq=58`、8/8 LLM HTTP 200、两个 Workspace commit HTTP 200。该 smoke 不把真实模型是否自主触发审批作为通过条件；日志保留既有刷新 `ERR_ABORTED`、PoC API 404 和 compaction capacity warning，不宣称全 console clean。正式 `dsh-user-approval` 的四终态定义和服务语义仍以其包源码/测试为准；本批没有把 projection 当作权限服务替代物。

## 失败与经验

初次单测直接运行时导入 `dsh-user-approval`，触发 Node 侧依赖并导致 Vitest 无法解析；测试改为只导入品牌类型和事件声明，避免把 Host 权限服务加载进 projection 单测。该修正不改变 Worker 运行时依赖。

初次 Chrome 断言在 `approval/decided` 到达后误把上一轮 `turn/end` 当作当前终态；修正为同时等待对应 `tool/result` 和同一 `tool/call` 的 `turn/end`。第二次失败由 scripted marker 前缀重叠造成，已将 recovery marker 放在普通 marker 前面，并保留该测试教训。

既有 ask-user refresh 和 timed HITL E2E 初次并行运行时暴露测试夹具缺少 Session principal 注册；新增 `rememberSessionPrincipal()`，并让手动捕获 Session id 的测试在 Node-side `sessionRequest()` 前登记同源 cookie。该修复只影响 E2E 测试适配，不改变浏览器运行时或权限语义。

## 限制

projection 输入必须由调用方先绑定正确 Session；正式 approval event 没有独立 agent id，projection 不声称可以从事件自身完成 agent 过滤。跨标签页/跨设备的 answerer owner、生产认证、分布式 claim、自然 eviction、OS/浏览器进程崩溃、Safari/WebKit 和页面关闭后的后台 Agent 未验证。

本批的 `allowed-once` 是 projection 的事件重放语义，不是 Chrome E2E 中真实点击 Allow once 的证据。`rejected` 和 Worker refresh unknown 已通过真实 Chrome；取消、超时、无 answerer 的正式 approval 专门矩阵仍未执行。

## 复跑命令

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-approval-projection.spec.ts
pnpm exec vitest run packages/interaction/user-approval/tests/approval.spec.ts packages/interaction/user-questions/tests/projection.spec.ts
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-approval-projection.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-projection.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-mount.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/approval-integrity-recovery.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/permission-approval-lifecycle.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/ask-user-refresh-recovery.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_TIMED_HITL_SCENARIO=in-time node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-projection-authority.e2e.mjs
```

## Dev Note

本记录是 `docs/drafts/` 下的中文验证草稿，只记录当前 checkout 的实验事实，不改变正式权限、Session、Workspace 或 Agent Loop 的产品承诺。
