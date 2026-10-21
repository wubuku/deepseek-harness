---
description: "Browser-Native DSH 下一轮验证进度：记录浏览器运行时实验的命令、结果、限制和剩余验证。"
---

# Browser-Native DSH 下一轮验证进度

## 当前批次状态

本轮 Chrome 验证与文档收敛已完成（100%）。按用户要求，Safari.app 和 Playwright WebKit 后续测试暂停；既有结果保留为历史对照，不计入本轮 Chrome 复测。

2026-10-21 真实 Chrome 基础 E2E 完成三个 `completed` turn，恰好执行一次 `todo_write`，Session 有 40 个 events、`durableThroughSeq=39`；后两轮从同一 Session 回忆 token 和任务标题。

同日 Browser-specific overlay 的真实 runtime E2E 完成三个 `completed` turn；首轮工具顺序严格为 `read → write → read`，刷新后模型能回忆 Session token，并通过实际 `read` 确认 Worker VFS 文件不存在。Session 有 57 个 events、`durableThroughSeq=56`，8 个模型请求均返回 HTTP 200。

Chrome scripted runtime 回归完成两次刷新，DOM 动画帧采样观察到 8 次递增更新；测试 backend 现在以 120 毫秒间隔发送 scripted 文本块，使采样不被过快 fixture 混淆。Chrome scripted lifecycle 记录 completed、completed、aborted、error、completed、completed、completed，最终 `durableThroughSeq=70`。真实 Chrome Stop/恢复最近一次为 `aborted → completed`、`durableThroughSeq=25`、page error 为空。

真实 Chrome 长回复生成 9,523 个字符，记录 84 次递增 DOM 样本和约 15.8 秒增长跨度；输入草稿交互约 20 毫秒，滚动可用，无 long task。截图与摘要位于 `/tmp/dsh-browser-native-streaming-evidence-20261021/`。

排查中发现一次 240 秒整轮等待超时发生在第四个模型步骤仍运行时；Session 已有三次成功 VFS 调用且没有 `turn/end`，因此它不是已完成失败的 Agent Loop。整轮 E2E 预算提高到 600 秒后真实 Chrome runtime 验证完成。

另一次真实 Stop 后的恢复请求曾收到无文本、无工具调用的 provider `finish_reason=stop`，旧 backend 错把空 assistant 记录为 `completed`。backend 现在以 `UPSTREAM_LLM_EMPTY` 报错，contract test 覆盖该映射；修改后的真实 Chrome Stop/恢复 E2E 通过，但真实 provider 在本轮没有再次触发空回复重试分支。

## 范围

本记录服务于 [`next-validation-plan.md`](next-validation-plan.md)，主线是验证 DSH 在 Dedicated Worker 中的运行能力和边界；SaaS 联动仅作为可选外部价值，不作为本轮主要验收条件。

## 版本与环境

- 分支：`research`。
- 日期：2026-10-21。
- Node：`v24.6.0`；pnpm：`11.7.0`；Playwright：`1.61.1`。
- 当前复测浏览器：Playwright Chrome；WebKit 和 Safari.app 的旧结果只作对照，按用户要求暂停新测试。
- LLM：scripted 与 real；真实模式只由 backend 读取 `docs/drafts/.env`。
- 每次测试使用动态 loopback port 和临时 Session 数据目录。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| 修正规划并限定浏览器运行时主线 | 已完成 | [`next-validation-plan.md`](next-validation-plan.md) 明确 DSH Worker、真实 Agent Loop、Session 和浏览器生命周期为主目标；SaaS 只作可选附录。 |
| 原始与 Browser-specific tool roster 对照 | 已完成 | 原始 roster 的真实 Chrome 曾暴露 `bash`、`web_search`、`web_fetch`；此前真实 Chrome/WebKit 请求都显示 Browser-specific 临时 overlay 排除了这些工具；本轮只在 Chrome 复测。 |
| 真实 Worker VFS、模型与多轮记忆 | Chrome 已复测 | Browser-specific overlay 下真实 Chrome 完成 `read → write → read`、刷新后同 Session token 回忆和 VFS 文件不存在探测；57 个 Session events、`durableThroughSeq=56`、8 个模型 HTTP 200。WebKit 旧结果保留，不再复跑。 |
| 基础真实多轮聊天与 todo | Chrome 已复测 | 三轮真实对话均为 `completed`，只执行一次 `todo_write`；40 个 Session events、`durableThroughSeq=39`，后两轮回忆同一 Session token 和任务标题。该基础用例使用默认 roster，不替代 Browser-specific roster 验证。 |
| scripted streaming DOM 与 lifecycle | Chrome 已复测 | Chrome 两次刷新后续聊通过，动画帧采样记录 8 次递增 DOM 更新；scripted backend 延迟设为 120 毫秒以避免所有文本块在 UI 首次刷新前完成。Chrome 生命周期覆盖 Stop、双标签写权冲突、注入模型错误后恢复、backend 重启和 Worker terminate 后 lease 回收。WebKit 旧结果保留。 |
| 真实模型 Stop 与恢复 | Chrome 已复测 | 最新 Chrome 真实 E2E 在同一 Session 记录 `aborted → completed`、`durableThroughSeq=25`、两个模型请求 HTTP 200、page error 为空。旧实现曾将无文本/无工具的 provider finish 错记为空 assistant `completed`；backend 现返回 `UPSTREAM_LLM_EMPTY`，contract test 覆盖该路径。 |
| backend port 0 与 Symbol.dispose 兼容 | 已完成 | backend/Symbol suite 为 9 passed、0 failed；动态端口返回实际分配端口；缺失的 Worker realm symbols 只补齐、不覆盖现有值。 |
| WebKit 刷新 teardown 错误 | 历史对照已复测未复现 | 刷新测试此前每轮重复导航；runtime 与 Worker terminate recovery 均改为 reload 后只等待当前页面。此前 WebKit scripted 五次连续刷新、真实 Chrome/WebKit 各两次刷新均无 tunnel 503 或 page error；本轮暂停 WebKit 后不再复跑。不能据此声称 Safari.app 或所有卸载时序均无竞态。 |
| 真实模型 streaming DOM 表现 | Chrome 已验证 | `tests/runtime-streaming.e2e.mjs`；真实 Chrome 长回复生成 9,523 个字符，观察到 84 次递增 DOM 样本、约 15.8 秒跨度、输入草稿交互约 20 毫秒、可滚动输出和空 long-task 记录。WebKit/Safari 长回复测试暂停。 |
| 多工具真实 turn 的总等待预算 | 已修正 | 一次 240 秒用例在第四个模型步骤仍运行时超时；Session 已含三次成功 VFS 工具调用且没有 `turn/end`。将整轮测试预算设为 600 秒后，真实 Chrome 工具、记忆与刷新验证成功；旧记录不是 Agent Loop 失败。 |
| 启动、首块、flush 性能与主线程响应 | Chrome 单次观测完成 | 记录首个 Session text chunk、UI 首次更新、turn settlement、flush 和 Stop/帧响应；真实 Chrome 长回复已测输入草稿、滚动和 long-task，样本不足以形成性能分布或 SLA。 |
| Safari.app 真实聊天与刷新恢复 | 部分完成，后续暂停 | Safari 26.6.2 真实 WebDriver 完成工作区选择、真实模型三轮记忆对话和刷新后继续；工具长文本输入在 WebDriver 中超时，工具闭环未验证；按用户要求暂不继续 Safari 测试。 |
| OPFS 与浏览器存储能力 | 已完成（能力探测） | 新增 `tests/browser-storage-boundary.e2e.mjs`；分别记录 Chrome/WebKit 的 OPFS 支持、读回结果、`estimate()` 和持久化状态。该结果不改变 DSH VFS 与 Session JSON 的独立语义。 |
| backend E2E teardown | 已完成 | `backend-v2.mjs` 的 `close()` 主动释放 keep-alive connections；最新真实 Chrome E2E 都能在输出成功摘要后正常退出。 |
| Safari.app 工具、跨设备与生产级恢复 | 未完成，Safari 暂停 | Safari 工具输入超时仍未归因；跨设备 workspace、跨进程 fencing、生产 HA 和生产授权未验证。OPFS 已完成能力探测，但不作为持久化方案。 |

## 命令与结果

本轮最终检查已运行：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/symbol-dispose.test.ts
```

`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 成功；本机 Darwin arm64 对不匹配的可选 native 包有安装告警，Vite 也提示既有大 chunk（主入口约 633 KB），均未阻止构建。`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/symbol-dispose.test.ts` 为 9 passed、0 failed。`pnpm run test:docs` 为 21 passed，`pnpm run doc-sync` 为 43 passed；`git diff --check` 通过。

最终 preview lint 修正后，`DSH_POC_BROWSER=chrome DSH_POC_LLM=scripted node docs/drafts/browser-native-dsh-poc/tests/runtime-lifecycle.e2e.mjs` 和 `DSH_POC_BROWSER=chrome DSH_POC_LLM=scripted node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` 均通过。生命周期 turn 序列为 `completed → completed → aborted → error → completed → completed → completed`，覆盖刷新续聊、Stop、写租约冲突、错误后恢复、backend 重启和 Worker terminate/lease reclaim；`durableThroughSeq=70`，无 page error。runtime smoke 检查了 Browser-specific roster、同源 LLM 两次 HTTP 200 和递增 DOM 更新，无 page error。`pnpm exec tsx scripts/run-oxlint.ts apps/web/src/preview.ts` 通过；全仓 `pnpm run lint` 被未修改的 `packages/core/tools/tests/json-schema.spec.ts:251` 的 `typescript(unbound-method)` 阻塞，单文件复跑确认该诊断仍存在于当前基线。

为满足 Web TypeScript 项目的 `rootDir`/文件列表约束，页面生命周期 bridge 已从草稿目录移到 `apps/web/src/browser-native-page-control.ts`。移动后的 `pnpm run typecheck`、preview build、preview 与 bridge 定向 Oxlint，以及 Chrome scripted lifecycle/runtime E2E 均通过；`pnpm run test:docs` 为 21 passed，`pnpm run doc-sync` 为 43 passed。该迁移只改变 bridge 源码位置和 preview import，不改变 Worker/Session 生命周期行为；真实模型 Browser-specific E2E 的既有结果仍是迁移前证据。

真实 Chrome Browser-specific 多轮验证记录位于 `/tmp/dsh-browser-next-validation/runtime-browser-real-chrome-current.log`：Session 有 42 个事件、`durableThroughSeq=41`，工具顺序为 `read → write → read`，6 个模型请求均 HTTP 200、无 page error。真实 Chrome Stop/恢复脚本的最新记录位于 `/tmp/dsh-browser-next-validation/runtime-lifecycle-stop-chrome-2.log`：turn 顺序为 `completed → completed → aborted → error → completed → completed → completed`，Stop 后恢复、刷新续聊、双标签写权冲突、backend 重启和 Worker terminate/lease reclaim 均有断言结果，`durableThroughSeq=70`、无 page error。

此前 Chrome/WebKit 的 scripted runtime 与 lifecycle 结果仍保留为历史对照；本轮暂停 WebKit 后，只新增 Chrome 真实 Stop/恢复复测。此前 Chrome 与 WebKit 各完成三轮 Browser-specific 任务和两次刷新，首轮工具顺序均为 `read → write → read`，每个浏览器 8 个模型请求为 HTTP 200，Session `durableThroughSeq` 为 56。Chrome 首个可见更新约 8.31 秒、首个 Session text chunk 约 8.26 秒、首轮 settlement 约 8.44 秒；这些是单机单次观测，不是 SLA。

真实 Chrome 长回复流式实验（`tests/runtime-streaming.e2e.mjs`）已完成：真实模型生成 9,523 个字符，assistant DOM 有 84 次递增样本，流式跨度约 15.8 秒；运行中输入草稿交互约 20 毫秒，输出滚动位置可变化，long-task 记录为空，模型请求为 HTTP 200、无 page error、turn 为 `completed`。只对 Chrome 继续验证；不得外推到 WebKit/Safari 或生产性能分布。

真实模型运行需要 `DSH_POC_LLM=real`、`DSH_POC_ENV_FILE=docs/drafts/.env`、`node --use-env-proxy` 和本机代理。一次未提供代理的运行在 backend 60 秒 deadline 后得到 `UPSTREAM_LLM_TIMEOUT`，不计为通过；通过本机代理重跑后成功。详细步骤见[运行时验证说明](runtime-validation-manual.md)，完整证据边界见[运行时验证报告](runtime-validation-report.md)。

## 已知限制

- Session history 与 Worker VFS 独立：刷新后 Session 仍记得随机 token，之前创建的 VFS 文件实际返回 `FS_NOT_FOUND`。
- `append` 只表示当前 backend 接受事件；`flush`/`close` 才建立本地 JSON durability receipt；当前 backend 没有通用 requestId 去重、跨进程 owner epoch、结果重放或 HA。
- Worker 不会在页面关闭后继续运行；Browser-specific profile 是 docs-local 测试配置，不改变默认 browser profile。
- `read_image` 虽出现在模型工具 roster 中，本轮没有验证图像读取；不能推广为所有暴露工具都已验证。
- preview 仍有辅助路由 404；刷新测试双重导航已修正，当前复测未出现 tunnel boot 503。WebKit lifecycle 曾记录迟到旧 owner `session/close` 409，见验证报告。
- runtime 测试曾以“新增任意 `turn/end`”判断本轮完成，可能在上一轮事件尚未完全落盘时误判；现改为按本次 `user/message` 的事件位置等待后续终态，并在页面关闭前等待 recovery marker 进入 durable JSON。该修复降低了测试竞态，但不改变 DSH Session 的生产恢复语义。
- Safari.app 工具输入、Safari 长回复、跨设备恢复、生产级配额治理和生产授权仍未验证；Chrome 长回复单次观测未发现 long task，但模型首块与性能分布仍未建立；OPFS 仅完成能力探测。

## 下一步

1. 后续批次可优先验证跨设备恢复、跨进程 fencing、生产存储和授权；不要把本地 JSON backend 与单次 Chrome 性能观测当作生产结论。
2. Safari.app 和 Playwright WebKit 测试按用户要求暂停；只有重新确认范围后才继续，并先归因 Safari WebDriver 输入超时。
