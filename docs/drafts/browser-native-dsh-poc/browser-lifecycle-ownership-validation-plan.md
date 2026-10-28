---
description: "规划 Browser-Native DSH 首次写权竞争、Chrome 生命周期恢复、本地身份连续性和多浏览器计算位置验证。"
---

# Browser-Native DSH 生命周期与写权连续性验证计划

## Summary

本批验证 Browser-Native DSH 在浏览器页面创建、缓存、冻结和恢复时，Session 与 Workspace 是否仍只有一个有效写入者；也测量多个浏览器 Worker 是否由浏览器侧运行真实 DSH Agent Loop。Chrome 进程强杀不属于已执行范围。

DSH-TUI 的 Session 事实源、执行者身份和取消不确定性原则已在 PoC adapter、handoff 与控制通道验证中覆盖。本批不重做这些协议，而检查它们在真实 Chrome 生命周期及并发初次 claim 下是否仍成立。当前证据显示恢复凭据副本已由 Web Locks 阻止，但首次 claim、真实 BFCache 往返和冻结期间 lease 到期尚未验证；Chrome 强杀后匿名身份 cookie 可能丢失，而 OPFS/IndexedDB 中的 Workspace retry 仍保留。

## 候选范围与取舍

| 候选 | 当前证据 | 决定 | 验证结论边界 |
|---|---|---|---|
| 无恢复凭据时两个页面同时 claim 同一 Session 与 Workspace | 现有 Web Locks 只保护已知资源 ID 的恢复凭据；backend 分别维护 Session owner 与 Workspace lease | 纳入 | 只判断当前 PoC backend 和页面初始化的并发语义，不外推多实例 backend。 |
| 真实 BFCache 往返、Worker 与锁的保留 | `pagehide.persisted` 只由合成事件测试 | 纳入 | 必须由真实 Chrome back/forward 导航确认页面确实进入 BFCache；未命中则记未验证。 |
| 页面冻结期间 Dedicated Worker 与 Session/Workspace lease 的关系 | 活动页面 heartbeat 已测，页面冻结后 Worker 是否继续运行未测 | 纳入 | Chrome CDP freeze 是受控生命周期实验；分别记录 Worker 继续续租与 lease 到期两种结果，不称自然标签 discard 或所有浏览器行为。 |
| 身份 cookie 丢失但 OPFS/IndexedDB 数据仍在 | 现有 Chrome E2E 可在同一 context 清除身份 cookie，同时保留本地 Workspace 数据 | 纳入 | 验证 fail-closed 和明确恢复/导出状态；不把清 cookie 当作 Chrome 进程强杀、自然过期或真实身份恢复。 |
| 多个 Browser Worker 对单 backend 的资源曲线 | 已有单浏览器容量样本；没有并发客户端下的 Agent 执行位置与 backend 负载记录 | 纳入 | 本机结果仅作相对容量诊断，不构成生产 SLA。 |
| Chrome 进程强杀、自然 eviction、OS/磁盘崩溃 | 当前有定向数据故障注入和 cookie 清除；没有本批 Chrome SIGKILL、自然 eviction 或 OS/磁盘故障实测 | 延后 | 不把页面 reload、cookie 清除或定向删除冒称进程/设备崩溃或自然 eviction。 |
| 多实例 backend、真实云存储、跨设备写权 | 共享 `dataDir` 多实例已确认会丢更新；生产协调和身份模型未选定 | 延后 | 保留已知限制，等待共享数据库、授权和部署设计。 |
| Safari/WebKit、动态插件全面兼容、WASI/Shell | 当前按约定只验证 Chrome；逐插件兼容需明确正式 profile | 延后 | 不扩大成无边界的 Node 兼容承诺。 |

## 实施顺序

### M0：确认代码与测试基线

检查恢复记录、页面 Web Locks、Session owner claim、Workspace lease、freeze/heartbeat、Chrome 强杀及容量 E2E。列出 Session ID、Workspace ID、owner epoch、fencing token、Session `seq`、turn/tool call、`operationId` 和后端请求计数的观测位置。先确认真实 BFCache 和 Chrome freeze 的测试 API 可用。

### M1：首次 claim 竞争

在两个无恢复凭据的页面上用 barrier 同时启动相同 Session/Workspace。对 Session claim 与 Workspace claim 分别制造先后顺序和响应丢失；读取 backend 持久状态确认只有一个 owner/lease 可写。若一个页面先取得 Session owner、随后 Workspace claim 失败，检查其是否释放或停止续租 Session owner。

通过条件：胜者最多发起一次 LLM turn 和一次指定 Workspace 副作用；失败者不 dispatch 工具、不报告 `synced`，也不保留有效写权。释放或 lease 到期后，显式恢复的页面取得更高 epoch/fencing；旧 token 的 append、renew 和 commit 均被拒绝。

### M2：真实 BFCache 往返

页面 A 在已存在 Session/Workspace 写权时导航到同源辅助页，再执行 back。记录 `pagehide.persisted`、`pageshow.persisted`、`PerformanceNavigationTiming.type`、Worker/channel 身份和 Web Lock 状态，证明测试确实命中 BFCache。页面 B 同时尝试获取同一资源时不得产生第二个写者。

通过条件：A 返回后控制通道仍属于同一 Worker 时必须重新确认 backend 写权后才能接受输入；若 Worker 或连接已失效，转为明确的 interrupted/unknown 并要求恢复，不重放旧 prompt 或工具调用。若 Chrome 未将页面放入 BFCache，该样本不计为通过。

### M3：页面冻结与 Worker 租约续期

使用独立 Chrome CDP session 冻结拥有者页面，持续观察 Dedicated Worker 的 Session owner 与 Workspace lease renew。冻结窗口跨过测试 lease TTL 后尝试竞争 claim，再恢复页面并读取 fencing 状态。

通过条件：若 Worker 在页面冻结时仍续租，竞争者必须被 backend 拒绝且 Session/Workspace revision 不变；若 Worker 停止续租导致 lease 到期，恢复中的旧 owner 必须先重新确认写权，旧 fencing token 不得写入。测试不将 CDP freeze 等同于自然后台冻结。

### M4：身份 cookie 丢失后的本地数据连续性

在一个真实 Chrome context 中先写入并 flush Workspace 文件，再用 Playwright 清除身份 cookie 并 reload；检查身份状态、保留的 OPFS/IndexedDB 数据、导出 bundle、远端 manifest、LLM 请求和 Workspace commit。该操作不关闭 Chrome 进程，也不模拟自然 cookie 过期。

通过条件：原身份不可确认时，旧本地数据不被附加到新 Workspace/principal，也不显示新空 Workspace 已恢复旧工作；页面显示身份缺失状态并允许导出保留的 Workspace 数据。恢复包总量上限为 64 MiB，超限时拒绝导出且不截断或修改本地数据。此实验不恢复远端 Session，也不验证身份 cookie 的自然过期或 Chrome 进程重启。

### M5：多浏览器计算位置与容量

以 1、4、8 个隔离 Chrome context 运行固定的 DSH Worker 工作负载；使用 scripted provider 保证每个 Session 的工具序列和数据量一致。记录 browser/Worker 数、各 context 的 CPU/heap/long task/动画帧间隔、backend PID/子进程/RSS/CPU、HTTP 请求与字节量、Session event 数和 Workspace commit 数。使用一个真实 LLM 的普通文件闭环作为独立接线 smoke，不把模型延迟混入容量对比。

通过条件：事件和副作用可按 Session/operation 唯一归属；每个 context 的 Host/Agent Loop 位于一个 Dedicated Worker，所有 context 使用同一个 backend PID；报告运行时测得的浏览器与 backend-harness 指标及其共享进程限制。该 PoC backend 不运行 DSH Agent Loop，因此结果不能外推为生产 backend 的进程成本。所有容量数字均标注为单机诊断数据。

### M6：文档与交付

更新本计划进度、PoC README、兼容矩阵、目录索引和 change ledger。真实模型 smoke 仅使用 backend 从 `docs/drafts/.env` 读取的凭据；检查浏览器请求、截图、Session、日志中没有模型密钥或 principal cookie。运行受影响的单测、backend 测试、preview build、Chrome E2E、真实 LLM smoke（凭据可用时）和文档门禁。

## 证据与安全规则

- scripted provider 只负责确定工具时序与容量负载；不代表真实模型选择质量。真实 LLM smoke 必须独立记录。
- BFCache 必须同时有浏览器生命周期字段证据；合成 `PageTransitionEvent` 不能替代真实返回导航。
- Chrome 强杀只作用于随机唯一 user-data-dir；按该路径确认并终止进程，不使用通用 Chrome 进程名清理。
- 诊断只记录脱敏 ID、状态码、计数、字节数和 hash；不得记录 cookie、owner token、API key、prompt 或文件正文。
- Browser Worker 仍受页面生命周期约束。本批不声称页面关闭后 Agent 继续运行。
- 不改变正式 DSH Agent Loop、Session 格式、默认 profile 或根级依赖。若必须改 `apps/web` 启动/状态投影，只做本批所需的最小接线，并在 change ledger 记录原因、验证和 upstream 重放方法。

## 非目标

本批不实现生产身份认证、跨设备恢复、跨 backend 分布式协调、自然 eviction、OS/磁盘崩溃、Safari/WebKit、Cloud Durable Worker 或完整后台 Agent。发现身份模型或多实例协调必须由产品/基础设施决策时，记录阻塞，不以 PoC bearer 或进程内 mutex 代替。
