---
description: "记录 Browser-Native DSH 可写 chunk-backed 文件编辑原型、真实 Chrome 证据和正式接入限制。"
---

# Browser-Native DSH 可写分块编辑验证进度

## 当前状态

状态：原型验证和当时的 Chrome/真实模型回归已通过。当前 checkout 已把同类 copy-on-write 路径接入 PoC 标准 `edit`、`MemoryVfs` 外部 backing、Workspace mirror 和 Session receipt；当前接入结果、资源数字和限制以[标准工具资源包络进度](opfs-standard-tool-envelope-validation-progress.md)为准。本记录保留原型边界，不代表已发布能力。

| 交付面 | 状态 | 实际证据 | 限制 |
|---|---|---|---|
| UTF-8 marker 的跨 chunk 定位 | `passed` | `browser-native-chunk-editor.spec.ts` 通过跨边界、缺失、重复、取消和非法范围测试。 | 这是精确 UTF-8 字节匹配，不是完整编辑器语义或多文件事务。 |
| 有界 copy-on-write 替换 | `passed` | 原型支持缩短、等长和扩长替换；源文件只读，目标文件分块写入并在 hash 校验后返回结果。 | 当前目标文件仍是 PoC 临时文件，没有发布到远端 manifest。 |
| 真实 Chrome Worker/OPFS 资源证据 | `passed` | 64 MiB 文件、1 MiB chunk 的 Chrome E2E 成功；`maxWorkingBytes=1,048,620`，结果 hash 与独立复算一致。 | 该值是算法工作 buffer 预算，不是 Chrome 进程 RSS、heap 峰值或产品 SLA。 |
| 写入故障与源文件保护 | `passed` | `copy-prefix`、`copy-suffix`、`write-replacement`、`truncate`、`hash`、`publish` 六个注入点均返回失败，源 hash 前后一致。 | 注入故障不是 OS/磁盘崩溃，也没有验证浏览器自然 eviction。 |
| 当前真实 DSH `edit` 对照 | `superseded` | 该行记录接入前的 16 MiB 完整 materialize 对照：`residentBytes` 从 `34,493,823` 增至 `51,276,228`，刷新后回到 `34,493,823`。 | 当前 checkout 已由标准工具接入 copy-on-write；请以[标准工具资源包络进度](opfs-standard-tool-envelope-validation-progress.md)中的 12/64 MiB 数据为准。 |
| 真实 LLM 回归 | `passed` | Chrome + `gpt-5.6-sol` 完成 `read → write → read`、刷新记忆和流式输出；59 个 Session events、两次 Workspace commit 均成功。 | 真实模型测试使用普通大小文件，不证明模型会自主选择或生成 64 MiB edit 参数。 |

本轮原型收尾修复了三个测试接缝问题：hash helper 现在拒绝短读；Worker probe 将 `oldText` 和 `newText` 限制为各自最多 256 KiB UTF-8；marker-fit 校验位于 OPFS handle 的 `try/finally` 生命周期内，非法请求也会关闭 handle 并删除临时目录。随后标准 `edit` 接入了相同的 copy-on-write 资源路径；接入后的真实 Chrome 证据不在本记录中重复维护。

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

分块传输和可写分块编辑解决的是不同问题。当前 Workspace 可以把 64 MiB blob 分成 1 MiB HTTP/OPFS 块，标准 `edit` 也能在 Worker 内用固定大小 buffer 完成 copy-on-write 并发布 external backing；但是 Workspace 仍上传完整的新 content-addressed blob。该路径没有实现块级 delta，也没有把浏览器本地 bytes、云端 manifest 和 Session receipt 变成跨存储原子事务。

原型在一次替换中先完整分块读取源文件计算 source hash，再复制前缀、写入 replacement、复制后缀，最后完整分块计算 result hash；它没有减少总字节读写，也不是 byte-level cloud delta。它证明的是内存上界和源文件保护，不是吞吐优化。

## 下一步与限制

继续产品化前仍必须明确 external backing mutation 的正式 API、未发布本地工作副本的恢复协议和云端 chunk/delta 数据模型。当前 PoC 已覆盖同一操作的 Session receipt、Workspace commit unknown 和刷新恢复，但不覆盖多标签页大文件合并、生产对象存储或真实模型驱动的大型 tool arguments。

本批未验证 Safari/WebKit、自然 storage eviction、OS/断电崩溃、生产对象存储、跨设备合并、CRDT、完整 Shell/WASI、零拷贝、进程 RSS、任意容量文件和真实 LLM 大型 tool arguments。Safari 按当前工作安排暂停。

## Dev Note

本记录描述当前 checkout 的 PoC 原型和实际命令。`chunk-edit-probe` 是 Worker 测试接口，不是产品 API；`scripted-tool-selection` 的大文件 DSH 对照不能写成真实模型自主选择。只有真实 LLM 命令输出的完整成功 JSON 才计入真实模型回归。
