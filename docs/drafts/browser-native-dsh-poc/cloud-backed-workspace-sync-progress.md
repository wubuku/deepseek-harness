---
description: "记录 Browser-Native DSH 云端 Workspace 同步 PoC 的实现、真实 Chrome/LLM 验收、故障观察和未完成项。"
---

# 云端 Workspace 同步 PoC 进度

## Summary

本记录追踪[云端 Workspace 同步 PoC 规划](cloud-backed-workspace-sync-plan.md)的实际实施。PoC 证明 DSH Worker 可在浏览器本地执行文件工具，同时将已提交的 VFS Workspace 文件保存到共享 backend，并在 Worker 重建后恢复；它不证明生产级云存储、后台 Agent 或离线持久化。

## 当前状态

- 分支：`research`；本任务在主工作区进行，没有创建隔离 worktree。
- 本记录对应 `research` 分支主工作区的本轮实现；代码、测试和文档的提交状态以当前 Git checkpoint 为准。
- 本轮总体进度：约 92%；Worker/VFS seam、云端同步协议、文件变更矩阵、真实 Chrome 多轮验收、stale-writer 冲突、真实 OS backend 重启和小规模协议并发已完成；浏览器级压力基准及生产化存储/身份仍未完成。
- 浏览器范围：真实 Chrome；Safari.app 和 Playwright WebKit 暂停。
- DSH `ctx.agentLoop`、Cordis Host、文件工具和 VFS 仍在 Dedicated Worker；同源 Node backend 提供 Session/LLM API 与 Workspace 存储，没有为 Agent turn 启动 DSH Host 或操作系统子进程。

## 里程碑

| 批次 | 工作 | 状态 |
|---|---|---|
| 0 | 确认并扩展 Worker VFS 注入、启动前 hydrate 和状态回报 | 完成 |
| 1 | 实现 Workspace identity、manifest/blob、增量提交与 revision CAS | 完成 |
| 2 | 覆盖幂等重试、路径/身份隔离、stale revision 与本地文件保留 | 完成；Chrome 双标签闭环通过 |
| 3 | 真实 Chrome/LLM 多轮读写、Worker/页面恢复和密钥检查 | 完成 |
| 4 | OS 进程重启、并发负载、吞吐与同步流量基准 | 部分完成；OS 重启和 8 客户端协议并发通过，浏览器级压力基准未执行 |
| 5 | 文档索引、可复现命令、已知限制与手动验收指引 | 完成 |

## 实施结果

- `WorkerHostOptions` 增加可选 `vfs` 与 `prepareVfs`；Worker Host 在镜像、overlay 和基础目录 seed 后、模块加载与 Cordis boot 前恢复远端 Workspace。默认不传这些选项的既有 Worker Host 行为不变。
- PoC backend 按 HttpOnly、SameSite cookie 建立匿名 Workspace principal；manifest 使用单调 revision，文件 blob 按 SHA-256 内容寻址，提交使用 `baseRevision` CAS 和稳定 `operationId`，数据写入 PoC `dataDir` 并支持新 backend 应用实例重载。
- Worker adapter 只同步 `/dsh/home/workspace`，在 boot 前校验并 hydrate manifest/blob；后续 VFS mutation 经 debounce、按内容 hash 上传、提交 manifest，并向页面报告 loading、dirty、syncing、synced、error 和 conflict 状态。
- DSH `write` 使用私有 staging directory 执行原子写入。仅依靠 100ms debounce 曾将 `.tmpdir` 和临时文件提交为多余 revision；adapter 现在按 `dsh-fs-local` 的实际 staging 命名过滤该目录树，真实 Chrome 验收确认一次原子写入只生成一个 Workspace revision。
- 同一 Worker/Session 只共享一份 DSH 事实：Session 仍记录 prompt、tool call/result 和模型交互；Workspace manifest/blob 保存文件 bytes。Copilot/聊天 UI 状态不参与此 PoC。
- Workspace blob 上传现在绑定 Workspace 的上传授权记录；仅知道全局 SHA-256 hash 的其他 Workspace 不能把该 blob 引用进自己的 manifest。上传记录、revision、operation receipt 和 manifest 通过原子文件替换保存到 PoC `dataDir`。
- 同步器覆盖了 append、rename、remove、chmod、空文件、二进制 bytes、Unicode 路径、目录重建、上传失败重试、提交期间删除和 hydrate 清理；失败时保留本地 bytes，成功后才发布 `synced`。

## 验证结果

| 命令或验收 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts` | 11 项通过；覆盖 hydrate、hash 去重、operation ID 重试、CAS conflict、dirty 保留、原子写过滤、变更矩阵、竞态、失败重试和 manifest/blob 校验。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 14 项通过；覆盖 Workspace 持久化、CAS/幂等、identity 与 blob 上传授权隔离、无效路径、空/二进制/Unicode/rename/remove/chmod 和响应密钥隔离。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/workspace-durability.test.mjs` | 2 项通过；真实 OS backend 子进程 kill/restart 后 manifest/blob/幂等回放恢复；单 backend 服务 8 个并发 Workspace、24 次 commit，Agent 子进程数为 0。 |
| `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/tar.spec.ts packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts` | 24 项通过。 |
| `pnpm exec tsc -b packages/experimental/webworker-runtime/tsconfig.json` | 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；更新了 WebWorker runtime、Worker packer、Preview 与 VFS image。 |
| `pnpm run verify-client-ui-i18n` | 通过；938 个 Client UI source 文件使用 locale-owned copy。 |
| `node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/workspace-sync.e2e.mjs` | 2026-10-21 使用真实 Chrome `channel: chrome`、真实 LLM、四轮同一 DSH Session 通过；最终证据为 11 个 HTTP 200 LLM 请求、6 个真实 DSH 文件工具调用、无浏览器外网请求、无 backend 子进程调用。 |

最终真实 E2E 的保留数据目录为 `/tmp/dsh-browser-native-workspace-e2e-20261021-final3`，Session 为 `session-afcf595e-de0b-46ad-b306-1591e4abc194`，脱敏结果为 `workspace-sync-result.json`，截图为 `workspace-sync-final.png`。Chrome 版本为 `155.0.8059.85`，冷启动到 Workspace synced 约 2.37 秒，刷新恢复约 1.91 秒；Worker 创建计数为 3，Workspace 文件 bytes 为 30，上传 blob bytes 为 40。首轮真实 DSH `write`/`read` 将 14 字节内容提交为 revision 1；backend Workspace 应用实例重建并刷新页面后，新的 Worker 从云端恢复文件并由同一 Session 的 `read` 工具读取；第二标签提交 revision 2 后，第一标签旧 revision 写入显示 conflict，dirty 本地文件仍可由 DSH `read` 读回，云端未收录该冲突文件。

该验收同时确认身份 cookie 带 `HttpOnly`、`document.cookie` 不可见、模型密钥不在浏览器 API 请求中、浏览器没有访问非同源地址、backend 进程内未观察到 child-process API 调用、没有 page error。该浏览器脚本在同一 Node PID 内重建 backend 应用；真实 OS 进程 kill/restart 由独立的 `workspace-durability.test.mjs` 验收。

在 2026-10-21 的复验中还观察到三类不应被隐藏的问题：一次真实模型把长随机路径抄错；一次上游返回 HTTP 200 但没有文本或 tool call；一次模型未调用工具而直接声明无法访问。测试均按证据判失败。最终通过样本使用短稳定路径和明确工具指令；这改善了验收可重复性，但不等于上游模型/工具选择稳定性已被 DSH 解决。第一次最终验收还发现 DSH 写入前的安全读取会产生额外只读 tool call，断言已按“写入不得重复、每个恢复/冲突步骤必须有目标工具”修正，而不是把安全读取误报成副作用重复。

Chrome 页面还请求了两个 PoC backend 未实现的 UI API：`/open-in-app/apps` 与 `/plugins/events`，均返回 404；这两项不阻止聊天、Worker、Session 或 Workspace 测试，但相应宿主 UI 集成不在当前 backend 范围内。

## 复现与手动验收

如本机网络需要代理，可先设置：

```sh
export https_proxy=http://127.0.0.1:9981
export http_proxy=http://127.0.0.1:9981
export all_proxy=socks5://127.0.0.1:9981
```

构建并启动真实模型的 Browser-Native Preview：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --use-env-proxy docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4185 \
  --data-dir /tmp/dsh-browser-native-workspace-manual \
  --llm real \
  --env-file docs/drafts/.env
```

打开启动器输出的 `preview.html?browser-native=1&preview-fixture=none` 地址，选择 `/dsh/home/workspace/`，让 Agent 通过 DSH `write` 与 `read` 工具创建并验证文件；等同步提示显示 revision 后刷新页面，在同一 Session 要求 Agent 再次调用 `read`。不要把 Agent 最终文字当作持久化证明；应检查 Workspace 状态、Session tool call/result 和 backend manifest/blob。

运行自动化真实 Chrome 多轮、刷新恢复和双标签 stale-writer 冲突验收：

```sh
export DSH_POC_PLAYWRIGHT_MODULE="$(node --input-type=module -e 'process.stdout.write(import.meta.resolve("playwright"))')"
DSH_POC_LLM=real \
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_LLM_TIMEOUT_MS=180000 \
DSH_POC_TURN_TIMEOUT_MS=600000 \
DSH_POC_PORT=4198 \
DSH_POC_DATA_DIR=/tmp/dsh-browser-native-workspace-e2e \
DSH_POC_KEEP_DATA=1 \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/workspace-sync.e2e.mjs
```

## 未完成项与限制

- backend 持久化目前是共享 Node backend 的本地 `dataDir` 文件，不是对象存储或多区域云存储；principal 是匿名 HttpOnly cookie，不接 SaaS 登录、租户授权或生产密钥管理。
- 已提交内容可在 Worker 重建后恢复；内存 VFS 中尚未成功提交的变更不跨页面关闭保存，未实现 OPFS/IndexedDB 离线 outbox、块级差分、三方合并或自动冲突解决。
- 已执行真实 OS 进程 kill/restart 和 8 客户端协议级并发，但没有执行浏览器页面压力、容量上限、长时间运行、生产吞吐或灾备测试。
- 后端 Workspace revision 与 DSH Session event log 不是跨存储原子事务；文件先成功、Session flush 失败或反向情况都需要产品级恢复策略。
- 已执行的 8 客户端并发是协议级小规模测试，不是浏览器页面压力测试、吞吐基准或生产 SLA；没有测量多 Worker CPU、网络抖动、容量上限、长时间运行或多区域复制。
- 只验证一个 Browser-Native profile、一个 Worker 和文件工作流；不证明所有 DSH 插件、后台 Agent、完整 Node API 或生产并发上限适合浏览器。
- Safari/WebKit 按当前安排暂停；E2E 中的 Chrome 404 宿主 API 尚未接入；真实模型工具选择、空完成和上游超时的频率与原因没有统计。

## Dev Note

本文件记录已执行结果；设计假设和尚未完成的目标仍以[规划文档](cloud-backed-workspace-sync-plan.md)为准。提交与推送状态以 `research` 分支的 Git 记录为准。
