---
description: "Browser-Native DSH 下一批高价值验证计划：用能力声明和启动前预检证明默认插件组合能否在 Worker 中安全运行，并验证受限工具的实际语义。"
---

# Browser-Native DSH 能力预检与插件兼容性验证计划

## Summary

本批次验证 Browser-Native DSH 在 Dedicated Worker 中启动插件时，能否在执行 Agent turn 前明确识别缺失的主机能力。验证重点不是增加更多聊天或文件工具，而是建立从插件需求、浏览器适配器到启动诊断的可检查关系，避免模块成功加载却在首次工具调用时才暴露 Node、子进程、watch 或原生扩展依赖。

## 候选范围与取舍

| 候选点 | 主要风险 | 本批决策 |
|---|---|---|
| 浏览器能力清单 | 工具名清单不能表达文件、Shell、网络和生命周期前置条件 | 选择，扩展为 PoC capability manifest 与可读诊断 |
| 默认 Browser profile 预检 | 插件 import 成功不等于插件可运行 | 选择，在 Worker Host boot 前 fail closed |
| 默认插件真实执行 | 预检可能只验证静态声明，不能证明实际接线 | 选择，验证文件、Shell、问答、todo、工作目录和多轮 Session |
| 受限 Shell 语义 | `tool-bash` 可能被误解为主机 bash | 选择，验证命令表、退出码、stderr、管道/重定向边界、取消和输出上限；不承诺完整 POSIX |
| 正式 package capability seam | 生产级 Service Definition/Provider/Consumer 需要跨 package 设计 | 记录设计结果，PoC 不修改正式 package |
| 可写 chunk-backed VFS | 大文件 edit 和部分写入仍有完整 materialize 风险 | 保留为下一批独立攻关，避免和 profile 启动问题混淆 |
| Worker 资源调度 | 单次正则、长任务和内存峰值可能阻塞 Worker | 保留为下一批，先用本批的输出/取消观察点记录证据 |
| 授权、跨 Worker 恢复和多实例 | 需要把能力与 principal、lease、Session 绑定 | 保留为后续安全与并发批次 |
| WASI、第三方 Shell、虚拟机 | 运行时体积和权限面扩大，不能替代 DSH 语义 | 不纳入，只有结构化能力不足时再单独实验 |

## 交付面

### A. Capability manifest

为 Browser-Native profile 定义能力 ID、提供方式、状态和失败原因。至少区分：Worker VFS、结构化文件工具、受限 Shell、Session persistence、LLM proxy、问答、todo、网络 fetch、主机子进程、`fs.watch`、动态模块、原生 addon、WASI 和后台进程。manifest 同时列出每个默认插件声明的 required/provided capabilities；未声明的主机能力不能因为浏览器中存在同名 API 而被视为支持。

### B. Boot 前 preflight

在 `createWorkerHost()` 前执行静态 profile 预检，并在 Worker boot failure 中返回插件 ID、缺失能力、可用适配器和恢复建议。预检失败时不创建半启动 Host，不注册 Agent Loop，不接受用户消息。正常 profile 的默认路径不改变；只有 Browser-Native opt-in 使用该清单。

### C. 默认 profile 执行回归

用真实 Chrome、Dedicated Worker、真实 DSH Host 和同源 backend 验证已声明的默认插件组合：`tool-fs` 的 read/write/edit/grep/glob，`tool-bash` 的受限命令，`tool-ask-user` 的等待和恢复，`tool-todo` 的持久事件，`tool-working-directory` 的路径上下文，以及至少两轮依赖前一轮结果的 Session。真实 LLM 与 scripted roster 分开记录；scripted 只证明确定性协议，真实 LLM 才能证明模型请求和 Session 闭环。

### D. 受限 Shell 证据

验证 `printf`、已支持的管道或重定向（若当前 provider 暴露）、非零退出码、stderr、输出预算、超时和取消。每个未支持的语法返回结构化错误，不回退到宿主机 shell。若当前 `tool-bash` 只支持固定命令表，则明确记录该事实，不能为满足测试而扩展成完整 Shell。

## 验收矩阵

| 验收项 | 证据 | 退出条件 |
|---|---|---|
| 静态预检 | 单测与真实 Worker successful boot；缺失 capability 由纯函数故障测试覆盖 | 缺少 capability 时启动前失败，错误指向具体插件和能力 |
| manifest 一致性 | profile、provider、模型 tool schema 对照测试 | 未声明工具不会出现在模型 schema；已声明工具有执行者或明确 adapter |
| 默认文件工具 | 真实 Chrome Worker E2E | read/write/edit/grep/glob 只访问 Workspace VFS，结果写入 Session，失败后可继续 |
| 受限 Shell | 真实 Chrome Worker E2E | 支持命令成功；不支持能力 fail closed；不访问主机进程、路径或网络 |
| 问答与 todo | 真实 Chrome E2E，必要时 scripted LLM | 等待期间可恢复，批准/回答和 todo 事件不重复、不丢失 |
| 多轮记忆 | 真实 LLM Chrome E2E | 第二轮能读取第一轮已提交事实；刷新后从 Session 重建 |
| 诊断安全 | 日志、页面和 Session 检查 | 不泄露模型凭据、主机绝对路径或未授权能力 |

## 不作出的结论

本批不宣称所有 DSH 默认插件都能在浏览器中运行，不宣称 Browser-Native 具备 Node、主机 bash、后台进程或完整 POSIX Shell，也不把静态 manifest 当成正式跨 package capability seam。可写 chunk-backed VFS、自然 eviction、OS crash、生产对象存储、多实例 backend、Safari 和完整 ReDoS 防护仍保持未验证。

## 实施顺序

1. 先运行现有文件工具、默认 profile 和真实 LLM 回归，记录基线。
2. 扩展 PoC capability manifest，加入结构化校验、诊断和 preflight 单测。
3. 在 Worker boot 前接入 preflight，并验证失败时不留下活动 Host 或 Session owner。
4. 增加默认 profile 的 scripted Chrome 矩阵，再运行真实 LLM 多轮回归；受限 Shell 只按实际支持语义验收。
5. 更新进度、兼容矩阵、README、change ledger 和 `docs/drafts/README.md`，执行针对性测试、preview build、文档门禁、typecheck 和 pre-push 检查。

## Dev Note

本文是 `docs/drafts/` 下的研究计划。若后续形成正式 capability service，应迁移测试到正式 Service Definition、Provider 和 Consumer，并删除本目录的重复静态清单；在此之前，PoC 清单不能作为正式 package API。
