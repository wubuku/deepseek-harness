---
description: "Workspace 恢复一致性的实施、故障证据、真实模型与限制记录。"
---

# Workspace 恢复一致性验证进度

## 当前状态

实现与行为验收完成，文档门禁和交付收尾进行中。主工作区 research，起始与 origin/research 同步且干净，仅一个 worktree。见[计划](workspace-recovery-consistency-plan.md)。提交推送状态由 Git 和交付报告确认。

| 里程碑 | 状态 | 验收要求 |
|---|---|---|
| M0 候选与规划 | complete | 十二类候选，选择恢复版本、操作身份、用户恢复与真实运行时四个交付面 |
| M1 复现与恢复算法 | complete | 三项原实现回归先失败；新专项 24 项与相邻 45 项单测通过 |
| M2 查询与用户恢复 | complete | 请求摘要、响应身份、unknown 区分、保留/导出原数据；receipt 保存失败仍保留原 retry |
| M3 Chrome 故障矩阵 | complete | 四场景完整 Host；已提交不重复覆盖、删除不复活、冲突导出与查询恢复；两项既有 Session/Workspace 恢复通过 |
| M4 真实模型与交付 | complete | 真实 LLM、Chrome 服务、Web tsc、build:check、文档门禁和 focused lint 完成；提交与推送由 Git 收尾 |

## 源码核查

原实现先 hydrate 最新 manifest，再把 retry 与 pending 合成排序序列；operation 查询把 found=false 与异常都折为 undefined。当前实现先核对 baseline 和 operation 状态，再 hydrate；retry 与 pending 分层重放。服务端查询返回既有 requestDigest，客户端从保留的原变化计算 SHA-256，严格核对 Workspace、operationId、revision、paths 和 manifest digest 格式；不把 manifest digest 当操作请求摘要。

已提交 retry 只产生本地对账 receipt，不再覆盖文件；后续 pending 只能叠加其直接基线。没有后续 pending 时可读取更高远端 revision；本地 retry 退休后保存 snapshot 和 receipt，保存失败不发布 synced。查询失败与 malformed response 分别拒绝恢复，均保留原数据。

## 执行记录

| 命令或入口 | 实际结果 |
|---|---|
| Vitest workspace-recovery-consistency（修复前） | 3/3 按预期失败：删除文件复活、旧 pending 被允许叠加新 manifest、已提交旧 retry 覆盖新远端内容；日志 /tmp/dsh-recovery-before.log |
| Vitest workspace-recovery-consistency、durable-workspace、browser-native-workspace | 69/69：专项 24、相邻 26 和 19。包含 rename/subtree removal、回退、unknown、身份/摘要错误、receipt 保存失败与重复 boot 去重 |
| node --test tests/backend-v2.test.mjs | 56/56；operation 查询请求摘要与规范化原 changes 一致 |
| tests/workspace-recovery-consistency.e2e.mjs | Chrome 156.0.8078.48 四场景通过；真实 Worker/OPFS/IDB；没有模型请求；unexpected pageErrors=[]、externalRequests=[]、cleanupErrors=[] |
| tests/durable-workspace-conflict-retention.e2e.mjs | 通过；刷新前仅一次失败 commit，刷新后不再发 commit；冲突两方内容保留，通过页面下载取回本地 bytes |
| tests/agent-workspace-unknown-commit-recovery.e2e.mjs | 通过；backend 重启后一个 write call、一个 commit、一个 receipt，原调用保留 TOOL_OUTCOME_UNKNOWN |
| tests/agent-workspace-receipt-recovery.e2e.mjs | 通过；Session flush 响应丢失、Worker 与 backend 重启后 receipt 仍只有一条；模型请求前后 [1,1]、Workspace commit=1、outbox 清空 |
| tests/runtime-validation.e2e.mjs，real/original/durable/CDC/chunk/verified-download | 真实模型 gpt-5.6-sol，3 turns、8/8 HTTP 200、60 events、durableThroughSeq=59；read→write→read、多轮记忆、刷新与清 Workspace cache 后冷恢复，2 次 Workspace commit 200；pageErrors=[]、同源 proxy |
| pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview | 通过；最后一次代码重建后执行真实 LLM |
| pnpm exec tsc --noEmit -p apps/web/tsconfig.json | 通过 |
| pnpm run build:check | host/client aggregate 2/2 通过 |
| pnpm exec oxlint --no-ignore（页面、mirror、新恢复模块与新测试） | 通过；目录默认忽略不作为证据 |

Chrome 四场景：先失败的 write 与随后 delete 在刷新后仍保持删除，放开网络后按原 write、后续 delete 提交至 r2；旧 retry 遇到外部 r1 时 pre-boot conflict，metadata 和导出内容不变；已提交 r1 的响应丢失后，外部更新到 r2，刷新读 r2、零重复 commit；operation 查询 503 时停止启动并可导出，恢复查询后沿用原 operationId 提交并继续读取。

证据目录为 /var/folders/17/x4gfsdmj74355x331tbfjts80000gn/T/dsh-recovery-consistency-Ny1USy，含 results.json、两张错误状态截图、两份实际下载恢复包和 backend dataDir。故障包只有测试生成内容，未包含用户文件或凭据。最终真实模型证据保留于 /tmp/dsh-workspace-recovery.yz3Fv2/real.json、real.stderr.log、real-data；最终测试和交付位置见下节。

首次新测试夹具没有实现旧 blob chunk 响应，先修正夹具；保留的修复前日志是三个业务断言失败，不把夹具错误当负对照。既有 retry 单测缺少 operation 查询身份，改为显式 confirmed absent。原 conflict E2E 期待刷新后仍启动可读混合 VFS，当前改为停止启动并核对导出；该拒绝会产生一条预期 tunnel boot 503 pageerror。新矩阵也保留两条精确匹配的预期 boot error，不能称“零诊断”。

真实模型仍有既有 compaction headroom warning、preview API 404 和流结束/刷新 ERR_ABORTED；关键模型请求均 200，不把这些诊断隐藏为“全部网络零错误”。额外 standalone strict/exactOptional tsc 暴露导入的旧 PoC 类型问题（包括 mirror.flush 与 VfsMutationSink 的既有返回类型、旧 unknown narrowing、optional 字段）；新测试自身的 optional 字段错误已修正，但未把整个 PoC 声称为通过这项额外检查。

## 限制与下一步

没有 base manifest，不能证明离线三方合并；隔离和导出不等于自动解决冲突。恢复包继承既有 64 MiB 上限，不是任意大 Workspace 的完整救援方案。操作摘要沿用当前 backend 的规范化 JSON 与 localeCompare 排序，尚未证明跨 ICU/locale 的协议稳定性；正式产品需要版本化且与 locale 无关的规范化编码。operation 查询与 manifest 不是跨请求事务；遇到中途又有提交会保守拒绝或由后续 CAS 再拒绝，不能保证任意外部并发写入时的无缝重放。真实自然 eviction、OS crash、多 backend 和生产对象存储不在本批验证范围。

## 验收服务与交付

验收服务已启动：`http://127.0.0.1:52533/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&preview-fixture=none`；worktree 是 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness` 的 `research` 分支，PID `95325`，日志 `/tmp/dsh-workspace-recovery.yz3Fv2/acceptance-server.log`，数据 `/tmp/dsh-workspace-recovery.yz3Fv2/acceptance-data`，元数据 `/tmp/dsh-workspace-recovery.yz3Fv2/acceptance.json`，停止方式为 `kill -TERM 95325`。运行中 Chrome 156 页面显示 `synced/r0`，无 page error 或跨源请求；截图和检查记录在同一 artifact 目录。
