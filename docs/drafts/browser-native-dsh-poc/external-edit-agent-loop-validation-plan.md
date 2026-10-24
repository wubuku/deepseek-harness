# External Edit 与 Agent Loop 验证计划

## 目标

本批验证 Browser-Native DSH 是否能把 OPFS/IndexedDB 外置文件接入标准 DSH `edit` 工具，而不是只通过 URL-gated test action 验证存储原型。重点是保持 DSH Agent Loop、Session 事件、Workspace receipt、CAS 和 Worker 生命周期语义不变，同时降低大文件编辑的 VFS heap 峰值。

## 候选范围

Browser-Native DSH 进入正式产品前的候选验证面包括：Worker 启动与包模块解析、DSH 插件组合兼容、VFS 文件身份和 POSIX 语义、标准工具和大文件 I/O、OPFS/IndexedDB 的提交顺序、刷新与 Worker 终止恢复、CAS 与多标签页 fencing、配额耗尽与缓存丢失、文件编码/二进制策略、工具参数和 Session 载荷预算、跨源权限与密钥隔离、离线恢复、后端多实例和对象存储。既有 PoC 已分别覆盖部分缓存恢复、一般 mutation、单次 unknown commit、lease、quota override、文件搜索边界和浏览器运行包探针；本轮不重复这些结果，而验证新的外置文件引用是否能穿过同一套 DSH 工具、持久化与冲突路径。

本批优先处理可直接阻断正式产品核心路径的风险：

| 候选 | 价值 | 本批范围 |
|---|---|---|
| 标准 `edit` 的 external/chunk-backed copy-on-write | 决定大文件能否通过真实 Agent 工具编辑 | 纳入 |
| open descriptor 与 external replacement | 决定 OPFS 外置文件是否保持可预测的文件身份语义 | 纳入 |
| external reference 的 Worker 终止与 receipt reconciliation | 决定失败后是否会伪造成功或重复副作用 | 纳入 |
| external reference 的 CAS 冲突和 writer fencing | 决定多标签页是否静默覆盖 | 纳入 |
| chunk-addressed unchanged-chunk 复用 | 决定“增量”能否达到块级 | 作为 P1，只有 P0 通过后再做 |
| 自然 storage eviction、OS 崩溃、生产对象存储 | 需要浏览器或外部基础设施条件，本批不伪造为已验证 |

更大的候选范围与本轮取舍：

| 验证面 | 主要风险 | 取舍 |
|---|---|---|
| Worker 包加载与核心服务依赖 | 插件启动失败会使 Session、Workspace 或 picker 服务链停用 | 纳入；先修复并以 Chrome 复验 |
| 文本编码、NUL、超长行、重复匹配、替换膨胀与取消 | 模型编辑失败时错误、文件和资源状态可能不一致 | 纳入 focused tests 与工具 E2E |
| 外置编辑写入、OPFS blob 缓存、IndexedDB snapshot 崩溃窗口 | 刷新后可能丢文件、伪造成功或重放副作用 | 纳入 P0-C |
| 外置引用遇到 unknown commit、Session receipt 延迟和 backend 重启 | 重试可能重复 revision 或产生重复 receipt | 纳入；复用既有故障注入路径 |
| stale CAS、dirty 内容保留与 writer fencing | 并发页面可能静默覆盖远端或本地文件 | 纳入 P0-D |
| `read`、`grep`、`glob` 对外置 backing 的分块读取 | 搜索/读取可能重新把大文件 materialize 到 Worker heap | 只做必要回归，不扩大搜索实现 |
| quota、OPFS 写失败与 orphan 回收 | 中断后可能发布半文件或遗留临时内容 | 复用既有模型无关故障矩阵做专项回归 |
| 自然 eviction 与本地缓存清除后的完整重建 | 浏览器清理站点数据后是否能从云端恢复 | 后续批次；cache-reset 不等于自然 eviction |
| 大量小文件、超大目录和 Session transcript 增长 | VFS、模型请求和 UI 的长期资源上限未知 | 后续批次；本轮只核对 edit 参数/结果预算 |
| Worker profile 中 Node API、native addon、shell/WASI 插件兼容 | 默认 profile 可能误启用浏览器不可用能力 | 既有运行范围工作已覆盖，本轮只处理触及的加载回归 |
| 跨源请求、认证 cookie 与模型密钥 | 浏览器权限或凭据可能越过预期进程 | 各 Chrome E2E 保留无跨源请求断言，不扩展认证产品化 |
| 离线重试、多实例 backend、生产对象存储与 HA | PoC 单进程 backend 不具备生产一致性 | 不纳入；需独立生产服务实验 |

选点依据：标准 `edit` 是模型可调用的核心能力；外置引用跨越 VFS descriptor、OPFS handle、Workspace outbox、远端 CAS 与 Session receipt，失败任一层都会让工具结果不可信。先验证这一完整链路，再决定是否投入 chunk-level transport 或自然 eviction 等后续工作。

## 交付面和验收

### P0-A：标准 `edit` 接入

- 对 `/dsh/home/workspace` 内的 `edit` 使用 bounded copy-on-write；非 Workspace 路径继续交给标准 provider。
- 保持 `file_path`、`old_string`、`new_string`、`replace_all` 参数和标准错误码语义。
- 成功调用通过正常 `tools/execute`、`tool/call`、`tool/result` 完成，并产生 `write-reference` mutation、Workspace receipt 和一次 CAS revision。
- 覆盖成功、未找到、非唯一、`replace_all`、二进制、超限、取消、失败后继续。
- 不引入第二个模型循环，不把 test action 当成 Agent 工具。

### P0-B：文件身份语义

- external replacement 后，已打开 descriptor 继续读取替换前的文件身份和内容。
- 新路径读取新的 external backing；descriptor 写入不修改新路径。
- 覆盖 rename、unlink、hard link、watch/mutation 观察和 backing close 生命周期。
- 任何不支持的行为必须显式失败，不能静默 materialize 或双重 close。

### P0-C：崩溃恢复

- local durable save 前终止 Worker。
- local durable save 后、cloud commit 前终止 Worker。
- cloud commit 成功但响应丢失。
- Session receipt append 中断。
- 刷新后只恢复 durable external reference；不重放原始 Agent tool call，不重复副作用。
- 对临时 OPFS target、pending reference 和无引用 blob 采用保守清理。

### P0-D：冲突和租约

- 一个 Worker 提交 external reference 后，另一个 Worker 使用旧 `baseRevision` 修改同一路径。
- 远端 revision 不被覆盖；本地 pending reference 和 backing 保留。
- stale writer token/fencing token 被拒绝。
- 刷新后状态明确为 conflict/retry，而不是显示成功或静默覆盖。

## 证据等级

- **源码事实**：实现、类型和单元测试直接支持的行为。
- **真实 Chrome**：真实 Dedicated Worker、OPFS、IndexedDB、DSH Host 和同源 backend 的 Playwright 证据。
- **真实 LLM**：同源 backend 使用真实模型；只用于回归模型可达性和标准工具闭环，不把固定工具脚本称为模型自主选择。
- **未验证设计**：P1 chunk-addressed delta、自然 eviction、OS/磁盘崩溃、生产对象存储和多实例高可用。

## 非目标

本批不重写 DSH Agent Loop，不把 `MemoryVfs` 变成完整 Node/Linux 文件系统，不宣称 chunked transport 已经是 chunk-level delta，不承诺 Worker 在页面关闭后继续运行，也不把本地 PoC backend 当成生产云存储。

## 通过门槛

P0-A 至 P0-D 必须同时满足：focused unit tests 通过；Chrome E2E 无页面异常、无跨源请求和无密钥泄露；Session 中工具调用与 receipt 一一对应；失败路径无远端 revision 增长或重复副作用；刷新后能从 durable state 重建。任一条件不满足，报告只记录部分通过，不进入 P1。
