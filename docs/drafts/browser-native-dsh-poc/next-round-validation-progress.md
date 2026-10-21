---
description: "记录 Browser-Native DSH 下一批 Chrome 验证的实际实现、测试结果、阻塞与已知限制。"
---

# Browser-Native DSH 下一批验证进度

## 当前状态

状态：P1-1、P1-2、P1-3 均已通过真实 Chrome。当前基线、详细验证范围和退出条件见[验证计划](next-round-validation-plan.md)。三项测试使用真实 Chrome、真实 Dedicated Worker/DSH Host 与 scripted LLM；没有调用真实模型。

| 验证点 | 状态 | 证据 | 未完成项 |
|---|---|---|---|
| 清除 OPFS/IndexedDB 后重建已提交 Workspace | `passed` | `durable-workspace-cache-reset.e2e.mjs`：本地 OPFS 与 IndexedDB 清除后，真实 Chrome Worker 从同一 backend revision 重建文件，commit 计数仍为 1 | 只覆盖云端已提交内容；本地唯一持有的 dirty bytes 不在本测试恢复范围 |
| DSH `edit` 与多文件变更的 Session receipt | `passed` | `agent-workspace-edit-receipt.e2e.mjs`：真实 DSH Loop 完成 `write → read → edit → write`，三次 mutation 分别关联唯一 receipt，revision 1–3 | 只覆盖 file tool `write`/`edit`，不覆盖并发工具执行 |
| 同标签页刷新后的 Workspace lease 恢复与 fencing | `passed` | `workspace-writer-reload.e2e.mjs`：模拟旧 sessionStorage 凭据缺少 `resumeId`，页面先持久化新幂等 ID；backend 已完成 resume 后丢弃第一次响应，重试沿用相同 ID 并返回同一 lease，fencing token 仅从 1 提升到 2；旧 token 的 renew/commit 和第二标签页 claim 均返回 409 | 不覆盖浏览器进程强制终止、租约过期后的恢复或多设备接管 |

## 实际验证

以下三项真实 Chrome E2E 均已执行通过：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview

export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js

node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-cache-reset.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-edit-receipt.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-reload.e2e.mjs
```

缓存清除重建结果：远端 revision 与 commit 数均为 `1`，文件 hash/内容匹配，测试清除并重建 OPFS 与 IndexedDB；没有页面错误或跨源请求。Agent 文件工具结果：真实 DSH Loop 执行 `write → read → edit → write`，三个 mutation 对应三个唯一 operation receipt，revision 为 `1–3`，只读调用未产生 commit；最终两个文件内容与 manifest 一致，Session reload 未重放副作用，本地 receipt outbox 清空。lease 刷新结果：真实 Chrome 先模拟旧 sessionStorage 凭据缺少 `resumeId`，页面生成并先保存幂等 ID；随后拦截并丢弃 backend 已执行的第一次 resume 响应，Worker 以同一 `resumeId` 重试并取得原 lease，fencing token 仅从 `1` 增至 `2`，另一个网络 `requestId` 只用于诊断；旧 token 的 renew/commit 和另一标签页 claim 均被拒绝，正常 release 后恢复凭据从 `sessionStorage` 清除。三项均无页面错误或非同源请求。

## 附加检查

| 命令 | 结果 |
|---|---|
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 15/15 通过，包括 resume 重放、旧 token fencing 与 release 后拒绝过期重放 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts` | 19/19 通过 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；输出含已有的 native platform、Vite 插件弃用和大 chunk 警告 |
| `pnpm run test:docs`、`pnpm run verify-md-wrap`、`pnpm run verify-md-links`、`pnpm run doc-typecheck` | 通过；doc quick 21 个 gate 全过，2,396 份 Markdown、2,375 个文档链接无错误，92 个文档代码块通过 typecheck |
| `git diff --check` | 通过 |

## 经验与限制

- 完全清除 OPFS/IndexedDB 只能验证已在 backend 提交的数据能否重建；本地唯一持有的 dirty bytes 无法从已删除的本地存储中恢复。
- lease 恢复必须由 backend 原子轮换 token/fencing epoch；仅把旧 token 持久化并复用会让仍运行的旧 Worker 与刷新后的 Worker 同时持有写权。
- 恢复凭据放在同标签页 `sessionStorage`，用于刷新恢复而不是跨标签页共享；backend 的 token rotation/fencing 才是旧写者失效的依据。它不是认证机制，正式系统仍须由服务端鉴权并约束 lease 所属用户与 Workspace。
- 刷新时遇到旧版凭据（尚无 `resumeId`）会先生成并写入稳定 ID，再向 Worker 发送恢复消息，避免首次请求和重试之间丢失幂等键。
- `resumeId` 是 lease resume 的幂等键，与诊断用 `requestId` 不同；backend 在当前进程中缓存最近一次 resume 结果，因此处理成功但响应丢失时可安全重试。PoC 不持久化 lease 凭据或 resume 缓存；backend 重启后旧 token 无效，客户端需清除旧凭据并重新 claim。
- 单次 scripted Agent turn 的文本渲染可能短于一个浏览器动画帧；本轮断言以 Session tool events、Workspace manifest/blob 和 receipt 为准，不把 UI 帧采样作为文件操作成功证据。
- 页面桥接源码变更后必须先重建 Preview bundle；只重建 Worker 测试镜像会让真实页面继续加载旧 page-control 代码。一次初始测试正是因漏掉该构建而未找到 `resumeId`，重建后完整 Chrome E2E 通过。
- 真实 Chrome quota exhaustion、浏览器自动 eviction 与 OS 级浏览器进程崩溃仍不在本轮证据范围。
- 本轮使用 PoC backend 的本地 `dataDir` 和 scripted LLM；不证明生产云对象存储、真实模型行为或生产多租户授权。
