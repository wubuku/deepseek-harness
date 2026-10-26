---
description: "规划 Browser-Native DSH 对复制标签页恢复凭据的隔离、单写者保护和刷新接管验证。"
---

# Browser-Native 复制标签页恢复隔离验证计划

## 目标

验证浏览器通过 `window.open()` 复制 `sessionStorage` 时，两个页面是否会用相同的 Session owner 或 Workspace lease 凭据启动两个 Dedicated Worker。Workspace `resumeId` 必须保留网络响应丢失后的幂等重试，但相同恢复材料不能让两个活跃标签页共享一个 writer token 和 fencing token。

这项风险直接关联 `dsh-TUI` 的单写 owner、会话身份和恢复原则。TUI 的进程/Channel 协议不移植到浏览器；本批验证浏览器自己的页面复制和 Worker 生命周期，并保留 backend fencing 为最终写权 authority。

## 候选范围与选择

候选覆盖恢复凭据如何产生、复制、校验、持有和失效，以及 browser lock 与 backend fencing 的责任分工。本批先处理浏览器内可复现、可能让两个 Worker 使用同一 bearer 的高风险项；多设备授权、共享 backend HA 和真实浏览器崩溃需要后续独立环境。

| 候选点 | 优先级 | 决定 | 依据与范围 |
|---|---:|---|---|
| opener 新标签复制 Workspace lease 和 `resumeId` | P0 | 纳入 | `workspace-v2.mjs` 对相同 `resumeId` 的有效重放返回同一 lease；若页面把重试身份误当成独占身份，两个 Worker 可能共享写凭据。 |
| opener 新标签复制 Session owner token | P0 | 纳入 | backend 对同 owner token 的 claim 可续租；必须单独验证 Session 锁，不能让 Workspace 锁冲突掩盖 Session 锁缺失。 |
| 同一副本同时带有 Session 与 Workspace 凭据 | P0 | 纳入 | 实际 opener 会复制整个 `sessionStorage`；需要验证页面在任何恢复请求前取得全部资源锁，并验证部分取得后冲突会释放先前锁。 |
| 有恢复凭据时浏览器没有 Web Locks | P0 | 纳入 | 无跨标签原子锁时继续恢复会让单写者保证失效；启动必须在 Worker probe/Host 和 backend 请求前 fail closed。 |
| 损坏、过长、非规范或字段超集的恢复记录 | P1 | 纳入 | 解析异常不能逃逸页面启动；未通过有限、精确校验的记录不能进入 Worker 恢复消息。 |
| 普通刷新、关闭与 Worker 生命周期的锁释放 | P0 | 纳入 | 页面销毁后要允许同一标签恢复；锁不能早于仍可能使用 bearer 的 Worker 释放。 |
| BFCache 页面离开与恢复 | P1 | 部分纳入 | `pagehide.persisted` 处理分支可由合成事件确定性触发；本批不把该测试等同真实 BFCache 跨页面往返。 |
| 新建 Session/Workspace 首次 claim 的并发竞争 | P1 | 延后 | 新凭据尚未写入 tab storage 时，Web Lock 尚无资源 ID；需要独立检查 backend claim/fencing 的竞态，而不能由本批恢复锁结论代替。 |
| 页面卸载与异步 lock acquisition 同时发生 | P1 | 纳入 | lock manager 在 `ifAvailable` 回调到达前记录本地取消状态；卸载释放 held/pending resource，晚到授权立即退出 callback。notice queue 与 `pageLeaving` 阻止卸载后新 notice 持锁或写恢复凭据。单测用延迟 grant 确定性验证；真实 Chrome E2E 覆盖已有锁在 `pagehide.persisted` 保留、正常关闭后刷新接管，但不伪称注入原生 callback 与卸载的精确调度竞争。 |
| `sessionStorage` 被禁用、配额错误或 getter 抛错 | P1 | 部分纳入 | 读取失败走 fail-closed；运行时写入失败会终止 Worker。浏览器策略差异和真实配额故障不在 Chrome 夹具覆盖内。 |
| 不同 Session、同 Workspace 与不同 principal 的锁命名隔离 | P1 | 延后 | 需要验证锁粒度不引入错误共享或错误阻塞；PoC backend fencing 仍负责最终 Workspace 写权。 |
| 后台标签冻结、锁饥饿、浏览器进程退出与锁自动释放 | P1 | 延后 | Web Locks 不提供租约超时保证；需要真实浏览器生命周期/进程测试及 backend lease 联合观测。 |
| 跨设备、跨 profile、跨 origin、跨 backend 实例 writer fencing | P0 产品风险 | 延后 | Web Locks 只覆盖同 origin/storage partition；生产服务端认证、共享 lease store 和部署级并发测试才覆盖这些场景。 |
| 自然 eviction、OS 级崩溃和 Safari/WebKit | P1 | 不伪造 | 确定性 Chrome fault injection 不代表这些外部故障，也不作为本批验收结果。 |

## 实施方案

1. 真实 Chrome 用 opener 分别复制 Workspace-only、Session-only 和完整恢复材料；browser request listener 必须在 popup 导航前安装，避免漏记启动竞态。
2. 为每个有效 Session/Workspace 恢复凭据按资源 ID 获取 Web Lock；全部取得后才向 Worker 发送恢复项、运行 probe 或启动 Host。使用 `ifAvailable` 保证冲突立即失败；Chrome 不允许该选项与 Web Locks `signal` 同用，卸载时由 adapter 标记 pending request 取消，晚到 callback 不得保留锁。冲突、缺少 Web Locks、锁调用失败或本地记录写入失败时停止 Worker，不能发送恢复 API 请求。
3. owner key 解码、Workspace JSON、ID、token、fencing 值和 UUID 使用有限精确校验；损坏数据不能使页面监听器抛错或进入 Worker 恢复消息。
4. 普通刷新/关闭先阻止新控制 notice，并在 Worker 停止或 durable pagehide barrier 完成后释放 held/pending lock；持锁页的 `pagehide.persisted` 处理不释放锁。页面锁之外仍由 backend owner/Workspace fencing 拒绝旧 token。
5. 恢复后通过真实 composer 在同一 Session 发送一个新 prompt；检查 Session 只追加一次该 user message、对应模型请求只出现一次，再对 Workspace 执行一次写入并检查唯一 commit。

Web Lock 只协调同一浏览器 origin/storage partition 内的页面，不是身份认证或服务端授权。独立设备和绕过页面 adapter 的请求仍由 backend owner/Workspace fencing 拒绝。

## 验收

- 真实 Chrome opener popup 的 Workspace-only、Session-only 和完整凭据副本在原页面存活时显示 `recovery-conflict`，没有 Session、Workspace lease 或 LLM 请求。
- 无 Web Locks 的 Chrome context 即使预载有效格式的 Session/Workspace 凭据也显示 `recovery-unavailable`，没有 Browser-Native API 请求。
- owner key、损坏百分号编码、空/超长 ID/token、坏 JSON、额外字段、越界 fencing 和非法 `resumeId` 的单测拒绝记录；确认多资源冲突会释放已取得的锁。
- 释放页面锁集合时取消尚未回调的获取；之后模拟晚到 grant 不得留下 held lock。失败的多资源获取只释放本次新取得的锁，不释放该页面原已持有的 Session/Workspace lock。
- 原标签关闭后，完整凭据副本 reload 取得锁、恢复 Session 与 Workspace；旧 Workspace token renew 返回 409，旧 lease fencing 小于新 lease。
- 同一 Session 的恢复后 composer turn 正常结束，唯一 user event 对应一个模型请求；Workspace 测试操作只产生一个 commit。
- 合成 `PageTransitionEvent({ persisted: true })` 后仍能观察到重复副本冲突；这不替代真实 BFCache 导航验收。全流程页面错误和跨源请求均为零。
- 最终代码另跑真实 Chrome/真实 LLM 的 `read → write → read` smoke，并核对 Session event、Workspace receipt、刷新恢复和模型请求计数。Scripted E2E 不替代该烟测。
- 更新 PoC README、兼容矩阵、目录索引、变更账本和本计划进度；Safari、跨设备、多实例 backend 和生产授权仍标为未验证。

## 非目标

本批不改变 DSH Agent Loop、Session 格式、Workspace backend lease API、默认 profile 或第三方依赖；不把 Web Locks 当作安全边界；不实现 Cloud Agent、页面关闭后继续执行或跨设备 owner transfer；不改造 page→Worker 的完整双向控制协议。

## 实施状态

本计划已在当前 checkout 实施；运行结果和限制见[进度](next-tab-recovery-isolation-validation-progress.md)。Web Locks 只约束同 origin/storage partition 中遵守协议的页面；服务端 fencing 仍是最终写授权，且本批不证明首次 claim 竞争、真实 BFCache 往返、后台标签恢复、原生 callback 与卸载的精确竞争或跨设备协调。
