---
description: "Browser-Native DSH 下一批文件工具与 capability 验证计划：验证 Worker 内搜索的资源边界、文本语义、取消和浏览器工具清单。"
---

# Browser-Native DSH 文件工具下一批验证计划

## Summary

本批次把 `dsh-browser-native-vfs-cli-fact-check.md` 的分层结论落实到 Browser-Native DSH 的文件工具：VFS 继续由 Worker 提供，`grep`/`glob` 继续作为结构化 command provider，不引入完整 Shell、WASI 或虚拟机来掩盖浏览器资源边界。目标是在正式产品前验证大目录、大文件、恶意搜索参数、二进制内容和取消时，Worker 不会无界构造结果或静默伪造文本语义。

## 候选范围

| 候选点 | 技术风险 | 本批决策 |
|---|---|---|
| 有界目录遍历 | 先收集完整文件数组会延迟取消并放大内存 | 选择，改为显式栈和边扫描限制 |
| `glob` 结果上限 | 文件数上限不等于模型结果上限 | 选择，增加独立结果上限和结构化错误 |
| 流式/range `grep` | 整文件读取造成 Worker heap 峰值 | 选择，用 `openFileSync().read()` 分块读取并验证跨块行语义 |
| 正则复杂度 | JavaScript `RegExp` 单次匹配不可中断 | 选择，增加长度、反向引用和嵌套量词的 fail-closed 防护；完整 ReDoS 证明保留为未完成项 |
| 文本/二进制语义 | 默认 UTF-8 替换可能把二进制误报成文本 | 选择，非法 UTF-8 或 NUL 文件返回明确二进制错误 |
| Browser file capability roster | 工具名条件分支容易继续堆叠 | 选择，先建立 PoC 内显式名称表；正式 registry 仍需后续设计 |
| WASI Shell、Lifo、Bashkit、v86 | 集成面扩大，不能替代 DSH Session、权限和生命周期 | 不纳入本批，保持候选研究状态 |
| 自然 eviction、OS crash、生产对象存储 | 当前环境无法把故障注入等同平台保证 | 不纳入本批，沿用已有限制记录 |
| 多文件原子写入 | 需要事务、receipt 和 partial failure 设计 | 不纳入本批，避免把单文件工具边界扩大成事务承诺 |

## 交付面

### A. 有界遍历与结果预算

`grep` 和 `glob` 使用显式栈边遍历边检查取消和文件数。`glob` 独立限制最终路径数量，超过上限返回 `SEARCH_RESULT_OVERFLOW`，不返回看似完整的部分结果。glob pattern、include pattern 和 grep pattern 均有字节上限；brace expansion 也有分支数上限。

### B. 分块 `grep`

搜索通过 `MemoryVfs.openFileSync()` 的同步 range read 分块读取文件，使用流式 `TextDecoder` 处理 UTF-8 边界和跨块换行。扫描字节数、单行结果字节数、匹配数和文件数仍由同一组预算约束。只有命中的行超过结果预算时才 fail closed；不相关的长行可以被扫描但不会进入结果，整体读取仍受扫描字节上限约束。

### C. 正则与文本安全

搜索拒绝超长 pattern、反向引用和检测到嵌套量词的 pattern。该检查是有限的输入防护，不是 JavaScript 正则引擎的完整复杂度证明；后续仍可评估 RE2/WASM 或独立搜索 Worker。非法 UTF-8 和包含 NUL 的文件不静默替换为文本，而是返回带路径的 `SEARCH_BINARY_FILE` 错误。

### D. capability roster

PoC 为浏览器文件工具维护显式名称表，并让 provider 使用该表路由。它只描述当前 provider 能处理的文件工具，不把 Browser VFS 说成主机 Shell、完整 Node 或任意 Unix 命令。正式产品仍需要 profile-level capability manifest 和 load-time plugin compatibility check。

### E. 真实浏览器验收

focused Vitest 覆盖边界、流式 UTF-8、二进制拒绝、复杂 pattern、glob overflow 和取消。真实 Chrome E2E 覆盖 Worker 中的搜索、超限、失败后继续和无跨源请求；已有 OPFS 外置文件 E2E 继续作为外部 range backing 回归。真实 LLM 只补充工具 roster 和普通文件闭环，不把 scripted tool selection 宣称为模型自主选择证据。

## 退出条件

1. 搜索不再先生成完整文件列表；超出文件或结果预算时在产生不可控结果前失败。
2. 64 KiB 以下跨块 UTF-8 文本搜索结果与原有行为一致；非法 UTF-8、NUL 文件、长行和复杂 pattern 有稳定错误码。
3. 取消后真实 Worker 可以继续完成下一次文件工具调用，且没有未处理 page/Worker error。
4. Browser provider 的文件工具名称集中登记，测试能证明未注册的 web、主机 shell 和本机路径能力不会因此被加入 roster。
5. 计划、进度、README、兼容矩阵和事实核查文档明确区分已实现 fallback、设计建议和未验证的完整 Shell/WASI/生产语义。

## 不作出的结论

本批不宣称实现完整 ripgrep 兼容、任意容量搜索、完整正则安全、块级编辑、后台 Agent、跨存储事务或第三方 Shell runtime 集成。`MemoryVfs` 的分块读取只验证搜索读取路径；`edit` 仍可能 materialize 文件，另有独立载荷限制。

## 验证顺序

1. 修改前运行现有 focused helper tests，记录基线。
2. 先实现并运行 helper 单测，再运行 backend contract 和 preview build。
3. 运行真实 Chrome 文件工具边界、取消和 OPFS backing 回归。
4. 更新证据文档和 change ledger，执行 `doc-sync`、类型检查、格式检查和 pre-push 检查。
5. 在 `research` 主工作区提交所有修改并推送；不创建额外 worktree。

## Dev Note

本文是 `docs/drafts/` 下的研究计划，不是正式 `tool-fs-search` 契约。正式实现若提供流式搜索或 Browser capability manifest，应将本批测试迁移到正式接口后删除重复 PoC 接线。
