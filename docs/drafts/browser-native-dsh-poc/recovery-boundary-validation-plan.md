---
description: "规划 Browser-Native DSH 下一批真实 Chrome 验证：VFS 崩溃窗口、本地损坏导出和双标签 Workspace 写权恢复。"
---

# Browser-Native DSH 恢复边界验证计划

## Summary

本批验证 Browser-Native DSH 在 Worker 突然终止、本地 durable 数据损坏和多个标签页争用 Workspace 写权时的可观察行为。目标是确认 DSH 工具结果、Session 事件、本地 OPFS/IndexedDB 与云端 manifest 不会互相冒充成功，并给用户保留不破坏数据的恢复入口。测试使用真实 Chrome、Dedicated Worker、DSH Host 和 scripted LLM；Safari 与真实模型不纳入本批。

## 验证点

### R1：VFS mutation 与本地 durable snapshot 之间终止 Worker

- 使用 PoC-only 确定性屏障暂停一次真实 DSH `write` 工具的本地保存，再终止实际 Worker。
- 记录 `tool/call`、`tool/result`、`turn/end`、OPFS blob、IndexedDB snapshot、Workspace commit 和 Session 持久化状态。
- 刷新并重开同一 Session，确认没有把未确认的内存写入显示为成功，也没有自动重放文件工具或远端副作用。
- 验证同一 Session 是否可以继续新一轮对话；若遗留工具调用妨碍续聊，修复或明确暴露该恢复失败，不伪造工具结果。
- 结论必须区分“工具未确认、可能丢失的 volatile mutation”与“已 durable、可以重试的本地 mutation”。不通过异步 observer 宣称零数据丢失。

### R2：损坏状态的用户可控恢复

- 对仍含未提交文件的 OPFS/IndexedDB 状态制造 metadata invalid、blob missing 和 blob hash mismatch。
- 页面必须 fail closed，不提交远端、不静默以云端版本覆盖本地状态、不提供无条件清除按钮。
- 为 `local-corrupt` 增加用户主动触发的本地恢复包下载，内容包含原始 IndexedDB 记录、可读 OPFS blobs 及缺失/读取错误清单；下载不上传网络。
- 真实 Chrome 验证恢复包可读、能保留可用 pending bytes，并明确标出损坏/缺失数据；导出前后不得改变本地记录或远端 manifest。
- 说明：若浏览器已清除某些本地 bytes，恢复包不能还原不存在的数据；恢复包可能包含用户敏感文件。

### R3：双标签 Workspace writer lease 的等待与重试

- 一个标签持有并续租，第二个启用 Workspace lease 的真实 preview 启动时必须显示可理解的写权冲突，而不是裸露 Worker bootstrap HTTP 503。
- 状态说明另一标签正在持有写权；用户可在租约预计到期后显式重试，重试仍以 backend fencing 为准。
- 第二标签不能在冲突期间写 Workspace；第一次标签释放或租约过期后，重试只能通过新的 claim/resume 获得更高 fencing token。
- 验证活跃 owner 继续续租时，提前重试仍被拒绝并更新等待时间；旧 token 的 commit 仍被 backend 拒绝。

## 实施范围

- 新增真实 Chrome E2E 和 PoC-only 故障屏障；不修改正式 Agent Loop、MemoryVfs、Session 格式或默认 profile。
- 恢复包由用户在 `local-corrupt` 状态下主动下载，默认不清除 IndexedDB/OPFS，不向 backend 或第三方发送数据。
- 对 preview 页面和 locale 的最小目录外改动登记在 `change-ledger.md`；默认 preview 与非 Browser-Native 路径保持不变。
- 若 R1 暴露 post-commit observer 的不可消除崩溃窗口，本批记录其确切 Session/UI 后果与产品限制，不通过改写正式 VFS API 掩盖风险。

## 退出条件

- R1 的 crash point、Session event 序列、远端 revision 和刷新后的续聊结果均有真实 Chrome 证据；未确认 mutation 不得呈现成功或被自动重放。
- R2 的损坏状态可导出本地诊断包；导出不会清除或覆盖任何数据，远端 manifest 保持不变。
- R3 冲突页提供本地化、可操作的等待/重试反馈；第二标签成功接管后旧 fencing token 不能写入。
- 更新 PoC README、进度、变更账本和 `docs/drafts/README.md` 索引；记录未通过或未覆盖项，不把 scripted 结果写成真实模型验收。
