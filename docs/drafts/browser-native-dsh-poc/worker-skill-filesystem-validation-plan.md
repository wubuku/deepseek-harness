---
description: "规划在真实 Browser Worker 中验证 DSH skill-filesystem 对 VFS、watcher、Session 投影和 Workspace 持久化的集成。"
---

# Browser Worker skill 文件系统集成验证计划

## 目标

在真实 Chrome Dedicated Worker 和 DSH Agent Loop 中启用现有 `dsh-skill-filesystem`、`dsh-skill` 与 `dsh-tool-skill`，确认它们只读取 Worker VFS 内配置的 Workspace skill 根目录，并验证 skill 目录变化、模型可见上下文、Session 记录、Workspace 持久化和 Worker 恢复保持一致。

本批验证 DSH 现有文件系统插件能否在 Browser-Native Worker 中作为实际应用能力运行，不实现新的 skill 格式、Shell、宿主文件桥接或生产登录；不把本地 Node API shim 描述为完整 Node.js。

## 候选范围与选择

| 候选验证点 | 价值 | 决定 | 原因 |
|---|---:|---|---|
| 实际 DSH 文件系统插件消费 Worker VFS | P0 | 纳入 | 最近的 Node shim trace 只验证文件工具与一个 `node:fs/promises` 探针，没有验证 DSH 插件经 Node API、Chokidar 和 `ctx.fs` 合作。 |
| skill 目录变化使模型可见目录更新 | P0 | 纳入 | 这验证 VFS mutation、watcher、skill registry 与 `tool-skill` 的真实集成，不以文件存在或模块成功加载代替用户价值。 |
| Session 与 Workspace 刷新恢复的一致性 | P0 | 纳入 | 已加载指令进入模型上下文后，刷新必须由 Session event 与 durable Workspace bytes 重建，不能依赖 Worker 内存。 |
| 本地或远端保存失败时不发布未确认 skill | P0 | 纳入 | skill 指令可能改变后续模型行为；volatile 文件若先进入目录或模型请求，会造成刷新后无法解释的上下文分歧。 |
| 缺失根创建、重命名、删除和 watcher dispose 的全量边界 | P1 | 部分纳入 | 验证主要 add/edit/delete 生命周期与关闭后的隔离；不扩展所有 Chokidar 语义或后台 watcher。 |
| Browser 默认 profile 全量启用本地 skill 根 | P1 | 不纳入 | 当前 Browser profile 未声明 skill 用户体验；本批仅用 PoC validation profile，不更改默认工具 roster。 |
| 任意 DSH 插件的 Node builtin conformance 自动发现 | P1 | 延后 | 单个插件集成提供了有用的真实消费者，但通用发现需要有维护责任的 capability catalog，不能从一条运行 trace 推导。 |
| Session 离线正文缓存、跨设备撤销和用户认证 | P1 | 延后 | 会引入独立的授权、缓存保留和撤销协议，超出验证现有 Browser Worker 文件能力的范围。 |
| 自然 eviction、OS 崩溃和生产对象存储 | P1 | 延后 | 当前批用可重复的 Chrome 故障注入回答插件集成问题，不把它们与自然系统故障混为一谈。 |

## 实施边界

- 所有新增 profile、脚本、测试和记录放在本目录；只在确有必要时修改目录外代码，并在 `change-ledger.md` 记录理由与上游重放方法。
- 新增 validation-only roster，将 `dsh-skill-filesystem` 限定到 `/dsh/home/workspace/.agents/skills`，设置 `includeDefaultRoots: false`，禁止扫描宿主机用户目录或工作区外路径；不修改默认 Browser profile。
- 复用 base profile 已注册的真实 `dsh-skill` registry，并在 validation-only preset 加载 `dsh-skill-filesystem` provider 与 `dsh-tool-skill` model tool；同时复用 Browser Worker Host、Session backend 和 Workspace durable store。不重复注册 registry，也不模拟 skill catalog 或替代 DSH Agent Loop。
- 使用 scripted Chrome 测试确定性地选择 skill 工具及触发 Workspace 变更；另用真实 LLM 至少完成一次显式 skill 调用与刷新后同一 Session 恢复。真实模型密钥只由 backend 从 `docs/drafts/.env` 读取。
- Session catalog、skill 工具结果与模型可见正文必须来自已记录 Session 与当前 Workspace revision；禁止把浏览器内存数组当成独立 transcript 或事实源。
- 采集只含事件类型、Session seq、Workspace revision/hash、工具身份与请求计数的脱敏证据，不保存 skill 正文、Cookie、owner token、模型凭据或原始用户环境路径。

## 阶段

### M0：消费路径与风险基线

核对 `dsh-skill-filesystem` 的 `ctx.fs` / Node fallback 分支、Chokidar 与 `fs.watch` 生命周期、`dsh-skill` 失效通知、`dsh-tool-skill` 的目录和加载事件，以及当前 Browser test-port、profile overlay 和 durable Workspace 写路径。

运行现有相关 package 单测与 PoC 基线；确认 validation profile 能只声明 Workspace 内 skill 根，并记录本批不覆盖的宿主文件、用户目录和生产认证风险。

### M1：验证专用 Worker profile

建立仅供测试使用的 validation roster，加载 skill registry、本地文件 provider 和模型工具；从 durable Workspace 建立 skill 根目录，配置空闲时没有宿主 fallback 的隔离根。

启动真实 DSH Worker Host，检查 capability publication、模型 schema、`skill` 工具注册和 profile boot errors；任何缺插件、schema 不匹配或尝试读取允许根目录外的请求都必须失败并出现在诊断中。

### M2：目录、watcher 与工具闭环

在 Chrome 中验证初始 skill catalog、显式 `skill` tool load、skill 正文进入 DSH Session tool result，以及 add/edit/delete 后 registry 失效和后续模型步骤收到的 catalog 更新。

分别确认新增/修改/删除通过 DSH Workspace 写路径完成，Session tool call/result 与 Workspace revision 对应，单次文件操作不重复 commit；如果 provider 使用 `fs.watch`/`fs.watchFile`，结果必须证明事件来自 Worker VFS，而不是宿主目录或 backend。

### M3：持久化、失败与刷新恢复

对 skill 文件提交前后的 Session event、Workspace receipt 和远端 manifest revision 做关联核对；注入本地 OPFS durable write 失败，检查未持久化的 skill 不得出现在后续模型工具 schema、目录或上下文中，也不得写入远端 Workspace。

刷新并重建 Worker 后，从同一 Session 与 Workspace 恢复当前 skill 目录和已加载上下文；不得重发已完成的 user prompt、tool call 或 Workspace effect。远端 commit response 故障对账与旧 Worker teardown fencing 不属于本批验收。

### M4：真实 LLM 冒烟

使用真实 Chrome、同源 LLM backend 和 `docs/drafts/.env`，通过用户显式 skill invocation 或模型 `skill` tool 加载 Workspace skill，要求模型响应包含 skill 指令中的唯一无敏感 marker；刷新后复用同一 Session 验证 marker 和文件仍可读取。

验证实际模型请求、Session event 与 Workspace commit 计数；检查浏览器只访问同源服务、凭据不进入页面/Worker/日志/Session，真实 LLM 冒烟不替代 scripted 故障矩阵。

### M5：文档与交付

更新 PoC README、兼容矩阵、change ledger、本计划、本进度和 `docs/drafts/README.md` 中相关目录登记。逐条区分 scripted 故障、真实 Chrome Worker、真实 LLM 与源码核查证据。

运行针对性 package 与 PoC 测试、Preview build、真实 Chrome scripted E2E、真实 LLM smoke、`test:docs`、`doc-sync`、变更范围和 diff 检查；按 `dsh-pre-push-checks` 选择推送前检查，再提交并推送 `research`。

## 验收矩阵

| 场景 | 通过条件 | 证据 |
|---|---|---|
| Profile 与文件访问 | skill provider 在真实 Worker 启动；只扫描指定 Workspace 内根，不读取 host home 或 Workspace 外路径 | Chrome network/Worker 诊断、Session tool schema、配置断言 |
| Skill load | `tool-skill` 通过 `ctx.skills` 读取当前 VFS 正文，Session 恰有一个匹配 call/result，模型可见正文与 Workspace 文件一致 | scripted DSH turn、Session events、内容 hash/长度摘要 |
| 目录变化 | add/edit/delete 后目录按 DSH provider 语义失效；下一次模型请求看到更新，不出现重复 Workspace commit 或陈旧新调用 | Chrome Worker E2E、Session catalog event、Workspace revision 与工具计数 |
| 本地保存失败 | OPFS 写失败的 skill 不进入后续模型 schema/context 或远端 Workspace；失败后的同一 Session 可继续并在刷新后恢复 | OPFS quota fault 注入、request body、Session/Workspace 事件 |
| 刷新恢复 | 同一 Session 从 durable Workspace 重建正确目录和已加载上下文；不重复已完成的 prompt 或工具调用 | Chrome 刷新 E2E、Session tool/result、Workspace revision 与请求计数 |
| 真实 LLM | 真实模型读取 skill 指令并响应 marker，刷新后可恢复；无密钥泄漏或跨源请求 | 脱敏 Chrome E2E 结果、backend 请求计数、Session/Workspace 摘要 |

## 明确不声称

本批不证明任意 Node API、任意 Chokidar watcher 选项、任意 plugin/profile、真实 SaaS 登录或多租户授权、浏览器页面关闭后的执行、自然 eviction、OS/磁盘崩溃、生产对象存储或 Safari/WebKit。验证专用 profile 的通过不自动把 skill 能力加入默认 Browser profile。

本批未在 skill 场景中注入远端 Workspace commit response 故障，也未独立断言页面刷新后旧 Worker watcher 的 fencing；一般 Workspace 故障恢复验证不替代这两项 skill 集成验证。
