---
description: "核查浏览器虚拟文件系统、类 Unix 命令套件和完整运行时项目对 Browser-Native DSH 的参考价值，区分可验证能力、项目边界、成熟度证据与 DSH 集成缺口。"
---

# Browser-Native DSH 的浏览器文件系统与类 Unix 工具生态事实核查（草稿）

## Summary

本文核查一段关于“浏览器虚拟文件系统 + 类 Unix CLI 套件”的项目盘点，并把结果映射到 DeepSeek Harness（DSH）的 Browser-Native 研究。核验时间为 **2026-10-24**；外部项目的 README、源码入口、npm 元数据和官方文档可能继续变化，本文是单语研究草稿，不是 DSH 产品契约，也不是第三方项目的生产可靠性或安全保证。

核心结论是：**原回复抓住了一个真实且值得研究的技术方向，但不能按原表格直接作为选型依据。**列出的项目中，Lifo、OpenFS、vanilla-shell、wasi-sh、Bashkit、uutils Playground、BROWSIX、Wanix、v86 和 SlashPC 都能找到真实项目或包；但是成熟度差异很大，若干包名、导入方式、VFS 持久化归属和“官方采用”说法不准确。没有一个项目可以直接替代完整的 Browser-Native DSH Host、Agent Loop、Session、授权和浏览器生命周期管理。

对 DSH 最有用的研究结论不是“选一个最像 Linux 的项目”，而是分层组合：用可嵌入的浏览器 VFS 承载 `ctx.fs`，用受限 Shell 或命令注册表承载模型可调用的文件工具，必要时再用 WASI 或 VM 运行特定工具；持久化、所有权、权限、模型凭据、Session 事件和失败恢复仍由 DSH 自己定义。

## Table of Contents

- [一、对原回复的总判定](#一对原回复的总判定)
- [二、逐项事实核查](#二逐项事实核查)
- [三、项目之间真正的技术差异](#三项目之间真正的技术差异)
- [四、与 Browser-Native DSH 的关系](#四与-browser-native-dsh-的关系)
- [四点五、当前 PoC 实现注解](#四点五当前-poc-实现注解)
- [五、初步选型建议](#五初步选型建议)
- [六、下一轮验证](#六下一轮验证)
- [证据索引](#证据索引)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

## 一、对原回复的总判定

“存在多个能在浏览器提供 VFS 和类 Unix 命令、并提供编程 API 的开源项目”这一主张**基本成立**。Lifo 的 `Sandbox`、wasi-sh 的 `run`/`spawn`、Bashkit 的 `Bash`、Wanix 的 namespace handle、v86 的 `V86` 构造器和 OpenFS 的 `createAgentFs` 都是可编程入口；BROWSIX 也不是只有终端截图的 Demo，而是带运行时 API 的研究框架。

“大多成熟”这一主张**不成立或至少证据不足**。Lifo、OpenFS、vanilla-shell、wasi-sh、Bashkit 的公开包和仓库时间都很新，版本号或 Stars 不能替代 API 稳定性、兼容性矩阵、独立安全审计、长期维护记录和真实部署验收。vanilla-shell 的 README 甚至明确写着 “mostly vibecoded” 和 “not a POSIX-accurate shell”；OpenFS 的 npm 版本为 `0.1.0` 且仓库当前没有 Stars；wasi-sh 的 GitHub 仓库当前只有个位数 Stars。

“完整 Unix 工具链”需要收窄为“项目所列的命令集合”。uutils 的 WASI 构建使用 `feat_wasm`，只包含能在 WASI 下工作的子集；uutils Playground 还把 `grep`、`find`、`diff` 和 `sed` 作为其他 WASM 模块按需加载。wasi-sh 使用 fork-free 的 BusyBox `ash` 和一组 applet，不等于完整 BusyBox；Bashkit 的命令是 Rust 重实现，也不等于原生 GNU 工具。

“VS Code for Web 官方采用 uutils + browser_wasi_shim 实现浏览器终端”是**明确错误**。uutils 官方确实有自己的 Playground，文档明确描述了 JavaScript shell、`@bjorn3/browser_wasi_shim`、uutils WASM 和内存 VFS；微软当前 VS Code Web 文档则明确说 web 版 terminal 和 debugger 不可用，并建议使用 Desktop、Codespaces 或 Remote - Tunnels 获得运行时能力。

“v86 的 Filer 通过 9P 桥接”把两个项目混在了一起。上游 v86 自己提供 9P virtio 文件系统，并支持 JSON/HTTP 文件系统、JS handler 和 WebSocket proxy；SlashPC 是另一个应用项目，它的 README 才明确写出 Filer（IndexedDB）、v86 fork 和 9P 桥接。v86 上游不应被描述成内置 Filer/IndexedDB VFS。

“`bashkit-wasm`”和示例 API 也不准确。公开 npm 包是 `@everruns/bashkit-wasm`，不是无作用域的 `bashkit-wasm`；README 的浏览器 API 是 `initBashkit()`、`Bash` 和可选的 `Terminal`，不是 `import { Shell } from 'bashkit-wasm'`。它确实主张单线程、无需 `SharedArrayBuffer` 和 COOP/COEP，但这个能力应按实际包版本验证。

## 二、逐项事实核查

### 2.1 纯 JS/TS 或 JS-facing 实现

| 项目 | 可验证事实 | 原回复需要修正的地方 | 对 DSH 的初步价值 |
|---|---|---|---|
| [Lifo](https://github.com/lifo-sh/lifo) / `@lifo-sh/core` | npm `0.10.24` 的 README 和源码提供 `Sandbox.create()`、`sandbox.commands.run()`、`sandbox.fs.*`；仓库包含 TypeScript VFS、Shell、命令注册表、`/proc`、`/dev` 和 IndexedDB persistence backend。README 列出 60+ 命令及 Node.js compatibility layer。 | 项目真实且 API 方向吻合，但当前版本仍是 `0.x`；“完整 Linux 沙箱”“生产成熟”不能从命令数量推出。`npm` 包将 `@lifo-sh/ui` 声明为可选 peer 依赖，接入时要分别验证 headless 和 UI 入口。 | 当前候选中最接近“JS 进程内 VFS + 命令注册表 + DSH 工具”的组合；需要验证是否能替换 DSH 所需的 `fs`、shell、subprocess 和网络能力，而不是只验证 `ls`/`grep`。 |
| [OpenFS](https://github.com/asdtransport/openfs) / npm `openfs-wasm` | 包版本 `0.1.0`，源码用 `sql.js`、`just-bash` 和 OpenFS adapter；提供 `createAgentFs()`、`exec`、`search`、`read`、`ls`、snapshot/export 和路径组过滤。`grep` 优化是 FTS5 候选过滤后再由 `just-bash` 精确执行。 | npm 包名是 `openfs-wasm`，README 的安装和 import 却写 `@openfs/wasm`；当前 registry 查询不到 `@openfs/wasm`。README 所说的 IndexedDB/disk restore 是调用方保存/恢复 snapshot 或选择 adapter，不等于该包自动提供浏览器持久化。它是新包，不应称为成熟基础设施。 | 适合研究“面向 Agent 文档库的搜索、RBAC、快照”而不是直接充当通用 POSIX 工作区。需要单独核查写入语义、目录/元数据、并发、配额、二进制文件和失败恢复。 |
| [vanilla-shell](https://www.npmjs.com/package/vanilla-shell) | npm `1.0.0` 的源码使用 ZenFS 和 `@zenfs/dom`，README 列出 IndexedDB、命令注册、管道、重定向、变量、命令替换、`if`/`for`/`while`、子 shell 和 XTerm demo。 | README 自己声明不是 POSIX-accurate shell，内置命令只覆盖简单常见情形，并写有 “mostly vibecoded”。npm 包 metadata 没有 repository 字段；不能据 `1.0.0` 把它当成熟实现，也不能把“语法宣称”当成兼容性证明。 | 适合做小型 JS-native 命令桥或 UI 实验，不适合作为 DSH 默认 Shell 语义的唯一来源，除非先建立命令和语法兼容性测试。 |

### 2.2 WASM 工具链

| 项目 | 可验证事实 | 原回复需要修正的地方 | 对 DSH 的初步价值 |
|---|---|---|---|
| [uutils/coreutils](https://github.com/uutils/coreutils) + [uutils Playground](https://uutils.org/playground/) | Rust coreutils 提供 `wasm32-wasip1` 构建路径和 `feat_wasm`；官方 Playground 的技术说明明确列出 JS shell、`@bjorn3/browser_wasi_shim`、uutils multicall WASM、内存 `PreopenDirectory`，以及按需加载的 grep/find/diff/sed WASM。 | 这是“真实 Unix 工具编译到 WASM”的强证据，但不是一个开箱即用的 DSH VFS/Session runtime，也不是 VS Code Web 的实现。Playground 的 shell 只支持有限的 pipes、redirection 和 quoting，不支持变量、glob、`&&`/`||` 等完整 shell 语义；工具集合由 WASI 兼容性决定。 | 适合把少数标准工具作为受限 command provider，尤其是需要接近 GNU 输出的离线文本处理；需要自己提供 VFS 生命周期、命令调度、取消、输出上限、Session logging 和模型权限。 |
| [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) | 这是浏览器 WASI Preview 1 的纯 JS shim，提供 `WASI`、`File`、`OpenFile`、`PreopenDirectory` 等底层 API；uutils Playground 使用它。 | shim 不是 shell、coreutils 或完整 VFS 产品；README 明确实现的是 WASI 子集，未实现部分会抛异常或返回错误。不能把它单独列作“CLI 套件”。 | 适合成为 DSH Worker 中运行 WASI 工具的低层适配器，但必须由 DSH 负责文件系统、权限和错误语义。 |
| [wasi-sh](https://github.com/alganet/wasi-sh) | npm `0.11.0` 提供 `run()`、`spawn()`、`WasiShim`、可注入的同步 ZenFS-shaped filesystem；默认 `memoryFs`，可通过 `persistentFs`、`journalFs`/`journalWriter` 配合外部 ZenFS 后端做持久化。README 明确区分不需要 SAB 的非交互 `run()` 与需要 cross-origin isolation 的交互 `spawn()`。 | 它不是 `Shell.create()` API；示例应使用 `run` 或 `spawn`。它使用 BusyBox `ash` 加一组 applet，不是“完整 BusyBox 工具链”。IndexedDB/OPFS 由 `@zenfs/dom` 等外部后端提供，`wasi-sh` 自己对 ZenFS 只保留开发依赖；持久化要处理 hydrate、flush、journal 和 worker 停驻问题。 | 是一个值得深入验证的 Shell/WASI 候选，尤其适合将同步 guest FS 与 Worker 中的异步持久化 adapter 分开；它的 `journalFs` 思路对 Browser-Native 工作区恢复有参考价值。 |
| [Bashkit](https://github.com/everruns/bashkit) / `@everruns/bashkit-wasm` | npm `0.19.0` 的浏览器包是 wasm-bindgen 单线程构建；README/API 提供 `initBashkit`、`Bash`、`execute`/`executeSync`、内置 VFS、host-backed FS、custom builtins、snapshot/checkout 和可选 Terminal。 | 原回复写错了包名和 API。它的“无需 SAB/COOP/COEP”是项目明确的浏览器构建特性，但仍需按目标浏览器、WASM 包体积和执行时间验证；README 也明确浏览器版不包含 curl/wget、ssh、sqlite、Python 等部分能力。 | 目前最适合拿来研究“模型生成 Shell + JS custom builtin + DSH host filesystem”的单线程 Worker 方案。它不是 DSH plugin adapter，且 host FS 合同、同步/异步执行和 snapshot 语义必须接到 DSH 的事件与权限模型。 |

### 2.3 完整系统或模拟器

| 项目 | 可验证事实 | 原回复需要修正的地方 | 对 DSH 的初步价值 |
|---|---|---|---|
| [BROWSIX](https://github.com/plasma-umass/browsix) | README 把它定义为 JavaScript-only 的 Unix-like browser framework，提供 pipes、processes、signals、sockets、shared filesystem、POSIX-like shell，并让 Node/C/C++/Go 程序在其运行时中执行；README 说明其使用 BrowserFS。 | 这是有影响力的研究项目和可编程 runtime，但仓库主要代码提交停留在 2019 年，构建依赖、编译器 fork 和 browser-node 限制都很明显。它运行的是适配过的运行时/产物，不应概括为“直接运行任意未修改的 C/C++/Go/Node.js 程序”。 | 可借鉴 Worker process、pipe、signal 和 shared FS 的抽象；不应作为当前 DSH 的默认依赖，除非先解决维护、浏览器兼容、构建链和安全审计问题。 |
| [Wanix](https://github.com/tractordev/wanix) | Go/WASM runtime 以 Plan 9 namespace 为中心；HTML elements 和 JS handle 都是真实 API。README 列出 tar/union/fetch、WASI/JS/Go tasks、OPFS、worker、service worker、9P federation、v86 VM 和 VS Code workbench 集成。 | Wanix 自身不是一个固定的 Unix CLI 套件；任务需要绑定 rc、BusyBox、WASI 或其他 WASM/JS 程序。它是 namespace/task/VM 编排 runtime，不能与 Lifo、Bashkit 或 uutils 作为同一层直接比较。 | 对“浏览器内多个任务、文件命名空间和可选 VM”的系统级设计有很高参考价值；对第一版 Browser-Native DSH 来说可能过重，且其 namespace 权限和 DSH Session ownership 需要重新对齐。 |
| [v86](https://github.com/copy/v86) | x86 CPU/硬件模拟器，使用运行时 WASM JIT；上游支持 virtio 9P。官方 filesystem 文档提供 JSON/HTTP in-memory FS、JS `handle9p` 和 WebSocket proxy；官方 npm 包支持 JS API。 | 上游 v86 没有把 Filer/IndexedDB 作为其内置 VFS。`filesystem` 选项和 9P bridge 是 v86 的能力，Filer + IndexedDB + v86 fork 的组合出现在 SlashPC 等外围项目。VM 的 Linux/BusyBox 命令真实性高，但启动时间、内存和镜像管理成本也高。 | 只适合“必须运行真实 Linux 二进制/内核”的隔离执行模式，不能作为默认 `ctx.fs` 或普通文件工具层。可作为未来 Cloud/VM handoff 的后端，而不是 Worker 内默认实现。 |
| [SlashPC](https://github.com/prakis/slashpc) | 独立的浏览器 Linux 应用，README 写明 BusyBox Linux 运行在 v86 fork，Filer 通过 9P 提供 IndexedDB 持久目录，另有 Pyodide。 | 它是应用级集成示例，不是通用 npm runtime；README 使用的 v86 fork 和上游 v86 不能互换。其 cold boot、镜像大小、服务 worker 和 Filer 版本都属于该应用的部署实现。 | 对“真实 Linux + 持久工作区 + 浏览器 UI”有演示价值，但不应被当作可直接嵌入 DSH 的库。 |

### 2.4 纯 VFS 库

[BrowserFS](https://github.com/jvilk/BrowserFS)、[Filer](https://github.com/filerjs/filer)、[memfs](https://github.com/streamich/memfs) 和 [ZenFS](https://github.com/zen-fs/core) 都是真实的浏览器/Node 文件系统库，但它们不提供 Shell 命令集。BrowserFS README 在 2024 年明确标记项目为 deprecated，并指向 ZenFS；Filer 主要是异步 Node-like `fs` API 和 IndexedDB backend；memfs 是内存 `fs`/File System API 实现；ZenFS 提供同步/异步 backend、OPFS/IndexedDB 等扩展包和 Node API 模拟。

对 DSH 来说，VFS 库与 CLI 解释器应分别评估。VFS 解决路径、目录、文件、元数据、持久化和挂载；Shell 或 WASI 运行时解决命令解析、管道、重定向、退出码和 stdout/stderr。将两者拼在一起时，必须定义同步 guest API 到异步浏览器存储的适配规则。

## 三、项目之间真正的技术差异

### 3.1 “VFS”不是一个能力

至少要区分五种 VFS：进程内临时内存树、浏览器持久化树、同步 guest 文件系统、异步 JS 文件 API，以及通过 9P/MessagePort/HTTP 代理的远程树。Lifo 的 IndexedDB backend 是对整个 INode tree 的序列化保存；wasi-sh 的 guest 需要同步的 ZenFS-shaped `statSync`/`readSync`/`writeSync`；Filer 默认异步；v86 的 JSON/HTTP FS 是给 guest 的 9P 服务。它们的错误、元数据、并发和 flush 语义不能直接替换。

### 3.2 “CLI”至少有三层

第一层是 JS 直接调用的文件方法，如 `readFile`、`writeFile` 和 `search`；第二层是 JS-native 命令注册表，如 Lifo、vanilla-shell 和 Bashkit custom builtins；第三层是 WASI/VM 中的 Shell 和真实/重实现工具，如 wasi-sh、uutils、BROWSIX 和 v86。DSH 工具应优先选择能返回结构化结果、可取消、可限制输出和可记录事件的入口，不应为了“像终端”而强制把所有调用编码成字符串 Shell。

### 3.3 “持久化”不是“刷新后仍能看到文件”

Browser-Native DSH 至少需要区分文件写入确认、Session 事件确认、Worker 被终止、页面刷新、多个 tab 竞争、配额耗尽和外部副作用未知。wasi-sh README 对 `persistentFs` 和 `journalFs` 的区分正好说明了这个问题：异步写回可能在长期阻塞的 guest 中无法运行，journal writer 才能在 guest 停驻时把写入落到后端。Lifo 的保存后端则是序列化整个树，不能自动推出增量日志、跨 tab owner 或 crash consistency。

### 3.4 “沙箱”不等于 DSH 安全边界

浏览器 VFS 可以阻止工具触碰宿主真实磁盘，但不能自动解决模型凭据、网络出口、同源请求、跨 tab 写入、Session 篡改、未授权 UI 操作或工具副作用。DSH 仍需在 Host/Worker capability registry、LLM proxy、Origin/CSRF、principal binding、Session event authority 和 handoff 语义上建立自己的安全边界。

## 四、与 Browser-Native DSH 的关系

当前仓库的 Browser-Native 研究已经把 Worker Host、Agent Loop、同源模型代理、浏览器 VFS tool、Session persistence、ownership 和 route authorization 分开讨论；浏览器文件系统项目应作为其中一个 provider family，而不是把外部 runtime 当成新的 DSH。现有实施计划也明确：Worker 不应携带 provider key、`x-api-key` 或任意 URL relay，生产 Browser Native profile 必须显式 opt-in，普通 `web`/`headless`/`sdk`/`acp` profile 不应隐式改变 Agent Loop 所有权。

建议把文件与 Shell 能力拆成以下 DSH capability roles：

| DSH 角色 | 需要定义的能力 | 外部项目能提供什么 | 仍由 DSH 负责什么 |
|---|---|---|---|
| `ctx.fs` provider | 路径命名空间、读写、目录、元数据、权限、快照/恢复、配额和 owner | ZenFS、Lifo VFS、Bashkit host FS、OpenFS、Filer/memfs | DSH principal、模型可见性、事件日志、跨 tab lease、恢复和失败分类 |
| Shell/command provider | 命令 allowlist、参数、stdout/stderr、退出码、取消、输出上限、结构化 tool result | Lifo registry、Bashkit builtins、vanilla-shell commands、wasi-sh/uutils | 工具 schema、审批、审计、Session settlement、重试/未知副作用政策 |
| WASI adapter | module 加载、WASI fd、preopen、同步 guest FS、Worker transport | browser_wasi_shim、wasi-sh、uutils | 模块供应链、权限、资源预算、版本锁定、错误映射和结果记录 |
| task/runtime provider | Worker task、管道、PTY、进程、VM、网络和终端 | BROWSIX、Wanix、v86/SlashPC | DSH lifecycle、ownership、handoff、Session 与外部副作用一致性 |

对默认 DSH 插件的关键问题是依赖盘点。`ctx.fs` 只是底层文件能力；Shell、subprocess、terminal、LSP、browser-use、computer-use、document conversion 和 package/runtime plugins 可能还依赖 Node API、真实进程、网络、可执行文件、长期目录或系统权限。不能因某个 VFS 能运行 `grep` 就宣称默认插件树已可在浏览器运行。

第一阶段的合理目标是“选择性 Browser-Native composition”：只装载已经有浏览器 provider、纯 JS/WASM 实现或明确禁用宿主依赖的插件；对其他插件在 profile reconcile 时显式拒绝或提供替代 provider。这样可以保持 DSH 的 all-plugin composition，而不把完整 Node 运行时的隐式假设塞进 Worker。

## 四点五、当前 PoC 实现注解

本节只解释当前 checkout 中 Browser-Native DSH 文件工具的证据，不把它提升为正式 DSH API，也不把 WIP 进度记录写成已发布能力。实现和测试入口见 [Browser 文件工具下一批验证计划](browser-native-dsh-poc/browser-file-tools-next-validation-plan.md) 与 [进度记录](browser-native-dsh-poc/browser-file-tools-next-validation-progress.md)。

### 证据等级

| 结论类型 | 本报告中的含义 |
|---|---|
| 源码事实 | 当前 checkout 的 `MemoryVfs`、Worker Host、provider 和文件工具源码直接表达的行为；仍需结合测试判断可观测结果。 |
| 自动化证据 | 已实际运行的 Vitest、backend contract test、preview build 或真实 Chrome Worker E2E；命令和结果以进度记录为准。 |
| 真实模型证据 | 同源 backend 使用配置的真实模型完成的有限回归，只覆盖记录中的任务，不外推到模型会自主选择每个 Browser 工具。 |
| 设计建议 | 对生产 Workspace、WASI、Shell、VM、云对象存储或正式 capability manifest 的建议；不是当前 PoC 已有能力。 |

### 当前 checkout 的分层边界

当前 PoC 使用 Worker 中的 `MemoryVfs`、结构化 Browser 文件工具 provider 和 Workspace durable mirror；文件工具名称集中在 [`browser-native-capabilities.ts`](browser-native-dsh-poc/browser-native-capabilities.ts)，`grep` 和 `glob` 通过 [`browser-native-file-tools.ts`](browser-native-dsh-poc/browser-native-file-tools.ts) 访问 Worker VFS。它没有引入 Lifo、Bashkit、wasi-sh、uutils、BROWSIX、Wanix 或 v86，因此本轮没有验证这些项目能否作为 DSH provider。

本轮实现的“增量”是资源受限的文件工具执行：目录遍历不先构造完整路径数组，`grep` 以 64 KiB range read 和流式 UTF-8 decoder 读取，`glob` 有独立的 5,000 路径结果上限，搜索 pattern/include glob 有字节上限，brace expansion 有分支上限，非法 UTF-8/NUL 输入返回二进制错误。它不是完整 Shell、ripgrep、POSIX 文件系统、块级 delta 或块级编辑；`edit` 仍会完整 materialize 文件，正则复杂度检查也只是有限启发式。

因此，本 PoC 具体验证的是“Worker VFS + 结构化 command provider”这一层，而不是“浏览器已经获得主机 CLI”。若未来接入 WASI 或 Shell，应将其作为独立的 runtime adapter，重新验证同步 guest FS、取消、输出预算、权限、Session tool settlement 和 Worker 生命周期；不能把第三方 runtime 的命令数量直接映射为 DSH 默认插件兼容性。

当前 Chrome 证据覆盖文件搜索边界、取消后继续、OPFS 外置大文件的 `read → grep → edit → read`，以及真实模型的普通大小文件 `read → write → read` 回归。真实模型回归不覆盖大文件 fallback 的自主工具选择；自然 storage eviction、OS/磁盘崩溃、生产对象存储、多实例 backend、完整插件兼容矩阵和任意容量编辑仍未验证。Workspace、Session、lease 和 durable store 的恢复语义仍按各自文档解释，不能据此声称跨存储原子事务。

这项注解的工程含义是：当前不需要为了证明浏览器文件搜索而引入完整 Shell runtime；优先把 VFS、结构化工具、持久化和 DSH 事实层分别验收。第三方 runtime 只有在需要 Shell 兼容性、WASI 工具复用或 VM 隔离时，才应通过单独的候选 adapter 验证进入选型。

## 五、初步选型建议

### 5.1 建议的候选分组

| 目标 | 首轮候选 | 选择理由 | 首要风险 |
|---|---|---|---|
| JS-native 文件工具和命令注册 | Lifo；Bashkit | 直接 API、可注册 JS builtins、无需把所有工具调用串成 Shell | 与 DSH capability、权限和事件模型没有现成 adapter；命令/Node shim 语义需逐项验证 |
| 标准 Shell 脚本和 WASI 工具 | wasi-sh + ZenFS；uutils + browser_wasi_shim | 真实 WASI 运行路径、可注入文件系统、可执行受限脚本 | 同步 guest 与异步持久化、SAB/COOP/COEP、工具子集和资源预算 |
| 文档库搜索和快照 | OpenFS | SQLite/FTS5、snapshot、路径组过滤和 Agent-oriented API | 新项目、包名/README 不一致、通用 POSIX 语义和并发尚未证明 |
| 复杂 namespace/task/VM | Wanix | 适合把文件、任务、终端、WASI、JS 和 v86 纳入统一 namespace | 集成面大，权限和 ownership 需要重做，第一版可能过重 |
| 真实 Linux 二进制 | v86；SlashPC 仅作应用参考 | 能启动真实 kernel/BusyBox，兼容性最高 | 镜像体积、启动、内存、VM 状态和持久化成本，不适合作为默认 Worker FS |

### 5.2 不建议的当前结论

不建议把 `BrowserFS` 直接作为新方案的默认推荐，因为其 README 已标记 deprecated；优先评估 ZenFS 及其 `@zenfs/dom` backend。也不建议把 vanilla-shell、OpenFS 或任何 `0.x`/新仓库项目称为成熟生产方案，除非补充可重复的兼容性、故障恢复、性能和安全证据。

不建议第一版直接引入 v86、BROWSIX 或完整 Wanix 来“获得 Linux”。DSH 首先需要一个受控的文件和工具 capability；完整系统会额外引入进程、设备、网络、镜像、终端、跨线程和供应链问题。真实 Linux 应作为显式的重型执行模式或云端 handoff，而不是默认浏览器 Agent Loop 的隐含依赖。

### 5.3 推荐的研究路线

建议建立一个内部 `BrowserFsProvider` 和 `BrowserCommandProvider` 的实验性 capability seam，分别测试至少两种实现：`ZenFS/InMemory + custom builtins` 代表 JS-native 路线，`ZenFS + wasi-sh` 或 `browser_wasi_shim + uutils` 代表 WASI 路线。候选项目只作为 provider implementation，不改变 DSH 的 Session、Agent Loop、LLM proxy、ownership 和 event authority。

首轮应优先验证 DSH 实际插件依赖，而不是扩充命令数量。以默认 Browser-Native profile 的最小插件集合运行真实 Worker turn，记录每个插件需要的文件 API、目录持久化、Node module、subprocess、network、terminal、WASM 或 native capability；缺失项进入 profile load-time failure 或显式替代 provider。

## 六、下一轮验证

下一轮研究可以把以下检查变成可执行矩阵：

| 主题 | 最小验收 |
|---|---|
| 文件语义 | UTF-8/二进制读写、空文件、目录、rename/unlink-while-open、路径规范化、错误码、mtime/mode、软链接策略 |
| Shell 语义 | pipes、redirection、glob、变量、command substitution、`&&`/`||`、退出码、stderr、SIGINT/取消、输出上限 |
| Worker | cold boot、并发命令、长命令、Worker terminate、页面刷新、重建 VFS、无 SAB 浏览器路径 |
| 持久化 | hydrate、flush、quota failure、写回未知、journal、跨 tab owner、reload/replay、Session event 与文件 revision 关联 |
| DSH 集成 | `ctx.fs` provider、工具 schema、审批、structured result、模型可见输入日志、tool-call settlement、snapshot replay |
| 安全 | Worker bundle 无 provider key、无任意 URL/header relay、网络 allowlist、Origin/CSRF、路径越界、工具 allowlist、principal binding |
| 资源 | 首次加载、WASM 包体积、内存增长、CPU/墙钟预算、单 turn command 数、文件/输出大小和浏览器配额 |

建议把每个外部项目的验证分为“README 事实”“源码事实”“最小运行事实”和“DSH 集成事实”。只有最后一层通过，项目才可以进入 Browser-Native DSH 的候选实现，而不是只列在生态调研表中。

## 证据索引

本次核验使用的主要一手来源如下。链接指向项目官方仓库、官方文档或 npm 元数据；版本和 Stars 等动态字段只作为检索时的背景，不能作为质量证明。

| 主题 | 来源 |
|---|---|
| Lifo API、VFS、`/proc`/`/dev`、IndexedDB | [Lifo repository](https://github.com/lifo-sh/lifo)、[`@lifo-sh/core` npm](https://www.npmjs.com/package/@lifo-sh/core)；仓库内 Sandbox 和 persistence backend 的路径按该仓库当前源码核对 |
| OpenFS package/API/grep optimizer | [OpenFS repository](https://github.com/asdtransport/openfs)、[`openfs-wasm` npm](https://www.npmjs.com/package/openfs-wasm)、[WASM entry source](https://github.com/asdtransport/openfs/blob/main/packages/wasm/src/index.ts) |
| vanilla-shell 的自我限制和功能表 | [`vanilla-shell` npm](https://www.npmjs.com/package/vanilla-shell) |
| wasi-sh 的 run/spawn、FS contract、persistent/journal 语义 | [wasi-sh repository](https://github.com/alganet/wasi-sh)、[README](https://github.com/alganet/wasi-sh/blob/main/README.md)、[FS source](https://github.com/alganet/wasi-sh/blob/main/src/fs.mjs)、[architecture](https://github.com/alganet/wasi-sh/blob/main/ARCHITECTURE.md) |
| Bashkit 包名、API、浏览器限制 | [Bashkit repository](https://github.com/everruns/bashkit)、[`@everruns/bashkit-wasm` npm](https://www.npmjs.com/package/@everruns/bashkit-wasm)、[browser README](https://github.com/everruns/bashkit/blob/main/crates/bashkit-wasm/README.md) |
| uutils WASI build 和 browser Playground | [uutils/coreutils](https://github.com/uutils/coreutils)、[WASI workflow](https://github.com/uutils/coreutils/blob/main/.github/workflows/wasi.yml)、[Playground](https://uutils.org/playground/)、[Playground architecture](https://uutils.org/playground-how-it-works/) |
| browser WASI shim | [browser_wasi_shim repository](https://github.com/bjorn3/browser_wasi_shim) |
| VS Code Web 的 terminal 限制 | [VS Code for the Web documentation](https://code.visualstudio.com/docs/editor/vscode-web) |
| BROWSIX | [BROWSIX repository](https://github.com/plasma-umass/browsix)、[README](https://github.com/plasma-umass/browsix/blob/master/README.md) |
| Wanix namespace/task/VM/OPFS API | [Wanix repository](https://github.com/tractordev/wanix)、[README](https://github.com/tractordev/wanix/blob/main/README.md)、[JS handle API](https://github.com/tractordev/wanix/blob/main/api/handle.js) |
| v86 及其 9P/JSON/HTTP filesystem | [v86 repository](https://github.com/copy/v86)、[README](https://github.com/copy/v86/blob/master/Readme.md)、[filesystem documentation](https://github.com/copy/v86/blob/master/docs/filesystem.md) |
| SlashPC 的 Filer + v86 fork + 9P 组合 | [SlashPC repository](https://github.com/prakis/slashpc)、[README](https://github.com/prakis/slashpc/blob/main/README.md) |
| BrowserFS/Filer/memfs/ZenFS 的 VFS 定位 | [BrowserFS](https://github.com/jvilk/BrowserFS)、[Filer](https://github.com/filerjs/filer)、[memfs](https://github.com/streamich/memfs)、[ZenFS](https://github.com/zen-fs/core) |

## Further Exploration

- [DSH 浏览器原生运行时、云端工作区与本机桥接深度调研](dsh-browser-native-runtime-research.md)
- [Browser-Native Agent implementation plan](dsh-browser-native-agent-implementation-plan.md)
- [DSH Browser-Native VFS and cloud sync research](dsh-browser-native-vfs-cloud-sync-research.md)
- [Browser-Native 文件工具下一批验证计划](browser-native-dsh-poc/browser-file-tools-next-validation-plan.md)与[进度](browser-native-dsh-poc/browser-file-tools-next-validation-progress.md)
- [DSH deployment and tenancy deep dive](dsh-deployment-and-tenancy-deep-dive.md)

## Dev Note

本文是 `docs/drafts/` 下的中文单语事实核查草稿。外部项目事实以 2026-10-24 的公开 README、源码、npm 元数据和官方文档为依据；没有把 Stars、Forks、包版本或项目自述的“production-ready”当成独立质量证明。下一轮进入实现前，应固定候选版本，运行本文“下一轮验证”中的最小矩阵，并把最终采用的 DSH capability seam、权限模型、持久化语义和失败处理写入正式设计记录。
