---
description: "Browser-native DSH 托管模式的单命令启动、配置项、数据目录升级路径与冒烟验收。"
---

# 托管模式部署

## Summary

本文是 browser-native DSH 托管启动的 owner。`hosted/start-hosted.mjs` 一条命令完成 preview 产物检查、backend 启动和本地 token 打印；`hosted/check-data.mjs` 在升级前后只读核对数据目录；`hosted/Dockerfile`、`hosted/systemd/` 和 `hosted/nginx/` 给出容器镜像、systemd 单元与 TLS 反向代理三种交付形态；`hosted/verify-deployment.mjs` 在干净数据卷上逐形态启动、跑冒烟与升级核对。本地 token 门禁始终开启，hosted bearer token 只是在此基础上把已验证 JWT 映射到隔离 principal，不替代本地门禁。

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
| `DSH_POC_PUBLIC_ORIGIN` | 无 | TLS 反向代理终结 TLS 时对外服务的裸 origin（如 `https://dsh.example.com`）。设置后 backend 额外接受该 Host 与 Origin，`/preview-api-origin` 与 printed URL 使用它，且本地 auth cookie 带 `Secure`；带路径、查询、凭据的取值拒绝启动 |

`real` 模式的 provider 凭据沿用 backend 既有环境变量（OpenAI 兼容为 `OPENAI_NEXT_*`，Anthropic 兼容为 `ANTHROPIC_*`），不写入数据目录，也不进入响应。`scripted` 模式的健康检查与冒烟不需要任何外部凭据。

告警阈值在启动时校验：`DSH_POC_ALERT_BUDGET_USD` 缺少两个单价变量、webhook 不是 http(s)、失败率窗口或样本数非法，都会拒绝启动。事件默认写 stderr，配置 `DSH_POC_ALERT_WEBHOOK_URL` 时同时 POST；`GET /api/browser-native/observability/alerts` 返回阈值、失败窗口、活动告警与最近 32 次状态变化。

## 部署形态

三种形态共用同一个 `start-hosted.mjs` 与同一套数据目录语义，只改变进程守护与传输层。

### 容器镜像

```sh
docker build -f docs/drafts/browser-native-dsh-poc/hosted/Dockerfile -t browser-native-dsh:local .
docker run -d --name browser-native-dsh \
  -p 127.0.0.1:4185:4185 \
  -v browser-native-dsh-data:/data \
  -e DSH_POC_PUBLIC_ORIGIN=https://dsh.example.com \
  browser-native-dsh:local
```

构建阶段执行 `pnpm install --frozen-lockfile` 与 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；运行阶段的镜像只含 `apps/web/dist` 与 `docs/drafts/browser-native-dsh-poc`，backend 运行时不依赖 `node_modules`。容器以 uid 10001（`dsh`）运行，`/data` 是数据卷，默认 `DSH_POC_HOST=0.0.0.0`、`DSH_POC_PORT=4185`、`DSH_POC_BUILD=0`。健康检查请求 `/api/browser-native/health`，未带 token 的 401 同样说明进程存活。网络受限环境用 `--build-arg NODE_IMAGE=<镜像源>/library/node:24-bookworm-slim` 指定基础镜像。

端口映射下浏览器经 `http://127.0.0.1:<映射端口>` 访问时，`/preview-api-origin` 返回请求实际到达的 Host，而不是容器内的 `0.0.0.0`；对外域名部署仍应设置 `DSH_POC_PUBLIC_ORIGIN`。

### systemd 单元

`hosted/systemd/browser-native-dsh.service` 以 `dsh` 用户运行 `/opt/browser-native-dsh` 下的 `start-hosted.mjs`，`StateDirectory=browser-native-dsh` 创建 `/var/lib/browser-native-dsh`，`ProtectSystem=strict` 只放行该状态目录；`hosted/systemd/browser-native-dsh.env.example` 是对应的 `EnvironmentFile`。`DSH_POC_BUILD=0` 要求安装前已有 `apps/web/dist`。

```sh
sudo install -d /opt/browser-native-dsh /etc/browser-native-dsh
sudo install -m 0644 docs/drafts/browser-native-dsh-poc/hosted/systemd/browser-native-dsh.service /etc/systemd/system/
sudo install -m 0640 docs/drafts/browser-native-dsh-poc/hosted/systemd/browser-native-dsh.env.example /etc/browser-native-dsh/browser-native-dsh.env
sudo systemctl daemon-reload && sudo systemctl enable --now browser-native-dsh
```

`systemctl stop` 发出 `SIGTERM`，与单命令相同：释放数据目录锁并删除 `.browser-native-backend.lock`。

### TLS 反向代理

`hosted/nginx/browser-native-dsh.conf` 监听 443（80 重定向），转发 `Host $http_host`、`X-Forwarded-Proto` 与 `X-Forwarded-For`，关闭 `proxy_buffering` 以保留 Session 事件流，上传上限 68 MiB 覆盖 64 MiB 附件上限。backend 必须同时把 `DSH_POC_PUBLIC_ORIGIN` 设为同一 https origin：`assertLocalRequest` 只放行回环 Host 与该配置 Host，Origin 校验同样接受该 origin，handshake cookie 带 `Secure`。

```sh
DSH_POC_PUBLIC_ORIGIN=https://dsh.example.com DSH_POC_DATA_DIR=/srv/browser-native-dsh-data \
  node docs/drafts/browser-native-dsh-poc/hosted/start-hosted.mjs   # 或用上面的 systemd 单元
docker run -d --network dsh -p 443:443 \
  -v ./docs/drafts/browser-native-dsh-poc/hosted/nginx/browser-native-dsh.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/browser-native-dsh/tls:/etc/nginx/tls:ro nginx:alpine
```

nginx 的 upstream 写成 `backend:4185`；容器部署时给 backend 容器加网络别名 `backend`，或按其实际服务名改写该行，并把证书与私钥放进 `/etc/nginx/tls`。

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

## 部署形态验证

```sh
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/hosted/verify-deployment.mjs
```

`--forms container,tls,systemd` 选择形态，`--skip-build` 复用已构建镜像；`DSH_POC_NODE_IMAGE` 指定基础镜像源，`DSH_POC_NGINX_IMAGE` 指定 nginx 镜像。`container` 从仓库根构建镜像，在全新命名卷上以临时端口启动，断言 readiness 行、401/200、43 字符 base64url token、handshake 302 与非 Secure cookie、Chrome 同步 Workspace，`SIGTERM` 后退出码 0、lock 删除、`check-data --json` compatible，随后在同一卷上重启并再次通过 token 门禁。`tls` 用同一镜像经 nginx 自签证书暴露 `https://localhost:8443`，断言代理后 401/200、匹配 Origin 200、`Origin: https://evil.example` 403、handshake cookie 含 `Secure`、Chrome 以 https 同步 Workspace、停止后 lock 清理与 `check-data` compatible。`systemd` 在 Linux 容器内用 `systemd-analyze verify` 校验 shipped 单元（挂载仓库、单元与 env 文件）。

实测结果（2026-11-04，Docker 29.4.0，Chrome 156，macOS）：三形态 `3/3 forms passed`；容器与 TLS 各产生 1 个 Session、1 个 Workspace，`check-data` 判定 compatible。systemd 只完成单元语法校验：本机没有 systemd，单元的运行时行为（启动服务、journal、stop 清理）未验证。TLS 验证使用自签证书，未覆盖证书轮换、HSTS 与真实 DNS。

## 已验证与未验证

已验证：单命令启动、缺产物时的构建入口、本地 token 门禁、handshake cookie、durable Workspace 首次同步、干净数据目录下的升级核对、锁清理、告警阈值配置与状态回读；容器镜像的构建与运行（含同卷重启后继续服务）、nginx TLS 反代的 Host/Origin 准入与 Secure cookie、systemd 单元语法。

未验证：systemd 单元运行时（本机无 systemd）、进程崩溃后的自动重启策略、证书轮换与真实 DNS/HSTS、跨主机或多实例部署。多实例边界与前置条件见[服务端交付边界](server-delivery-boundaries.md)；纯浏览器零服务端依赖不成立，见[产品就绪度](product-readiness-go-no-go.md)。
