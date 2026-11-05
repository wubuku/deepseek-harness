---
description: "1,000 Session 冷启动、store.load() 内存与首个 turn 延迟实测，对照启动线性增长的扩展触发条件给出单节点容量上限和优化顺序。"
---

# 启动规模与单节点 Session 上限

## 判定

在 1,000 Session（每个 50 条事件）、4 个 Workspace、12 个附件对象、1,000 条审计记录的 `dataDir` 上，`store.load()` 133.8 ms / 17.9 MiB，整机冷启动 231.4 ms，首个 durable turn 35.4 ms。三项都远低于预算，1,000 Session 仍有一个数量级的启动时间余量，因此本批不实现索引或懒加载，继续以测量守住[横向扩展](multi-instance-feasibility.md#触发扩展的可测量条件)中的“启动恢复退化”触发条件。

## 可接受阈值

| 指标 | 默认预算 | 覆盖方式 | 取值理由 |
|---|---|---|---|
| `store.load()` 耗时 | 5,000 ms | `DSH_POC_STARTUP_LOAD_BUDGET_MS` | 与整机冷启动 10 s 预算配合，给 Workspace、journal 与 durable 恢复留一半 |
| `store.load()` 堆增量 | 256 MiB | `DSH_POC_STARTUP_HEAP_BUDGET_BYTES` | 1 GiB 容器里给 JSON 事件常驻留出空间，不含附件字节 |
| 冷启动（create + listen） | 10,000 ms | `DSH_POC_STARTUP_COLD_BUDGET_MS` | 发布前的重启护栏；超过即触发扩展立项 |
| 首个 durable turn | 2,000 ms | `DSH_POC_STARTUP_TURN_BUDGET_MS` | scripted 模型下的客户端可感知上限 |

阈值可由环境变量覆盖；测量脚本在最大规模处断言，规模与事件数可用 `DSH_POC_STARTUP_SIZES`（默认 `0,250,1000`）与 `DSH_POC_STARTUP_EVENTS`（默认 50）调整。

## 测量结果

| Session 数 | `store.load()` | 堆增量 | 冷启动 | 首个 turn |
|---|---|---|---|---|
| 0 | 0.1 ms | 0.0 MiB | 15.7 ms | 29.2 ms |
| 250 | 33.7 ms | 4.5 MiB | 64.4 ms | 28.9 ms |
| 1,000 | 133.8 ms | 17.9 MiB | 231.4 ms | 35.4 ms |

一次 macOS 本地运行（Node 22、系统 `tmpdir`、scripted 模型、回环 HTTP）。从 250 到 1,000（4 倍 Session）`store.load()` 增长 3.97 倍，符合线性；脚本断言超过 8 倍视为退化。堆增量同样按 Session 线性增长，每 Session 约 18.3 KiB（50 事件，约 0.37 KiB/事件）。

## 单节点上限

按实测斜率外推：

- 时间约束：5,000 ms / 0.134 ms ≈ **37,000** Session；14,300 Session 时 `store.load()` 约 1.9 s，冷启动约 3 s。
- 内存约束：256 MiB / 18.3 KiB ≈ **14,300** Session。

两者取小，**单节点建议上限约 14,000 Session（每个 50 事件）**，受堆内存约束而不是启动时间约束。事件数是更强的影响因子：若平均 200 事件，每 Session 约 3.5 倍堆，上限降到约 4,000；若平均 500 事件，降到约 1,400。上限另外受 `dataDir` 单写者、Session 事件全量常驻内存两个既有约束限制（见[横向扩展可行性](multi-instance-feasibility.md#单节点约束)）。

## 优化点

只有实测继续接近预算时才按下列顺序落地；当前优先级是保持测量而不是提前做索引。

1. **Session 索引**：flush 时原子写 `sessions/index.json`（id、principalId、header、eventCount、durableThroughSeq、mtime），`load()` 只读索引，Session 记录和事件按需读取；启动从 O(bytes) 变为 O(metadata)。
2. **事件分段与偏移索引**：事件改为追加段文件，按 seq 区间读取，避免每次冷启动 parse 全量 JSON。
3. **活跃集 LRU**：内存只保留最近读写的 Session 事件，其余从磁盘重读；把堆上限与 Session 总数解耦。
4. **去掉逐 Session `stat`**：mtime 来自索引，或在 `readdir` 后用一次批量 stat；当前每个 Session 多一次 syscall。
5. **Workspace 按需加载**：`workspaces/` 只预读 principal→workspace 映射，Workspace 元数据在首次访问时读取。
6. **审计内存截断**：`restore()` 为验证哈希链要解析全部行，但内存只保留 `ACCESS_AUDIT_LIMIT`（200）条；1,000 行已验证在预算内，行数继续增长时再按需截断。

## 复跑

```sh
node --expose-gc docs/drafts/browser-native-dsh-poc/tests/startup-scale.e2e.mjs
# 放大规模或调整阈值：
DSH_POC_STARTUP_SIZES=0,500,2000 DSH_POC_STARTUP_EVENTS=200 DSH_POC_STARTUP_COLD_BUDGET_MS=20000 \
  node --expose-gc docs/drafts/browser-native-dsh-poc/tests/startup-scale.e2e.mjs
```

脚本先建一个含 Workspace、附件与审计账本的基线 `dataDir`，再复制出各规模的 `dataDir` 并写入 Session JSON；随后直接调用 `FormalSessionStore.load()` 计时和测堆，再启动真实 backend 测冷启动与首个 durable turn。`--expose-gc` 用于在测量前后回收，缺省不传时堆增量为粗略值。

## 边界

- 只覆盖 scripted 模型、回环 HTTP 和本地 `tmpdir`；不覆盖真实磁盘、NFS、对象存储、真实模型延迟、并发写或多实例。
- 堆增量是 `process.memoryUsage().heapUsed` 差值，不含 RSS、页缓存和 attachment 字节；启动不读取附件对象，附件只计入目录扫描成本。
- 上限是按 50 事件/会话的线性外推，不是产品 SLA；事件分布、单条事件大小和 JSON 序列化实现变化都会移动该值。
