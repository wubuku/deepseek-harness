---
description: "规划 Browser-Native DSH 下一批会话目录、只读观察、交接幂等和跨边界载荷上限验证，吸收 dsh-TUI 的投影与单写者经验。"
---

# Browser-Native DSH 会话目录与观察交接验证计划

## Summary

本批验证 Browser-Native DSH 在多个页面、刷新恢复和交接重试时是否仍能保持“Session 是事实源、一个写 owner、多个只读观察者”的基本语义。`dsh-TUI` 的可迁移启发不是终端代码，而是会话投影必须从 append-only 事件折叠、目录列表不能冒充事实、挂载集合必须明确 owner，以及跨边界消息必须有界并能诊断。

本批不把分页目录、观察者游标或 PoC backend 的 handoff 角色写成生产多实例 HA、云端 Durable Worker 或跨服务事务。每个验证面都保留 `Session seq`、owner epoch、Workspace revision 和 request/handoff id 的独立含义。

## 候选范围

| 候选验证点 | 价值 | 本批决定 | 需要证明的风险 |
| --- | ---: | --- | --- |
| handoff response 丢失后的幂等重试与查询 | P0 | 纳入 M1 | 已经提升 epoch 后重复请求可能再次交接，或因响应丢失无法判断结果 |
| checkpoint 严格校验与 flush 失败回滚 | P0 | 纳入 M1 | 不一致的 seq/revision 被当作安全点，持久化失败却已经 fencing 旧 owner |
| Session catalog 分页和只读语义 | P0 | 纳入 M2 | 大量会话拖垮首屏，缓存/列表结果被误当成完整事实或获得写权 |
| 多观察者 cursor、重复 frame 和 gap 诊断 | P0 | 纳入 M3 | 观察者丢事件后继续渲染，或者把另一个 owner 的写入误认为本地执行 |
| bridge/request/Session event 载荷上限 | P0 | 纳入 M4 | 大工具结果或深 JSON 阻塞 Worker、超出响应上限后静默截断 |
| TUI decision-event 的超时、撤销和异常隔离 | P1 | 只迁移原则 | Browser 当前没有同等插件决策注册表，直接复制会扩大范围 |
| 多 Browser owner 与只读 tab 的长时间租约竞争 | P1 | 复用已有 lease 证据，补负例 | 单写者是否能在观察者持续读取时保持 fencing |
| Session catalog 跨设备增量通知 | P1 | 不伪造完成 | 当前 backend 没有 push/cursor 通道 |
| blob/event 引用化与大工具结果分页 | P1 | 先做有界拒绝，不做完整 blob 协议 | 需要统一 Session 可见性、权限和回收策略 |
| 多实例 backend、共享数据库和生产对象存储 | P1 | 不纳入通过范围 | 当前 PoC 是单进程、单 `dataDir`，已有锁不是分布式协调器 |

## 选定交付面

### M1：handoff 幂等与安全点

`handoffId` 是一次交接的幂等键。同一 Session、同一原 owner、同一 checkpoint 的重试返回原 handoff receipt，不重复提升 epoch；相同 `handoffId` 搭配不同 owner 或 checkpoint 必须拒绝。checkpoint 必须严格校验 Session id、原 owner epoch、当前 `nextSessionSeq`、非负 Workspace revision 和有界 pending id 列表。

handoff 只有在新 owner、checkpoint 和 handoff record 一起成功落盘后才 fencing 原 owner。flush 失败必须恢复原 owner 的内存写权；响应丢失后的重试可以从持久化 handoff record 重建结果。该验证仍只证明 PoC backend 的单进程恢复语义。

### M2：Session catalog 分页

Session list 使用有界 `limit` 和稳定 cursor，默认页不能无界返回所有会话。列表项只提供 preview、状态和 Session id，不授予写权；继续操作必须重新执行 `open(access=write)` 并通过 owner lease。测试覆盖空列表、页边界、无效 cursor、重复读取和创建会话后下一页的可观察行为。

### M3：多观察者单写者

只读观察者从 `offset` 读取事件并得到 `nextSeq`、`revision`、`ownerEpoch` 和 durable cursor；它不接收 owner token，也不改变写权。观察者使用 `BrowserNativeSessionCursor` 处理 history-before-live、重复事件和 gap；写 owner 继续追加时，两个观察者都能从同一 Session 事实源恢复。测试覆盖旧 owner 被 fencing、只读观察者仍可读取、seq gap fail-closed 和 owner epoch 变化提示。

### M4：跨边界载荷预算

Session append、Session read、handoff checkpoint 和 catalog page 都有明确的元素数、字符串和 JSON 字节预算。超限请求返回结构化错误，不截断后继续执行；响应提供分页/下一游标而不是静默丢事件。工具结果仍可留在 Session 事件中，但超过预算时必须由调用方选择分页或受控引用，不能把“HTTP body 可接收”误写成 Worker 可安全处理。

## 验证矩阵与退出条件

| 交付面 | 单元/合同 | 真实 Chrome | 真实 LLM | 退出条件 |
| --- | --- | --- | --- | --- |
| M1 | 必须 | handoff E2E 增加响应重试与错误注入 | 不需要 | 不重复 epoch；flush 失败不 fencing；重启后可重建 receipt |
| M2 | 必须 | 至少一个真实页面读取分页目录 | 不需要 | 默认返回有界；只读列表不能获得写权；cursor 错误显式失败 |
| M3 | 必须 | 两个页面/观察端读取同一 Session | 不需要 | 观察者不能写；gap、重复和 epoch 变化均可诊断 |
| M4 | 必须 | 真实 Worker 触发超限请求并继续运行 | 不需要 | 拒绝是结构化且可恢复；没有静默截断或第二个模型循环 |

## 设计限制

- 本批适配器和 backend 变化只属于 `docs/drafts/browser-native-dsh-poc`，不修改正式 Session format 或 Agent Loop。
- `handoffId` 幂等只覆盖同一 PoC backend 的持久化记录；没有跨服务幂等协调、租户授权或云对象存储保证。
- Session catalog 是查询投影，不是新的事实源；列表缺页、过期或失败时必须显示不完整，而不能推断“没有会话”。
- 只读观察者不等于协同编辑者；Workspace 写入仍由独立 writer lease、revision 和 operation receipt 管理。
- 载荷拒绝不等于支持 blob 引用。真正的引用协议还需要权限、生命周期、回收、Session 可见性和恢复测试。

## Further Exploration

- [Session 适配与执行交接验证计划](next-session-adapter-and-handoff-validation-plan.md)
- [dsh-TUI 参考架构启发备忘](../dsh-tui-reference-architecture-memo.md)
- [Browser-Native PoC README](README.md)

## Dev Note

本计划根据 `dsh-TUI` 当前 checkout 的 Session projection、mount heartbeat、effect ledger 和 bounded decision dispatch 源码制定。它记录验证目标，不把候选项或设计建议写成已实现能力。
