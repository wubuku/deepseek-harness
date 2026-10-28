---
description: "规划 Browser-Native DSH 共享 Workspace 的读取线性化、revision 查询成本和长操作 fencing 验证。"
---

# Browser-Native Workspace 并发 revision 验证计划

## Summary

当前 PoC 已验证多个 Session 共享 Workspace 时的只读 observer、工具调用前 revision 检查、stale 后停止读取和显式写权接管；这些证据没有覆盖 revision 检查与异步文件工具之间的竞态。本批验证并修复当前 observer 已开放的 `read`、`grep`、`glob` 在执行期间遇到远端 revision 变化时是否会返回旧快照，并检查旧 writer 在长时间 OPFS 编辑中失去 fencing 后能否继续发布本地或云端状态。当前 Browser profile 禁用 `read_image`，既有 observer 能力清单也不开放该工具；本批不扩展图像读取能力。

本批还测量当前调用前检查下载完整 manifest 的成本；只有测量证明其传输成本随 Workspace 文件数增长且不可接受时，才新增同源轻量 revision API。Session event log、Workspace CAS、writer lease 仍是各自事实来源；本批不引入跨存储事务，不修改 DSH Agent Loop、Session 格式或正式产品 profile。

## 候选范围

| 候选点 | 优先级 | 决定 | 理由 |
|---|---:|---|---|
| Observer 工具运行前后 revision 一致性 | P0 | 纳入 | 已有检查只在线程进入工具前执行；`read`、`grep`、`glob` 可跨越异步等待，期间 owner 可能提交新 revision。 |
| Revision 检查响应随 manifest 文件数增长 | P0 | 纳入测量 | observer 每次读目前请求完整 manifest；增加工具后可能把正确性检查变成与 Workspace 大小成正比的重复传输。 |
| 长时间 OPFS edit 遇到 lease 失效或 fencing 提升 | P0 | 纳入 | 启动时持有 lease 不表示整个异步工具仍有写权；需核对晚到 VFS mutation、本地 snapshot、云端 CAS、DSH tool result 与 receipt。 |
| 同一 Workspace 多个有效 writer 自动合并 | P1 | 暂缓 | 当前服务端明确采用单 writer 和整份 manifest CAS；合并策略及用户冲突交互需另立方案。 |
| 多 backend 实例共享 lease/manifest | P1 | 暂缓 | 当前 PoC backend 将状态放在进程内存和本机 `dataDir`；该实验不能替代生产数据库事务。 |
| BroadcastChannel revision 推送 | P1 | 暂缓 | 推送只能降低发现延迟，不能取代服务端权威 revision 检查；先修复读操作自身的一致性。 |
| 自然 storage eviction、操作系统崩溃和真实对象存储 | P1 | 暂缓 | 这些属于不同故障域，不能由本批注入故障外推。 |

## 实施范围

### M0：源码与基线核对

- 确认 `authorizeFileTool()` 当前只在工具开始前核对 observer revision，并核对 `read`、`grep`、`glob` 在 `tools/execute` 中的真实调用顺序。
- 核对 Workspace revision endpoint、manifest 路由的身份校验、缓存策略、单 writer lease 和 OPFS edit 的 staging/publish 顺序。
- 记录当前 observer、CAS、lease fencing 和 edit 故障测试覆盖；不把既有测试描述为本批新证据。

### M1：轻量 revision 传输核算

- 对比空 manifest 与 1,000 个目录项的完整 manifest 和 revision-only JSON UTF-8 字节数，确认 revision 查询响应不随 Workspace entries 增长。
- 若 revision-only 响应至少比 1,000 项 manifest 小两个数量级，添加受同一 principal/Workspace 校验保护、`Cache-Control: no-store` 的 revision 读取路径；否则保留现有 API 并记录测量结果。
- backend 测试验证未认证、跨身份 Workspace ID、错误协议版本和无缓存响应；manifest 内容、digest 与 commit CAS 行为保持不变。

### M2：Observer 读取一致性

- 将 revision 检查结果作为本次只读工具的局部授权版本，不存入跨调用共享状态。
- 在 `read`、`grep`、`glob` 成功产生工具结果后重新检查权威 revision；两次检查不同则丢弃结果、将 Workspace 标记为 stale 并撤销文件工具。
- 检查网络/解析错误时不返回刚读取的文件内容；只有本次工具开始与结束的 revision 相同，才允许其结果进入 DSH Session。
- 单测覆盖未变化、revision 中途改变、第二次检查失败、writer 模式不增加只读校验、并发工具各自持有授权 revision，以及一个较早的预检响应在其他调用已标记 stale 后不能启动文件读取。

### M3：真实 Chrome 并发读写时序

- 使用两个真实 Chrome 页面、同一 BrowserContext 和两个不同 DSH Session；observer 发起延迟 `read` 时，owner 提交新 revision。
- 断言旧快照内容没有出现在成功 tool result、后续 LLM 请求或完成消息中；当前 DSH tool call 以明确 stale 错误结算，且后续 schema 撤销 Workspace 文件工具。
- 记录 observer revision 请求数、响应字节数和耗时；不把本机数字称为 SLA。

### M4：长编辑与旧 writer fencing

- 通过 Worker test port 在 OPFS chunk edit 中设置确定性屏障；在 edit 尚未发布时释放旧 lease，并让新 owner 重新读取同一路径后提交更新。
- 释放屏障后验证旧 fencing token 不能提交，旧执行不能覆盖新 owner 的云端 manifest；临时 OPFS edit staging 不得发布到旧 Worker VFS，DSH `tool/call` 参数必须留在 Session，失败必须结算为显式工具错误且不得生成 receipt 或自动重放。
- 本批接受旧 lease 拒绝后丢弃尚未发布的临时 edit staging：源文件从未变更，用户操作参数已记录在 DSH Session；恢复要求重新 hydrate 并显式重试，不承诺恢复中间 staging bytes。核对 DSH `tool/call`、`tool/result`、Workspace revision、receipt 和 IndexedDB retry batch，避免把未发布的临时文件误报为已保存。

### M5：回归与交付

- 使用真实 Chrome 跑 scripted 并发测试；再用真实 LLM 冒烟普通 `read → write → read` 和刷新恢复。真实模型冒烟不替代确定性竞态测试。
- 运行 Workspace focused Vitest、backend tests、chunk editor/receipt 相关 E2E、preview build、相关 typecheck/Oxlint、文档门禁和 `git diff --check`。
- 更新本计划进度、PoC README、兼容矩阵、`docs/drafts/README.md` 和 `change-ledger.md`；只记录本 checkout 的实现和实际运行命令。
- 完成后提交并推送 `research`，确认 `origin/research` 与 HEAD 一致、工作区干净且没有隔离 worktree 遗留。

## 明确不作的承诺

revision 前后相同只能说明工具执行区间内观察到同一服务端 revision，不是跨 Session/Workspace 原子快照；PoC 本地 backend 的成功结果不证明多实例生产部署。页面关闭仍会终止 Dedicated Worker，本批不把 Worker 描述成后台 Agent。未实测的 Safari、自然 eviction、OS 级崩溃、生产对象存储、跨设备身份和多 writer 合并仍保持未验证。
