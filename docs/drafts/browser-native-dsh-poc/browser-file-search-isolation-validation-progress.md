---
description: "记录 Browser-Native DSH 文件搜索正则隔离、资源上限和 Chrome 验收进度。"
---

# Browser-Native 文件搜索隔离验证进度

## 当前状态

状态：实现和 Chrome 验证已完成。基线为本批开始时的 `research` 分支，主工作区没有隔离 worktree；本批修改尚未提交。目标与候选取舍见[验证计划](browser-file-search-isolation-validation-plan.md)。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：基线与候选审查 | `complete` | 已核对文件工具实现、Browser capability、既有 Chrome E2E 和兼容矩阵。grep 内容 regex、include regex 和 glob regex 均可在 Agent Worker 同步运行；grep 只在匹配后限制行长。批次据此纳入所有模型可控 pattern，而非只隔离内容 grep。 |
| M1：matcher Worker 协议与单测 | `complete` | 新增嵌套 module Worker；主 Worker 校验响应 id、匹配索引、超时、取消和消息错误，正则语法编译也只在子 Worker 执行。文件工具单测使用可注入 matcher 覆盖搜索语义和资源限制。 |
| M2：grep 资源上限与取消 | `complete` | 内容 grep、`include` 和 glob 路径匹配都经可终止 matcher Worker；每批最多 32 行/256 KiB/1 秒，单次搜索最多 30 秒、250,000 行、32 MiB 扫描字节和 10,000 个文件。任何超过 64 KiB 的行在匹配前拒绝，包括不匹配行。 |
| M3：真实 Chrome DSH 闭环 | `complete` | 真实 Chrome 中，长无匹配行、恶意内容正则、glob 正则和 `include` 正则均结算为明确错误；随后同一 DSH turn 的合法 grep/glob 成功。单独取消正在执行的 regex 后，Worker 继续可用。 |
| M4：回归、文档和交付 | `complete` | 真实 LLM 在 Chrome 中自主选择 `grep` 并找到普通文本；既有文件工具、取消和 12 MiB OPFS backing E2E 回归通过。README、兼容矩阵、drafts 索引和 change ledger 已更新；Safari/WebKit 不在本轮范围。 |

## 证据

| 验证 | 实际结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts` | 7/7 通过；覆盖正常匹配、无效正则、长行和总行数预算、取消、glob 结果上限、跨 chunk UTF-8 与二进制拒绝。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；Vite 产出独立嵌套 regex Worker。 |
| `pnpm run typecheck` | 通过，5/5 gates。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/browser-native-grep-isolation.e2e.mjs` | 通过；真实 DSH Host 结算长行与三个恶意 matcher 超时，随后 grep/glob 成功。没有新增 Workspace commit、页面/Worker 错误或跨源请求。 |
| `DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-grep-isolation.e2e.mjs` | 通过；真实模型自主选择 `grep` 并返回普通文件 marker。该结果不表示真实模型选择或执行恶意参数。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.e2e.mjs` | 通过；文件搜索错误闭环和 70 KiB 单行 chunk-backed `edit` 均成功，后者产生一次 Workspace commit。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools-cancel.e2e.mjs` | 通过；取消 helper 后真实 DSH turn 仍可继续。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs` | 通过；12 MiB 冷 hydrate 文件仍完成 DSH `read → grep → edit → read` 和刷新恢复。 |

## 限制

本轮验证了当前 Vite 构建、Chrome Worker 和本机 DSH Host 拓扑，但不证明其他打包器或浏览器部署的 CSP 配置允许嵌套 Worker。1 秒是单个 matcher 批次上限，30 秒是整次搜索的总时限，不是通用 Worker CPU quota；超时终止 matcher Worker，不中断 Agent Worker 本身。单行超过 64 KiB 会让搜索 fail closed，即使该行不匹配。真实 LLM 只覆盖普通 grep；Safari/WebKit、ripgrep 兼容、自然 eviction、OS crash、多实例 backend、生产对象存储和任意容量搜索未验证。
