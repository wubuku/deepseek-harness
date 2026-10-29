---
description: "规划 Browser-Native DSH 正式 composer 移除附件时的上传取消传播、发布竞态与 Session 事实验证。"
---

# Browser-Native DSH 附件取消与发布竞态验证计划

## 目标

验证正式 composer 移除正在上传的文件时，取消信号从 Conversation service、FileUpload transport、Worker AttachmentStore 一直传播到同源 backend；验证 backend 在不可逆对象发布前中断时清理 staging，在对象已发布但回执尚未返回时不伪称撤销成功、不把附件加入 Session，并允许用户继续提交不含该文件的消息。

本批沿用 DSH-TUI 对 cancel/dispose 的启发：取消回执不能把 unknown 说成 confirmed，late completion 不能复活已释放的 UI 状态，执行销毁必须等待所拥有工作达到可观察的静止状态。TUI 是设计参考，不是 Browser API 或后台执行证明。

本批在主工作区 `research` 实施，不创建隔离 worktree。只修改 `docs/drafts/browser-native-dsh-poc/` 和 drafts 索引；不修改正式 Client/Attachment packages、Web application、Session format、Agent Loop、根依赖或 lockfile。Chrome 是唯一真实浏览器；真实 LLM 至少运行正常附件路径冒烟，但故障时序由 scripted LLM 与确定性 backend barrier 驱动。

## 候选范围与取舍

| 候选 | 价值 | 本批决定 | 理由 |
|---|---:|---|---|
| composer 移除 draft 时取消 OPFS staging 写入 | P0 | 纳入 | 验证用户动作是否中止 Worker 写入、关闭 writer 并删除临时对象。 |
| backend 已收到部分 body、尚未发布对象时取消 | P0 | 纳入 | 验证 AbortSignal 到 HTTP request/socket 的传播、`.part` 清理和无 FileBlock 引用。 |
| backend 已发布对象、但上传 receipt 尚未返回时取消 | P0 | 纳入 | 发布不可逆；必须证明 UI 忽略 late response、Session 不含 FileBlock，并明确对象成为 orphan，而不声称取消撤销了远端写入。 |
| 用户在取消后立即提交纯文本并继续 Agent turn | P0 | 纳入 | 证明旧上传不会阻塞 composer 或被隐式附加到新 prompt；Session 只有一次纯文本 prompt。 |
| 上传期间切换 Session 或 dispose Conversation service | P1 | 延后 | 需要定义原 Session 凭证和跨 Session 上传队列的正式 UX，本批不扩张生命周期范围。 |
| 重复移除、Retry 与迟到 upload response 的所有排列 | P1 | 延后完整排列；纳入 late completion 负例 | 本批只固定 remove 与 in-flight upload 的关键交错，不穷举所有 UI 操作顺序。 |
| 附件引用账本、orphan GC、跨 Workspace 身份恢复 | P0 架构问题 | 不在本批实现 | `FileBlock` 未携带独立 Workspace namespace，且 Session 与附件对象分属不同存储；没有权威引用归属前，GC 可能删除有效附件。 |
| 自然断网、浏览器 eviction、OS/磁盘崩溃 | P1 | 未验证 | 测试 barrier 只控制确定性取消时序，不等价于自然环境故障。 |
| 图片/多设备/生产对象存储 | P1 | 不纳入 | 当前 Browser AttachmentStore 拒绝图片；后端仍是 PoC 本机 `dataDir`。 |

## 实施面

### M0：边界与现状核验

检查正式 `ConversationController.releaseDraftAttachment()`、`ctx.fileUpload.upload()` AbortSignal、Browser AttachmentStore OPFS writer、backend attachment 临时文件/发布顺序和现有 E2E selectors。确认每个阶段的 owner、取消信号和异步完成条件；测试不能只断言函数被调用。

### M1：可控上传 barrier

Worker 测试端口注入 OPFS staging write barrier；`createBrowserNativeV2Server({ testHooks })` 注入 backend body 和 receipt barrier。所有 hook 都只由测试构造器或测试端口启用，生产 route 不接受 query/header 故障开关。E2E `finally` 必须先释放 barrier，再关闭页面和 server。

### M2：取消 OPFS staging 写入

通过真实 Chrome composer 选择文件，等待 Worker 在 OPFS `WritableFileStream.write()` 成功后报告暂停。检查 OPFS 中存在 `upload-*` 临时项，再移除附件。验证 AbortSignal 到达 Worker、writer abort、临时项清除且 backend 没有收到 PUT。随后提交纯文本 prompt，确认 Agent turn 成功且 prompt 只出现一次。

### M3：取消 backend 对象发布前的上传

通过真实 Chrome composer 选择文件，等待 backend 收到 body 后在原子发布前取消。验证 request 中止，backend `.part` 和 hash 对象均清除，FileCard 不复活，Session 不含 FileBlock。随后提交纯文本 prompt，确认 Agent turn 成功且 prompt 只出现一次。

### M4：对象已发布、receipt 未返回时取消

选择文件并等待 backend 报告对象已发布且 response barrier 已就绪；在 receipt 返回前移除文件并 abort。释放 barrier 后验证服务端 hash 对象存在且可完整读取，浏览器 UI 不将 draft 标记为 ready、不重新出现附件，Session 没有该 FileBlock。随后提交纯文本并确认该 turn 不引用附件。报告该对象是当前 PoC 的 orphan 风险，不尝试不安全 GC。

### M5：回归、文档和提交

复跑 attachment backend tests、backend-v2 tests、preview build、Chrome scripted cancellation E2E、Chrome 真实 LLM 附件 smoke、`test:docs`、`doc-sync` 和 `git diff --check`。更新 PoC README、操作兼容矩阵、drafts 索引和 change ledger，写明真实 LLM smoke 不证明取消故障时序。提交并推送 `research`，确认本地/远端一致、工作区干净。

## 状态与安全语义

- UI 移除只确认 draft 不再属于 composer；它不能撤销已经发布的 backend 对象。
- backend 对象未发布时，取消后必须没有 `.part` 或 hash 对象；对象已发布时，取消结果是“UI 已移除、远端对象可能已提交”，不能把它标记为删除成功。
- 取消后的 late response 不得恢复 `ready` 状态、重新插入 FileBlock 或改变已发出的纯文本 prompt。
- Session 是模型输入事实源。取消附件不会追加 FileBlock；后续纯文本 turn 只能由显式用户提交产生。
- 本批不实现 orphan GC。若没有完整的 Session→Workspace→attachment 权威引用映射，按时间或目录扫描删除可能破坏历史 Session。

## 验收判据

| 面向 | 验收 |
|---|---|
| 前端取消 | 正式 composer 移除活动 draft 后，上传操作结束且 late completion 不复活 UI 状态；重复移除安全。 |
| OPFS staging 取消 | Chrome Worker 的 OPFS 写入已成功至少一个分块；取消后收到 AbortSignal、OPFS `upload-*` 临时项消失，且没有 backend PUT。 |
| backend 发布前取消 | Chrome 中 backend 已进入 body barrier；取消后 request 与 handler 静止，backend staging 和已发布对象均不存在。 |
| 发布后取消 | backend 对象已原子发布但 receipt 被 barrier 挡住；取消后对象仍完整存在，composer 与 Session 不承认附件已提交。 |
| Session/Agent 续接 | 三个取消场景后各有一个显式纯文本 prompt；每个 prompt 只出现一次，无附件 FileBlock；DSH turn 成功且不执行附件 `read`。 |
| 资源回收 | E2E 的 promise barrier、浏览器、backend、临时目录和 preview runtime 均在 teardown 后静止并释放。 |
| 隔离 | 测试使用动态端口、唯一 `mkdtemp` dataDir；无外源请求、页面错误、日志凭据或文件正文。 |

## 证据限制

测试只证明 Chrome 与 PoC backend 的定向 abort 时序，不证明自然断网、浏览器自然 eviction、OS/磁盘 crash、跨设备恢复、生产对象存储或 exactly-once。真实模型 smoke 仅证明未故障的正常附件读取路径。对象已发布后的 orphan 归属与安全回收仍待 Session/Workspace 身份模型决策。

## Dev Note

实际命令、结果、失败观察和未完成项记录在[附件取消与发布竞态进度](attachment-cancellation-validation-progress.md)。
