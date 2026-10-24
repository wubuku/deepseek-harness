---
description: "记录 Browser-Native DSH 局部存储丢失、Chrome 强杀、多进程 backend、大工具参数和 S3 兼容 blob adapter 验证进度。"
---

# Browser-Native DSH 故障边界与存储后端验证进度

## 当前状态

状态：M0–M7、文档更新和验证门禁已完成。最终提交与远端状态以 `research` 分支的 Git 历史为准。目标、验收条件和证据边界见[验证计划](mock-and-crash-boundary-validation-plan.md)。基线是合并 `dsh-v0.2.1-rc.2` 后的 `research` checkout；本轮使用主工作区，没有创建隔离 worktree。Chrome、backend 和 MinIO 测试只使用唯一临时 profile、临时 data directory、随机命名容器和 loopback 动态端口。

## 候选与状态

| 验证面 | 状态 | 当前证据 | 下一步 |
|---|---|---|---|
| OPFS blob / IndexedDB metadata 局部丢失 | `complete` | `workspace-partial-storage-loss.e2e.mjs` 真实 Chrome：只删 OPFS blob 时保留 retry metadata，刷新后 `local-corrupt`、远端 revision 仍为 0，恢复包列出缺失 hash；只删 IndexedDB 行时原实现曾把空远端 Workspace 报为 synced，修复后检测到孤儿 OPFS bytes、fail closed 并可按 hash 导出。 | metadata 丢失后 bytes 可导出，但原文件路径和 operation 关联不可恢复；状态报告 dirtyCount 为 0，错误状态与恢复包才表示仍需人工处理。 |
| Chrome 进程强杀与 profile 恢复 | `complete-with-limitation` | `chrome-process-crash-recovery.e2e.mjs` 使用 Chrome 155 和唯一 profile 强杀 7 个 Chrome 进程。该次运行重启后身份 cookie 未恢复，页面创建了新 Workspace；旧 IndexedDB retry 与 OPFS blob 仍在。测试桩重新注入旧 cookie 后，同一 `operationId` 只提交一次、revision 到 1、内容/hash 一致。 | 当前匿名 PoC 身份 cookie 丢失后不能自动关联旧 Workspace；测试桩注入不代表用户恢复能力。该实验不覆盖 OS/磁盘崩溃。 |
| 两个 backend 进程共享 `dataDir` | `unsafe-multi-instance-confirmed` | `workspace-backend-multi-instance-characterization.e2e.mjs` 使用两个独立 Node PID。两个 Session writer claim、相同 seq append 和 flush 都返回 200；两个 Workspace lease claim 与 `baseRevision: 0` commit 都返回 200。第三个 backend 冷启动后只恢复一条 Session event、一个 Workspace 文件和一个 operation receipt。 | 这是当前 PoC 的负面兼容证据，不实现分布式锁；共享 `dataDir` 多实例会丢更新，必须保持单 backend 部署。 |
| 大型真实 DSH `tool/call` 参数 | `complete-with-limit` | Chrome scripted E2E：768 KiB 参数成功写入并 commit；6/9 MiB 参数在 Browser LLM adapter 的 1 MiB 累计参数限制处形成 error turn，无 `tool/call`、`tool/result` 或 Workspace 副作用；同 Session turn 4 成功继续。 | Session `readBody()` 原有 8 MiB 限制并未提高。adapter 当前硬编码 1 MiB 上限会拒绝更大的合法工具参数；真实模型生成大型参数未验证。 |
| S3-compatible blob store 接入 | `complete-with-limit` | 真实 Chrome Worker + MinIO 上传 2,097,189 bytes、Range 读取、S3 outage 503、恢复 retry、注入 commit 前对象丢失后刷新重传、backend 重启后读回；manifest 最终 revision 为 3。 | 只验证 MinIO 与 PoC adapter。Session、manifest、identity、lease 和 operation ledger 仍在本地 JSON `dataDir`；真实云对象存储与多 backend 未验证。 |
| 自然 storage eviction / OS crash / 真实模型大参数 / 生产云存储 | `not-verified` | 定向删除、Chrome SIGKILL、scripted LLM 和 MinIO 只覆盖相邻的协议状态，不能证明这些真实平台行为。 | 保留为未验证项，不作等价宣称。 |

## 里程碑

| 里程碑 | 状态 | 命令/证据 | 结果与阻塞 |
|---|---|---|---|
| M0：分支、工作区和资源基线 | `complete` | `git status --short --branch`、`git worktree list --porcelain` | `research` 与 `origin/research` 一致，工作区干净，仅主 worktree。 |
| M1：现有覆盖与候选盘点 | `complete` | 阅读 Browser-Native PoC README、近期验证计划/进度、兼容矩阵、Workspace store/backend、运行时测试支持及现有 Chrome restart/large-file E2E | 排除重复的全量缓存清除、损坏数据、quota override、正常浏览器重启和 Workspace chunk 测试；发现局部两侧丢失、SIGKILL、真实多进程竞争和 Session/tool JSON 体积未覆盖。 |
| M2：计划与初始进度 | `complete` | 新增本计划与本进度文档 | S3 纳入最小 PoC-only blob adapter；明确不把 MinIO 结果扩写为生产对象存储。 |
| M3：局部存储丢失 | `complete` | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；`DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/workspace-partial-storage-loss.e2e.mjs` | Chrome 155 观察到 OPFS 缺失和 IndexedDB metadata 缺失两种状态；后者先发现误报 synced，PoC store 现改为孤儿 bytes 检测并生成恢复包。 |
| M4：Chrome 强杀恢复 | `complete-with-limitation` | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/chrome-process-crash-recovery.e2e.mjs` 输出 `limitation-observed-and-local-retry-restored`；强杀 7 个 Chrome PID 后原身份 cookie 缺失，OPFS/IndexedDB retry 保留，测试桩恢复 cookie 后原 operation 单次提交。 | 不能把测试桩重新注入 cookie 写成自动恢复；本机匿名身份仍是阻断点。 |
| M5：多进程 backend characterization | `unsafe-multi-instance-confirmed` | `node docs/drafts/browser-native-dsh-poc/tests/workspace-backend-multi-instance-characterization.e2e.mjs`：双进程请求均获接受，冷启动后 Session 只剩一条 event、Workspace 只剩 `backend-b.txt`，另一 operation receipt 丢失。 | 源码中的 mutex、owner lease 和 fencing 仅在每进程内有效；PoC 仅支持单 backend 实例。 |
| M6：大型工具参数 | `complete-with-limit` | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/large-tool-arguments.e2e.mjs`。Node `v24.6.0`、Chrome 155。 | 768 KiB `write` 完成；6/9 MiB 参数返回 `TOOL_ARGUMENT_TOO_LARGE`，未持久化 tool call 且无文件副作用；后续 turn id 4 成功；两次成功复跑各有 25–26 次 Session append，最大 body 均为 3,147,323 bytes。首轮探针曾把 6 MiB 参数写成约 25,167,427-byte append，超过 8 MiB backend 限制，导致反复 413 和 turn 卡住；本次 adapter 限制在参数超限前中止流。 |
| M7：MinIO blob adapter | `complete-with-limit` | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/workspace-s3-minio.e2e.mjs`。MinIO 镜像 `minio/minio:RELEASE.2023-03-20T20-16-18Z`，image id `sha256:fb4e814a3183f5f7b193377fccda08504f3d9284466d6f5a41c84cfd031637f7`。 | 2,097,189-byte staging file 以流上传并 Range 读取 1 MiB；MinIO outage 返回 503 且 revision 不前进；恢复后 revision 2。删除已完成上传对象后 commit 返回 409，刷新从 OPFS retry 重新上传并达 revision 3；backend 重启后读回通过。浏览器没有直连 MinIO，页面无错误。SDK 可选 request checksum 在该 MinIO 版本导致流式请求失败；设置 `requestChecksumCalculation: 'WHEN_REQUIRED'` 后通过，完整对象由应用层 SHA-256 流式校验。 |
| M8：文档与最终检查 | `complete` | `pnpm run test:docs` 21/21；`pnpm run doc-sync` 43/43；`pnpm run typecheck` 5/5；`pnpm exec tsc --noEmit -p apps/web/tsconfig.json`；backend-v2 17/17；Workspace Vitest 11/11；新建/修改的 `.mjs` 通过 `node --check`；`git diff --check` 通过；目录私有依赖 `npm ci --prefix docs/drafts/browser-native-dsh-poc` 成功，0 vulnerabilities。 | 首轮 `test:docs` 拒绝了草稿中的裸 commit hash；改用 release tag 描述基线后，21 项文档门禁全通过。最终代码、文档和测试随本批提交推送。 |

## 记录规则

- 每个里程碑完成后记录实际命令、Chrome/Node/MinIO 版本、观察到的状态和清理结果。
- 失败或发现不支持的行为照实保留；characterization 脚本成功复现错误语义不等于功能通过。
- 本批 Node `v24.6.0`、pnpm `11.28.5`；Chrome 155；MinIO image digest 见 M7。真实 Chrome E2E 使用外部 Playwright entry `/Users/yangjiefeng/node_modules/playwright/index.js`，不把 Playwright 加到根 workspace。
- Docker 测试容器在 E2E 退出时删除，MinIO 临时数据目录清理；`docker ps -a --filter name=dsh-browser-native-minio` 未发现遗留容器。
- MinIO 首轮流式 PutObject 使用 AWS SDK 默认可选 request checksum 时未完成上传。改为 `requestChecksumCalculation: 'WHEN_REQUIRED'` 后，MinIO 上传恢复；Workspace 仍通过 SHA-256 流式计算验证完整内容。
- 不保存 prompt、模型凭据、S3 secret 或文件正文；报告只记录大小、hash、工具名、状态码、revision、operationId 和去敏事件类型。
- 如果 S3 adapter 只能验证 blob API，文档不得把 manifest、CAS、lease、operation ledger 或 Session 描述为对象存储能力。
