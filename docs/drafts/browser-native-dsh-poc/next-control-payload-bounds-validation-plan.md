---
description: "规划 Browser-Native 页面与 Worker 控制帧的严格字段、载荷预算和恶意/损坏输入验收。"
---

# Browser-Native 控制通道载荷约束验证计划

## 目标

验证页面与 Dedicated Worker 的控制协议能否在不解析无限制对象、不静默接受未知字段、也不把损坏状态投影为成功状态的前提下处理生命周期通知。`dsh-TUI` Channel 对 JSON 深度、大小和未知方法采用显式拒绝；Browser-Native 控制帧需要适配同一原则，但不复用 TUI 的 wire protocol。

本批延续已完成的 `channelId/seq` 连续性验证，专门检查 frame schema、字符串字段和总载荷大小。Session event log、Workspace manifest 和模型请求保持现有 authority，不改变 Agent Loop、Session 格式或持久化协议。

## 候选范围与取舍

| 验证点 | 价值 | 决定 | 原因 |
|---|---:|---|---|
| 控制帧 exact-key schema 和字段长度上限 | P0 | 纳入 | 当前 validator 接受额外属性和无界字符串；去重前的 `stableJson()` 会遍历未约束数据。 |
| 序列连续性、重复去重和刷新新通道 | P0 | 复用现有证据 | 上一批已由单测与真实 Chrome E2E 覆盖，不重复实现。 |
| 过大、未知字段、未知通知和循环结构的 fail-closed | P0 | 纳入 | JSON 深度/字节限制不能由 TypeScript 类型替代；结构化克隆允许循环引用，validator 必须在规范化前拒绝。 |
| 控制错误诊断中的原始 frame 和凭据暴露 | P0 | 纳入 | 诊断只应包含固定错误码和有限元数据，不应把未经验证的原始 payload 转发给页面监听者。 |
| invalid 后刷新建立新 receiver、重新发布 Worker 权威状态 | P1 | 纳入 | 证明拒绝通道后可由新 Worker 建立新基线，而不是沿用页面内存中的控制状态。 |
| 突发消息吞吐、MessagePort backpressure 和队列上限 | P1 | 暂缓 | 当前只需验证单 frame 资源有界；没有控制消息高频生产者或产品级吞吐目标，不能从人工 flood 推导 SLA。 |
| Session 与 Workspace 工具结果的 blob 引用/分页 | P1 | 后续独立批次 | 这是另一条跨存储数据协议，不应与生命周期控制帧预算混成一批。 |
| 自然浏览器消息丢失、OS 崩溃和 Safari/WebKit | P1 | 不伪造 | 本批通过确定性坏帧验证 validator，不声称测得浏览器自然故障率或跨浏览器能力。 |

## 实施范围

- 为 `control-ready`、`control-frame` 和每种 notice 定义 exact-key 字段集合；未知字段、未知 notice、非安全整数和非法字符串均拒绝。
- 为 ID/token/error/message 字段设定明确 UTF-8 byte 上限，并限制完整 frame 的序列化 byte 数；只在 schema 验证和大小预算通过后生成去重 fingerprint。
- validator 必须在递归或序列化前拒绝额外嵌套对象、循环引用和非 plain object，避免用 `stableJson()` 遍历任意结构化克隆对象。
- invalid 事件只发布固定 reason code；不派发未经验证的完整 frame、owner token、Workspace writer token 或任意字符串。
- 通过仅由 PoC test query 暴露的 test port，在真实 Chrome Worker 中注入未知字段、未知 notice、超长字符串、循环引用及有效边界 payload；每个 invalid case 之后刷新并验证新 channel baseline 与 Workspace 状态恢复。
- 单测覆盖每类 notice 的 schema、UTF-8 byte 边界、exact limit、limit+1、危险整数、循环结构、旧/新 channel、重复和连续序列。
- 使用真实同源 backend 的真实模型 `read → write → read` smoke 确认 wire validator 改动没有破坏现有 Agent Loop；真实模型不承担坏帧发生器职责。

## 验收标准

1. 字段集之外的属性在 `stableJson()` 或其他规范化前被拒绝；无效帧不会更新 Workspace 状态、owner token 或 lease。
2. 合法最大 payload 可接受；超限 payload 得到固定 `CONTROL_FRAME_TOO_LARGE` 或字段专用错误码，不造成页面/Worker error。
3. 循环引用、未知通知、未知协议版本和危险整数都得到确定的 fail-closed 结果，页面诊断不含注入的凭据或超长文本。
4. fail-closed 后，刷新建立不同 `channelId`，Worker 重新发布 authoritative Workspace 状态；原 receiver 不复用。
5. Chrome E2E 无外站请求、无未处理页面/Worker 错误；真实模型 smoke 的 DSH Session event、工具结果、Workspace receipt 与刷新恢复保持一致。
6. 更新 PoC README、兼容矩阵、drafts 索引与 change ledger；记录运行命令、实际结果和未验证限制。

## 非目标

本批不改 Session event 或工具结果载荷协议，不将控制帧写入 DSH Session，不实现 backpressure、后台 Agent、Cloud handoff、生产认证、跨存储事务、自然 eviction、OS crash 或 Safari/WebKit 支持。

## 实施状态

本批规划已写入；实际实现和验收结果以[进度记录](next-control-payload-bounds-validation-progress.md)为准。未执行的检查不得标为通过。
