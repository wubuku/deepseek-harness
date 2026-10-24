---
description: "记录 Browser-Native DSH 能力预检、默认插件兼容性和受限 Shell 语义验证的实际实现、证据与限制。"
---

# Browser-Native DSH 能力预检与插件兼容性验证进度

## 当前状态

本批次已完成。PoC 现在有一份可执行的 capability manifest，Worker 在创建 Workspace 和 Worker Host 前检查默认插件及模型可见工具所需能力；缺少主机子进程等不支持能力时，预检会返回具体插件、能力和诊断文本。当前清单仍是 docs-owned 静态清单，不是对任意 Cordis profile 的动态扫描，也不是正式 package capability service。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0 候选范围与计划 | 已完成 | 选择能力声明、boot 前预检、默认 profile 回归和受限 Shell 语义；可写 chunk-backed VFS、资源调度、安全授权和跨 Worker 并发留到后续批次。 |
| M1 capability manifest | 已完成 | 集中描述 Worker VFS、结构化文件工具、受限 Shell、Session/LLM backend、问答、todo、工作目录及明确不支持的主机能力。 |
| M2 fail-closed preflight | 已完成 | Worker 收到 init frame 后、创建 Workspace/Host 前执行预检；单测覆盖正常 profile、缺失 host-subprocess 和重复/未知声明。 |
| M3 默认 profile Chrome 回归 | 已完成 | 真实 Chrome/Worker 执行受限 Shell 管道、重定向、重定向文件读取和不支持命令；检查 tool/result、Session 顺序、无跨源请求和无页面异常。 |
| M4 真实 LLM 回归 | 已完成 | 真实 `gpt-5.6-sol` Chrome 回归通过：8 个 HTTP 200、57 个 Session events、`read → write → read`、刷新后恢复和可观察流式响应；该轮使用独立 browser validation roster。 |
| M5 文档与门禁 | 已完成 | 本进度、README、兼容矩阵、docs/drafts 导读和 change ledger 已更新；Markdown、doc-sync、typecheck、preview build 和 focused tests 已通过。 |

## 实际验证

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 3 个测试文件、21/21 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 17/17 通过。 |
| `pnpm run typecheck` | 5/5 gate 通过。前端 package 没有独立 `typecheck` script，错误命令未作为证据使用。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留既有平台和 chunk size warning。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs` | 真实 Chrome 通过；工具 roster、Worker `bash`、管道、重定向、读回和不支持命令失败均进入 Session。0 page error、0 跨源请求。 |
| `DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 Chrome + 真实 `gpt-5.6-sol` 通过；8 个 LLM HTTP 200、57 个 Session events、刷新恢复和流式响应通过。日志只保留脱敏摘要。 |

## 已验证语义

- 预检把 `host-subprocess`、`native-addon`、`filesystem-watch` 和 `background-process` 标为不支持；它们不会因为 Node shim 或模块 import 成功而进入默认工具 roster。
- 默认 Browser profile 的受限 Shell 真实执行了 `printf | tr`、输出重定向和 `cat`；不存在的主机命令返回失败结果，不回退到宿主机进程。
- `tool/call`、Session checkpoint 和 `tool/result` 的顺序仍由 DSH Agent Loop 负责；manifest 只决定启动前的兼容性检查，不创建第二个 loop。

## 未完成边界

当前预检没有解析任意 `cordis.yml`、检查每个插件实际 import 图或验证每个默认插件的所有运行路径。Shell 本批未覆盖 stderr 专项、输出预算、超时和用户主动取消；`dynamic-module-loading` 和 `wasi-runtime` 保持未验证。可写 chunk-backed VFS、单次正则不可中断、自然 eviction、OS/磁盘 crash、生产对象存储、多实例 HA、Safari 和正式 capability seam 仍未完成。真实 LLM 回归没有证明模型会自主选择每一种 Browser fallback 工具，也没有覆盖大型 tool arguments。

## 经验教训

模块可加载、工具出现在模型 schema 和工具实际可执行是三个不同事实，必须分别记录。能力清单可以在 PoC 阶段阻止明显错误的 profile，但不能替代 package 级 Service Definition/Provider/Consumer 设计；正式产品需要从 profile 配置或插件声明生成同等可审计的预检输入。

## Dev Note

本文件只记录当前 checkout 的验证。默认 profile 的 scripted E2E 与独立 roster 的真实 LLM E2E 不合并成“所有插件均由真实模型验证”的结论。
