---
description: "规划 Browser-Native DSH 附件上传中 Worker 强制终止后的 OPFS 清理、backend 中断结算与内容幂等恢复验证。"
---

# 附件 Worker 强制终止恢复验证计划

## 目标

验证 Dedicated Worker 在附件上传期间被强制终止后，下一 Worker 能安全回收本地临时文件；恢复过程不能删除另一标签页仍在使用的临时文件，不能把未提交附件写入 DSH Session，也不能把已发布的 backend 对象误报为可撤销或已被引用。

本批在主工作区 `research` 实施，不创建隔离 worktree。只改动 `docs/drafts/browser-native-dsh-poc/` 与 drafts 索引；不改正式 packages、应用代码、Session 格式、根依赖或 lockfile。Chrome 是唯一真实浏览器；故障顺序由真实 Worker、OPFS、IndexedDB、同源 PoC backend 和确定性 barrier 驱动。另运行现有真实 LLM 附件 smoke，证明正常路径仍工作，不让模型承担故障注入。

## 候选范围与取舍

| 候选 | 决定 | 原因 |
|---|---|---|
| Worker 在 OPFS `upload-*` 写入时终止后的临时项回收 | 纳入 | 现有取消测试走 AbortSignal；Worker 被 terminate 时不会运行 writer abort/finally，重启后的回收尚未验证。 |
| 两标签页并发时清理器误删活动上传 | 纳入 | 文件名和时间戳不能判断活跃 owner；必须用 Web Locks 的存活语义保护每个临时对象。 |
| backend 收到部分 PUT 后 Worker 终止 | 纳入 | 验证浏览器 fetch 断开是否让 backend 清除 `.part`，并证明新 Worker 可以重传。 |
| backend 原子发布对象后、receipt 返回前 Worker 终止 | 纳入 | 远端对象不可撤销；验证重选同一文件后按 hash 安全复用，Session 仍只在用户显式发送后获得 FileBlock。 |
| Session/Workspace 权威附件引用账本与远端对象 GC | 延后 | `FileBlock` 不含独立 Workspace namespace，当前 backend 也没有 Session 引用账本；按时间或单个 Session 删除会误删历史附件。 |
| 上传中的 Session 切换、草稿跨 Session 重绑定 | 延后 | 需要单独验收正式 composer 的草稿身份和用户可见转移语义；与 Worker crash cleanup 不共用恢复机制。 |
| 自然 eviction、OS/磁盘崩溃、生产对象存储 | 不纳入 | 本批可控 Worker termination 不等价于这些环境故障，且 PoC backend 是单机 `dataDir`。 |

## 实施面

### M0：现状与恢复边界

核对附件 staging 命名、OPFS `createWritable()` 临时条目、Worker AttachmentStore 生命周期、Workspace principal、backend `.part` 与 hard-link 发布顺序。明确可回收对象只有 `upload-<uuid>`、`download-<uuid>` 及对应浏览器 `.crswap`；内容 hash 对象不是临时文件，不做清理。

### M1：有 owner 保护的 OPFS 临时文件

每个临时文件在创建之前获取由 Workspace ID 与文件 ID 派生的独占 Web Lock，并持有到临时文件发布或失败清理完成。AttachmentStore 首次访问该 Workspace 的 OPFS 目录时，枚举已知临时文件；仅在成功取得对应锁时删除它及匹配 `.crswap`。锁占用表示另一个 Worker 仍拥有该上传，清理器必须跳过。缺少 Web Locks 时不猜测存活状态、不做临时文件回收。

### M2：Chrome 多标签页活动上传隔离

标签页 A 在 OPFS staging write 后暂停。标签页 B 使用同一 principal 启动新 Worker 并触发附件目录检查与一次上传尝试。由于 A 持有 Workspace writer lease，B 必须以只读状态拒绝上传；验证 B 的清理器没有删除 A 的活动 `upload-*`/`.crswap`，且没有为 B 创建或发送附件对象。终止 A 后，新 Worker 再次检查目录并回收 A 留下的 staging。

### M3：Worker 强制终止故障矩阵

分别在 OPFS staging、backend 收到部分 body、backend 对象已发布但 receipt 被 barrier 阻挡时终止实际 DSH Host Worker。检查 Session 没有用户 prompt 或 FileBlock；部分 backend upload 没有 `.part` 或 hash 对象；已发布对象保持完整。重启 Worker 后，用户必须重新选择文件；同 hash 重传只能复用对象，不能自动重放用户 prompt。

### M4：回归、真实模型 smoke 与文档

运行附件 backend tests、类型/定向 lint、preview build、Chrome crash-recovery E2E、现有附件正常流程与取消 E2E、真实 Chrome/LLM 附件 smoke、文档门禁和 `git diff --check`。更新 PoC README、compatibility matrix、drafts 索引、change ledger 和本进度。记录每个失败命令与外部 LLM 失败，不把脚本故障矩阵说成真实模型 E2E。

## 状态语义与安全约束

- Worker 被 terminate 后不保证执行 `finally`、AbortSignal 回调或 composer dispose；强制终止只用于模拟 Worker 消失，不代表页面关闭后 Agent 继续运行。
- 本地临时文件是否可回收由同源 Web Lock 是否可取得决定，不用 mtime、随机 ID 年龄或页面列表推断 Worker 已死。
- Web Lock 名称按 Workspace principal 与临时文件 ID 稳定派生；获取锁后才创建临时项，避免清理器观察到尚未登记的活动文件。
- `upload-*` 与 `download-*` 是可重建临时对象；hash 命名对象可能已被 Session 引用，不因 Worker crash 或无当前 FileBlock 而删除。
- backend 未完成上传应清理 `.part`。对象 hard-link 发布后属于已提交内容；响应丢失后的恢复只能用同一内容 hash 重传并确认 `reused`，不能把它说成 rollback。
- Browser File 对象与 composer draft 不跨 Worker/刷新持久化。恢复不自动补交 prompt；用户重新选择文件并显式发送后才会有 Session FileBlock。
- 本批不实现附件对象 GC、Session/Workspace 跨存储事务、真实云存储或 OS 级 crash recovery。

## 验收判据

| 面向 | 验收 |
|---|---|
| 临时文件 owner | 活动 Worker 持锁期间，另一标签页的恢复扫描不删除 `upload-*` 或 `.crswap`。 |
| Crash cleanup | OPFS staging 暂停后 terminate Worker；新 Worker 获取同一临时文件锁后清除遗留条目。 |
| backend 部分上传 | Worker 在 backend 已收到 body 后 terminate；request settles，backend 无 `.part`、无发布对象。 |
| 发布后未知 receipt | Worker 在对象已发布后 terminate；对象完整保留，重新选择相同文件得到同 hash 的 `reused` receipt。 |
| Session 事实 | 强制终止前后均没有由测试自动生成的用户 prompt、FileBlock 或 Agent `read`；只有恢复后的显式用户发送才可写 FileBlock。 |
| 真实模型回归 | 既有真实 Chrome/LLM 附件 smoke 在本轮新构建上完成 `FileBlock → read → 回复 → 刷新补水`。 |
| 资源隔离 | 每个测试使用动态端口、唯一 `dataDir` 和独立 browser context；teardown 释放 barrier、browser、backend 与临时目录。 |

## 复跑入口

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-worker-crash-recovery.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs
pnpm run test:docs
pnpm run doc-sync
```

## Dev Note

本计划限定当前 PoC 的可证范围；实际命令、结果、失败和偏差记录在[实施进度](attachment-worker-crash-recovery-validation-progress.md)。
