---
description: "规划 Browser-Native DSH 对 Node 文件 API 调用、原生文件工具和缺失宿主能力的验证。"
---

# Browser-Native 文件能力与 Node API 调用验证计划

## 目标

确认真实 Dedicated Worker 中 DSH 文件工具是否进入已插桩的 `node:fs` / `node:fs/promises` shim，区分标准 `ctx.fs` 工具路径与 Node API 路径，并验证两者访问同一个 Worker VFS；同时证明不支持的宿主 API 会明确拒绝，而不会返回空实现或制造副作用。

本批不尝试实现完整 Node 兼容层，不把属性读取推断为函数调用，也不将部分方法的调用 trace 或文件工具成功外推为所有插件可在浏览器运行。

## 候选范围

| 验证点 | 价值 | 决定 | 本批证据边界 |
|---|---:|---|---|
| Chrome Worker 内观察 Node builtin 方法调用 | P0 | 纳入 | 只记录插桩方法的实际入口次数，不记录参数、路径、内容或调用栈。 |
| DSH 原生 `read` / `write` 对 Worker VFS 的一致性 | P0 | 纳入 | 通过真实 DSH Host、工具事件、VFS/Workspace 状态及 shim 成员 trace 联合验证。 |
| Browser-native `grep` / `glob` 的实现路径与原生工具区分 | P0 | 纳入 | 核对 fallback 直接使用 Worker VFS，不把它描述为 `dsh-tool-fs-search` 的 ripgrep 执行。 |
| Durable `edit` 与原生 `dsh-tool-fs` 的关系 | P0 | 纳入 | 记录 durable Workspace 专用 edit 路径会绕过标准 `ctx.fs.editText`；保留现有 receipt、CAS 和 commit 验收。 |
| `node:net` 等明确不支持的 shim 调用 | P1 | 纳入 | 在测试通道实际调用 `node:net.createServer()`，确认错误可见且不启动宿主服务。 |
| 所有 Node builtin、npm replacement、process 全成员覆盖 | P1 | 延后 | 需要逐项成员语义与消费者矩阵；本批只观测文件相关 API 和一个明确拒绝样本。 |
| `fs.watch`、descriptor、权限、symlink、POSIX errno 的全量 conformance | P1 | 延后 | 由现有 shim 单测和后续明确的 DSH consumer 场景分别承担，不由一次工具闭环代替。 |
| 静态分析所有 DSH 插件的 Node API 需求并自动生成准入表 | P1 | 延后 | 需要维护源包、打包镜像与 profile 激活面的映射，不在本批建立第二份插件目录。 |
| Safari/WebKit、自然 eviction、OS 崩溃与后台 Worker 生命周期 | P2 | 不纳入 | 本批固定 Chrome，且不把 Node API 兼容性问题与浏览器存储故障混为一谈。 |

## 设计

Worker Host 在挂载 VFS 时可接收一个可选的 builtin API 调用观察器。`node:fs` 与 `node:fs/promises` shim 在明确插桩的方法入口调用该观察器；观察器收到 builtin 名和成员名，不接收参数、路径、内容或调用栈。被 Promise API 委托的内部同步方法不重复计数。未传观察器时不保留 trace，也不包装 namespace、函数或模块 factory，因此 Node builtin 对象和函数身份不变。

只有 Browser-Native PoC 的专用测试 MessagePort 存在时才向 Worker Host 提供成员 trace observer。trace 按 builtin 与成员聚合，设唯一成员上限并显式报告溢出；它不进入 DSH Session、Workspace、模型请求、页面常规日志或 backend。无测试通道时不创建 trace recorder。

真实 Chrome scripted E2E 使用 12 MiB OPFS 外置文件执行 DSH `read → grep → edit → read`，并检查文件工具的 DSH `tool/call`/`tool/result`、Workspace revision、刷新恢复和 `node:fs` 调用 trace。源码确认标准 `read` 通过 `ctx.fs.streamText/readText`；trace 只提供 Worker 范围计数，不能将整个 turn 内的 shim 调用归因于特定工具。E2E 再经测试通道直接调用 Node shim 读取同一已提交文件并核对内容，以验证两个 API 路径共享 Worker VFS。另一个测试通道探针实际调用 `node:net.createServer()`，核对结构化 shim 仍明确拒绝。

真实 LLM smoke 继续使用既有同源代理与真实凭据配置，执行普通文件 `read → write → read` 及刷新恢复。它验证诊断包装未破坏真实 Worker/DSH 闭环，不声称真实模型完成 12 MiB scripted 场景。

## 实施顺序

1. 核实 `WorkerModuleLoader` 静态 factory 身份、Node builtin namespace 描述符、PoC test-port 生命周期和文件工具当前路径。
2. 先写本计划与进度；再新增有界调用 trace，通过 Worker Host 可选 observer 接入 `node:fs` 与 `node:fs/promises` shim。默认关闭时不创建记录结构，不包裹 namespace 或替换函数。
3. 为插桩的公开调用入口、`node:` builtin 调用、参数不采集、容量溢出、默认关闭、内部委托去重和 stub 错误增加定向单测。
4. 将成员 trace 与 `node:net.createServer()` 负例接到 PoC 专用 test port；扩展 Chrome 大文件工具 E2E，明确区分 `ctx.fs` 原生工具、PoC grep fallback 和 durable edit 特殊路径。
5. 运行定向单测、preview 构建、Chrome scripted E2E、Chrome 真实 LLM smoke 和文档门禁；保存不含原始 trace、路径和内容的汇总结果。
6. 按实测结果更新 PoC README、能力兼容矩阵、目录索引、变更账本和本批进度；审阅目录外修改，提交并推送 `research`。

## 验收标准

| 证据 | 通过条件 |
|---|---|
| 方法调用 trace 单测 | 插桩的 shim 方法入口被观察；参数不会进入记录；builtin namespace 与函数身份不变；Promise 内部委托不重复计数；容量溢出可见；默认关闭不创建 observer 记录。 |
| 不支持 API 负例 | Worker 真实静态 builtin 表解析 `node:net`；调用 `createServer()` 返回明确错误；无服务器、文件或 Workspace 副作用。 |
| Chrome 文件工具 E2E | 真实 DSH Session 记录 `read → grep → edit → read` 及匹配结果；源码显示标准 `read` 使用 `ctx.fs`；测试通道直接调用 Node shim 能从同一 VFS 读到 DSH 已提交的文件内容；grep fallback 和 durable edit 的实现路径被分别标注；刷新后内容一致。Worker 级 trace 不用于把 turn 中的调用归因到具体工具。 |
| 真实 LLM smoke | 真实模型通过同源 backend 完成普通文件 `read → write → read` 与 Session/Workspace 刷新恢复；没有模型凭据进入页面、Worker trace 或仓库文件。 |
| 文档与报告 | 区分成员读取与函数调用、静态 builtin 代理范围与静态 ESM import、当前实测与未验证能力；原始 trace 不落盘。 |

## 限制

成员 trace 只覆盖显式插桩的 shim 方法，不覆盖未接入观察器的成员或绕过这些 shim 的静态 ESM import。一次文件工具成功只验证本次 Chrome、profile、shim 和文件场景。`node:net.createServer()` 的拒绝不代表所有 mock shim 都有同等负例覆盖。
