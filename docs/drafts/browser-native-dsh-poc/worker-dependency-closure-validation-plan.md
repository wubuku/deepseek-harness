---
description: "规划 Browser-Native DSH Worker 可达依赖闭包、Node 替代实现分类和真实执行路径验证。"
---

# Browser-Native Worker 依赖闭包验证计划

## 目标

验证当前 Browser profile 的 Worker 镜像实际包含哪些可达模块、Node builtin 与 native/external 替代项，并区分“被解析”“由浏览器实现”“结构性 stub”“未解析但运行时 fail loud”和“真实执行通过”。这项工作针对 Browser-Native DSH 最核心的文件系统与 Node 环境依赖，不把 Host 成功启动或模块成功导入当成 API 兼容证明。

DSH-TUI 的能力发布纪律适用于此处：每项能力必须指向可审计的实现来源和执行证据；明确不支持项可以留在依赖闭包中，但不能被报告为可用能力。Dedicated Worker 仍受页面生命周期约束，本计划不引入 Shell、WASI、Native Bridge 或云端执行者。

## 候选范围

| 候选验证点 | 价值 | 本批决定 | 未选或限制 |
|---|---:|---|---|
| Worker 镜像的可达模块请求图 | P0 | 纳入 M1 | 仅扫描全部源码会把不可达代码误报成运行依赖；必须复用 packer 实际裁剪后的 image 和 module lowering。 |
| Node builtin、替代包与未解析 external 的来源分类 | P0 | 纳入 M2 | 分类只描述模块级代理来源；不能推导其每个导出成员均可用。 |
| `ctx.fs` / `node:fs`、path、crypto、stream 和 command Worker 的真实关键路径 | P0 | 纳入 M3 | 以真实 Browser Worker 和真实 DSH 工具/请求路径验收；不逐项复刻 Node 完整 API。 |
| 结构性 stub 与主机专属依赖的 fail-loud 负例 | P0 | 纳入 M3 | 只验证诊断和无副作用拒绝，不试图让不支持的宿主能力在浏览器伪装成功。 |
| 每个 shim 每个导出成员的 Node 兼容 conformance | P1 | 延后 | 范围等同独立兼容性项目；优先覆盖实际 Browser profile 可达且用户路径触及的成员。 |
| 多个 DSH profile 的依赖闭包比较 | P1 | 延后 | 本批只认准部署入口 `web` profile；其他 profile 需分别声明产品目标。 |
| 第三方插件运行时安装、签名和动态依赖加载 | P1 | 排除 | 当前 Worker 镜像按版本打包可信代码；动态安装需要独立供应链和安全设计。 |
| HMR/plugin unload 时 shim、VFS 与子 Worker 的资源生命周期 | P1 | 延后 | 属于生命周期/资源泄漏批次，不与依赖分类混为一个结论。 |
| 非静态动态 import、native addon、computed require 的运行时审计 | P0 | 纳入 M2 报告限制 | 静态扫描无法证明这类请求不可达；列出当前 packer 的识别范围和未解析项，不伪造完整动态分析。 |
| 全量 Node API 等价、完整 POSIX 权限/链接/watch 语义 | P2 | 明确不做 | Browser VFS 提供受限语义，不是宿主文件系统或完整 Node。 |

## 交付面

### M1：从实际 Worker image 导出依赖请求

扩展 `webworker-packer` 的 `PackResult`，返回 reachability sweep 实际处理的模块请求：请求模块、导入者、请求类别、解析结果和 image 内目标路径。packer 的根包括 Worker assembly seeds，以及每个已物化 workspace package 的全部非通配符运行时导出；因此报告是保守的打包闭包，不等于合成 profile 实际激活的插件集合或模块执行轨迹。记录 Worker static proxy 请求与 unresolved external 请求，不把页面 Client bundles 当成 Worker Host 依赖。

该输出必须来自 packer 自己的 resolver/lowering pass，不能在 PoC 中再实现一套不一致的 Node-style resolver。新增测试覆盖相对模块、package export、static proxy、meta resolve 和 tolerated unresolved external。

### M2：生成 Browser profile 依赖闭包审计

新增可复跑生成器，以当前 `web` Worker image 和 runtime `MODULE_PROXIES` 为输入，输出稳定 JSON 报告。报告至少列出：Worker image 中的模块数、静态请求数、Node builtin 请求及 importer、代理路径属于 `implemented`/`mock`/外部替代、未解析 external、native/external replacement、动态解析覆盖限制和 image wrapper contract。

生成器对所有记录执行分类完整性检查；新出现但无法分类的 static proxy 必须使生成失败。报告必须声明 `implemented` 仅表示代理源码归类，不表示该模块的全部 Node 导出都已实现。

### M3：真实 Chrome 执行矩阵

使用 built preview 的真实 Dedicated Worker、DSH Host 和 `ctx.agentLoop` 验证一组由审计闭包选出的文件/运行时路径：浏览器 Shell 命令、Workspace redirection、真实 LLM 文件工具和 Session 持久化。Chrome 负例执行不支持的 host command，要求错误可诊断、Workspace 文件集和 commit 数不增加；`node:vm` 等结构性 stub 的直接 fail-loud 语义由 runtime 的 node-stub 单测覆盖，不把单测冒充浏览器执行证据。

Scripted Chrome 负责可重复的 success/failure assertions；真实 LLM smoke 至少完成一次 DSH 文件工具回路。两种证据分开记录。只对实际触及的路径声称已验证，不因 Browser profile 完成一轮任务就声称全部可达模块可用。

### M4：文档、回归和交付

更新 packer README/JSDoc、PoC README、运行时兼容矩阵、`docs/drafts/README.md` 与 `change-ledger.md`。记录生成报告的命令、Chrome/真实 LLM 结果、静态分析遗漏类型和仍未验证的 Node API。

## 验收标准

| 证据 | 通过条件 |
|---|---|
| Packer request graph | 每条被解析请求均有 importer、request kind 与 resolution；unresolved module 与 meta-resolve request 均明确记录；现有 image 内容与 boot 行为不变。 |
| 依赖分类报告 | 当前 `web` profile 的 Worker Node builtin、proxy replacement、mock 和 unresolved 项均分类；未知分类使生成失败；JSON 可重复生成且 diff 稳定。 |
| Chrome 正向路径 | 真实 Worker/DSH Loop 完成文件 read/write、受限 shell 命令和同源 LLM/Session 路径；每次 mutation/调用有可核对事件，未发生跨源请求。 |
| Chrome 负向路径 | 不支持的 host command 在真实 DSH tool result 中明确失败；不新增 Workspace 文件或 commit。结构性 stub 的 fail-loud 由其定向 runtime 单测证明。 |
| 真实 LLM 烟测 | 使用 backend-only 的 `docs/drafts/.env` 完成至少一轮真实 DSH 文件工具调用与回复；不打印或持久化密钥。 |
| 文档事实 | 明确静态可达不等于动态执行、模块级 `implemented` 不等于成员完整实现，未测路径均列为限制。 |

## 限制

- Packer 的 graph 根包括已物化 workspace 包的全部非通配符运行时导出；这比 profile 配置实际激活的插件集合更宽。它覆盖可识别的静态 import/require 与受支持的 `createRequire(import.meta.url)` 请求；computed specifier、运行时构造路径和模块执行分支不能由静态闭包完整证明。
- Worker 的 Node compatibility shim 有逐导出限制；本批提供模块来源和选定行为证据，不生成完整 Node API 兼容声明。
- 构建镜像的 `web` profile 不是所有 Web 配置、任意外部插件或未来版本的证明。
- 真实 LLM 只证明选定任务路径，不证明模型会规避所有 unsupported capability。
- 测试只运行 Chrome；Safari/WebKit 维持暂停。

## Dev Note

先实现依赖请求的 packer 产物，再决定报告是否需要运行时执行覆盖。不得为了让审计“全绿”把 unresolved external 静默过滤；新增分类应保留 importer 和明确的 fail-loud 责任。
