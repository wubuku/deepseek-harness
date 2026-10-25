---
description: "记录 Browser-Native DSH 长会话可持续性验证的进度、实测证据和限制。"
---

# Browser-Native DSH 长会话可持续性验证进度

## 当前状态

状态：已完成实现、真实 Chrome 验证和文档整理；本批目标在当前 PoC 范围内完成。

基线：`research` 分支当前 checkout；本批开始时只有本批计划和进度两个未跟踪文件，没有其他 worktree。源码核对发现 Browser profile 覆盖 standard preset 时遗漏 compaction group；Browser LLM adapter 固定回报 128,000 context window；上一批 24 轮仅记录 202 个 Session events。浏览器范围限于真实 Chrome；scripted LLM 用于确定性故障和工具时序，真实 LLM 单独记录。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选审查与计划 | `complete` | [验证计划](next-session-sustainability-validation-plan.md)列出候选、取舍、验收和限制 | 确认 Browser overlay 的实际插件组合 |
| M1：Browser profile compaction 组合与 context window 元数据 | `complete` | Browser profile 已挂载 compaction 组；默认 profile Chrome 回归验证 `/compact`；显式 context window 通过同源 config 传入，未配置时不猜测 | 保持 capability manifest、backend contract 和 provider metadata 的回归覆盖 |
| M2：大工具结果裁剪、压力/overflow 压缩与刷新恢复 | `complete` | Chrome scripted E2E 通过自动压力、context overflow、prune、摘要和刷新；原始 `tool/result` 保留，后续模型请求使用压缩后的 DSH surface | 后续只在发现真实模型或生产负载问题时单独设计分页/投影验证 |
| M3：摘要失败及 Session append 故障 | `complete` | 摘要部分流失败以 error end 收束；一次 `compaction/end` append 503 重试后无重复 summary/replacement，失败后可刷新并继续 | 保留故障矩阵，不将其外推为永久 backend outage 或跨存储事务 |
| M4：真实模型闭环与 64 轮诊断 | `complete` | 真实 Chrome/LLM `/compact` 后刷新并回忆 sentinel；64 轮冷 hydrate 记录事件、落盘和传输字节，刷新不重放 LLM | 依据量化数据决定是否规划 Session 分页或本地 projection cache |
| M5：文档、门禁、commit、push | `complete` | README、矩阵、索引、ledger 和本进度已更新；focused code/browser/docs checks 已通过；本批提交待远端 ref 确认 | 后续批次依据 64 轮数据评估 Session 分页或 projection cache |

## 执行记录

| 日期 | 命令或操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-25 | `git status --short --branch`; `git worktree list`; `git log -1 --oneline` | 开始时 `research` 与 `origin/research` 一致；无其他 worktree；工作区干净 | 按计划在主 worktree 继续 |
| 2026-10-25 | 核对 `browser-native-profile.cordis.patch.yml`、Web standard preset、Web bundle、Browser adapter 与 compaction package 源码 | Browser profile 替换 standard preset 插件列表并漏掉 compaction group；adapter 的 `resolveModel()` 固定回报 `contextWindow: 128_000`；Web 标准组含 `compaction-basic`、`command-compact`、`tool-result-pruner` | 已将发现写回计划，优先修复默认 Browser profile，而非只在测试 overlay 中模拟 |
| 2026-10-25 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs` | 通过；Browser schema 含预期文件/交互工具、不含 `read_image`/主机网络工具；受限 Bash tool loop、默认 profile `/compact`、摘要事件、无 page error/外站请求均通过。首次运行暴露测试错误复用写租约和 scripted fixture 历史 marker，已修正为同页同 Session 当前 prompt 路由 | 保留默认 profile 回归，避免用多标签共享写 Session 做单页能力测试 |
| 2026-10-25 | `DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_CONTEXT_WINDOW=32768 node docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs` | 通过；真实 `gpt-5.6-sol` 生成 summary，`compaction/summary` 与 `compaction/end` 各 1 个，刷新不重放模型请求，之后真实模型回忆 sentinel；无 page error/外站请求，密钥未进入浏览器观测 | 该结果只覆盖当前 provider/model、Chrome 和当前 compact prompt，不是所有模型的摘要质量保证 |
| 2026-10-25 | `DSH_POC_BROWSER=chrome DSH_POC_LONG_SESSION_TURNS=64 node docs/drafts/browser-native-dsh-poc/tests/long-session-hydrate.e2e.mjs` | 通过；64 轮、刷新前 522 个事件、落盘 142,006 bytes；hydrate 读取 2 次、响应 284,184 bytes、耗时 1,885 ms；刷新后 LLM 请求数保持 65，后续 turn 成功 | 这是单机 scripted Chrome 诊断，不是性能 SLA 或生产容量上限 |
| 2026-10-25 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/compaction-session-sustainability.e2e.mjs` | 通过；自动压力/overflow 场景 1 次 prune、2 个 summary；摘要失败场景无成功 summary 且有 error end；`compaction/end` 一次 503 场景恢复后无重复事件；三场均刷新并继续，无 page error/外站请求 | 故障由 PoC backend/scripted LLM 注入，不等价于自然上游断流或永久 backend 故障 |
| 2026-10-25 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`; `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts`; `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 分别通过 24/24、3/3 和 preview build；构建保留既有平台依赖、tsdown deprecation 和大 chunk 警告 | 继续运行文档聚合门禁 |
| 2026-10-25 | `pnpm run verify-md-wrap`; `pnpm run verify-md-links`; `pnpm run doc-typecheck`; `pnpm run test:docs`; `git diff --check` | 全部通过；`test:docs` 为 21/21 gates，文档 wrap 检查 2,165 个文件，链接检查 2,128 个文件，typecheck 编译 100 个 block | 提交、推送并确认工作区干净 |

## 证据与限制

- 上一批 24 轮/202 个事件只证明小规模全量 hydrate 和刷新后续聊，不证明 compaction、长 Session 上限或分页读取。
- 本批源码核对发现 Web bundle 的 base 配置禁用 host compaction provider，而 Web standard preset 通过隔离的 compaction group 提供 Browser profile 应继承的组合；现已在 Browser profile 显式挂载并由 Chrome 回归验证。
- 本批源码核对发现固定 `128_000` 的 Browser adapter context window 与 backend 实际模型配置无关；现已改为 backend 显式、非敏感配置，未提供时省略 context metadata。
- 真实 LLM 与 scripted 压缩故障均已在真实 Chrome Worker 中运行；真实证据只覆盖当前 `gpt-5.6-sol`、显式 `contextWindow=32768`、当前摘要提示和同源 PoC backend。
- 64 轮 hydrate 仍是全量 Session read：落盘 JSON 未因 compaction 变小，刷新读取字节高于落盘文件大小，说明压缩改变模型可见投影而不压缩权威事实日志。
- 本批修改集中在 `docs/drafts/browser-native-dsh-poc/`；Browser profile、backend 和 preview 入口仍属于 PoC 草稿接线，不改变正式 DSH packages 或 Session format。

## 经验与限制

- Browser profile 覆盖标准 preset 时必须显式复制 compaction group；只检查 Web bundle 中是否存在 compaction package 会漏掉 Cordis composition。
- 测试模型必须按当前用户消息路由。DSH 会追加 runtime context、time context 和历史 user 消息；仅从完整 `messages` 搜索 marker 会把旧 turn 误判为当前场景。
- `/compact` 只在 summary 比被 shadowed content 更小时成功；真实模型输入过短时会得到带原因的 `compaction/end`，不能把“命令被调用”写成“压缩成功”。
- `compaction/summary` 的摘要字段是 `event.data.summary`，不是 assistant message 的 `message.content`；测试必须区分 Session 事实事件和聊天投影。
- 真实模型 summary 成功且刷新回忆 sentinel，只证明当前模型和 prompt 的一个闭环；不能证明所有模型都保留任意业务事实，也不能把 compaction 说成删除历史或缩小 durable Session。
