---
description: "Browser-Native DSH 运行能力、容量和存储恢复的下一批验证计划。"
---

# Browser-Native DSH 运行范围与运营上限验证计划

## 结论

合并 `dsh-v0.2.1-rc.2` 后，下一批仍应优先验证浏览器运行时，而不是扩展 SaaS 业务联动。上游增加了 VFS 懒加载归档、更多 Node 模块兼容和文件系统行为；这些改动扩大了可运行模块的范围，也增加了“模块能加载”与“插件能真实工作”之间的差距。

本批启动时的代码核对发现，Browser-Native overlay 只替换模型和 Session provider，标准 preset 仍继承 Web profile 的工具清单；Browser-specific roster 只由临时验证镜像启用。上游 release 同时增加了 Worker 内的受限 shell 执行器，所以旧报告中的“浏览器没有 Bash”不再足以作为裁剪依据。此前 Browser-specific E2E 不能代表默认启动时模型看到的能力。本批据此修改 PoC overlay 并新增真实 Worker 调用验收；实际结果和未完成的验收范围见[实施进度](operational-envelope-validation-progress.md)。

## 目标与限制

本批回答四个问题：默认 Browser-Native 启动时，模型声明的能力是否与 Worker 可执行能力一致；上游 Worker runtime 哪些 DSH 插件可以工作、需要适配或应排除；当前浏览器 VFS、OPFS、IndexedDB 和 Workspace backend 在固定工作负载下的成本与响应基线是多少；浏览器配额失败和完整浏览器重启后，哪些已提交与未提交状态可以恢复。

验收只使用 Chrome。脚本模型用于可重复的工具、故障和恢复断言；真实 LLM 验证一个独立 Browser validation roster 的完整文件工具闭环，不把模型延迟纳入容量指标，也不宣称实际默认 Browser profile 的全部工具都通过真实模型验收。真实 quota 降额、浏览器驱逐和 OS 级进程崩溃必须分别记载，不把注入异常、CDP 配额覆写或正常关闭混称为自然故障。

本批不修改 DSH Agent Loop、正式 profile、正式 package、Session 格式或 workspace service。改动限制在本 PoC 目录；若实验发现必须修改目录外代码，先更新 `change-ledger.md` 并说明必要性。

## 交付面

### 1. 默认能力配置与 Worker 闭环

让 `browser-native-profile.cordis.patch.yml` 显式选择经过浏览器验证的工具集合。先验证上游 Worker shell 的 parser、coreutils 和 VFS 访问，再决定 `bash` 是否以受限能力保留；验证 Web search/fetch 的实际网络路径和凭据来源，再决定是否暴露。PowerShell、subagent 和其他依赖真实主机进程的工具不得仅因模块成功加载就列为支持。system prompt 应准确说明 Worker VFS、shell 子集、网络访问和 Session 持久化语义。

增加实际 preview 启动路径的 scripted Chrome 验收：首个 LLM 请求的工具 schema 只含已通过实际执行或明确 adapter 验证的工具；`glob`、`grep`、`read`、`write`、todo 以及被选中保留的 shell 命令覆盖真实 DSH 工具执行与 Session tool/result；profile 有效配置、模型 schema 和 Worker 执行结果一致。另以一条真实 LLM Chrome E2E 验证用户默认入口，而不是临时替换 profile 的测试入口。

### 2. 插件与 Node 兼容矩阵

建立一份有代码证据的兼容矩阵，分别标记“Chrome Worker 已执行”“由同源 backend 提供”“需要专用 adapter”“明确排除”“尚未验证”。矩阵至少覆盖 Worker Host、VFS 基础 I/O、搜索归档懒加载、Session、LLM、todo、shell/process、Web search/fetch、watch、网络内建模块、动态模块解析和依赖真实 Node 原生模块的插件。

使用真实构建产物验证当前选定 Browser preset；对懒加载模块检查首次读取、归档请求/加载失败重试及归档校验的真实语义。不得从 Node shim 单测或成功 import 推导整套上层插件兼容。

### 3. Chrome 容量和响应基线

新增阈值无关的真实 Chrome 基准脚本，分别测量冷启动至 Workspace ready、固定 VFS 工作负载、本地 OPFS/IndexedDB durable、Workspace commit、刷新后的 hydrate、主线程动画帧间隔和 `navigator.storage.estimate()` 前后读数。工作负载用确定性、互不相同的内容，至少覆盖大量小文件、中型多文件和少量大文件三种分布。

每种工作负载执行三个独立浏览器存储上下文，记录所有样本、浏览器版本、机器平台、文件数、总字节数、耗时阶段、commit 数和页面错误。真实模型、上游网络延迟、跨设备并发和 Safari 不进入计时。首轮只建立可复跑基线，不将单机样本解释为 SLA 或容量上限。

### 4. 存储失败与浏览器生命周期恢复

保留现有直接异常注入和 Worker terminate 测试作为协议回归；新增由 Chrome 存储层实际执行的配额限制实验，确认 OPFS 写入得到的原生错误、Worker 状态、VFS 工具保护和刷新后的恢复内容。单独新增持久浏览器 profile 的完整 Chrome 进程正常关闭、重启和同源恢复测试，核对本地 OPFS/IndexedDB 与 backend manifest。

若能安全、可重复地强制终止 Playwright 所启动的 Chrome 进程，再以单独用例覆盖进程 crash；否则只报告正常关闭/重启，并将 OS 级 crash 标为未验证。浏览器自然 eviction 同样标为未验证；不能用清除存储 API 冒充浏览器 eviction。

## 实验数据与退出标准

所有 Chrome 测试使用临时 backend dataDir、动态 loopback 端口、隔离浏览器上下文和可等待的状态信号。测试结束等待浏览器、Worker、backend 和文件操作完全退出。日志只保存脱敏指标、工具名、事件类型、revision 和 hash，不保存 prompt 私密内容或凭据。

本批完成条件：实际启动 overlay 不再暴露未经支持的工具；兼容矩阵中每项结论具有源码或本批测试入口；三个负载都生成三组原始 Chrome 测量且没有隐藏掉失败样本；真实存储配额失败与正常 Chrome 进程重启的恢复结果有独立断言；自然 eviction、OS crash、真实容量上限和未运行项保持明确的未验证状态；README、索引和进度记录互相链接且不把 PoC 能力写成已发布能力。

## 参考入口

- [Browser-Native PoC 当前说明](README.md)
- [Worker runtime 上游实现](../../../packages/experimental/webworker-runtime/README.zh.md)
- [Browser-specific 工具配置研究](browser-native-tool-roster-and-configuration-research.md)
- [恢复边界验证结果](recovery-boundary-validation-progress.md)
- [PoC 目录外修改账本](change-ledger.md)
