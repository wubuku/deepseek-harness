---
description: "规划 Browser-Native DSH 文件附件从浏览器上传到 Session 持久化的故障恢复、幂等重试和并发验证。"
---

# Browser-Native DSH 附件提交与恢复验证计划

## 目标

验证 composer 已显示附件就绪、附件对象已在 backend 持久化、Session 已接收 FileBlock、Session 已 durable 这四个状态不会被混为一谈。Chrome 故障注入需要证明失败可见、未知结果可对账、重试不产生重复引用或重复 Agent turn，并且文件始终能由标准 DSH `read` 读取。

本批在主工作区 `research` 实施，不创建隔离 worktree。运行时、测试和记录优先限制在 `docs/drafts/browser-native-dsh-poc/`；正式 `packages/` 与 Web app 只读核对、不改动。Safari 暂停；真实 LLM 至少执行小文本附件冒烟。

## 候选范围与取舍

| 候选 | 风险或价值 | 本批决定 | 理由 |
|---|---|---|---|
| OPFS quota 拒绝附件保存 | 浏览器存储耗尽时不能显示 ready 或提交 FileBlock | 纳入 | 有 Chrome quota override，可用真实 Worker/OPFS 触发并恢复配额重试。 |
| backend 在完整对象发布前返回 503 | 请求失败时不能留下可读半对象或 Session 引用 | 纳入 | 可确定性注入，并观察 composer 错误、临时对象清理与同一 draft retry。 |
| 完整对象发布后丢失上传响应 | 客户端无法判断对象是否已提交 | 纳入 | 重试应按 hash 校验并复用对象，不要求用户重新执行 Agent turn。 |
| Session append 已接受但响应丢失 | 用户消息和 FileBlock 可能重复或 turn 状态不明 | 纳入 | 直接验证 Session seq readback reconciliation、唯一 user event、唯一模型 turn 和 tool result。 |
| 同一内容并发上传 | backend 内容寻址发布的竞争分支可能覆盖或误拒绝合法并发者 | 纳入 | Node 独立请求同时上传相同 hash，检查只有一个对象且每个请求都得到正确回执。 |
| 上传期间移除 draft/取消请求 | Worker 取消传播与服务端原子发布之间可能竞态 | 延后 | backend 中断请求清理已有合同测试；要验证正式 composer 取消，需要可控的 Chrome 流式暂停点，本批先集中覆盖 quota、上传 unknown 和 Session append unknown。 |
| Session 跨 Workspace 身份恢复 | FileBlock 未包含 Workspace namespace，切换身份后可能无法取回对象 | 延后独立架构决策 | 需要定义 Session 与 Workspace 的正式绑定，不以当前 PoC cookie 推断租户模型。 |
| 附件对象引用追踪、TTL 与 GC | 上传成功但 Session 未引用的对象会累积；过早 GC 会丢未完成提交 | 延后独立批次 | 需要服务器权威 Session/attachment 引用账本和多实例 fencing；仅按文件 mtime 删除不安全。 |
| 自然 OPFS eviction、OS/磁盘崩溃和真实 quota 长期行为 | 验证浏览器/OS 自主策略 | 保持未验证 | 定向 quota override 只证明 quota 错误处理，不等价自然 eviction 或 crash consistency。 |
| 图片、跨设备共享及大附件真实 LLM | 其他载荷和身份形态 | 不纳入 | 本 PoC 当前拒绝图片，且真实模型只做安全的小文本冒烟。 |

## 实施面

1. **故障注入。** 为 PoC backend 增加仅由测试构造器启用的 attachment 503 与“对象已发布后丢响应”钩子；Session append 钩子只匹配含 FileBlock 的 user event。生产 route 不接受 query/header 控制故障。
2. **后端并发与对象状态。** 并发上传相同内容时验证 content-addressed hard-link 竞争、hash/byte 校验和对象数量；响应丢失后重传同字节应返回 `reused`，不同字节不能冒领同一 hash。
3. **正式 composer Chrome E2E。** 通过 Chrome quota override 让 Worker OPFS 写失败，确认 FileCard 为失败、Send 被禁用、Session 无 FileBlock；恢复 quota 后点 Retry，确认 ready。随后注入 backend 503 和 post-publish response loss，分别验证清理和 hash 幂等重试。
4. **Session unknown append E2E。** 让含 FileBlock 的 Session append 在 backend 接收后丢响应；确认 provider 以 event seq 精确读回而不是再次追加，消息只出现一次、DSH `read` 只执行一次、后续同 Session turn 成功且不重复 prompt。
5. **真实模型冒烟及文档。** 在代码与 backend 改动后使用 `docs/drafts/.env` 跑 Chrome 真实 LLM 小文件上传、`read` 和刷新恢复；检查同源网络、Session/Workspace 计数、无凭据日志。更新 PoC README、兼容矩阵、drafts 索引、change ledger 与进度。

## 安全与状态语义

- `ready` 仅表示文件上传 provider 返回了可用于本 Session 的 staged receipt；它不表示 Session 已保存 FileBlock，也不表示当前 Session event 已 durable。
- 上传响应 unknown 时，只能以同一内容 hash 重传并由 backend 校验对象；不得重放用户 prompt 或业务副作用。
- Session append response unknown 时，沿用已实现的 seq-range exact readback；不得基于“请求超时”直接追加第二份 user message。
- OPFS quota、backend 明确 503 或用户取消必须使 composer 留在失败/可重试状态；不能生成 Session FileBlock。若远端已经原子发布对象，取消不能声称撤销远端对象。
- 真实 E2E 只验证其实际场景，不把测试注入的 quota/响应丢失写成自然 eviction 或 OS crash 证据。

## 验收判据

| 面向 | 验收 |
|---|---|
| quota | Chrome 原生 OPFS 写入返回 quota 类错误；composer 显示失败且不可发送；Session 无该 FileBlock；恢复 quota 后 Retry 成功。 |
| 上传 503 | composer 不进入 ready；Session 不含引用；服务端无未完成 `.part`；相同 draft Retry 后可正常提交。 |
| 上传响应丢失 | backend 已有完整对象但浏览器未收到回执；Retry 返回同一 `FileAttachmentRef` 并报告复用；backend 只有一个 hash 对象。 |
| Session append unknown | 远端接受含 FileBlock 的 event 后丢 append response；最终 Session 中 user/message 与 FileBlock 各一份，`read` call/result 各一份，prompt 与模型 turn 不重复。 |
| 并发内容上传 | 同 principal 的两个并发 PUT 得到相同 hash/bytes 回执，唯一对象可完整读回；坏摘要竞争不能发布对象。 |
| 隔离 | 附件不改变 Workspace manifest/revision；浏览器无跨源请求，日志无文件正文或模型凭据。 |
| 回归 | 当前附件 backend tests、backend-v2 tests、preview build、相关 Session transport tests、Chrome scripted 和真实 LLM smoke、文档门禁均通过。 |

## 验证顺序

先跑现有附件与 Session transport 检查作为基线；实现后先运行 backend Node 合同测试，再跑 Chrome quota/retry 和上传故障 E2E，最后跑真实 LLM smoke。任何 quota fixture 若实际影响 IndexedDB 而不只是 OPFS，须先隔离资源或将其作为单独明确结果，不能放宽断言。提交前执行文档门禁、`git diff --check`、`change-scope --base origin/research` 和仓库 pre-push hook。

## 明确限制

本批不实现附件 GC、跨 Workspace 身份命名空间、多设备授权或生产对象存储。Session FileBlock 和附件对象仍是独立持久化对象；提交失败后可以产生 orphan。PoC 测试钩子只用于确定性故障注入，不是线上恢复机制。

## Dev Note

实施命令、实测结果、偏差和经验记录在[附件提交与恢复进度](attachment-commit-recovery-validation-progress.md)。
