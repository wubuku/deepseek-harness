---
description: "规划 Browser-Native DSH 并行 Agent Loop、多 backend 共享 authority 与 Workspace writer fencing 的交叉验证。"
---

# Browser-Native 并行 Agent 执行验证计划

## Summary

本批检查多个真实 Browser Worker 同时执行各自 DSH Agent Loop 时，Session 事件是否仍按 Session 隔离、共享 Workspace 是否维持单写者，以及接管后旧工具操作是否被 fencing。Chrome E2E 使用两个 backend 和一个共享 PoC authority；真实 LLM 只作为独立烟测，不替代确定性竞态证据。

## Table of Contents

- [候选评估](#候选评估)
- [验证范围](#验证范围)
- [验收标准](#验收标准)
- [限制](#限制)

-----

## 候选评估

本批检查的 DSH-TUI 参考 checkout 是干净的 `main`。其 `AgentSession` 将 history、live subscribe、submit、cancel 和 dispose 归于一个明确 Session handle；事件以 seq、turn、step、attemptId 和 callId 标识；多个 Channel observer 不代表多个 writer。迁移到 Browser-Native DSH 时，仍须由 DSH Session event log 和远端 Workspace authority 分别裁决事实与写权，不能复用 TUI Channel 协议或把多个 Worker 的内存状态合并。

| 候选验证点 | 失败后果 | 本批决定 |
|---|---|---|
| 两个独立 Worker 的 DSH Agent Loop 同时发起模型请求 | 隐藏的全局串行化、Session 串线或一页阻塞另一页 | 纳入 M1，以 Playwright route barrier 证明两次请求重叠 |
| 两个 backend 经 round-robin 同时服务不同 Session | backend 本地缓存可能被误当成共享事实，或 owner 授权不一致 | 纳入 M1/M2，共用单独的 PoC authority，并核对 backend 命中 |
| 一个 Workspace owner 与 observer 并行使用真实 DSH 文件工具 | observer 可能读取未提交状态、写入共享 VFS 或错误产生 receipt | 纳入 M2，覆盖 owner write、observer committed read 和 forged write 拒绝 |
| Workspace lease 转移时旧 Worker 仍执行长时间 `edit` | 旧工具可能覆盖新 revision、留下虚假成功 receipt 或破坏后继本地快照 | 纳入 M3，复用 32 MiB OPFS copy-on-write 编辑屏障 |
| authority OS 进程强杀并重启后的 Session/Workspace 恢复 | 进程内状态可能被误认为 durable；崩溃后 unknown operation 可能被盲目重放 | 另列后续批次；本批 authority 只按既有进程内共享状态测试启动 |
| backend 协议新旧版本混跑、schema migration 和版本回滚 | 节点滚动期间可能静默降级或误读数据 | 另列后续批次，需要独立协议版本矩阵与至少两个构建版本 |
| 云端 Durable Worker 与 Browser Worker 的显式 handoff | 可能被误称为页面关闭后继续运行，或迁移未结算 Promise | 不纳入；当前没有 Durable Worker 执行环境 |
| provider 自主产生真实多 Agent 冲突和复杂 tool args | 模型非确定性会混淆并发协议证据 | 只执行真实 LLM 工具烟测，不以其作为并发裁决证明 |

## 验证范围

### M1：两个实际 DSH Loop 同时运行

使用真实 preview 页面、Dedicated Worker、DSH Cordis Host 与 `ctx.agentLoop`。两个页面在同一 Chrome BrowserContext 中打开独立 Session，均使用共享 Workspace，其中一页取得 writer lease，另一页以 observer 启动。测试在两个目标 `/api/browser-native/llm` 请求到达时设置 Playwright route barrier，确认两个用户消息分别只写入各自 Session，且两次请求同时挂起；随后同时放行并确认两个 turn 各自结束，没有重复 prompt、跨 Session tool/event 或页面错误。

### M2：双 backend、共享 authority 和 Workspace 单写者

两个 backend 通过 round-robin 同源代理访问独立 authority。owner 使用真实 DSH `write` 提交文件；observer 使用真实 DSH `read` 读取已提交文件，并让 scripted 模型尝试未发布的 `write`。检查 observer 工具 roster、错误结果、Workspace revision、operationId、Session receipt 和两个 backend 的命中记录。backend 本地 Session/Workspace store 不得成为恢复或读取回退。

### M3：旧 owner 长 edit 与新 owner DSH turn 交叠

owner 在 OPFS 上对 32 MiB 文件执行真实 DSH `edit`，测试在 copy-on-write 阶段暂停。owner 显式释放 Workspace lease 后，另一页面获得更高 fencing token，并在同一文件上执行新 Agent turn。确认新 owner 的 revision 和文件内容唯一有效；旧 edit 以工具错误结算，不写 Workspace receipt、不发布本地变化、不自动重放原工具调用。两个 Session 各自保留原始 tool call/result 与 turn 终态。

### M4：真实模型烟测与交付

用 `docs/drafts/.env` 在 Node backend 进程配置真实模型，使用 Chrome 验证至少一轮模型自主调用 DSH 文件工具、Session StreamChunk、可见 DOM 增量样本、durable watermark 和刷新后同 Session 续聊。分别记录模型响应分块与可见 UI 更新；Session 有多个 chunk 不代表页面渐进渲染已通过。工具调用计数为零时只记作模型聊天烟测，不记为真实工具闭环。该结果不能替代 M1/M2/M3 的 scripted 竞态证明。

## 验收标准

1. route barrier 观察到两个不同 Session 的模型请求同时在途；两个 turn 各完成一次且 Session 事件没有交叉。
2. 两个并发 LLM 请求分别由不同 backend 处理；Session owner、Workspace lease、manifest revision 和 operation 由共享 authority 裁决，两个 backend 的本地记录保持为空。
3. observer 只能使用 `read`、`grep`、`glob`；模型发起的隐藏 `write` 被真实 Worker capability guard 拒绝，不新增文件、commit 或 Workspace receipt。
4. 新 owner 获得更高 fencing token 后，其文件版本保持最终远端状态；旧 Worker 的迟到 edit 不发布、不产生成功 receipt，原 tool call 不重放。
5. 浏览器请求均同源；无页面错误；诊断不输出 bearer、writer token、真实模型凭据或完整模型请求。
6. 真实 LLM 证据单独记录具体模型、轮数、tool call 数、Session events/watermark 和刷新恢复结果；未完成项明确列出。

## 限制

本批验证同机 Chrome、单个 Node PoC authority 进程、两个 backend 进程、两个 Browser Worker 和当前脚本化服务响应。它不证明跨主机网络分区、生产数据库事务、生产多租户授权、authority OS 进程 crash consistency、Cloud Durable Worker、自然 eviction、Safari/WebKit 或模型自主处理竞态的可靠性。`dsh-TUI` 的 Channel 生命周期和能力语义仅作为设计参考，不构成 Browser-Native DSH API 兼容承诺。

## Dev Note

此计划仅指导 `docs/drafts/browser-native-dsh-poc/` 中的 PoC 测试与记录；不修改正式 Agent Loop、Session 格式、package、app 或根依赖。
