# 变更清单

## 目录外修改

2026-10-19 本轮仅调整研究文档，不修改运行时代码：当时曾将成熟 React SaaS 的下一阶段实施主线暂定为 CopilotKit，同时标明三份 PoC 非同口径、`/v2` 已在使用、业务工具靠自有桥执行和生产采用缺口。随后复杂批量续约对照让 assistant-ui 与 CopilotKit 在同一真实模型故事上通过，当前统一结论改为 assistant-ui 低耦合基线、CopilotKit 条件性升级。统一论据由[路线重评](../dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)维护；其他报告保留各自主题并链接它。

本轮验证：`pnpm run test:docs` 21 项通过、`pnpm run doc-sync` 43 项通过。既有 Chrome/WebKit 两份 Session 重新计数与原记录一致，没有重新执行模型或浏览器验收。重放本次文档修订时应保留“框架提供的呈现”与“自有 bridge 执行”的区分，不把文档修订当作运行时缺口已修复。

| 文件 | 原因与验证 | 上游重放方式 |
|---|---|---|
| `docs/drafts/README.md` | 为新 PoC 增加索引，并以实际 SaaS 工作台闭环更新三路线综述；链接和事实边界由 `pnpm run doc-sync` 核对 | 在 drafts 索引中保留 PoC 链接和“单个 mock 业务闭环”的证据限制 |
| `docs/drafts/assistant-ui-copilotkit-browser-native-dsh-assessment.md` | 用真实 PoC 结果修正 CopilotKit/assistant-ui 的相对定位，仍区分业务 mock 与生产集成；`pnpm run doc-sync` 验证引用 | 将实现证据作为增补，避免外推为所有 SaaS 的普遍结论 |
| `docs/drafts/dsh-web-ui-quality-and-agentic-ui-framework-assessment.md` | 更新 SaaS 已有 React GUI 场景下的路线排序，并链接 PoC 证据和限制；`pnpm run doc-sync` 验证引用 | 保留三路线比较，标明当前首选依赖本 PoC 的单业务闭环证据 |
| `docs/drafts/dsh-browser-native-agentic-ui-research.md` | 更正旧版“业务 capability seam 尚未实现”的概括，并依据本 PoC 更新 Browser-Native Agentic UI 路线结论；将单个 mock capability 闭环与未验证的生产授权、幂等和 receipt 明确区分 | 保留当时“优先深化 CopilotKit”的历史范围限定，同时以路线重评中的最新结论为准；不将单个 mock 操作外推为通用生产能力 |
| `docs/drafts/dsh-agentic-ui-research.md`、`docs/drafts/saas-agentic-ui-report-review.md` | 与三份 PoC 后的统一推荐同步，纠正包版本/API 代际混淆，保留生产授权、幂等和恢复限制 | 更新选型摘要并指向路线重评；不得改写为 CopilotKit 已证明普遍优于其他候选 |
| `docs/drafts/copilotkit-browser-native-dsh-source-verification.md` | 在实施前源码核查中补充实际 PoC 入口，避免将待验收的原生工具调度实验当成已完成 | 保留源码事实与原实验建议，另链实际 `useRenderTool`/自有 bridge 的验证范围 |
| `docs/i18n/README.md`、`docs/i18n/README.zh.md`、`docs/i18n/README.i18n.yaml`、`scripts/translation-pairing.manifest.json` | 为本目录显式登记中文单语实验例外，并同步中英配对摘要；翻译配对检查和 `pnpm run doc-sync` 验证 | 仅保留 PoC 目录范围的豁免，不扩大为全仓库或 drafts 全目录例外 |
| `scripts/repo-files.ts`、`scripts/repo-files.spec.ts`、`scripts/doc-typecheck.ts` | 文档扫描器递归进入 PoC 的 npm 依赖目录，导致第三方 README/license 和代码示例被误当成仓库正文；递归 glob 跳过 `node_modules`，明确字面路径仍可检查。定向 Vitest 和 `pnpm run doc-sync` 验证 | 上游重放时保留文档扫描排除和 repo-files 定向测试；不要修改 PoC 依赖或翻译豁免来掩盖扫描器问题 |

没有修改正式 `packages/`、`apps/`、根依赖、既有 Browser-Native DSH PoC 或 assistant-ui PoC。目录外修改是研究索引、选型综述、Browser-Native Agentic UI 综合报告和本目录中文文档策略所必需；没有改动产品运行时。

## 本目录实现

| 文件 | 变更 | 验证/重放说明 |
|---|---|---|
| `src/main.tsx` | 增加 SaaS 工具桥注册、聊天内可编辑操作卡片、确认/取消及最终工具结果呈现 | `npm test`、`npm run build`、真实 Chrome Playwright E2E |
| `src/saas-workspace.tsx` | 新增既有 SaaS 工作台 mock、列表和本地持久化 | 单元与浏览器 E2E |
| `src/saas-workspace-model.ts` | 新增创建工作项状态转换及未确认/未知项目错误语义 | `tests/saas-workspace-model.test.ts` |
| `src/copilotkit-browser-native-tools.ts` | 在 Worker 真实 DSH tools registry 增加页面读取与业务动作工具 | Worker->MessagePort->页面->原 DSH waiter 的真实 Session event |
| `src/dsh-agui-agent.ts`、`src/dsh-client.ts`、`src/browser-native-control.ts`、`src/browser-native-worker.ts` | AG-UI/DSH 消息与 turn 适配、Session hydrate/写租约、Worker 生命周期和 Main Thread 页面工具桥 | 真实 Chrome/WebKit E2E、flush/restart E2E；适配细节见 `design.md` 和 `lessons-learned.md` |
| `profile-overlay/`、`run.mjs`、`vite.config.ts`、`package.json`、`package-lock.json` | 独立固定 CopilotKit/AG-UI 版本；复用 v2 Browser-Native runtime/Session/LLM backend，并加载 CopilotKit 工具 overlay | `npm ci`、`npm test`、`npm run build`、scripted 与真实模型 E2E |
| `src/styles.css` | 替换暗色 demo 外壳，增加桌面/窄屏工作台、聊天消息排版和 Agentic UI 表单样式 | Chrome/WebKit 桌面、消息排版和窄屏 E2E |
| `tests/` | 增加领域状态单测、scripted/真实模型浏览器验收及 Session flush/backend restart 恢复测试 | 详见 `test-record.md`；真实证据目录和 Session ID 均已记录 |
| `README.md`、`implementation-plan.md`、`progress.md`、`design.md`、`lessons-learned.md`、`test-record.md` | 记录目标、可启动说明、架构、经验教训、实际验收证据与限制 | `pnpm run doc-sync`、`pnpm run test:docs` |

Vite 将构建输出写入被仓库 `.gitignore` 排除的 `apps/web/dist/`。PoC 内依赖/构建临时目录不属于交付源文件；提交前通过局部 `.gitignore` 排除。
