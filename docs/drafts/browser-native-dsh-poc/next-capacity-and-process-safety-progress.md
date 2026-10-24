---
description: "记录 OPFS-backed VFS 驻留与 Browser-Native backend 单写者/进程恢复批次的实施证据和限制。"
---

# Browser-Native DSH 容量与进程安全验证进度

## 当前状态

状态：M0-M6 已完成。实施计划、候选优先级和退出条件见[验证计划](next-capacity-and-process-safety-plan.md)。基线为本批开始时的 `research` 分支；开始时主工作区干净，只有一个主 worktree。

## 里程碑

| 里程碑 | 状态 | 命令/证据 | 结果与阻塞 |
|---|---|---|---|
| M0：基线与候选盘点 | `complete` | `git status --short --branch`、`git worktree list`；审阅最近 VFS scale、storage failure、multi-instance 和 runtime integrity 计划/进度、`MemoryVfs`、Worker Host、Durable Workspace Store | 旧双 backend E2E 已证明同 Session seq、Workspace base revision 和 fencing token 都可被两个进程同时接受，冷启动后只保留一方写入；当前 VFS 文件节点把完整 bytes 保留在内存。 |
| M1：验证计划与实现范围 | `complete` | 新增[验证计划](next-capacity-and-process-safety-plan.md) | 选择 OPFS read-only backing 与 backend 单 writer/restart recovery 两个风险面；认证、生产 HA、真实 eviction、Safari 等延期并给出理由。 |
| M2：VFS backing API 与单测 | `complete` | `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts --coverage=false`；`pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json` | 22/22 VFS 测试通过；新增 `VfsFileBacking`、range read、写入 materialize、VFS close 释放和 `logicalBytes/residentBytes` 观测，定向 TypeScript 检查通过。 |
| M3：OPFS sync handle 与 Chrome Worker 集成 | `complete` | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；Chrome 155 `tests/opfs-vfs-residency.e2e.mjs` | 8 MiB 文件真实刷新 hydrate 后通过 OPFS sync handle 做 64-byte range read；`residentBytes` 从写入后的 42,887,747 降至 34,493,823，追加写重新 materialize，第二次刷新再次 externalize；无 page error。 |
| M4：backend dataDir lock 与多进程恢复 | `complete` | `node docs/drafts/browser-native-dsh-poc/tests/workspace-backend-multi-instance-characterization.e2e.mjs` | 两个独立 Node PID 共享 `dataDir` 时第二实例在 `listen()` 前以 `BACKEND_ALREADY_RUNNING` 失败；第一实例 `SIGKILL` 后新实例恢复 1 条 Session event、Workspace revision 1，fencing token 从 1 到 2，原 operation replay 不增加 revision。 |
| M5：故障组合、容量证据和回归 | `complete` | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`；PoC Workspace Vitest；preview build；上述 Chrome E2E | backend 17/17、Workspace Vitest 23/23、MemoryVfs 22/22；Chrome 155 两项新 E2E 通过。结果不覆盖自然 eviction、OS/磁盘 crash、跨主机 HA 或真实 LLM 大文件参数。 |
| M6：文档、检查、commit 和 push | `complete` | `pnpm run verify-md-wrap`、`pnpm run verify-md-links`、`pnpm run doc-typecheck`、`pnpm run test:docs`、`pnpm run doc-sync`、`git diff --check`；本记录、README、兼容矩阵、`docs/drafts/README.md`、change ledger 已更新 | 文档门禁全部通过：Markdown 换行 2,138 个文件、链接 2,101 个文件、文档类型检查 100 个 block、doc-quick 21/21、doc-sync 43/43；提交和 push 作为本批最后交付步骤执行。 |

## 候选判断

- `dataDir` 多进程写丢失是已观察到的功能性数据损坏，本批将其从“限制说明”提升为启动时 fail-closed 的安全条件，并验证强杀后安全接管。
- VFS 的 OPFS mirror 不能证明工作集从 Worker heap 移出；只有 `MemoryVfs` 文件节点可从同步 OPFS backing 做 range read、且真实 Worker 可关闭资源，才计入本批成功。
- backend 单写者锁不是 HA。若未来必须并行 backend，应迁移 Session、manifest、lease、identity 与 operation ledger 到具有事务/CAS 能力的共享 metadata store，再独立验证故障域。
- 浏览器身份 cookie 在强杀后未自动恢复仍是已知限制；本批重启 backend 时保持 Chrome 页面与用户身份不变，避免用 backend 测试替代登录恢复。

## 记录规则

- 每个里程碑记录精确命令、Node/Chrome 版本、真实 PID/operation/revision、bytes/hash、失败注入点和资源清理结果。
- memory 结果同时报告 `logicalBytes`、`residentBytes`、完整读分配和工作集；不把 heap snapshot 的单次观测写成 SLA。
- 任何接收失败的第二 backend 必须在 `listen()` 前退出；SIGKILL 恢复后要从新的独立进程 cold-load，不读取旧进程内存。
- Chrome 使用真实 Dedicated Worker、OPFS、IndexedDB 与 scripted DSH Loop；除非另有真实 provider 结果，不宣称真实 LLM 验证。
- 失败实验保留其发现；stale lock 无法安全识别时的 fail-closed 是可接受结果，静默覆盖 owner lock 不可接受。

## 实际证据与限制

- Chrome 155.0.8059.85、Node v24.6.0、pnpm 11.28.5；新 E2E 使用真实 Dedicated Worker、OPFS、IndexedDB 和 scripted backend/LLM，不是真实模型证明。
- OPFS hydrate 当前会为完整 SHA-256 校验临时读取完整 blob；低常驻驻留已证明，但首次 hydrate 的峰值内存降低尚未证明。`residentBytes` 是 VFS 节点统计，不是浏览器 heap snapshot 或 SLA。
- `dataDir` 锁是本机进程锁：原子 `wx` 创建、live PID fail-closed、owner PID 退出后回收 stale lock。它不解决 PID 复用、跨主机锁、目录 fsync、共享数据库事务或真正 HA。
- 旧的双 backend 并发写入负面 characterization 仍是本批选择单写者的依据；当前测试不再把该不安全行为作为通过结果。
