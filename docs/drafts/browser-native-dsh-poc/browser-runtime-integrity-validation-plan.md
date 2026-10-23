---
description: "规划 Browser-Native DSH 默认交互能力、浏览器存储丢失恢复和 Worker 写入生命周期验证。"
---

# Browser-Native DSH 交互与恢复验证计划

## 目标

上一批验证了默认工具清单、受限 shell、OPFS quota fail-closed、正常 Chrome/backend 重启和单机容量基线。本批聚焦尚未被现有证据覆盖的真实交互与恢复缺口：默认问答和工作目录工具的端到端执行、浏览器缓存丢失且 backend 不可用时的 fail-closed、真实 Worker 标签页的写权交接。现有缓存清除后的成功重建和 mutation/snapshot 中断窗口已有 E2E，本批只在最新 checkout 上回归，不另造重复实现。

所有新实现继续限定在 `docs/drafts/browser-native-dsh-poc/`，不修改正式 DSH package、默认 Web profile 或共享构建配置。使用真实 Chrome、真实 Dedicated Worker、Cordis Host 和 DSH Agent Loop；用 scripted LLM 固定工具顺序，避免把模型选择和上游延迟混入运行时断言。真实 LLM 只在脚本模型无法验证的模型路由能力上使用，并明确记录结果。

## 四个交付面

### 1. 默认交互工具闭环

通过当前 PoC Browser profile 验证 `ask_user_question` 的实际 UI 提问、用户回答、Agent 续跑和 Session 事件；在 profile 中显式挂载 `working_directory`，并验证切换到已有子目录后相对文件写入落在该目录。当前 Browser LLM adapter 未声明 `inputModalities`，正式 `read_image` 会拒绝未声明 image input 的 route；因此本 profile 将 `tool-fs.readImage` 设为 `false`，并断言模型 schema 不含 `read_image`。不通过测试假数据伪造模型能力。

验收同时检查模型 schema、匹配的 DSH `tool/call`/`tool/result`、用户交互结果和 durable Session。工具仅出现在 schema 中不算通过。

### 2. OPFS/IndexedDB 清除后的离线 fail-closed

已有 `durable-workspace-cache-reset.e2e.mjs` 验证保留 cookie、清除 origin 的 IndexedDB/OPFS 后，从 backend 重建已提交文件。本批补测相反的故障条件：清除本地数据后让 manifest 请求返回 503，确认 Worker/Workspace 不进入 `synced`、不将空 VFS 当成已恢复状态，并在状态错误中保留可诊断原因。该脚本不模拟自然 eviction。

成功重建的既有 E2E 与本批失败场景都要检查 identity cookie 未清除；本批不更改后端权威状态或本地存储协议。

### 3. 双标签页 Worker 写权交接

已有 lease E2E 覆盖两个预览 Worker 的冲突、显式 release/lease expiry 和旧 token fencing，但未覆盖首个页面关闭后第二个 Worker 完成真实 DSH 文件工具调用。本批使用两个 Chrome 标签页和短测试 lease：第一个 Worker 执行并提交一次 DSH `write`；第二个 Worker在持有期显示冲突且不得发出模型请求；关闭第一个页面、等待 lease 到期后，第二页经 UI 重试取得更高 fencing token，再执行自己的 DSH `write`。使用旧 token 对 renew/commit 发请求，确认 backend 拒绝。

测试记录 Workspace revision、lease token、DSH tool/result、LLM 请求数和页面错误；不能以直接调用 backend lease API 替代 Worker 生命周期验收。

### 4. VFS mutation 到本地 snapshot 的中断窗口

`agent-workspace-crash-window.e2e.mjs` 已使用 PoC local-save barrier 覆盖保存前与保存后终止 Worker，检查未产生成功 `tool/result`、分别验证 volatile mutation 丢失或 durable mutation 恢复、确认 `TOOL_OUTCOME_UNKNOWN` 并在同 Session 后续轮不重放原副作用。本批在合入前对该既有 E2E 做一次回归，不复制脚本；若回归失败，只修复本 PoC 适配层并记录证据。

该验证明确保留 `VfsMutationSink.record()` 是 post-commit observer 的限制，不通过 PoC 改写 DSH 核心 VFS 来掩盖窗口。

## 共享验收规则

- 每个新增 E2E 使用临时 backend dataDir、动态 loopback 端口、隔离 Playwright profile，并在 `finally` 中等待页面、浏览器、backend 和构建资源退出。
- 浏览器只访问同源 API；断言没有非预期页面异常。注入 manifest 503 的场景要单独捕获预期的 preview boot rejection，并同时证明错误状态可见；保存脱敏的 Session 事件、operation/revision、工具名和 hash，不保存密钥或私有 prompt。
- 对故障场景分别记录本地 VFS、OPFS/IndexedDB、远端 manifest、Session tool/result/receipt；一个存储层的成功不能代替另一层的证据。
- 自然 storage eviction、OS 级浏览器 crash、Safari/WebKit、生产多实例 backend 和跨设备网络不在本批通过范围。
- 若工具 schema 和可执行能力不一致，修正 PoC roster 或 adapter 后重跑同一 E2E，并更新兼容矩阵。

## 退出标准

新增交互工具、离线 fail-closed 和真实 Worker 写权交接各有可复跑 Chrome E2E；既有 storage-reset 成功重建和 crash-window E2E 在当前 checkout 回归通过。默认 Browser profile 的工具不能只凭 schema 存在宣称可用；双 Worker 写权交接遵守 fencing。未解决的 VFS mutation 前置持久化限制、Session 未结算调用语义和自然 eviction 必须留在已知限制中。

## 入口

- [Browser-Native PoC 说明](README.md)
- [最新运行范围与兼容矩阵](operational-envelope-validation-progress.md)
- [持久 Workspace 实施进度](durable-workspace-progress.md)
- [高价值工具 receipt 验证](next-high-value-validation-progress.md)
