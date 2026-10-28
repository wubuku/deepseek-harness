---
description: "规划标准 DSH 文件工具在 OPFS 外置工作区上的资源、载荷和恢复验收。"
---

# OPFS 外置工作区标准工具资源包络验证计划

## 目标

本批确定 Browser-Native DSH 文件工具对 OPFS 外置 Workspace 的可用规模和代价，重点核实标准 `read`、`grep`、`edit` 是否保持有界 Worker 驻留、Session/模型载荷、取消和提交语义。此前 external edit 已进入标准 DSH `edit`；本批不重做接线，而是验证 64 MiB 文件和多文件冷工作集，并纠正与当前源码不一致的旧容量说明。

## 候选范围

| 候选验证面 | 产品风险 | 本批处理 |
|---|---|---|
| 单文件到 64 MiB 的标准 `read`、`grep`、`edit`、提交和刷新恢复 | 文件工具可能暗中整文件驻留或超过 Session/API 限制 | 纳入；区分搜索 32 MiB 扫描上限和编辑 64 MiB 文件上限 |
| 多文件冷 hydrate、同内容 blob 复用、编辑单文件后保留其他路径 | 多路径工作集可能重复驻留或破坏未编辑文件 | 纳入；4 个 16 MiB 路径组成 64 MiB 工作集 |
| Worker 实际 JS heap、VFS `residentBytes`、OPFS bytes、Chunk I/O 和阶段耗时 | VFS 统计可能被误读为浏览器峰值内存 | 纳入；分开报告观测值，不定义 SLA |
| 搜索/编辑取消与 OPFS 临时文件清理 | 慢任务可能阻塞 Worker 或留下半成品 | 纳入 focused 回归；复用现有工具取消与 chunk editor 故障测试 |
| 大文件 edit 的上传字节数和 unchanged-chunk 复用 | O(chunk) 内存可能被误认为 O(delta) 网络流量 | 纳入；明确测量完整新 blob 上传，不实现 chunk-level delta |
| 大文件提交 unknown、Session receipt 和刷新恢复 | 扩大工作负载可能暴露重试重复副作用 | 纳入一个 64 MiB edit 的 commit-response-loss 场景；同 operation 查询结算 |
| 自然 eviction、OS crash、多实例 backend、生产对象存储 | 需要平台或生产基础设施 | 不模拟成等价证据，保留为未验证项 |
| 默认 profile 的真实 LLM 文件闭环与时延 | scripted 工具序列不代表模型可用性或感知流式 | 纳入普通文件 smoke；统一采集请求、DSH stream、Session 和 DOM 时间点，不要求模型处理 64 MiB 内容 |
| 任意 Node `fs`/Shell/LSP 插件兼容 | 插件生态准入范围未知 | 不属于本批文件资源包络，另行设计兼容矩阵 |

## 交付面

### M1：可区分的资源观测

Chrome E2E 记录 Worker JS heap（若 Chromium CDP 能稳定连接 Dedicated Worker）、VFS `logicalBytes` 与 `residentBytes`、OPFS 使用量、quota estimate、编辑 copy-on-write 指标、上传/下载 body bytes、Workspace revision 和每阶段耗时。若 Worker heap 无法可靠采样，明确记为 unavailable，不用主线程 heap 或 `residentBytes` 代替。

### M2：标准工具容量矩阵

用真实 Chrome、Dedicated Worker、DSH Host 和 scripted tool selection 执行 64 MiB 单文件 `read → edit → read`，另执行 4 个 16 MiB 文件的冷 hydrate、多文件 manifest 校验和单路径编辑；在 16 MiB 搜索样本上运行标准 `grep`。检查工具结果、Session append 和模型请求均不含整文件内容，编辑期间 VFS 驻留不随文件长度线性增长，OPFS/Workspace 内容 hash 在刷新后一致。

`grep` 的 32 MiB 扫描总预算、编辑的 64 MiB 文件预检上限及其失败语义要分别测试；不得把“支持 64 MiB edit”描述为“64 MiB grep”。

### M3：I/O 放大与 unknown commit 恢复

统计标准 `edit` 为定位、源 hash、copy-on-write、结果 hash 与上传实际读取/写入的字节数。预期内存缓冲有界，但文件级 content-addressed blob 仍需上传整个新文件。让 64 MiB edit 的 backend commit 成功后丢弃响应并重启 backend；刷新后沿同一 operationId 查询 settlement，断言 Workspace revision 只增加一次、Session 只有一条 tool call 和 receipt，原工具不重放。

### M4：真实 LLM 时间线与文档纠正

使用默认 Browser profile 和真实模型完成普通大小文件读写 smoke，记录 LLM 请求开始/首个响应字节、DSH assistant stream 首 chunk、Session append/flush、页面首个可见文本和 turn settlement。时钟来自同一 E2E runner，并说明计时点，不从不同日志时钟相减推断 UI 延迟。更新 README、旧 OPFS 工具进度、测试记录和 change ledger 中与当前标准 external edit 不一致的描述。

## 通过条件

- 64 MiB edit 在真实 Chrome Worker 中成功，编辑期间 `residentBytes` 相对冷态不随文件长度线性增长；copy-on-write 受控 buffer 和 Workspace upload body 上界均有直接记录。
- 4×16 MiB 工作集冷 hydrate 后各文件保持外置；编辑一个路径不改变另外三个路径的 hash、内容或 manifest entry。
- `read`、`grep`、`edit` 都通过正常 DSH `tools/execute` 和 Session `tool/call`/`tool/result`；模型请求和 Session 不包含重复大文件内容。
- 64 MiB commit 响应丢失并重启后，同一个 operationId 最终只产生一个 revision 和一条 receipt，不重放原始 edit。
- 真实 LLM smoke 只有在模型、Chrome、同源 proxy 和 Session 断言全部满足时才记为通过；上游失败保留原始失败状态，不由 scripted E2E 替代。
- 每个资源数值注明观测层、浏览器版本、样本和限制；不把单机结果写成 SLA、自然 eviction 或 crash consistency 证明。

## 非目标

本批不修改 DSH Agent Loop、Session 格式或正式 VFS API，不引入完整 Node/Linux 文件系统，不实现 chunk-level delta、无限容量搜索、页面关闭后的后台执行或生产对象存储。浏览器 Worker heap 采样只作为本机测量，不改变存储语义。

## 预期验证命令

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
DSH_POC_BROWSER=chrome DSH_POC_OPFS_ENVELOPE_SCENARIO=12m \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_OPFS_ENVELOPE_SCENARIO=64m \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_OPFS_ENVELOPE_SCENARIO=workset \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 \
  node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=original \
  DSH_POC_ENV_FILE=docs/drafts/.env \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
pnpm run test:docs
```

实际运行命令、未执行项和偏差由配套[进度记录](opfs-standard-tool-envelope-validation-progress.md)维护。
