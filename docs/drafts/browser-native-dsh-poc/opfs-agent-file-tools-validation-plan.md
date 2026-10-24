---
description: "规划通过真实 DSH 文件工具验证 OPFS 外置大文件的流式读取、搜索、编辑和刷新恢复。"
---

# OPFS 外置文件的 DSH 工具闭环验证计划

## 结论

Browser-Native PoC 已分别验证 16/64 MiB Workspace 分块传输、OPFS sync-handle VFS backing、冷启动分块 hydrate，以及 DSH `read`/`grep`/`edit` 的普通文件操作。但这些证据尚未连成一条路径：真实 DSH 文件工具没有在冷 hydrate 后的 OPFS 外置大文件上运行，也没有证明模型只收到有界结果、编辑时完整文件被正确 materialize、atomic-write staging 不进入 Workspace manifest，且新版本可再次冷恢复。

本批在真实 Chrome、Dedicated Worker 和 DSH `ctx.agentLoop` 中验证一份 12 MiB UTF-8 多行文件的 `read → grep → edit → read`。用 scripted LLM 固定工具选择以隔离运行时和存储语义；它不代替真实模型验收。文件字节由 Worker test port 在浏览器本地生成，不经页面、模型请求或 Session 上传。

## 候选范围

| 候选验证面 | 价值 | 当前证据 | 本批决定 |
|---|---:|---|---|
| 冷 hydrate 后，DSH `read` 是否从 OPFS backing 流式读取并限制输出 | P0 | `read` 源码对大文件使用 `ctx.fs.streamText`；OPFS E2E 只直接调用 VFS range API | 选择 |
| 默认 `grep` 在 Worker 缺少 ripgrep 子进程时是否返回可见错误，且 Agent 能继续处理 | P0 | `dsh-tool-fs-search` 通过 `ctx.subprocess` 启动打包的 ripgrep；Worker runtime 将 `@vscode/ripgrep` 映射到不可执行 stub | 选择；验证并记录当前不支持，而非假定 grep 可用 |
| DSH `edit` 是否能把外置文件安全 materialize、原子替换并形成单一 Workspace mutation | P0 | VFS backing 单测和小文件 Agent edit receipt 各自通过，未验证两者组合和原子写 staging 过滤 | 选择 |
| 修改后的大文件能否提交、刷新后重新 externalize，并由同一 Session 的 DSH 工具读到 | P0 | 大文件传输、OPFS 冷 hydrate、Agent Session 恢复分开验证 | 选择 |
| 文件工具是否把完整大文件内容写进 LLM 请求或 Session | P0 | 大工具参数有 1 MiB 上限；`read` 有输出上限，尚无大文件实际调用记录 | 选择并设为安全验收 |
| OPFS range read 错误或句柄关闭时的 DSH 工具错误语义 | P1 | backing 读取和 Worker 关闭各有单项测试，没有模型可见错误 E2E | 仅检查现有错误能否浮现；不新增故障注入接缝 |
| DSH `write` 覆盖外置大文件的内存峰值和 diff 结果 | P1 | 普通 VFS 写入、diff 限制和 OPFS 读取分开验证 | 延后；本批通过 `edit` 验证写时 materialize，不扩大到整文件覆盖 |
| 并发 `read`/`grep` 与互斥 `edit` 的 Agent Loop 调度 | P1 | Agent Loop 的并发分类有核心测试，浏览器 Worker 没有同一大文件组合证据 | 延后；本批按确定序列避免混淆文件变更时序 |
| 多个外置大文件混合工作集、总驻留内存和浏览器 heap 峰值 | P1 | 单文件 VFS `residentBytes` 和 1,000 小文件规模已有测试 | 延后；需要独立工作集基准与浏览器 heap 采样标准 |
| 二进制、无效 UTF-8、极长行、CRLF 和空文件在 Agent 工具中的处理 | P1 | 文件工具包有单测，Browser VFS 有二进制与文本基本用例 | 延后；不把本批单一 UTF-8 文件外推为完整格式矩阵 |
| 用户本机目录导入、File System Access 授权撤销和外部文件变化 | P1 | 当前 Workspace 是 OPFS/远端存储，不等同用户硬盘 | 延后；需单独定义本机目录授权和同步语义 |
| 本地 corruption 恢复包重新导入 | P1 | 当前可导出 hash 校验后的本地数据，尚无恢复导入协议 | 延后；需先定义覆盖、冲突和身份确认规则 |
| 多账号切换、退出登录后的 OPFS 数据归属 | P0（产品安全） | PoC 匿名 identity 与 Chrome 强杀身份缺口已有证据；没有 SaaS 登录/登出合同 | 保留高优先级候选，但不在本批模拟不存在的认证产品 |
| 不支持 OPFS/IndexedDB 的浏览器 capability preflight | P1 | 当前 Chrome 路径已验证；Safari 与移动端新测试暂停 | 延后；需先确定正式支持浏览器矩阵 |
| Node builtin、`fs.watch`、LSP、原生 addon 和非 Browser 工具逐插件兼容 | P1 | 插件兼容矩阵明确多数能力尚未验证 | 延后；作为独立插件准入矩阵，不并入文件数据路径实验 |
| 自然 eviction、OS/磁盘崩溃、跨主机 HA、生产云授权 | P0/P1 | 当前 PoC 只能做相邻故障或本机服务验证 | 保留明确限制；不把 mock 宣称为平台等价证据 |

## 验证面

### F1：冷 hydrate 后由 DSH `read` 和 `grep` 访问大文件

在真实 Worker VFS 中生成 12 MiB 文件，按 4 KiB 行分隔并把唯一 marker 放在第二行；commit Workspace 后刷新，使文件通过 OPFS sync backing 冷恢复。让真实 DSH `read` 请求第二行，并让默认 `grep` 搜索唯一 marker。

通过条件：`read` 在 Session 中有真实 `tool/call`/`tool/result`，只返回第二行；默认 `grep` 明确返回 Worker ripgrep 子进程失败，而不是伪造匹配结果；该错误有匹配的 `tool/result`，之后同一 Agent turn 仍继续到 `edit` 和 `read`。VFS `residentBytes` 在冷读取/搜索前后不因文件大小增长；Agent 请求、工具结果和 Session 不包含大文件原文。该项同时记录 stock `grep` 尚不可用于 Browser Worker 的能力缺口。

### F2：在外置 backing 上运行 DSH `edit`

在 F1 的同一 Session 中，用 `edit` 把第二行 marker 替换为新值。文件使用有界 4 KiB 行，避免把一个 12 MiB 单行 diff 当作常规输出。测试暂停 Workspace commit 响应，在 Agent turn 等待期间查询 VFS residency，观察编辑是否从 read-only backing materialize 完整文件；随后放行 commit，让同一 turn 继续由 DSH `read` 验证新值。

通过条件：`edit` 成功并只产生一个 Workspace commit 和一个关联 receipt；操作路径只有目标文件，原子写临时目录不进入 manifest；commit 前文件内容仍完整且只在 Worker VFS 中出现预期新值；commit 后 manifest revision 只增加一次。

### F3：编辑版本的冷恢复和同 Session 工具读取

确认 Workspace commit、Session receipt 和本地 outbox 已结算后刷新页面。重新读取 VFS residency、manifest、blob hash 和 Session，再在同一 Session 通过 DSH `read` 获取新 marker。

通过条件：刷新后文件再次 externalize；blob 字节数与 SHA-256 和 manifest 一致；Agent read 返回编辑后的值；不重放已成功的 edit，不增加 commit 或 receipt；page/Worker errors 为空。

### F4：模型与 Session 载荷限制

捕获同源 LLM 请求、Session events 和 Workspace API metadata，不捕获或打印 provider secret。文件内容由 Worker 本地生成；模型仅接收 `read` 窗口和 `grep` 匹配。

通过条件：任何 LLM 请求或 Session event 都不含 12 MiB 文件内容或其长重复字节串；模型请求和 `tool/result` 体积保持有界；大文件 bytes 只通过 Workspace blob chunk 路径同步。

## 实施顺序

1. 记录干净 `research` 基线，核对 `large-file-scale`、OPFS residency、Agent edit receipt 和 read/grep 上限的现有证据。
2. 新增本计划和初始进度文件，明确 scripted LLM 只负责确定工具选择。
3. 在 PoC backend scripted handler 增加专用大文件工具场景；新增 Chrome E2E，通过 Worker test port 生成文件，再经实际 Web UI 和 Worker Agent Loop 执行工具。
4. 实现一个 commit 暂停点，观察外置文件编辑期间的 materialization 和 mutation 状态；测试结束始终释放路由和所有资源。
5. 断言工具顺序、tool result 身份、Workspace receipt、manifest/revision、staging 路径过滤、模型/Session 载荷、冷恢复 hash 和同 Session 读取。
6. 运行 PoC backend contract test、VFS/Workspace focused tests、Chrome E2E、相关 typecheck/build 与文档门禁；根据实际结果更新 README、兼容矩阵、进度和 change ledger。

## 明确限制

- 本批不将 scripted 工具选择写成真实 LLM 行为；既有真实 Chrome/LLM 三轮工具与记忆 E2E 继续作为独立证据。
- `residentBytes` 是 VFS 节点统计，不是浏览器 heap 峰值或内存 SLA。
- `edit` 需要完整 UTF-8 文件内容，预期会 materialize 整个外置文件；本批不宣称零拷贝编辑或任意大小编辑。对单条超长行的 edit，DSH diff/result metadata 可能随该行增长；该极端用例本批不验收，应单独设置行长度限制或验证结果裁剪策略。
- 默认 Browser roster 暴露 `grep`，但 Worker 中打包 ripgrep 子进程当前不可执行。本批只验证错误可见和 Agent 在该工具失败后能继续，不宣称 Browser-native grep 已实现。
- Workspace chunk API 限制单次传输大小，不证明文件编辑使用块级 delta；编辑后仍可能重传完整内容 blob。
- 本机 PoC backend、OPFS、IndexedDB、单 Chrome 版本的结果不证明生产云存储、多设备协同、自然 eviction、OS crash 或所有浏览器兼容。
