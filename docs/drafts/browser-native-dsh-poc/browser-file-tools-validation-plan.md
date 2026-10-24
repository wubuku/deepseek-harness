# Browser-Native 文件工具可用性与载荷安全验证规划

## Summary

本批次验证 Browser-Native DSH 是否能在没有主机子进程的 Worker 中可靠完成文件搜索、文件编辑、取消和真实模型闭环。重点不是增加一个能返回文本的演示，而是消除当前浏览器 profile 暴露 `grep` 却必然调用不存在的 ripgrep 子进程这一结构性缺口，并固定大文件结果、取消和真实工具 roster 的证据边界。

当前 checkout 已经证明 OPFS 外置文件可以被 DSH 的 `read`、`write`、`edit` 工具使用，但上一次大文件验证使用了 scripted 工具选择，且普通真实 LLM 验证使用了独立 validation roster。本文把这两个事实分开，避免把 scripted 选择误写成真实模型能力。

## 候选范围

下一批可降低正式产品风险的候选点包括：

| 候选点 | 主要风险 | 本批决策 |
|---|---|---|
| Worker 内置 `grep` 搜索 | 标准工具依赖主机 ripgrep，浏览器中返回 provider failure | 选择，作为 P0 交付面 |
| Worker 内置 `glob` 搜索 | 同样依赖 ripgrep，目录发现能力仍不完整 | 选择，至少验证 roster 不再把它误称为可用；若共用实现成本可控则一并替换 |
| 搜索结果上限与超长行 | 结果进入模型和 Session 时放大内存、请求体和持久化压力 | 选择，作为 P0 交付面 |
| `edit` 超长单行和大替换 | 工具成功后 Session append 可能超过请求体限制，形成状态不一致 | 选择，作为 P0 交付面 |
| 取消与背压 | 长搜索期间停止后留下未结束读取、定时器或 Worker 任务 | 选择，作为 P1 交付面 |
| 多文件批量写入与 partial failure | 单个 Agent turn 的多个文件与 Workspace receipt 可能只有部分提交 | 保留为下一批 P1，不在本批伪造事务语义 |
| 真实 Browser profile roster | 模型看见不可用 bash、web 或失败 grep 后反复尝试 | 选择，作为 P0 交付面 |
| 双标签页 writer handoff UX | 协议已验证安全拒绝，页面提示和恢复操作仍需产品化 | 保留为下一批 UX/生命周期批次 |
| 自然 eviction、OS 崩溃、多实例 backend | 需要受控设备、部署或更强故障注入 | 本批不宣称已验证；保留现有 mock 证据和限制 |
| 生产对象存储、真实大型 tool args | 超出 PoC dataDir 和当前模型稳定性范围 | 本批不实现，改为明确验收前置条件 |

## 本批交付面

### A. Browser-native `grep` fallback

在 `browser-native-providers.ts` 的 PoC 专用 `tools/execute` waterfall 中拦截 `grep`，使用注入的 `MemoryVfs` 遍历 `/dsh/home/workspace`，实现 regex、`path`、`include`、无匹配和错误语义。返回 canonical `{ matches }`，让 DSH 原有 output schema、render、presentation metadata、spill 和 Session tool/result 逻辑继续负责结果处理。搜索必须检查 `exec.signal`，并对文件数量、文件大小和扫描字节设有明确上限。

通过标准：真实 Worker 中 `grep` 不再启动 `/dsh/bin/rg`；单文件、多文件、include/path、无匹配、非法 regex、结果上限和取消均产生标准 tool/result；完整结果不进入 Session 或模型，只保留受限预览；错误后同一 Session 可以继续。

### B. 文件结果和载荷安全边界

为 Browser profile 固定并测试搜索与编辑的上限：最大扫描字节、最大文件数、最大匹配数、单行预览字节、最大 edit 行长度、最大 replacement 和最大模型可见结果。对不能在当前 Session backend 中安全持久化的 `edit` 输入 fail closed，在文件写入前返回结构化错误；不得出现文件已改、工具却因 Session append 超限而失败的假成功。

通过标准：超长行、重复 old string、不存在 old string、大 replacement、结果超限均有可识别错误或有界成功结果；成功结果的 Session append 和 Workspace receipt 可恢复；错误后不产生 Workspace commit、不重复副作用。

### C. 取消、背压和资源释放

通过模型无关的 Worker test seam 驱动慢搜索和慢读取，检查取消传播到 `exec.signal`，搜索结束后没有悬挂任务，OPFS lazy backing、reader 和 timers 可继续用于下一次工具调用。取消必须保留 DSH canonical aborted result，不把取消伪装成成功或网络错误。

通过标准：停止后出现 `turn/end` 的 `aborted` 或既定取消原因；没有未结算 tool call；同一 Session 的后续读取或搜索成功；页面、Worker 和 backend 日志无未处理错误。

### D. 真实 Browser roster 闭环

把真实 Chrome + 同域 backend + `docs/drafts/.env` 的验证切换到实际 Browser-native profile，记录模型请求中的工具 roster、真实 tool call 顺序、失败恢复、Session durable event 和刷新恢复。验证模型不会看到 `web_search`/`web_fetch`，不会把不可用 host shell 当成可用能力；如果 bash 仍保留，必须把它标为受限 Worker command table 并证明失败后停止或改走可用工具。

通过标准：真实 LLM 至少完成多轮 `grep -> read -> edit -> read` 或在能力不足时诚实失败；所有工具 call/result、Workspace receipt 和 turn/end 持久化；刷新同一 Session 后可以读取已提交结果；无跨源请求、无浏览器凭据泄露、无第二个模型循环。

## 明确不做

本批不把 `glob` 的完整产品级语义、任意大小文件的编辑、块级 delta、离线云端提交、跨文件原子事务、生产对象存储、自然 eviction、OS 级崩溃、多实例 backend lease 或 Safari 验证写成已完成能力。若实现遇到这些边界，测试必须留下失败证据和下一步，不用扩大范围掩盖风险。

## 影响范围

优先修改 `docs/drafts/browser-native-dsh-poc/browser-native-providers.ts`、必要的 PoC-only 搜索 helper、Worker 测试接缝和 `tests/`。同步更新本目录 README、兼容矩阵、change ledger、进度和 `docs/drafts/README.md`。不修改正式 Agent Loop、Session format、正式 filesystem package 或根级依赖。

## 验证顺序

1. 先用 focused unit/contract test 证明 middleware 返回值经过标准 output/post-execute 流程。
2. 再跑 scripted Chrome 的搜索、边界、取消和恢复场景。
3. 再跑真实 Chrome + 真实 LLM 的 Browser roster 多轮闭环；超时或上游不稳定时只记录实际结果，不降级为“完整通过”。
4. 最后执行 preview build、文档门禁、类型检查和 pre-push 检查，并保留脱敏摘要。

## 证据等级

- **源码事实**：当前 Worker、VFS、工具 registry 和 PoC backend 的实现。
- **自动化证据**：当前 checkout 实际执行的 Vitest、Node contract test 和真实 Chrome Playwright。
- **真实模型证据**：同域 backend 使用环境文件中的凭据发起的真实 LLM 请求；不能用 scripted 工具序列替代。
- **设计建议**：尚未由本批测试覆盖的生产级同步、对象存储和跨实例语义。
