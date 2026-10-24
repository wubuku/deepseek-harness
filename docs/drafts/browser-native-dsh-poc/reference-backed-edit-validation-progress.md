---
description: "记录 Browser-Native DSH 外部引用编辑、range Workspace 上传、compact receipt 和刷新恢复的实际证据。"
---

# Browser-Native DSH 外部引用编辑验证进度

## 当前状态

状态：PoC 验证通过，正式 DSH `edit` 仍未接入。本批把上一批 PoC-local chunk editor 与 `MemoryVfs`、Workspace durable store 和刷新恢复接起来；结果证明了 external reference 的技术可行性，但没有把测试端口升级为正式工具协议。

| 交付面 | 状态 | 证据 | 限制 |
|---|---|---|---|
| VFS external reference mutation | `passed` | `MemoryVfs` 以 `write-reference` 发布 hash/bytes，range read 不 materialize，VFS 单测通过。 | 仍属于 experimental 类型，尚未成为正式 VFS/Session 兼容承诺；replacement 假设没有活动 descriptor。 |
| Workspace reference-aware local cache/upload | `passed` | Memory store 单测和真实 Chrome OPFS/IndexedDB 运行通过；commit JSON 没有 `content`，16 MiB 文件使用 1 MiB 上传块。 | 当前 backend 仍是 PoC `dataDir`，不是生产对象存储。 |
| Compact reference edit Worker action | `passed` | `reference-edit-probe` 返回 hash、bytes、替换摘要、operationId 和 receipt，不返回全文。 | 只面向 PoC test port，不是标准 `edit` 工具，也没有经过真实 Agent 自主工具选择。 |
| Chrome 刷新恢复 | `passed` | 真实 Chrome Worker/OPFS/IndexedDB 刷新后 external hydrate、分块 digest 和 range read 通过；resident bytes保持冷 hydrate 基线。 | 未验证自然 eviction、OS/断电崩溃或页面关闭后的后台运行。 |
| 失败、重试与 receipt | `passed` | 真实 Chrome 4 MiB 故障矩阵覆盖 copy-prefix、copy-suffix、replacement、truncate、hash、publish；源 hash不变且失败轮次无 commit，随后成功只增加一个 revision。 | 失败样本是 Worker/OPFS 注入，不是物理磁盘 crash；cloud 503/unknown 由既有故障矩阵覆盖。 |
| 真实 LLM 回归 | `passed` | 真实 Chrome + `gpt-5.6-sol` 运行时回归通过：8 个 LLM HTTP 200、59 个 Session events、普通文件 `read → write → read`、刷新恢复、可观察流式文本和两个 Workspace commit HTTP 200。 | 只证明普通文件真实模型闭环；不证明模型会自主选择 compact reference edit 或生成大型 external-reference tool args。 |

## 经验教训

上一批只证明了 copy-on-write 算法的 buffer 上界，不能证明 DSH 文件工具已经使用该算法。本批必须同时检查 VFS mutation、本地 snapshot、HTTP commit 和 Session/工具摘要，任何一层重新读取完整文件都要在结果中标出。

## 实际命令

已实际运行：`pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json`；`pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts --coverage=false`，VFS/Workspace 共 12 个测试通过；`node --check docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs`；`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；`DSH_POC_BROWSER=chrome DSH_POC_REFERENCE_EDIT_BYTES=4194304 node docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs` 和 `DSH_POC_BROWSER=chrome DSH_POC_REFERENCE_EDIT_BYTES=16777216 node docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs`，真实 Chrome 分别通过六个失败注入和 16 MiB 正常闭环、刷新恢复、无 page error；`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` 通过真实 LLM 回归，8 个 LLM HTTP 200、59 个 Session events、两个 Workspace commit HTTP 200。此前使用当前未监听的 `127.0.0.1:9981` 代理变量时得到两次 502；清除代理后直连通过。构建保留既有 unsupported native platform、tsdown deprecation 和大 chunk warning。

## 已知限制

外部引用 mutation 目前只验证没有活动 descriptor 的 PoC replacement；标准 Node `fs` 写入、append、hard link、watch、正式 `edit` 输出和 Session event schema仍未因本批自动获得 range语义。reference pending 与同一路径后续 dirty overwrite 的复杂 retry 交错尚未验证；实现会对当前 range hash 做校验并失败关闭。真实 OPFS 自然 eviction、浏览器进程崩溃、断电和生产多实例 backend仍不在本批范围内。

## Dev Note

本记录只描述当前 checkout 的实施证据。`passed` 只表示对应的 PoC 证据；`not-run`和`PoC-only`不能在总 README中改写成正式能力或真实模型通过。
