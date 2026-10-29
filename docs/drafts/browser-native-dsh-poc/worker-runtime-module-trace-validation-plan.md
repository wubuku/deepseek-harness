---
description: "规划 Browser-Native Worker 运行时模块请求追踪，并与 packer 静态请求图对账。"
---

# Browser-Native Worker 运行时模块追踪验证计划

## 目标

验证 packer 的保守静态请求图与真实 Dedicated Worker 执行 DSH Host、工具和模型请求时实际解析及加载的模块之间有什么差异。

运行时追踪只记录模块请求元数据，不读取模块源码、模型输入、环境变量、文件内容或 HTTP body；它只在 PoC 测试模式显式启用，不向 backend、LLM 或第三方服务发送。

本批不把运行时请求追踪描述为完整动态分析、Node 兼容性证明或 profile activation 清单；它只覆盖 Chrome 中实际执行到的请求路径。

## 候选范围

| 候选验证点 | 价值 | 本批决定 | 边界 |
|---|---:|---|---|
| 从 Worker loader 记录真实解析请求、结果和模块加载情况 | P0 | 纳入 | 追踪在运行时解析器内部采集，不能另写 resolver 或只从 bundle 源码猜测。 |
| 将 Chrome 请求与静态 request graph 按 importer/specifier 对账 | P0 | 纳入 | 未匹配项分类为静态扫描未记录、启动根请求或路径规范化差异，不直接判作构建缺陷。 |
| 比较 Worker boot、DSH 工具路径和真实 LLM turn 的增量模块集合 | P0 | 纳入 | 真实模型 smoke 仍走 backend-only 凭据；请求轨迹不得包含 prompt、工具参数、文件内容或密钥。 |
| 有界追踪容量、溢出报告和关闭状态下不保留事件 | P0 | 纳入 | 容量满时必须显式报告丢弃数；关闭追踪不保存事件，不承诺零 CPU 或分配开销。 |
| 逐个核验静态 unresolved 请求是否在实际工具路径被触发 | P1 | 部分纳入 | 报告观测到的 unresolved 请求和路径，不把未触发解释为不可达，也不把被捕获的异常称为用户可用。 |
| 逐个审计 Node shim 的导出成员访问及参数语义 | P1 | 延后 | 需要代理成员追踪与成员级契约矩阵，不能由模块请求事件推导。 |
| 按 Cordis profile 精确生成插件激活闭包和按需 image | P1 | 延后 | 需要区分插件激活、动态 Loader 配置和 packer 根集合，属于独立打包优化批次。 |
| 动态插件下载、任意 computed import、native addon 与 Worker 代码供应链 | P1 | 排除 | 本批只观测现有可信静态 image，不改变动态代码加载和信任模型。 |
| Worker 启停、HMR、子 Worker 和 lazy archive 的完整资源生命周期 | P1 | 延后 | 需要独立的生命周期与回收验收，不由模块请求差异代替。 |
| 全量 Node/POSIX conformance、Safari/WebKit 和自然 eviction | P2 | 不纳入 | 超出当前 Chrome PoC 目标。 |

## 实施范围

### M0：复核观察入口

复核 `WorkerModuleLoader.resolve/load`、`createWorkerHost` 和 Browser PoC 测试桥。追踪必须从同一个 Worker loader 取得事件，且不得改变模块解析、缓存、异常或 DSH Loop 行为。

### M1：实现 opt-in 有界追踪

新增可选的 loader/host 追踪配置及只读快照，记录单调序号、请求 importer、specifier、请求方式、静态或 VFS resolution、目标、失败代码，以及模块实际加载、缓存命中或加载失败。

追踪关闭时不保存记录；启用时到达上限后保留前序记录并递增 `droppedEvents`。诊断快照只从 PoC 的专用测试 MessagePort 读取，测试桥不得暴露在生产页面配置中。

单元测试覆盖相对请求、Worker static proxy、`require.resolve`、实际加载、缓存命中、模块加载失败、未解析请求、trace 上限和关闭模式。

### M2：静态图与 Chrome Worker 对账

扩展现有 default-profile Chrome E2E，在真实 Worker boot 和 DSH shell/tool 路径后取追踪快照，并与提交的 packer request graph 对照 importer/specifier。

报告静态图匹配数、运行时独有边、静态 unresolved 但本次未触发的记录、实际 unresolved 请求、各 resolution 类别、加载/缓存事件数和追踪溢出数。事件会包含模块 importer、specifier 和目标路径；summary artifact 只保存计数与有限示例，不保存原始 trace。验证字段 allowlist、Workspace 用户路径和凭据未出现在 trace 中，不记录模型 prompt、工具 arguments、文件内容或网络 body。

### M3：真实 LLM smoke 与安全核查

运行真实 Chrome `read → write → read` 任务，并从测试桥读取同一 Worker 的追踪快照。检查 LLM 仍只访问同源 backend；浏览器、页面和追踪记录中不出现模型凭据。

Scripted 与真实 LLM 结果分开记录。真实 LLM 不要求命中预先指定的全部模块，只要求完成 DSH 工具闭环、追踪不溢出且报告的模块证据与静态图可对账。

### M4：经验和限制归档

更新 PoC README、兼容矩阵、`docs/drafts/README.md` 和 `change-ledger.md`；保存可复跑命令及脱敏的 Chrome 追踪摘要。列明未触发模块、运行时 unresolved 的调用者是否由上层捕获无法由本追踪独立判断，以及追踪不覆盖的 Worker/client bundle、动态代码和未执行分支。

## 验收标准

| 证据 | 通过条件 |
|---|---|
| Loader 单元测试 | 请求、结果、加载、缓存、错误和容量语义明确；追踪关闭不改变现有返回值或异常。 |
| Chrome scripted E2E | 真实 Worker Host 与 DSH 工具路径有追踪；无未报告溢出；静态图对账给出可复核的 matched/unmatched 分类。 |
| 真实 LLM E2E | Chrome Worker 完成真实模型文件工具回路；同源模型代理和 Session 记录仍正常；追踪未暴露模型或用户数据。 |
| 安全检查 | Worker trace 仅经专用同源测试通道读取；无跨源请求；追踪字段不含内容、凭据、headers 或模型请求 body。 |
| 文档 | 明确区分静态闭包、实际模块请求、模块加载和未执行路径；不声称完整动态分析或 Node 兼容。 |

## 已知限制

- 模块追踪只能说明本次 Chrome 执行触及的请求，不能说明未触及模块不可达。
- 运行时成功解析只说明目标存在并由当前 Worker loader 接受，不证明对应模块的全部导出成员或行为兼容 Node。
- unmatched edge 可能来自 computed specifier、bootstrap 根请求或 import/require 表达差异；需保留原始 importer/specifier 并分类，不能静默丢弃。
- unresolved 请求记录不包含模型工具参数、调用栈或 catch 关系，因此不能单独判断它是否让用户路径降级。
- 追踪容量限制事件数，不限制单个 importer、specifier 或 target 的字节长度；只对可信 Worker module loader 启用，避免把原始 trace 写入用户可见或长期持久化日志。
- Dedicated Worker 仍受页面生命周期约束；此批不验证页面关闭后的后台执行。

## Dev Note

静态 request graph 是保守构建闭包，运行时 trace 是一次执行的证据；两者只有按 importer、specifier 和 resolution 分类对账后才有意义。避免把未观察到的模块解释成不可达，也避免把“模块已加载”扩写为“Node API 可用”。
