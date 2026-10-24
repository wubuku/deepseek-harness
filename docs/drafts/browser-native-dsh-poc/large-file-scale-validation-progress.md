---
description: "记录 Browser-Native DSH 文件规模与分块传输验证的阶段、实际证据和限制。"
---

# Browser-Native DSH 文件规模与传输验证进度

## 当前状态

状态：已完成实现和当前 checkout 的 Chrome/单元测试验证。目标、候选范围、验收门槛和非目标见[验证计划](large-file-scale-validation-plan.md)。实施在 `research` 主工作区进行；基线是本批开始前已提交的 research 工作区，没有使用隔离 worktree。

本批把 Workspace blob 的一次性传输改为 1 MiB 分块 staging、状态查询、缺块续传、finalize 和分块下载；OPFS blob 写入也按 1 MiB 分块。它只限制单个 HTTP body 和传输缓冲，仍由同步 `MemoryVfs` 持有完整文件 bytes，下载最终也会组装完整 `Uint8Array`。因此本批证明了当前 PoC 的可恢复传输路径，不证明任意大小文件、块级 delta、生产级吞吐或内存 SLA。

| 交付面 | 状态 | 证据 |
|---|---|---|
| 变更前 Chrome 文件规模与旧 8 MiB API 负向基线 | `passed` | 旧 API 的 8,388,608-byte body 返回 200，8,388,609-byte body 返回 413 `REQUEST_TOO_LARGE`；既有容量 E2E 的最大单文件为 512 KiB、总量 1 MiB。 |
| backend 分块上传状态、幂等与重启恢复 | `passed` | backend contract tests 覆盖 staging、状态查询、重复块、损坏块、缺块 finalize、完整 hash/size 校验、重启加载和幂等 operation；17/17 通过。 |
| Worker 分块上传、下载与 OPFS 分块写入 | `passed` | Workspace Vitest 与 durable Workspace Vitest 共 23/23 通过；客户端使用 1 MiB chunk，OPFS 写入按 1 MiB 写入，manifest 只引用已 finalize blob。 |
| 真实 Chrome 大文件、1,000 小文件和故障恢复矩阵 | `passed` | Chrome 155 通过 16 MiB、64 MiB 和 1,000 个 256-byte 小文件；覆盖 staging 损坏重传、已写入块但响应丢失后的不重复上传、backend 重启、刷新 hydrate、bytes/hash 校验和页面错误检查。 |
| 小型真实 DSH Loop 与文档归档 | `passed` | 既有 scripted DSH 文件工具回归与 preview build 通过；本批大文件负载由 Worker test port 生成，不宣称为模型生成的大型 tool args。本文、README、总索引和 change ledger 已补齐。 |

## 里程碑

| 里程碑 | 状态 | 实际结果 |
|---|---|---|
| M0：分支、工作区和候选范围审查 | `complete` | `research` 与 `origin/research` 同步；检查了 PoC README、近期计划/进度、兼容矩阵、MemoryVfs、Workspace mirror/store/backend 和容量脚本。 |
| M1：规划与变更前基线 | `complete` | 已复现旧 8 MiB API 边界，并保留既有 Chrome 容量基线；本批新负载从 Worker 内部生成，避免页面向 Worker 复制大 payload。 |
| M2：backend 分块协议 | `complete` | 1 MiB chunk staging/status/put/finalize、hash/size 校验、重启恢复、幂等和缺块拒绝均有 backend tests。 |
| M3：浏览器客户端和 OPFS 分块 | `complete` | Worker Workspace mirror 完成分块上传/下载；OPFS blob 分块写入；本地 snapshot burst coalescing 避免千文件 mutation 触发千次完整 snapshot 保存。 |
| M4：Chrome 大文件与故障验收 | `complete` | 16 MiB、64 MiB 和 1,000 小文件真实 Chrome 通过；响应丢失、staging 损坏、backend 重启和刷新恢复均有断言。Safari/WebKit 本批暂停。 |
| M5：文档门禁、commit 和 push | `complete` | focused tests、preview build、typecheck、文档门禁和 diff review 已通过；提交和 push 作为本批交付动作完成。 |

## 检查记录

已运行 preview build、旧 backend blob API 尺寸边界实验、backend contract tests（17/17）、Workspace/durable Workspace focused Vitest（23/23）、真实 Chrome 大文件和千文件 E2E，以及新增 E2E 的 `node --check` 和 `git diff --check`。16 MiB 和 64 MiB 测试分别验证 16/64 个 1 MiB chunk；本轮复跑的 16 MiB 结果为 16 个 chunk、revision 1、无 pageerror，千文件测试验证 1,000 次写入最终合并为一次本地 durable snapshot 和一次 Workspace commit。`pnpm run typecheck` 的 5 个 gate 和 `pnpm run test:docs` 的 21 个 gate 均通过；preview build 成功并保留既有平台依赖与大 chunk 警告。真实模型、Safari/WebKit、自然 storage eviction、OS 级浏览器崩溃、多实例 backend 和真实 LLM 大型 tool args 尚未验证。

## 预期限制

chunk protocol 只限制单次 HTTP body 和传输缓冲，不会改变正式 `MemoryVfs`。大文件如果作为 DSH `tool/call` 参数进入 Session JSON，仍会受 Session backend JSON body 上限影响；大文件 E2E 使用 Worker 内部生成的 VFS bytes，不能代替模型上下文或真实用户文件导入验收。当前 backend 仍使用 PoC `dataDir`，不是生产对象存储；客户端下载最终仍组装完整文件；Chrome 单机指标不构成 SLA。Safari/WebKit、自然 eviction、OS 级崩溃和多实例 backend 本轮不验证。
