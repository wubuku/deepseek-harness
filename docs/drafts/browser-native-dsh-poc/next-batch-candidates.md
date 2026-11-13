---
description: "基于 dsh-TUI 只读参考的第二批 Browser-Native DSH PoC 高价值验证候选评估、取舍记录与本批选择。"
---

# 第二批高价值验证候选（含取舍记录）

## Summary

本页回答一个问题：在正式产品开工前，下一批最值得攻关的 Browser-Native 技术难点是什么。评估参考了本仓库既有的 [dsh-TUI 参考架构启发备忘](../dsh-tui-reference-architecture-memo.md)，并对 `/Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI` 提交 `29572774890a4a89ae1fa562dd15a1ae21bb3593` 做只读阅读（不写、不改、不构建、不 fetch/push）。

评估口径沿用备忘的五项纪律：Session 事件是事实源、live 与 replay 同语义、能力要经声明/探测/发布三段、跨边界状态要有版本连续性、执行者恢复要沿用原身份并显式报告不确定性。一个候选只有落在这些纪律上，或直接补齐 CURRENT-STATE 的未闭环项，才算高价值；纯 UI 打磨与文档补写不进入本表。

本批选择两项实施：**能力发布链**（声明→探测→模型 schema→审计报告）与 **durable 流重连连续性**（断线续读、不重放 prompt、gap 显式失败）。取舍理由见[本批选择](#本批选择)。

## 候选表

价值分三档：**阻断**＝不做就无法宣称产品承诺；**分水岭**＝决定架构能否扩展到多执行者；**证据缺口**＝已有实现但缺少可复验证据。成本按当前仓库改动面估算，不含不可本地闭环的外部基础设施。

| # | 验证点 | 价值 | 主要风险 | 成本 | 当前环境可闭环 | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 待决审批跨宿主重启：决策一次性且不重放工具 | 阻断 | 重启后的审批若被误当作有效，会重放副作用 | 中 | 是（可先固定“结算后拒绝决策”的保守语义） | 备忘「取消和销毁必须报告不确定性」；CURRENT-STATE 未闭环项 |
| 2 | 能力发布链：声明→运行时 probe→模型 schema→审计报告 | 分水岭 | 静态 manifest 让模型看到不可执行工具，只能反复试错 | 中 | 是 | 备忘「能力声明、探测和发布是三个阶段」 |
| 3 | 取消/销毁结果矩阵：confirmed / unknown / failed | 阻断 | 网络失败被误报为“已取消” | 低 | 是（现有 stop 已覆盖多数分支） | 备忘「取消和销毁必须报告不确定性」 |
| 4 | durable 流重连连续性：fromSeq 续读、去重、gap 拒绝、不重放 prompt | 分水岭 | 刷新/断线后重复执行或漏事件 | 低 | 是 | 备忘「live 与 replay 是同一份语义」 |
| 5 | 多观察者/单写者三方 fencing：两个 Worker + 一个 durable 同时存在 | 分水岭 | 双写产生重复副作用 | 中 | 是 | 备忘「Multi-observer/single-writer」 |
| 6 | 主 composer 图片附件接 durable start | 证据缺口 | 附件上传仍走 Worker，与 durable-first 主路径割裂 | 中 | 是 | CURRENT-STATE 未闭环项 |
| 7 | 按 turn 的 token/成本记账与预算硬停 | 阻断 | 预算条只展示不阻断，超支不可控 | 中 | 是 | 备忘「用量与配额」；现有预算条 |
| 8 | 长会话上下文压缩/检查点在 durable 路径 | 阻断 | 长任务撞上下文上限后整轮失败 | 高 | 是（工程量大） | 备忘 token 归因结论 |
| 9 | 服务端全文索引接 durable 事件（SQLite） | 证据缺口 | 线性全文回退在规模下退化 | 中 | 是 | CURRENT-STATE 未闭环项 |
| 10 | 归档保留期自动调度与归档后打开 | 证据缺口 | 仅管理员显式归档，治理不闭环 | 低 | 是 | CURRENT-STATE 未闭环项 |
| 11 | Session 引用绑定租户/用户/Workspace/执行者 | 分水岭 | 裸 UUID 让不同执行者被误认为拥有同一写权 | 中 | 是 | 备忘「Session 身份和后端身份不能混为一个裸字符串」 |
| 12 | 模型路由回退与提供商故障转移（真实端点） | 阻断 | 单端点故障直接导致全量失败 | 中 | 是（需真实调用） | 备忘「不要在恢复时自动换执行权威」的反向要求 |
| 13 | 副作用幂等 receipt 跨重试与重启 | 分水岭 | 重试导致重复写 | 中 | 部分（已有 edit receipt 覆盖） | 备忘「安全点」 |
| 14 | 有界 bridge payload：超大/超深工具结果分页或 blob 引用 | 证据缺口 | 大结果撑爆 frame 或 Session | 中 | 部分（已有 payload bounds） | 备忘「Bounded bridge payload」 |
| 15 | 外部 Session 导入（Claude/Codex 风格）后续聊 | 中 | 格式不可忠实回放，导入后不可继续 | 高 | 是（但偏离浏览器执行面） | dsh-TUI `migrate/` 与外部来源标签页 |
| 16 | Session mount：一个 Session 作为另一 Session 的只读上下文 | 中 | 上下文注入与写权混淆 | 中 | 是 | dsh-TUI `session-mount-runtime.md` |
| 17 | 轨迹/活动流（trajectory、working activity）进 Web UI | 中低 | 只是可观测性提升 | 中 | 是 | dsh-TUI `src/trajectory/`、`working-activity.ts` |
| 18 | 多智能体团队：并行子代理、配额与取消传播 | 阻断 | 单层嵌套无法支撑真实并行任务 | 高 | 部分（可先做并发与取消传播） | dsh-TUI `agent-teams-design.md` |
| 19 | 跨主机 HA / 跨节点关页接管 | 分水岭 | 单进程 dataDir 锁与 owner token 不支持多实例 | 最高 | 否（需多实例基础设施） | CURRENT-STATE 不可测项 |
| 20 | Safari/iOS 真机执行面、KMS/HSM、租户硬阻断与账单 | 阻断 | 缺真机与托管密钥，硬配额未实现 | 高 | 否（外部依赖） | CURRENT-STATE 不可测项 |

## 本批选择

### 选中 1：能力发布链（#2）

理由：当前 durable host 把 `DURABLE_TOOL_DEFINITIONS` 整表交给模型，工具能否执行只由运行期 try/catch 体现。这违反备忘的三段纪律：声明不等于 probe，更不等于已对模型发布。它同时是“模型先看到工具再反复试错”这一产品体验问题的根因，且可用 scripted 模型直接断言“发给模型的 tool 列表”。

本批做法：为每个工具记录声明、probe 结果与发布状态；probe 失败的工具不进入模型 wire；新增只读报告入口，列出每个工具的 `declared/probed/published/reason`，并纳入 metrics 快照。验收断言是“未 probe 通过的工具不出现在模型请求的 `tools` 中，且报告能解释原因”。

### 选中 2：durable 流重连连续性（#4）

理由：`/session/durable/stream` 已支持 `fromSeq`，但没有证据证明断线重连不重放 prompt、不丢事件、对 gap 显式失败。这是备忘列为第一优先的 “history-before-live / 重连连续性”，也是产品“刷新后继续”承诺的底层保证。成本低，收益是可复验的硬结论。

本批做法：新增 E2E，在流中途主动断开，从已收到的最后 `seq` 续读，断言续读首事件不重复、事件序列连续、prompt 只提交一次；再伪造一个越界 `fromSeq` 断言显式错误而不是静默补洞。

### 本批未选与理由

- **#1 审批跨重启**：与 #2 同属高价值，但它需要先固定“重启后审批是否允许继续”的产品语义；本批先把能力发布与重连证据补齐，下一批再按保守语义实施。
- **#3 取消矩阵**：现有 `durable-cancellation` 与 `durable-approval` 已覆盖运行中、待审批、重复 stop 与外域 stop；缺口主要是网络未知态，留到与 #1 的恢复语义一起做。
- **#5 三方 fencing**：已有共享 viewer/editor 与 owner epoch 证据，扩展为三方需要新的测试编排，成本与 #2 相当但产品紧迫性略低。
- **#6 附件接 durable start**：服务端已能接收附件，缺的是页面从 composer 取附件引用；浏览器侧改动面比本批两项大，留作下一批。
- **#7 预算硬停**：与 #8 上下文压缩共享“用量”数据模型，等 #8 一起设计更省返工。
- **#11/#12/#18**：均需新的数据模型或真实端点矩阵，单批做不彻底，拆到后续批次。
- **#19/#20**：当前环境不可闭环，保持“不可测项”记录，不做伪验证。

## 记录在案

- 本页的候选排序会随证据变化；实施后应把结论写回 [CURRENT-STATE](CURRENT-STATE.md) 与对应 owner 文档，而不是只留在本页。
- 参考项目只读：本批不引入 dsh-TUI 的 TTY、Node 进程或本地路径假设；只迁移“声明/探测/发布”与“重连连续性”两条纪律。
- 每个选中项独立提交，提交正文写动机与证据；涉及 `packages/` 时先 `build:artifacts` 再 `build:check`。
