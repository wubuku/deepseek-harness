---
description: "规划 Browser-Native DSH 下一批长期运行、并行工具、Session 失败收束和大文件写入边界验证。"
---

# Browser-Native DSH 下一批深度运行时验证计划

## Summary

当前 PoC 已覆盖单次 Worker 终止、OPFS/IndexedDB 故障、Workspace CAS、writer fencing、未知提交、文件搜索边界和 external-reference 编辑。下一批转向决定正式产品可行性的长期语义：长 Session 是否能在刷新后完整重建；一个 DSH turn 的多个只读工具调用是否仍由同一个 Agent Loop 并行调度并按模型顺序结算；模型流失败后 `assistant/attempt` 和 `turn/end` 是否能在 Browser-native Session 中可靠落盘；大文件写入是否明确暴露当前 VFS 的 materialize 上限，而不是被误称为已经解决。

本批只修改 `docs/drafts/browser-native-dsh-poc/` 的 PoC 适配和测试。验证使用真实 Chrome、Dedicated Worker、真实 DSH Host、同源 Session/LLM backend；脚本模型只用于确定性控制工具调用和故障，不替代真实模型质量验证。Safari、自然 storage eviction、OS/断电崩溃、生产对象存储和多实例 backend 仍不在本批证据内。

## 执行状态

四个交付面已经完成当前 checkout 的 Chrome 验证。M1 使用 24 轮真实 DSH turn 测量全量 hydrate；M2 使用两个只读 `read` call 验证同一 turn 的并行调度和部分失败结算；M3 注入一次 `assistant/attempt` append 503，验证有限重试、失败 turn 收束、刷新不重发和显式继续；M4 复用既有 OPFS residency 与 reference-backed edit 实现，验证标准写入的 materialize、external range backing 和 copy-on-write 源文件保护。实际命令、数值和首次测试误判记录见[进度记录](next-deep-runtime-validation-progress.md)。

## 候选范围

| 候选方向 | 价值 | 本批决定 | 未选原因或前置条件 |
|---|---:|---|---|
| 长 Session 多轮事件与刷新 hydrate | P0 | 纳入 | 长期使用直接决定 Browser-native Session 是否可用；当前 open 返回全量事件，尚未量化。 |
| 同一 turn 的并行只读工具 fan-out/fan-in | P0 | 纳入 | DSH 核心已有 bounded parallel scheduler，但 Browser Worker/provider 尚未证明真实接入；错误结算更容易暴露适配问题。 |
| `assistant/attempt` 持久化失败和显式继续 | P0 | 纳入 | 已有核心语义，Browser remote append/flush 失败路径仍缺证据；失败后误报成功会污染 Session。 |
| 大文件写入 materialize 上限与分块写入原型 | P0 | 纳入 | chunk-backed 只读/编辑原型已有，但标准 `writeFileSync`/append 的内存与持久化边界仍未形成可执行结论。 |
| 自然 storage eviction 后云端重建 | P1 | 延后 | 可模拟清除，但不能把模拟清除写成浏览器自然 eviction；需要正式用户提示和 dirty 数据恢复合同。 |
| OS 级进程/断电崩溃 | P1 | 延后 | Chrome/Playwright 无法证明真实断电；已有 Worker 强杀和 backend 重启限定性证据。 |
| 多实例 backend、真实数据库和对象存储 HA | P1 | 延后 | 当前 PoC backend 已明确单写者/本地目录边界，需先确定生产后端原子原语。 |
| 真实供应商自然断流、HTTP 半包和超时统计 | P1 | 延后 | 已有模型流故障注入与真实 LLM 普通回归；不把上游偶发超时重复包装成 Browser 语义验证。 |
| Safari/WebKit OPFS 差异 | P1 | 延后 | 当前工作节奏优先 Chrome；应在 Chrome 合同稳定后做独立兼容矩阵。 |
| Session compaction/分页读取 | P1 | 记录缺口 | 若当前 browser profile 未挂载 compaction，本批只记录未验证，不伪造支持；分页需要 Session adapter 与 UI 合同共同改造。 |
| 权限、租户切换、跨设备 Workspace 恢复 | P1 | 延后 | 需要 SaaS 身份和授权合同，不能由 PoC bearer token 推断安全结论。 |
| Worker 内 Shell/WASI、LSP、图片和二进制工具 | P2 | 延后 | 不是本批的长期 Session/文件存储核心；逐插件兼容应另有矩阵。 |

## 选定交付面

### M1：长 Session 与冷 hydrate

- 通过真实 Session API 写入多个多轮事件，事件量足以暴露全量 `open/read` 的体积和耗时。
- 让真实 Chrome 页面以同一 `sessionId` 重建 Worker，检查历史投影、`nextSeq`、`durableThroughSeq`、后续 turn 的 prompt 不重复。
- 记录事件数量、响应体大小、hydrate 时长和刷新后的新增 LLM 请求；这些是本机实验数据，不是 SLA。
- 如果 compaction 未在 Browser-native profile 中挂载，报告为“未验证/当前不支持”，不把长 Session 通过误写成无限历史支持。

### M2：并行工具 fan-out/fan-in

- scripted LLM 在同一 assistant message 中返回两个明确只读工具调用，分别带唯一 call id。
- 通过真实 DSH Agent Loop 和 Worker provider 执行；工具调用应重叠，结果事件必须按模型调用顺序结算，且每个 call/result 只出现一次。
- 让一个只读调用返回错误，另一个成功；下一次模型请求仍收到两个有身份关联的结果，并在同一 turn 生成最终回复。
- 不在 PoC 中手写第二个 loop，也不把页面并发请求数当成 Agent Loop 并行证据。

### M3：Assistant attempt 失败收束

- 注入模型半流失败，使真实 DSH Loop 写入 `assistant/attempt` 并以 `turn/end:error` 收束，不产生成功的 `assistant/message`、tool call、tool result 或 Workspace revision。
- 注入 `assistant/attempt` append 失败，检查 Worker/UI 不会把 live 文本当成已持久化成功；Session 仍只能显示明确错误或不可恢复状态。
- 刷新同一 Session 后确认不会重复原模型请求或副作用；用户发送新消息时必须是显式新 turn。
- 区分模型请求已发出、attempt append、Session flush 和最终回复四个阶段。

### M4：大文件写入边界

- 在真实 Chrome Worker/OPFS 中对比标准 `write`、`append`、external range read 和 chunk-backed copy-on-write 的 bytes、hash、resident bytes。
- 证明当前标准 VFS 写入仍会 materialize 完整 bytes，并在超过明确上限时 fail closed；不得把 64 MiB 通过写入描述为任意规模能力。
- 用模型无关 test port 验证分块外部引用能完成写入/刷新/重建，且失败时源文件 hash 不变；不把原型宣称为标准 `fs` API 或块级 delta。

## 验收矩阵

| 交付面 | 必须观察 | 通过条件 | 明确不等价于 |
|---|---|---|---|
| 长 Session | 全量事件、hydrate 时长、刷新后新 turn | 事件顺序和 seq 连续；无重复 prompt；刷新后能继续 | 无限历史、compaction、生产性能 SLA |
| 并行工具 | call/result id、开始/结束时间、错误和最终 turn | 两个只读调用重叠；结果按模型顺序且只结算一次；部分失败可继续 | 任意工具都可并发、页面请求并发 |
| attempt 失败 | raw fault、attempt、turn/end、刷新请求数 | 失败不产生成功消息或副作用；刷新不重跑；新消息显式继续 | 真实供应商所有断流、自动重试成功 |
| 大文件写入 | logical/resident bytes、hash、local/cloud revision | 标准路径边界诚实；分块原型失败保持源不变；恢复 hash 一致 | 零拷贝、通用 Node fs、块级 delta、内存 SLA |

## 实施顺序与证据

1. 先增加 backend scripted 场景和最小单测，固定多工具、半流失败、attempt append 失败的触发条件。
2. 再增加四个 Chrome 脚本，脚本只读取脱敏 event 类型、seq、hash、计数和耗时，不输出密钥、完整大 payload 或完整 prompt。
3. 每个里程碑更新进度文件，记录命令、结果、失败和未执行项；更新 `README.md`、`change-ledger.md` 和 `docs/drafts/README.md` 的索引。
4. 运行 PoC focused Vitest、backend tests、preview build、四项 Chrome E2E、文档门禁和推送前检查。

## 限制

- 当前 Browser-native Session `open/read` 返回全量事件；若本批发现大 Session 响应已成为产品阻塞，记录为后续分页/compaction 设计，不在本批隐式改 Session format。
- 并行工具只选择声明 `isConcurrencySafe` 的只读工具；Workspace write/edit 仍是 exclusive，不能由该实验推导并发写安全。
- `assistant/attempt` 的失败 append 若无法安全重试，优先保留错误和 unknown 语义，不伪造成功或自动重放模型请求。
- 大文件实验的 bytes 上限是 PoC 测试预算，不是浏览器或正式产品的通用限制；生产值需要 quota、内存、对象存储和用户体验共同标定。
