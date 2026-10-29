---
description: "记录 Browser-Native Worker 依赖闭包审计、分类报告、Chrome 执行矩阵和真实 LLM 烟测结果。"
---

# Browser-Native Worker 依赖闭包验证进度

## 当前状态

状态：实现与 Chrome/真实 LLM 验收完成；文档门禁和提交前检查待完成。目标、候选范围与限制见[验证计划](worker-dependency-closure-validation-plan.md)。本批在 `research` 主 worktree 进行，没有隔离 worktree；Safari/WebKit 暂停。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：源码和现有证据盘点 | `complete` | 核对 packer 的保守 roots、runtime `MODULE_PROXIES`、Browser profile 排除项和既有 Chrome Worker E2E。 | 保留“静态闭包不是激活/执行图”的说明。 |
| M1：Packer request graph | `complete` | `PackResult.moduleRequests` 记录 importer、specifier、request kind、resolution 和 image target；相对请求、静态代理、普通 unresolved 与 `meta-resolve` 测试通过。 | 更新 package API 文档并运行回归。 |
| M2：依赖闭包分类报告 | `complete` | [生成报告](worker-dependency-closure-report.json)：1,350 个 Worker JavaScript entries、4,252 条 request records；重复生成与提交报告逐字节一致。 | 记录 unresolved 依赖和静态分类的局限。 |
| M3：真实 Chrome 正反路径 | `complete` | Chrome 156.0.8078.48 scripted DSH shell 路径通过；不支持命令未新增 Workspace 文件或 commit。真实模型 `read → write → read`、刷新恢复和 durable Session 通过。 | 结构性 stub 直接拒绝由 runtime 单测证明；不外推为全模块兼容。 |
| M4：文档、回归与交付 | `complete` | PoC README、兼容矩阵、目录索引、packer 中英 README 与变更账本已更新；packer 50/50、backend contract 56/56、`doc-sync` 43/43 通过；remote base 已确认与本地 HEAD 相同。 | 本批源码与验证工作已完成；Git 交付由当前任务收尾。 |

## 命令与结果

`pnpm exec tsc -b packages/experimental/webworker-packer/tsconfig.json` 通过；`pnpm exec vitest run packages/experimental/webworker-packer/tests/profile-image.spec.ts` 为 8/8；`pnpm exec vitest run packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` 为 29/29。

`pnpm exec vitest run packages/experimental/webworker-packer/tests` 为 6 个文件、50/50；`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 为 56/56；`pnpm run doc-sync` 为 43/43，包括 markdown wrap、links、translation pairing 和 doc-typecheck。

首次 `doc-sync` 有 42/43 通过：repository-reference gate 拒绝新账本中的短 commit OID。账本改记录 `research` 分支和工作区状态，不保留 OID；随后重跑 43/43 通过。

`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过，生成 web profile 镜像：1,350 个 JavaScript entries、290 个 workspace packages、3,608 个镜像文件、64 条 unresolved requests。构建输出含预期的非当前平台 native package 警告和大 chunk 警告。

`node docs/drafts/browser-native-dsh-poc/generate-worker-dependency-report.mjs` 通过；再次输出到 `/tmp/worker-dependency-closure-report.json` 并用 `cmp` 核对，JSON 完全一致。报告含 4,252 条静态 request records：3,693 image module、450 implemented-builtin proxy、26 structural-stub proxy、19 external replacement、54 unresolved Node builtin 和 10 unresolved meta-resolve requests。counts 表示请求记录数，不是唯一模块数或运行次数。

`env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs` 通过。真实 DSH Worker/Host 执行 shell pipeline、Workspace redirection、文件回读和 unsupported command；Workspace 最终只有 `shell-redirect.txt`，本轮只有 redirection 产生一次 commit，页面没有跨源请求或 page error。

真实 LLM 命令：`env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` 通过。模型 `gpt-5.6-sol` 在 turn 1 恰执行 `read → write → read`；刷新后同一 Session 的第 3 turn 再读文件成功。Session 有 59 events，durable watermark 为 58；8 个模型请求均返回 200，LLM route 仅访问同源 backend。测试输出还记录刷新时取消的旧请求、未实现 PoC UI routes 的 404 和 compaction capacity warning；这些未使该 E2E 断言失败，但不应描述成无错误的全栈运行。

尚未运行：全仓测试、Safari/WebKit、逐模块/逐导出 Node API conformance、静态 unresolved 分支的全量执行覆盖、自然 eviction、OS crash 和生产 backend。

## 已知限制

`moduleRequests` 是 packer roots 上可识别请求的保守闭包，不是 profile boot trace 或运行时执行覆盖。根包含 materialized workspace packages 的全部非通配符 runtime exports；`implemented`/`mock` 是代理源目录分类，不代表 Node API 成员完整。`undici` 的 Node builtin 请求尚未解析，且 Browser profile 不暴露 `web_fetch`；若要启用相关路径，应先设计浏览器或同源 backend provider 并做实际 Chrome 调用验证。后续未覆盖项不得由此报告推定可用。
