---
description: "记录 Browser-Native Workspace 内容定义分块对照实验的实际实施、验证、决策和限制。"
---

# Browser-Native Workspace 内容定义分块验证进度

## 当前状态

状态：实验与 Chrome/真实 LLM 验收完成；满足进入独立服务端协议原型的门槛，不改变当前固定偏移上传协议。本批从与 `origin/research` 同步的 `research` 分支干净 checkout 开始，未使用隔离 worktree。Chrome 是验收目标，Safari 暂停。

## 里程碑

| 阶段 | 状态 | 结果 |
|---|---|---|
| M0：候选评估与测量设计 | 完成 | 计划覆盖 CDC 收益、块数/元数据、Chrome Worker 扫描与哈希成本，以及协议升级准入条件。 |
| M1：参数化 chunker 与属性测试 | 完成 | gear-based 原型以确定性、有界 OPFS range 读取生成连续块；6 项单测覆盖确定性、完整覆盖、最大块、短读、空文件、预取消和分段取消。 |
| M2：真实 Chrome Worker 成本对照 | 完成 | 最新 preview 上 18 个 OPFS workload 均通过，每个策略 3 次测量；保存[脱敏原始 JSON](content-defined-chunking-chrome-results.json)，页面无错误。 |
| M3：固定偏移恢复回归与决策 | 完成 | 64 MiB 固定偏移复用响应丢失、Worker 终止、backend 重启及刷新恢复通过；仅补传 1 MiB，revision 只提交一次。CDC 仅达成进入协议原型的门槛。 |
| M4：真实 LLM、文档与交付 | 完成 | 最终 preview 上 `original` roster 真实 Chrome smoke、目录登记与文档门禁通过；实现已提交并推送到 `origin/research`。 |

## 实测结果

在 16 MiB 结构化文本与确定性伪随机二进制的头部/中部 64 KiB 插入和删除共 8 个核心场景中，128 KiB 目标平均值配置均比 1 MiB 固定偏移少上传 86.3% 至 98.9%。这些数字是按当前 Workspace 来源 chunk hash 匹配后估算的目标上行，不是 HTTP 上传测量。

| 场景 | 固定偏移上行 | CDC 128 KiB 上行 | CDC 512 KiB 上行 |
|---|---:|---:|---:|
| 文本 16 MiB，中部插入 64 KiB | 8.06 MiB | 1.10 MiB | 8.06 MiB |
| 文本 16 MiB，中部删除 64 KiB | 7.94 MiB | 0.98 MiB | 7.94 MiB |
| 二进制 16 MiB，中部插入 64 KiB | 8.06 MiB | 0.27 MiB | 0.58 MiB |
| 二进制 16 MiB，中部删除 64 KiB | 7.94 MiB | 0.15 MiB | 0.45 MiB |
| 二进制 48 MiB，中部插入 64 KiB | 24.06 MiB | 0.26 MiB | 0.30 MiB |
| 重复模板 16 MiB，中部插入 64 KiB | 8.06 MiB | 3.06 MiB | 3.06 MiB |
| 文本 64 MiB，中部等长替换 4 KiB | 1.00 MiB | 0.76 MiB | 1.00 MiB |
| 重复模板 16 MiB，中部等长替换 4 KiB | 1.00 MiB | 1.00 MiB | 1.00 MiB |

每个场景的三个 target 准备样本以中位数汇总；源码与数据由固定种子生成。8/8 的核心移位场景通过计划的“上行减少至少 50%”门槛；等长修改没有任何内容类型超过固定偏移的两倍。64 MiB 样本中 512 KiB 配置生成 66 个 chunk、7,306 bytes descriptor JSON，满足不超过 512 个 chunk 和 256 KiB descriptor 的门槛。

## 成本与限制

16 MiB 二进制样本的 128 KiB chunk 平均值接近配置值：源 chunk mean 148 KiB、median 118 KiB、maximum 506 KiB；512 KiB 配置的 mean 为 357 KiB、median 298 KiB、maximum 1 MiB。相同配置在结构化文本上的分布明显偏大：16 MiB 源的 128 KiB 配置 mean 为 763 KiB、median/max 为 1 MiB；64 MiB 文本 mean 为 809 KiB。文本 512 KiB 配置约半数 chunk 达到 1 MiB 上限，64 MiB 等长修改没有节省上行。因此平均值是算法目标，不是输入无关的块长保证，不能把二进制结果外推到所有文件。

16 MiB CDC target 扫描与 hash 准备约需 0.137–0.200 秒，并读取约 32 MiB target bytes；建立来源索引另约 0.136–0.226 秒并读取约 32 MiB source bytes。64 MiB 文本的 CDC target 准备约需 0.643–0.684 秒，来源索引约 0.661–0.668 秒，来源与目标各读取约 128 MiB；页面帧探针最大间隔为 16.8 ms。固定偏移只 hash 每个文件一次，约读一遍文件。上述耗时来自一台桌面 Chrome，不是低端设备分布或 SLA。

实验在 Dedicated Worker 的临时 OPFS 文件上运行 chunker 和 SHA-256，但没有执行实际上传、服务端 chunk 验证、staging 写入、对象存储、manifest 更新、GC 或网络时延。浏览器测得的 hash 匹配仅估算潜在上行；服务端仍需独立验证来源授权、每块内容和完整文件 hash。当前 Worker 与 backend 上传协议未改变，生产文件仍按现有固定偏移路径同步。

## 版本、命令与结果

| 项目 | 实际记录 |
|---|---|
| 起始 revision | 本轮上一批已推送的 `research` 分支 HEAD；起始工作区干净。 |
| 分支 / worktree | `research`；`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness`；本批没有隔离 worktree。 |
| Node / pnpm | Node `v24.6.0`；pnpm `11.28.5`。 |
| Chrome | Headless Chrome `156.0.0.0`；用户代理和 18 个场景结果见原始 JSON。 |
| preview build | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过；有 native 非当前平台告警、tsdown 选项弃用及既有大 bundle 警告。 |
| chunker 单测 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-content-chunker.spec.ts` 6/6 通过；包含分段取消。 |
| 兼容性单测 | Workspace、durable store 与 chunker Vitest 40/40 通过；`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 56/56 通过。 |
| Chrome CDC E2E | `DSH_POC_BROWSER=chrome DSH_POC_RESULT_FILE=docs/drafts/browser-native-dsh-poc/content-defined-chunking-chrome-results.json node docs/drafts/browser-native-dsh-poc/tests/content-defined-chunking.e2e.mjs` 通过；18 场景、无页面错误。 |
| 固定偏移恢复回归 | 64 MiB reuse-response-loss E2E 通过；blob hash 完整、revision `2`、单一 edit call/receipt、1 MiB client upload、无外连或页面/Worker 错误。 |
| TypeScript | `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` 通过。 |
| 真实 LLM | 最终 Chrome/`original` roster smoke：3 个 completed turns，首轮 `read → write → read`，刷新后 Session token 与 durable Workspace 文件可读，60 个 Session events、`durableThroughSeq=59`、8/8 LLM HTTP 200；provider secret 未出现在浏览器流量中。 |
| 真实 LLM 噪声 | Worker 记录了 context window 小于 compaction headroom 的非致命 warning；preview 附属 `/open-in-app/apps`、`/api/changes.summary`、`/api/present.host` 返回 404。页面无未处理异常；刷新导致的 `ERR_ABORTED` 是预期卸载请求。 |
| 真实 LLM 失败尝试 | `browser` validation roster 的首次真实模型运行返回了 200，但模型未执行要求的文件工具，断言失败；工具 schema 断言已通过。改用曾验证的 `original` roster 后完成 smoke。 |
| 原始证据 | [`content-defined-chunking-chrome-results.json`](content-defined-chunking-chrome-results.json)；只含合成文件、算法指标、Chrome UA 和页面错误数组，不含 Session、API 请求或凭据。 |
| 文档验证 | `pnpm run test:docs` 21/21；`pnpm run doc-sync` 43/43；`pnpm run verify-md-wrap` 2212 文件通过；`pnpm run verify-md-links` 2175 文件通过。 |
| Repository lint | `pnpm run lint` 失败于未改动文件：`apps/web/src/browser-native-recovery.ts` 两项类型 lint、`packages/core/tools/tests/json-schema.spec.ts` 一项 lint；另有 `packages/experimental/client-ui-cot-translation/src/index.ts` 未使用 disable warning。 |

## 失败、阻塞与经验

- 第一次 Chrome E2E 在文本样本修正后仍运行旧 preview；该结果未计入证据。之后每次 Worker 改动都重建 preview，并以最终原始 JSON 作为当前结果。
- 第一次真实 LLM 冒烟选了 `browser` validation roster。LLM 请求和 schema 正常，但模型没有执行文件工具；这是模型行为不符合该 smoke 的要求，不是 roster 缺少 `read/write`。使用既有成功的 `original` roster 重跑后通过。
- 只测随机二进制会掩盖块长分布对内容类型的敏感性；追加块长 mean/median/max 后，结构化文本的高比例 1 MiB 上限块变得可见。后续评估必须同时报告上传字节、实际块长和本地扫描成本。
- 估算上行减少不代表 backend 复制、持久化对象数、请求数或 GC 成本减少。CDC 不能只通过改客户端分块参数进入生产协议。

## 决策与下一步

按本批门槛，进入独立的服务端/Worker 协议原型验证；不把 CDC 设为默认路径，也不改写当前 upload API。原型需冻结 chunker 名称、版本和参数，并将其绑定到稳定 `operationId`、Workspace principal、授权来源文件 hash/revision、目标完整 hash/size 和 `baseRevision`。服务端须校验每个新 chunk 与最终文件 hash，以 manifest CAS 发布有序 chunk 引用；重试通过状态查询处理 unknown，fencing、GC 对 pending chunk 的保护、range/read 和旧版协议拒绝也必须纳入故障矩阵。

下一阶段要比较“后端复制 chunk 到完整文件 staging”和“manifest 直接引用 immutable chunk 对象”两种成本，测量对象/文件数、写放大、来源索引建立与缓存、提交/读取/GC 延迟、响应丢失恢复及 Worker 重启。需另外优化或替换结构化文本上偏大的 chunk 分布；不得从本次 18 个固定合成样本推断通用 chunker 性能。

实现和测试已提交并推送到 `origin/research`；pre-commit staged lint、空白检查、vendor guard 和 pre-push 5 项增量类型检查均通过。工作区在推送后干净。

## Dev Note

本进度记录当前 checkout 的实验结果，不表示 CDC 已集成 Workspace uploader。实际操作命令、非通过运行、已知噪声和继续/停止结论均保留；构建告警与模型无关的算法证据不冒充真实模型或生产 backend 验收。
