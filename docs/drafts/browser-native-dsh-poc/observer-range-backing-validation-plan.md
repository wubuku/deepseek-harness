---
description: "验证多个只读 Browser-Native DSH Host 的有界文件驻留、私有 OPFS 缓存与生命周期。"
---

# 只读 Workspace range backing 验证计划

## 决策问题

DSH-TUI 的多挂载模型提醒我们：允许多个观察者不仅是授权问题，还意味着每个执行者都会付出文件与 Session 的资源成本。当前 writer 可以用 OPFS synchronous range backing，observer 却把每个已提交文件下载为完整 Uint8Array。多标签打开大 Workspace 时，内存随文件总量和观察者数增长；不能据“小文件只读通过”推断适合正式产品。

## 候选范围

| 候选 | 产品决策价值 | 本批安排 |
|---|---|---|
| observer 大文件驻留 | 多会话是否必须重复装入完整 Workspace | P0，实施 |
| observer 缓存与 writer 隔离 | 读取不得改写 pending、retry、control、共享 blob | P0，实施 |
| 私有临时缓存生命周期 | 正常退出和 Worker 强杀不得长期锁住资源或误删活实例 | P0，实施 |
| 有界下载与完整性 | 损坏、短读、quota 失败不得变成可读文件或 resident fallback | P0，实施 |
| 等本地锁时远端 lease 过期 | 完整 Host 是否能拒绝迟到接管 | 后续；已有直接 Worker 探针，不冒充完整 Host |
| 长离线冲突与三方合并 | rename/delete 与用户冲突决策 | 后续独立批次 |
| 多 backend metadata 与 GC | 当前单进程队列不能等同分布式事务 | 后续独立批次 |
| 大 Session hydrate 与查询 | Workspace 外仍存在独立内存成本 | 后续，不以本批替代 |
| Browser/Cloud 执行交接 | 不能迁移 Promise 或活动模型流 | 后续独立批次 |
| 老页面与新格式共存 | writer schema 已 fail closed，读缓存仍需版本命名 | 本批使用独立版本目录，不更改 IDB schema |
| 自然 eviction 与 OS crash | 真实平台丢失本地状态的行为 | 不外推；本批仅主动强杀与失败注入 |
| WASI/Shell 和 Native Bridge | 主机工具兼容性 | 保持可选，不为文件读取扩大运行时 |

## 四个交付面

1. **私有 range backing。** durable observer 使用独立、版本化、按 Workspace 与随机实例隔离的 OPFS 目录；逐块下载并验证完整 SHA-256 后才交给 VFS。只读实例不取得本地 writer、不修改共享 snapshot/control/下载 journal，不复用 writer 的独占 sync handle。同一实例相同 hash 的不同路径可以共享验证过的 bytes，并有独立 backing 生命周期。
2. **资源与失败。** 在下载前按唯一 hash 核对文件数和总 bytes 预算，运行时选项显式提供预算。每次 IO 最多 1 MiB，不分配整文件输出；损坏、短读、quota、缺少同步 OPFS 支持均拒绝，不静默回退为大 resident 数组。volatile 模式保留既有行为并明确未提供低内存保证。
3. **生命周期。** 私有目录持有独立 Web Lock 表示活实例。正常 release 关闭 backing、删除本实例目录；启动时只通过 ifAvailable 独占锁回收同一 Workspace 的遗留目录，活实例一律跳过。下载失败关闭句柄、删除 partial；Worker 强杀只由浏览器释放锁，后继可回收，不使用时间戳推断存活，不清理 writer 缓存。
4. **真实运行时证据。** 单测覆盖完整性、alias 生命周期、短 IO、预算、释放和错误；真实 Chrome Worker 验证并存、强杀、orphan 回收和 writer 数据不变。完整 DSH Host 验证大文件 observer range read、grep、revision 过期拒绝和低 VFS residentBytes，另跑同源代理真实 LLM 文件闭环、记忆及刷新恢复。

## 验收边界

记录 logical bytes、VFS residentBytes、单次 IO buffer 上限、请求与 operation 数，不能把 VFS 计数等同整个 Chrome heap 或 RSS。私有缓存是可丢弃副本，不是 Workspace durable authority；其下载仍然是 eager hydrate，不是按首次读懒下载。预算为每实例而非整个 origin；并发观察者仍增加磁盘和带宽。文件工具沿用执行前后 revision 检查，缓存存在不代表版本最新。

本批不引入第三方 VFS/Shell，不改正式 packages/apps、Agent Loop 或 Session 格式。先记录本计划和[进度](observer-range-backing-validation-progress.md)，再编码；验收失败如实记录，真实 LLM 与确定性故障证据分别报告。

## Dev Note

私有缓存优先避免与 writer 的 OPFS 独占句柄和 GC 竞争；这会付出重复磁盘成本。是否改为共享只读 handle 与 pin 协议，需要另行证明平台支持、跨实例 GC 和写权隔离，不能在本批偷换为默认方案。
