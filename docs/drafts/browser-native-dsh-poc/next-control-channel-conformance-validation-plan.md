---
description: "规划 Browser-Native DSH Worker 控制通道的基线、序列连续性、重复去重和跳号 fail-closed 验证。"
---

# Browser-Native Worker 控制通道连续性验证计划

## 目标

验证页面与 Dedicated Worker 之间承载 owner、Workspace 状态和 pagehide 回执的控制通道是否具有可解释的连接基线和序列连续性。控制通道只投影 Worker 生命周期与写权状态；DSH Session event log 仍是对话、工具结果和模型可见上下文的事实源。

本批吸收 dsh-TUI 的 live/replay 连续性纪律，但不把 TUI Channel 协议直接移植到 Web。页面必须先接受同一 `channelId` 的基线，再接受递增 `seq`；相同序号的相同帧可去重；不同内容、跳号、协议版本或通道身份变化必须停止应用后续状态并发出诊断。刷新建立新通道，不能从页面内存补造 Worker 状态。

## 候选范围与取舍

| 验证点 | 价值 | 决定 | 说明 |
|---|---:|---|---|
| 控制通道基线与版本协商 | P0 | 纳入 | 没有明确基线时，页面无法判断首个状态是否属于当前 Worker。 |
| owner、Workspace、pagehide 帧的统一序列 | P0 | 纳入 | 当前不同通知没有共同的连续性证据，迟到或重排可能覆盖新状态。 |
| 重复帧去重与同序冲突 | P0 | 纳入 | 重试和 MessagePort 重连不能重复触发 UI 副作用；同序不同内容必须 fail closed。 |
| 跳号与未知协议的 fail-closed 处理 | P0 | 纳入 | 页面不能把丢失的 lease/owner 状态当作仍然有效。 |
| Worker 刷新后的新通道与状态恢复 | P1 | 纳入 | 证明恢复来自 Worker/Session/Workspace authority，而不是 page memory。 |
| Session event live/replay 统一投影 | P0 | 不在本批重复实现 | 当前 DSH client/Session adapter 已有独立 conformance 证据；本批只保护其旁路控制状态。 |
| Cloud Worker handoff | P0 | 延后 | 当前没有 Durable Worker executor；控制通道连续性不能替代 handoff 协议。 |
| 浏览器自然 eviction、OS crash、Safari | P1 | 不伪造 | 继续保留已有未验证边界。 |

## 设计

### 控制帧

Worker 首次绑定 `MessagePort` 时发送 `control-ready`，包含固定协议版本、随机 `channelId` 和 `seq=0`。随后所有 owner、Workspace、Workspace lease 和 pagehide ack 都使用同一 envelope，并从 `seq=1` 单调递增。payload 保持现有通知类型，页面只在 envelope 通过检查后投影它。

同一 `channelId`、同一 `seq`、完全相同 payload 的重复帧被忽略；同序不同 payload、通道变化、协议版本不支持或 `seq` 跳跃会将通道标记为 invalid，停止应用后续状态并派发可诊断的页面事件。页面不会把无序状态猜测为最新状态；用户需要刷新以建立新基线。

### 刷新与卸载

刷新会创建新 Worker 和新 `channelId`。`sessionStorage` 中的 owner/Workspace lease 只作为恢复请求材料发送给新 Worker，不作为控制帧序列或事实源。pagehide ack 仍只表示本地屏障和 lease release 的结果，不表示 Session 或云端 Workspace 已形成跨存储原子提交。

### 验收

- 单元测试覆盖首帧、合法递增、重复相同帧、同序冲突、跳号、协议版本错误和 channel 变化。
- 真实 Chrome Worker E2E 观察 owner、Workspace 和 pagehide 相关控制帧，确认刷新后新通道重新建立，页面没有把旧通道帧应用到新 Worker。
- 测试注入仅通过 PoC control test port 发送重复、跳号和冲突帧；不改 DSH Agent Loop、Session format 或正式 Client API。
- 真实 LLM 只做已有普通 `read → write → read` smoke，证明控制通道改动没有破坏 Worker、Session、Workspace 和同源 LLM 闭环；不把真实模型当作序列故障发生器。

## 非目标

本批不把控制帧作为 Session event，不实现页面关闭后的后台 Agent、Cloud Worker 接管、跨存储事务、自然 eviction、OS crash 或 Safari/WebKit 支持。控制通道失效时，页面保留最后一个已验证状态并报告 invalid；不得显示新的成功写权或已保存结论。

## 实施状态

本批已按计划完成。实现和实际命令见[进度记录](next-control-channel-conformance-validation-progress.md)；真实 Chrome 已验证基线、连续序列、重复去重、跳号/同序冲突 fail-closed 和刷新后的新通道，真实 LLM 仅完成普通文件闭环 smoke。
