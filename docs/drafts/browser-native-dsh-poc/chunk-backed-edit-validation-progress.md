---
description: "记录 Browser-Native DSH 可写 chunk-backed 文件编辑原型、真实 Chrome 证据和正式接入限制。"
---

# Browser-Native DSH 可写分块编辑验证进度

## 当前状态

状态：PoC 原型和当前 checkout 的 Chrome/真实模型回归已通过。本批没有把原型接入正式 `MemoryVfs` mutation sink、Workspace mirror 或 Session event；因此只能确认浏览器存储层具备 bounded-memory copy-on-write 编辑的技术可行性，不能宣称正式 DSH `edit` 已经块级化。

| 交付面 | 状态 | 实际证据 | 限制 |
|---|---|---|---|
| UTF-8 marker 的跨 chunk 定位 | `passed` | `browser-native-chunk-editor.spec.ts` 通过跨边界、缺失、重复、取消和非法范围测试。 | 这是精确 UTF-8 字节匹配，不是完整编辑器语义或多文件事务。 |
| 有界 copy-on-write 替换 | `passed` | 原型支持缩短、等长和扩长替换；源文件只读，目标文件分块写入并在 hash 校验后返回结果。 | 当前目标文件仍是 PoC 临时文件，没有发布到远端 manifest。 |
| 真实 Chrome Worker/OPFS 资源证据 | `passed` | 64 MiB 文件、1 MiB chunk 的 Chrome E2E 成功；`maxWorkingBytes=1,048,620`，结果 hash 与独立复算一致。 | 该值是算法工作 buffer 预算，不是 Chrome 进程 RSS、heap 峰值或产品 SLA。 |
| 写入故障与源文件保护 | `passed` | `copy-prefix`、`copy-suffix`、`write-replacement`、`truncate`、`hash`、`publish` 六个注入点均返回失败，源 hash 前后一致。 | 注入故障不是 OS/磁盘崩溃，也没有验证浏览器自然 eviction。 |
| 当前真实 DSH `edit` 对照 | `passed` | 16 MiB 冷 OPFS 文件执行真实 DSH `read → grep → edit → read`；`residentBytes` 从 `34,493,823` 增至 `51,276,228`，刷新后回到 `34,493,823`。 | 该路径仍完整 materialize 文件；原型尚未接入 DSH 文件工具。 |
| 真实 LLM 回归 | `passed` | Chrome + `gpt-5.6-sol` 完成 `read → write → read`、刷新记忆和流式输出；59 个 Session events、两次 Workspace commit 均成功。 | 真实模型测试使用普通大小文件，不证明模型会自主选择或生成 64 MiB edit 参数。 |

本轮收尾修复了三个测试接缝问题：hash helper 现在拒绝短读；Worker probe 将 `oldText` 和 `newText` 限制为各自最多 256 KiB UTF-8；marker-fit 校验位于 OPFS handle 的 `try/finally` 生命周期内，非法请求也会关闭 handle 并删除临时目录。修复后重新运行 chunk editor 单测、Worker runtime 类型检查、Node 语法检查、diff 检查和真实 Chrome/OPFS 故障矩阵，结果仍通过。

## 实施内容

新增 [`browser-native-chunk-editor.ts`](browser-native-chunk-editor.ts)，定义了同步 chunk-backed 文件的最小读写接口、跨 chunk UTF-8 范围定位、copy-on-write 替换、增量 SHA-256、取消检查、故障注入和内存 fake。`createSyncAccessChunkBackedFile()` 只面向 Worker 中的 `FileSystemSyncAccessHandle`；页面不接触 OPFS handle，也不接收大文件内容。

新增 Worker 测试端口动作 `chunk-edit-probe`。它在 Worker 内生成 64 MiB 源文件，使用独立 OPFS 临时目录执行替换，返回 hash、字节数、读写计数和失败摘要；成功或失败后都会关闭并删除临时目录。该动作没有经过 DSH Agent Loop，不会写入 Session 或 Workspace manifest。

## 实际运行

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json
DSH_POC_BROWSER=chrome DSH_POC_CHUNK_EDIT_BYTES=67108864 \
  node docs/drafts/browser-native-dsh-poc/tests/chunk-backed-edit.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_OPFS_AGENT_FILE_BYTES=16777216 \
  DSH_POC_AGENT_TURN_TIMEOUT_MS=180000 \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 \
  DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

结果：chunk editor 单测 `6/6`；preview build、webworker runtime typecheck、E2E syntax check 和 `git diff --check` 通过；真实 Chrome chunk probe 通过成功样本和 6 个故障样本；16 MiB scripted DSH 对照通过；真实 `gpt-5.6-sol` Chrome 回归通过。浏览器页面和 Worker 均没有报错，真实模型请求只访问同源 backend。

## 关键发现

分块传输和可写分块编辑解决的是不同问题。当前 Workspace 已经可以把 64 MiB blob 分成 1 MiB HTTP/OPFS 块，但正式 DSH `edit` 仍通过 `MemoryVfs.readFileSync()` 和完整写入路径 materialize 文件。新的原型证明了可以在 Worker 内用固定大小 buffer 完成局部替换，但它没有解决 VFS mutation sink 如何表达 range mutation、Workspace 如何从 durable backing 分块 hash/upload、IndexedDB 如何恢复临时工作副本，以及 Session receipt 如何区分本地发布和云端提交。

原型在一次替换中先完整分块读取源文件计算 source hash，再复制前缀、写入 replacement、复制后缀，最后完整分块计算 result hash；它没有减少总字节读写，也不是 byte-level cloud delta。它证明的是内存上界和源文件保护，不是吞吐优化。

## 下一步与限制

正式接入前必须先定义新的 `range-write` 或外部文件引用 mutation，不能在现有要求完整 `VfsMutation.bytes` 的接口上偷偷调用 `readFileSync()`。Workspace durable snapshot 也必须能在 Worker 重建后找到未发布的本地工作副本；否则“编辑成功但刷新丢失”仍然可能发生。接入完成后才应继续验证多标签页大文件冲突、云端 operation receipt 和真实模型驱动的有界编辑。

本批未验证 Safari/WebKit、自然 storage eviction、OS/断电崩溃、生产对象存储、跨设备合并、CRDT、完整 Shell/WASI、零拷贝、进程 RSS、任意容量文件和真实 LLM 大型 tool arguments。Safari 按当前工作安排暂停。

## Dev Note

本记录描述当前 checkout 的 PoC 原型和实际命令。`chunk-edit-probe` 是 Worker 测试接口，不是产品 API；`scripted-tool-selection` 的大文件 DSH 对照不能写成真实模型自主选择。只有真实 LLM 命令输出的完整成功 JSON 才计入真实模型回归。
