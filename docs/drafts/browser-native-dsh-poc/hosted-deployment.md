---
description: "Browser-native DSH 托管模式的单命令启动、配置项、数据目录升级路径与冒烟验收。"
---

# 托管模式部署

## Summary

本文是 browser-native DSH 托管启动的 owner。`hosted/start-hosted.mjs` 一条命令完成 preview 产物检查、backend 启动和本地 token 打印；`hosted/check-data.mjs` 在升级前后只读核对数据目录。本地 token 门禁始终开启，hosted bearer token 只是在此基础上把已验证 JWT 映射到隔离 principal，不替代本地门禁。容器镜像、systemd 单元与反向代理不属于本次交付，见[服务端交付边界](server-delivery-boundaries.md)。

## 前置条件

- Node `^22.19 || >=24`，pnpm 11。
- 仓库根目录已执行 `pnpm install`。
- 首次启动会按 `DSH_POC_BUILD=auto` 执行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；产物已存在时跳过。
- 数据目录必须由单个 backend 进程独占；现有进程会持有 `.browser-native-backend.lock`。

## 单命令启动

```sh
DSH_POC_DATA_DIR=/srv/browser-native-dsh-data \
DSH_POC_HOST=0.0.0.0 \
DSH_POC_PORT=4185 \
node docs/drafts/browser-native-dsh-poc/hosted/start-hosted.mjs
```

启动成功输出以下事实：

```text
hosted: ready at http://0.0.0.0:4185
hosted: preview http://0.0.0.0:4185/auth/handshake?token=<token>&next=%2Fpreview.html%3F...
hosted: health http://0.0.0.0:4185/api/browser-native/health
hosted: data dir /srv/browser-native-dsh-data
hosted: local auth token /srv/browser-native-dsh-data/browser-native-auth-token
hosted: auth local-token
hosted: llm scripted; model browser-native-scripted
hosted: admission ≤8 concurrent turns, ≤16 mounted Sessions
```

运维者把 `preview` URL 交给使用者。该 URL 只用于首次 handshake：backend 校验一次性本地 token，返回 302 并设置 `HttpOnly; SameSite=Strict` cookie。`/api/browser-native/*` 没有该 cookie 或 `x-browser-native-auth` 头时返回 401，因此不能绕过 handshake 直接调用 API。`DSH_POC_PORT=0` 选择临时端口，便于脚本化 smoke。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_POC_HOST` | `127.0.0.1` | 监听地址；容器内通常设 `0.0.0.0` |
| `DSH_POC_PORT` | `4185` | 监听端口；`0` 为临时端口 |
| `DSH_POC_DATA_DIR` | `<repo>/browser-native-data` | Session、Workspace、附件、ledger 与本地 token 文件的根目录 |
| `DSH_POC_DIST_ROOT` | `<repo>/apps/web/dist` | 已构建的 Web preview |
| `DSH_POC_BUILD` | `auto` | `auto` 缺产物时构建，`1` 强制构建，`0` 缺产物即失败 |
| `DSH_POC_LLM` | `scripted` | `scripted` 不访问外部模型；`real` 读取 `DSH_POC_ENV_FILE` 或进程环境 |
| `DSH_POC_ENV_FILE` | 无 | backend-only dotenv；真实 provider 的凭据只在本进程内使用 |
| `DSH_POC_MODEL` | provider 配置 | 真实模式模型名覆盖 |
| `DSH_POC_LLM_TIMEOUT_MS` | `60000` | 上游模型请求超时 |
| `DSH_POC_OWNER_LEASE_MS` | `30000` | Session 写租约；同时作为挂载租约时长 |
| `DSH_POC_MAX_CONCURRENT_TURNS` | `8` | 同时运行的模型 turn 上限，超出排队 |
| `DSH_POC_MAX_MOUNTED_SESSIONS` | `16` | 已挂载 Session 上限 |
| `DSH_POC_WORKSPACE_CHUNK_OBJECTS` | `0` | 数据目录由 chunk-object 布局创建时必须设为 `1` |
| `DSH_POC_WORKSPACE_VERIFIED_DOWNLOADS` | `0` | 下载分块时重新校验；要求 chunk objects 为 `1` |
| `DSH_POC_INPUT_USD_PER_1M` / `DSH_POC_OUTPUT_USD_PER_1M` | 无 | 成本报表的每百万 token 单价；两项同时设置，见[租户成本报表](tenant-cost-report.md) |
| `DSH_POC_ALERT_FAILURE_RATIO` | 无 | 最近请求的失败占比阈值（0–1）；设置后启用失败率告警，见[可观测性](observability.md#阈值告警) |
| `DSH_POC_ALERT_FAILURE_MIN_SAMPLES` | `20` | 失败率判定的最少样本数 |
| `DSH_POC_ALERT_FAILURE_WINDOW` | `200` | 失败率窗口的最大请求数 |
| `DSH_POC_ALERT_QUEUE_BACKLOG` | 无 | 排队 turn 数阈值；达到即告警 |
| `DSH_POC_ALERT_BUDGET_USD` | 无 | 累计 provider 费用阈值；必须同时配置两个单价变量 |
| `DSH_POC_ALERT_WEBHOOK_URL` | 无 | 告警与恢复事件的 JSON POST 目标；不设置时只写 stderr |
| `DSH_POC_ALERT_INTERVAL_MS` | `15000` | 周期评估间隔 |
| `DSH_POC_HOSTED_ISSUER` / `..._AUDIENCE` / `..._SECRET` | 无 | 三项必须同时设置；HS256 共享密钥至少 32 字节；`sub` 映射为稳定 principal |
| `DSH_POC_HOSTED_CLOCK_TOLERANCE_SECONDS` | `30` | token 的 `exp`/`nbf` 容差 |
| `DSH_POC_STATE_AUTHORITY_ORIGIN` / `..._TOKEN` | 无 | 指向共享 Session/Workspace authority；token 32–200 字符 |

`real` 模式的 provider 凭据沿用 backend 既有环境变量（OpenAI 兼容为 `OPENAI_NEXT_*`，Anthropic 兼容为 `ANTHROPIC_*`），不写入数据目录，也不进入响应。`scripted` 模式的健康检查与冒烟不需要任何外部凭据。

告警阈值在启动时校验：`DSH_POC_ALERT_BUDGET_USD` 缺少两个单价变量、webhook 不是 http(s)、失败率窗口或样本数非法，都会拒绝启动。事件默认写 stderr，配置 `DSH_POC_ALERT_WEBHOOK_URL` 时同时 POST；`GET /api/browser-native/observability/alerts` 返回阈值、失败窗口、活动告警与最近 32 次状态变化。

## 升级路径

1. 向进程发送 `SIGTERM`，确认正常退出且 `.browser-native-backend.lock` 已删除。
2. 停止状态下备份数据目录：`tar -czf browser-native-dsh-data-$(date +%F).tar.gz -C /srv browser-native-dsh-data`。
3. 运行只读核对：

   ```sh
   node docs/drafts/browser-native-dsh-poc/hosted/check-data.mjs --data-dir /srv/browser-native-dsh-data
   ```

   输出逐项列出 Session 日志格式、Workspace 元数据与 identity 元数据版本、存储布局、backend lock 和 `verdict`。存在不支持版本或不可读文件时退出码为 1；数据目录不存在时为 2。工具不写、不迁移、不删除任何数据。

4. 当前构建只读取 Session format v4、Workspace metadata v1、identity metadata v1 与 cross-store ledger v1。低版本 Session 日志不会被就地迁移：backend 会保留文件并拒绝加载，直到兼容的构建读取。不要用新构建覆盖旧格式文件。
5. 目录存在 `workspace-v2/chunk-objects` 时，本次构建启动必须带 `DSH_POC_WORKSPACE_CHUNK_OBJECTS=1`，否则 `WorkspaceStore.load()` 会以 `CHUNK_STORE_REQUIRED` 失败。`check-data` 会打印 `required flags`。
6. 用新构建启动，执行下方冒烟。失败时回滚：恢复备份、用旧构建启动；不要在同一目录同时运行两个 backend。
7. 升级前后都不得删除 `sessions/`、`workspace-v2/`、`cross-store-operation-ledger.json` 等历史数据。

## 冒烟

```sh
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/hosted-deployment-smoke.e2e.mjs
```

`tests/hosted-deployment-smoke.e2e.mjs` 使用全新临时数据目录执行文档中的单命令，并断言：

- 健康检查带本地 token 返回 200（`scripted` 模式），不带 token 返回 401；
- handshake 带 token 返回 302、`Location` 指向 preview 并设置本地 auth cookie；
- `x-browser-native-identity-mode: existing` 在缺少 principal cookie 时返回 401，不暗中签发身份；
- 本地 token 文件存在且权限为 `0600`；
- 配置 `DSH_POC_ALERT_FAILURE_RATIO=0.5`、`..._MIN_SAMPLES=100`、`..._QUEUE_BACKLOG=6`、`..._BUDGET_USD=5` 后，readiness 输出列出阈值，`GET /observability/alerts` 回读 `enabled: true`、三个阈值与 `window.failures: 0`；
- Chrome 打开打印的 preview URL 后 Workspace 状态到达 `synced`，页面无异常，且数据目录中出现对应 Workspace 元数据；
- `SIGTERM` 后进程退出码为 0、lock 文件删除；
- `check-data --json` 退出码为 0 且 `compatible: true`、`lock.present: false`。

实测结果（2026-11-04，Chrome 156，macOS，临时数据目录）：脚本输出 `PASS`，one session、one workspace，`check-data` 判定 compatible。该冒烟复用了已构建的 `apps/web/dist`；自动构建分支要求先完成 `pnpm install`，与容器镜像构建阶段相同。

## 已验证与未验证

已验证：单命令启动、缺产物时的构建入口、本地 token 门禁、handshake cookie、durable Workspace 首次同步、干净数据目录下的升级核对、锁清理、告警阈值配置与状态回读。

未验证：容器镜像、systemd/进程守护、TLS 与反向代理、跨主机或多实例部署。多实例边界与前置条件见[服务端交付边界](server-delivery-boundaries.md)；纯浏览器零服务端依赖不成立，见[产品就绪度](product-readiness-go-no-go.md)。
