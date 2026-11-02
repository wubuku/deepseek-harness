---
description: "定义跨标签审批归属语义：审批决策权属于 Session 拥有者标签，并发标签在触达后端前失败关闭；拥有者退出后的待决审批只结算一次且不再重问。"
---

# 跨标签审批归属验证计划

## Summary

本批用双页 harness 验证浏览器多标签下的 HITL 审批语义：谁有权结算一个待决审批、第二个标签能否重复审批、以及拥有者标签退出后恢复投影是否正确。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 审批决策权属于谁 | 当前持有该 Session recovery lock 的拥有者标签 | 审批会驱动工具执行与副作用，必须与唯一写入者绑定；观察者标签决策会绕过单写者约束。 |
| 并发第二标签能否显示可操作审批 | 不能，必须失败关闭且不触达后端 | 第二标签拿不到 Session 锁，若仍展示按钮会制造“已批准”的错觉并产生竞态。 |
| 拥有者标签退出时待决审批如何处理 | 结算一次为 `TOOL_OUTCOME_UNKNOWN`，`approval/asked` 保留，不追加 `approval/decided` | 审批是运行中 Worker 的远程交互；Worker 消失后无人能安全执行该工具的副作用，重问会重复暴露权限。 |
| 恢复后投影 | 从 durable `approval/asked` 与已结算工具结果重建，不显示审批卡片 | Session 日志是唯一事实来源；恢复标签必须看到“请求存在但已失效”。 |
| 恢复后是否重试工具 | 否 | 与既有 open tool fork 语义一致：未知结果不重放。 |
| 是否提供实时观察者标签 | 不在本批实现 | 实时观察者需要独立的只读投影通道与原子决策 API；本批只验证“唯一拥有者 + 恢复投影”。 |
| 未来观察者若开放审批 | 决策必须由单一权威原子结算，重复决策拒绝 | 设计约束：任何多客户端审批入口都必须先做 durable claim。 |

## 实施设计

### M0：双页 harness

`context.on('page')` 追踪所有标签的请求；拥有者标签启用 `browser-native-durable=1` 与 `browser-native-test=approval-integrity`，通过真实 composer 触发 `bash` 审批请求；`window.open` 克隆 `sessionStorage` 得到并发标签。

### M1：归属与单次结算

并发标签在拥有者持锁期间必须进入 `recovery-conflict`，且后端请求数为 0、审批卡片数为 0。拥有者拒绝后断言 1 个 `approval/asked`、1 个 `approval/decided`、1 个工具结果。

### M2：拥有者退出与恢复投影

第二次审批待决时关闭拥有者标签，克隆标签 reload 接管同一 Session；断言审批卡片 0、工具结果 `TOOL_OUTCOME_UNKNOWN`、`approval/asked` 仍为 2、`approval/decided` 仍为 1、无新模型请求、审批工具未执行。随后新 prompt 完成一轮，且不重问、不重放。

## 验收矩阵

| 场景 | 通过条件 | 禁止结论 |
| --- | --- | --- |
| 并发第二标签 | `recovery-conflict`；0 后端请求；0 审批卡片 | 第二标签能读 Session 等于能审批 |
| 拥有者拒绝 | 1 asked、1 decided、1 工具结果 | 两个标签都能打开卡片 |
| 拥有者退出 | 1 个 `TOOL_OUTCOME_UNKNOWN` 结果；0 decided；0 卡片；无新模型请求 | 恢复后自动重问审批 |
| 恢复后继续 | 新 prompt 完成；asked/decided 计数不变；审批文件未生成 | 恢复等于重放被中断的工具 |
| 页面/Worker/跨源错误 | 全部为 0 | 多标签同步靠轮询容错 |

## 证据边界

只覆盖 Chrome 156 同 BrowserContext 的 `window.open` 克隆标签、durable Session、`approval-integrity` scripted 审批与 `bash` 工具。不含真实模型审批、独立只读观察者、跨设备接管、Workspace lease 打开时的审批交接、Safari/WebKit 或浏览器崩溃。

## 删除条件

当正式客户端提供多标签只读投影与原子审批结算，并迁移 `cross-tab-approval.e2e.mjs` 时删除本批结论；或者移除 Browser-Native DSH PoC。
