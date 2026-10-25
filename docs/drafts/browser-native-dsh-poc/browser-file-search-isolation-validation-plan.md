---
description: "规划 Browser-Native DSH 文件搜索的正则隔离、资源上限和 Chrome 故障恢复验证。"
---

# Browser-Native 文件搜索隔离验证计划

## 目标

验证模型提供的 grep pattern、grep `include` 和 glob pattern 不会因 JavaScript 正则回溯而无限占用 Agent Worker，也不会让超长无匹配行绕过现有搜索预算。验证范围限定为当前 Browser-Native PoC 的 Worker VFS 和 Chrome；不把它描述成 ripgrep 兼容或正式产品承诺。

## 候选范围与取舍

| 候选点 | 风险与价值 | 本批决定 |
|---|---|---|
| 模型控制的正则在 Agent Worker 同步执行 | 一次 `RegExp.test()` 不能响应 AbortSignal；重叠分支等模式可能长时间阻塞 Worker，连带阻止取消和其他消息处理 | 纳入；将匹配放进可终止的子 Worker，设置每批墙钟预算，超时以结构化工具错误结束，不返回部分结果 |
| glob/include pattern 转换后的正则在 Agent Worker 同步执行 | glob pattern 由 PoC 适配器生成正则；恶意或偶然的重复通配符组合可能回溯。只隔离 grep 内容匹配会留下相同阻塞入口 | 纳入；内容行与路径名均由同一个可终止 matcher Worker 执行，路径名分批且有界 |
| 超长无换行文件绕过单行限制 | 现有限制只在命中后检查行长；不匹配的巨大行仍会在 `pending` 中累积并创建大字符串 | 纳入；匹配前限制每行 UTF-8 字节，并对总行数和扫描字节设置独立上限 |
| 取消发生在正则执行期间 | cooperative yield 只能在同步正则返回后运行 | 纳入；父 Worker 等待子 Worker 时必须能接收取消，终止子 Worker、关闭文件句柄并结束本次搜索 |
| 超时后同一 Agent/Worker 是否仍可用 | 正则超时可能损坏共享 Worker 生命周期或留下待处理请求 | 纳入；验证显式错误结算后后续合法 grep/read turn 成功，且没有遗留子 Worker |
| glob 目录顺序、忽略规则和 POSIX 匹配兼容 | 属于工具语义兼容性，不是本批正则阻塞与内存风险的前置条件 | 延后；单独与主机 ripgrep 对照，不能因本批通过而推断兼容 |
| 多文件写入原子性和 partial failure | 需要定义业务事务、Session receipt 和 Workspace reconciliation | 延后；不可通过搜索工具改动顺带引入伪事务 |
| Workspace GC 的分页内存、部分删除和重试 | 影响 backend blob 生命周期，与 Worker 内文件系统运行风险不同 | 延后到 backend 运维批次 |
| 自然 OPFS eviction、OS 级崩溃、生产对象存储和多实例 fencing | 需要真实平台或部署环境，现有单机注入不能替代 | 保留为独立验收，不在本批外推结论 |
| WASI/Linux shell 或第三方 VFS | 会扩大执行环境与安全模型，不能解决正则阻塞的根因 | 不纳入 |

## 实施面

### 1. 将正则执行隔离到可终止的 Worker

由 Agent Worker 创建专用 module Worker 编译 grep、include 和 glob pattern 并执行一批文本/路径匹配。父 Worker 不调用模型可控 pattern 对应的 `RegExp` 构造器或 `RegExp.test()`；语法验证也在 matcher Worker 中执行。每批匹配有固定的安全时间预算。超时后终止 matcher Worker，并返回 `SEARCH_REGEX_TIMEOUT`。Worker 创建、脚本加载或协议响应异常必须明确失败，不回退到主 Agent Worker 的同步正则。

matcher Worker 只接收 pattern、请求 id 和有界文本行或路径名；结果只允许返回匹配行索引或结构化错误。主 Worker 验证响应 id、索引范围和结果类型。批次消息的最大行数和总 UTF-8 字节数必须有上限。

### 2. 对所有搜索行施加内存和工作量限制

在正则执行前拒绝超过单行 UTF-8 字节上限的任何行，不论该行是否会匹配。增加总行数上限，保留已有文件数、总扫描字节、匹配数和结果行限制。超过任一上限时，返回结构化错误且不返回可能被误认为完整的部分匹配。

UTF-8 解码仍按块处理；跨块字符、跨块换行、CRLF、空文件、末尾无换行和二进制文件均须有确定性测试。取消或任一失败路径必须关闭当前 VFS 文件描述符并终止 matcher Worker。

### 3. 真实 Chrome 的 DSH tool-loop 验收

通过当前 PoC 的 DSH Host 与真实 Dedicated Worker，在 Chrome 中触发已知会使主线程 JavaScript RegExp 发生灾难性回溯的 grep 和 glob pattern，并证明调用在预算内以 `SEARCH_REGEX_TIMEOUT` 结算。另覆盖等待 matcher 期间取消、超长无匹配行拒绝、超行数拒绝，以及失败后的合法搜索或读取。

脚本化模型只用于确定性注入 pattern、取消和后续调用；它不作为真实模型选择工具的证据。若同域 backend 的真实 LLM 配置可用，单独跑普通文件搜索闭环，记录模型请求、工具调用、Session 结果和 Workspace revision；不要求真实模型生成恶意 regex，也不以 scripted E2E 代替真实 LLM 证据。

## 验收条件

- Agent Worker 不构造或执行模型提供的 grep/include/glob 正则；语法验证和匹配只发生在可单独终止的子 Worker。
- 正则超时、Worker 启动失败、Worker 消息错误、取消和行/字节上限均有明确工具结果；任何错误都不返回部分结果为完整结果。
- Chrome 中恶意回溯模式在限定时间内结束；Agent Worker 后续仍可接受消息并完成新 turn。
- 超长无匹配行在进入 matcher 前拒绝；峰值待匹配文本受单行和批次字节上限约束。
- 取消能终止 matcher Worker，关闭文件 descriptor，且同一 DSH Session 后续读取或搜索成功。
- UTF-8 多字节字符跨块、CRLF、glob fallback、常规正则结果和已存在大文件场景回归通过。
- 本批不宣称真实模型选择恶意工具参数、生产浏览器性能、多实例 backend、自然 eviction、OS crash 或 ripgrep 兼容。

## 验证顺序

1. 写 matcher Worker 协议和边界单测；先验证 `^(a|aa)+$` 和重复 `**` glob 一类有重叠分支的回溯模式会被父 Worker 超时终止。
2. 改造 grep/glob 为有界内容/路径批次和可取消 matcher；grep 保持逐块解码，并加入长行、总行数和超时单测。
3. 运行 preview build，确认 Vite 将子 Worker 正确打包为 Worker 内可加载的模块。
4. 新增真实 Chrome Worker/DSH E2E，覆盖超时、取消、失败后继续和 Session 工具结果；不要只直接调用 helper。
5. 复跑文件工具、大文件、取消和默认 Browser capability 回归；有可用凭据时独立执行真实 LLM 普通搜索验收。
6. 更新进度、PoC README、兼容矩阵、变更账本和 drafts 索引；执行针对性测试、文档门禁和 push 前检查。

## Dev Note

本计划属于当前 checkout 的 PoC。matcher Worker 的存在不提供页面关闭后的后台执行能力；超时只限制单个正则批次，不构成通用 CPU quota。任何子 Worker 加载失败都必须 fail closed。
