---
description: "记录 Browser Worker 中 DSH skill 文件系统插件集成的实施、Chrome 与真实 LLM 验收结果及限制。"
---

# Browser Worker skill 文件系统集成验证进度

## 当前状态

状态：M0–M5 已完成。目标、候选范围与验收条件见[验证计划](worker-skill-filesystem-validation-plan.md)。

批次基线：`research` 工作区干净且与 `origin/research` 同步；只有主 worktree，没有隔离 worktree。Safari/WebKit 暂停；真实模型凭据只由同源 backend 从 `docs/drafts/.env` 读取。

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：消费路径与风险基线 | `complete` | `skill-filesystem` 在 `ctx.fs` 可用时经 DSH VFS 发现和读取；缺失根使用 `fs.watchFile`，已存在根由 Chokidar 使用 `fs.watch`。 | — |
| M1：验证专用 Worker profile | `complete` | Chrome Dedicated Worker 运行真实 `dsh-skill-filesystem`、base profile 的 `dsh-skill` registry 和 `dsh-tool-skill`；只扫描 `/dsh/home/workspace/.agents/skills`，未重复注册 registry。 | — |
| M2：目录、watcher 与工具闭环 | `complete` | Chrome scripted E2E 验证缺失根创建、初始加载、DSH `read → edit → edit → skill`、目录描述更新、正文进入同一 turn 的后续模型请求、删除后目录撤回。两次 edit 各有一个 Session call/result、Workspace receipt 和 Workspace commit。 | — |
| M3：持久化、失败与刷新恢复 | `complete` | Chrome scripted E2E 验证同一 Session 刷新后恢复目录和正文；OPFS 保存失败后撤回 `write`/`skill` 发布，易失正文不进入后续模型请求或远端 Workspace，刷新后不存在。skill 场景的远端 commit response 故障与旧 Worker teardown fencing 未验证。 | — |
| M4：真实 LLM 冒烟 | `complete` | Chrome 经同源 backend 完成两次模型 `skill` 调用；刷新后复用同一 Session。只有一次用于 seed 的 Workspace commit，读取 skill 没有额外 commit；无跨源请求、页面或 Worker error，凭据泄漏计数为 0。 | — |
| M5：文档与交付 | `complete` | PoC README、兼容矩阵、目录索引、change ledger、计划和进度已更新；PoC focused Vitest 27/27、`test:docs` 21/21、`doc-sync` 43/43、Node syntax checks、定向 Oxlint、最终 diff 与 change-scope 检查均通过。 | — |

## 执行记录

| 日期 | 命令或操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-29 | `git status --short --branch`; `git worktree list --porcelain`; `git log -8 --oneline --decorate` | 位于 `research`，起始工作区干净且与 `origin/research` 同步；只有主 worktree；当前 HEAD 为已提交的 Worker 文件能力验证 | 仅在主 worktree 实施本批 |
| 2026-10-29 | 阅读 `dsh-skill-filesystem`、`dsh-skill`、`dsh-tool-skill` README/source，以及 PoC capability publication 和 Node filesystem trace | `skill-filesystem` 在 `ctx.fs` 存在时通过 DSH VFS 扫描；watcher 仍走 Node `fs.watch`/`fs.watchFile` 与 Chokidar；`tool-skill` 将目录和正文投影到 DSH Session/model context。现有测试没有把三者合并到真实 Browser Worker。 | 核对 profile overlay 与 Session/Workspace 保存顺序 |
| 2026-10-29 | `pnpm exec vitest run packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` | 20 项通过、2 项失败：主机临时目录 watcher 状态超时，失败于“recreated missing root”和 project watcher LRU 两个原生 watcher 场景；未修改 package 或放宽测试。 | 用 Worker VFS mutation watcher 的浏览器证据单独判断集成结果 |
| 2026-10-29 | `pnpm exec vitest run packages/experimental/webworker-runtime/tests/node/chokidar.spec.ts packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts` | Chokidar VFS 测试 12 项通过；本机为 macOS，仓库 Vitest 配置将 `fs-watch-stream.spec.ts` 作为 Linux-oracle 测试排除。 | 以 Chrome E2E 验证真实 Worker VFS watcher |
| 2026-10-29 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | Preview、Worker runtime、VFS image 构建成功；出现仓库既有平台包/Chunk size 警告，无构建错误。 | 运行 Chrome skill-filesystem scripted E2E |
| 2026-10-29 | `DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/worker-skill-filesystem.e2e.mjs` | Preview 页面未在 30 秒内显示 composer；首次失败路径没有足够诊断，尚未进入 Session 或 skill 场景。 | 加入仅记录错误、API 路径和页面尾部的脱敏诊断后重跑 |
| 2026-10-29 | 同上（加入脱敏诊断后） | Worker console 报告 Cordis `skills` 服务已由 base profile 的 `<SkillRegistry>` 注册；validation overlay 再注册一次导致该 agent preset 无法加载。 | 删除 overlay 中重复的 `dsh-skill` 注册；保留 DSH base registry |
| 2026-10-29 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | Preview、Dedicated Worker runtime 与 VFS image 构建成功；有既有平台包和大 chunk 警告。 | 用最新 bundle 重跑 Chrome scripted 流程 |
| 2026-10-29 | `DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/worker-skill-filesystem.e2e.mjs` | 首轮确认真实 `edit` 工具要求同一 Session 先 `read` 文件；后续发现目录描述断言要求改变 frontmatter，而脚本只改正文。脚本现按 `read → edit(description) → edit(body) → skill` 执行；PoC 直接 edit 路径在执行它的 agent Context 发出同步 `fs/observed`，使 skill catalog 在下一模型请求前更新。外部 VFS 删除按 Chokidar settle 窗口等待 250 ms 后验证目录撤回。 | 继续跑完故障和刷新断言 |
| 2026-10-29 | 同上（最终 scripted 运行） | Chrome 通过；工具计数为初始 load 1、编辑/重载 4、刷新后 load 1、删除后 0、保存失败写入 1、失败刷新后 0。共 6 次 Workspace commit；无页面/Worker 错误或跨源请求。既有 `/open-in-app/apps`、`/api/changes.summary`、`/api/present.host` 路由返回 404，不影响验证流程。 | 运行真实 LLM smoke |
| 2026-10-29 | `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/worker-skill-filesystem.e2e.mjs` | 真实 Chrome/LLM 通过，两次模型工具调用均为 `skill`；刷新后同一 Session 仍可读取已持久化 skill。只有同源请求，`secretLeakCount=0`，无页面/Worker 错误或跨源请求；seed 产生 1 次 Workspace commit，读取没有额外 commit。 | 更新矩阵与交付记录 |
| 2026-10-29 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts` | 2 个 test files、27 项通过。 | 更新进度并审查完整 diff |
| 2026-10-29 | `node --check`（backend、runtime validation 与本批 E2E）；定向 `pnpm exec tsx scripts/run-oxlint.ts`（Preview 与本批 Worker TypeScript） | 全部通过，无输出错误。 | 执行文档和推送前检查 |
| 2026-10-29 | `pnpm run test:docs`; `pnpm run doc-sync` | 分别 21/21 与 43/43 gate 通过。 | 检查 `change-scope`、diff、提交与推送 |
| 2026-10-29 | `pnpm --silent run change-scope --base origin/research`; `git diff --check`; `git worktree list` | 变更范围只含本批 Preview test-port 接线、PoC Worker/backend、验证脚本和文档；diff 无空白错误；只有主 `research` worktree。 | 完成提交与推送 |

## 实际验证

Chrome scripted 与真实 LLM E2E、Preview build、focused Vitest、定向 Oxlint、`test:docs` 和 `doc-sync` 均通过，具体命令与脱敏结果见执行记录。真实模型凭据只由同源 backend 读取 `docs/drafts/.env`；测试输出不包含密钥。原生临时目录 watcher 的 2 项单测失败仍只说明本机 macOS 测试观察到的宿主 watcher 超时，不是 Browser VFS watcher 的失败证据；Chokidar VFS watcher 的 12 项单测通过。

## 已知限制

本批使用 PoC validation profile，不等同于默认 Browser profile 的正式能力声明；默认 profile 仍未启用 skill。外部 VFS mutation 依赖 Chokidar 异步通知，验证在测试中等待配置的 settle 时间；它不是通用同步 watcher 保证。skill 场景未单独注入远端 commit response 故障，也未独立断言刷新后旧 Worker watcher 的 fencing。页面生命周期仍约束 Dedicated Worker，页面关闭后 watcher 不会继续运行。生产身份授权、自然 eviction、OS/磁盘崩溃、生产 backend、Safari/WebKit、任意 Node API 或所有 Chokidar 选项均未验证。
