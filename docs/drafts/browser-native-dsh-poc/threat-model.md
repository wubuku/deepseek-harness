---
description: "以“客户端执行、服务端权威”为模型，列出 Browser-Native DSH 试点的信任边界、资产、威胁、现有控制、逐项证据与仍未闭环的风险。"
---

# 威胁模型：客户端执行、服务端权威

## Summary

页面与 Dedicated Worker 是不可信执行面：它们运行 Host、Agent Loop、工具与本地 OPFS 副本，可被页面内 XSS、恶意扩展、被篡改的构建或同机其它进程控制。backend 是唯一权威：Session 日志、owner token/epoch、principal、provider 凭据、usage 账本、egress 授权与审计都在服务端进程内。任何安全判定都不能依赖 Worker 自报，服务端拒绝必须发生在副作用之前。

[worker-isolation-and-security.md](worker-isolation-and-security.md) 已证明 Worker 没有 `document`、`window`、页面 cookie 与 provider 环境变量，但不能把它当作网络或凭据边界；[server-delivery-boundaries.md](server-delivery-boundaries.md) 已把 Session、预算、egress 与 durable host 定为服务端交付物。本页把这些事实合成一份威胁清单，并明确三项仍未闭环的边界：预览页内 XSS、同机进程互认证、预览页与 API 同源。

## 信任边界

```text
不可信：浏览器执行面                     权威：backend 进程（单实例）
┌────────────────────────────┐          ┌────────────────────────────────────┐
│ 预览页（同源 HTML/JS）      │ 同源 HTTP │ Session 存储、owner token/epoch     │
│  ├─ UI 组件（React 转义）   │─────────▶│ principal cookie 签发与校验         │
│  ├─ Dedicated Worker        │          │ provider key（仅内存/.env）         │
│  │   ├─ Agent Loop/工具策略 │          │ usage 账本、预算判定               │
│  │   ├─ OPFS 本地副本       │          │ egress capability、审计 journal    │
│  │   └─ IndexedDB（不受管） │          │ durable turn host                  │
│  └─ 模型/工具输出（不可信） │          └────────────────────────────────────┘
└────────────────────────────┘                     │
         ▲                                         ▼
   同机其它进程 / 恶意扩展                   上游模型与外部服务
```

边界内不受信任的输入包括：模型输出、工具参数与结果、Workspace 文件内容、附件、页面 URL 查询串、任何请求体。边界外的攻击者能力包括：在预览页注入脚本、运行同机进程、安装浏览器扩展、诱导模型执行工具、控制上游模型响应。

## 资产与不可接受损失

| 资产 | 不可接受的损失 | 权威所在 |
| --- | --- | --- |
| provider 凭据 | 出现在任何 HTTP 响应、日志、Session、Worker 或导出包中 | backend 进程 |
| Session 日志与事件 | 跨 principal 读取、旧 owner 写入、被客户端伪造 seq | backend `dataDir` |
| Workspace 与附件 | 跨 principal 读取；路径逃逸到宿主机 | backend 校验 + 浏览器本地副本 |
| principal 身份 | 任意页面自封为其它 principal；审计泄露原始 cookie | backend cookie 签发 |
| usage 与预算 | 被篡改的客户端少报用量或绕过 fetch 前阻断 | backend 账本（判定仍在 Worker） |
| egress 授权 | 白名单外 host/path/method 被调用；凭据被转发 | backend capability |
| 审计 journal | 客户端可删除；重启后无法区分无请求与记录丢失 | backend 文件 |

## “客户端执行、服务端权威”的判定表

| 判定 | 客户端可做 | 服务端必须做 | 现状 |
| --- | --- | --- | --- |
| 我是谁 | 读取 backend 下发的 cookie | 签发 principal cookie、按 principal 过滤每个资源 | 已实现，[principal 隔离](principal-scoped-session-isolation-progress.md) |
| 能否写 Session | 提议 append | 校验 owner token/epoch、seq 与 `durableThroughSeq` | 已实现，[durable host 重启](durable-host-restart.md) |
| 能否读 Session | 请求读取 | 按 principal 404 化拒绝 | 已实现 |
| 能否发上游请求 | Worker 直接调用同源 `/llm` | 持 key、代理上游、解析 usage | key 仅在服务端；预算判定在 Worker（见 T7） |
| 花费多少 | 上报 meter | 独立解析 provider usage 并记账 | 记账已实现；判定未迁移（见 T7） |
| 能否调用工具 | 在 Worker 内执行 | durable host 复核 `write` 审批 | 常规 turn 策略在 Worker（见 T6） |
| 能否访问外部服务 | 提议 egress 请求 | capability 白名单、限流、脱敏、不跟随重定向 | 已实现，[凭据隔离](credential-isolation-proxy.md) |
| 写什么审计 | 不能写 | append-only journal、重启恢复 | 已实现，[可观测性](observability.md#持久记录与重启对账) |

## 威胁清单

| ID | 威胁 | 前提与攻击面 | 现有控制 | 证据 | 残余风险 |
| --- | --- | --- | --- | --- | --- |
| T1 | 恶意站点跨源读取 API 或发起 CSRF | 用户在其它站点打开页面，向回环端口发请求 | Host 白名单、`Sec-Fetch-Site`/`Origin` 准入、principal cookie `SameSite=Strict` + `Path` 限定 | `tests/local-request-guard.test.mjs` | 本机端口扫描仍可发现服务（见 T4） |
| T2 | DNS rebinding 指向回环服务 | 攻击者域名解析到 `127.0.0.1` | 只接受回环 Host 与回环 Hostname | 同上 | 无 |
| T3 | 凭据经 URL 查询串进入日志 | 页面或工具把 key 拼进 query | 查询名匹配 token、secret、key 等敏感名时拒绝 | 同上 | 无 |
| T4 | 同机其它进程冒充浏览器 | 本机任意用户进程可访问回环端口；启动脚本默认端口 4185/4186 | 无进程互认证；identity 端点可自签 principal | 本页新增 `threat-model-invariants` 只证明凭据不回显 | **未闭环**：可消耗本机模型额度、运行工具；读不到其它 principal 的 Session |
| T5 | 预览页内 XSS 取得同源全部权限 | 同源预览页加载恶意脚本；模型输出进入 HTML 路径 | React 默认转义；Markdown 代码块只消费 shiki 生成的静态 span 树；HTML 文档在无 `allow-same-origin` 的 Blob iframe 内运行，写入文档首位带严格 CSP，静态模式额外经 DOMPurify 清理 | `apps/web/tests/document-preview.e2e.ts` 注入脚本断言 cookie、Web storage、OPFS 与同源 API 均被拒；`html-bootstrap` 单测断言 CSP 位置与指令 | **部分闭环**：预览内容已隔离；预览页自身仍与 API 同源，页面脚本仍持完整权限（由预览与 API 分离源关闭） |
| T6 | 提示注入让模型越过工具策略 | 工具结果或文件内容含指令 | 工具策略与 guard 在 Worker 内；durable host 对 `write` 要求页面审批；路径/大小限制 | [提示注入边界](prompt-injection-boundaries.md) | **部分未闭环**：被篡改的 Worker 可跳过常规 turn 的策略与审批 |
| T7 | 篡改客户端绕过预算 | 修改 Worker 中的 meter 或跳过 fetch 前判定 | backend 独立解析 usage 并记账；超限事件与账本可对账 | [token 预算](token-budget-metering.md) | **未闭环**：阻断发生在 Worker；服务端目前只记账不拒绝 |
| T8 | 伪造或重放 owner token | 旧标签页或用旧 token 写入 | 服务端 owner token/epoch、单调 epoch、seq 校验 | [重启 epoch 与租约](durable-host-restart.md) | 跨实例未验证（单实例范围） |
| T9 | 跨 principal 读写 Session/Workspace | 换 cookie 或猜 id | 每个资源按 principal 404；错误不区分存在性 | [principal 隔离](principal-scoped-session-isolation-progress.md) | 侧信道时序未测 |
| T10 | egress 绕过白名单或把 key 转发出去 | 工具直接 fetch 或滥用代理 | capability 的 origin/path/method 校验、不跟随重定向、响应脱敏、固定窗口限流 | `tests/credential-isolation.e2e.mjs` | Worker 自身仍可访问任意 CORS 站点；需部署方 CSP `connect-src` |
| T11 | provider key 经错误路径或配置端点回显 | 上游失败、debug 路由、导出包 | key 只在 backend；`/health` 与 `/config` 只暴露 provider/model；错误文案固定 | 本页 `threat-model-invariants` 2/2 | 日志文件若由进程外工具采集需再脱敏 |
| T12 | 客户端删除或篡改审计 | 页面调用私有路由或改本地副本 | journal 只由 backend 追加；客户端无写接口 | `observability-persistence` 3/3 | 同机同用户进程可改写 JSONL；未做签名/只追加卷 |
| T13 | durable host 在无页面时执行高权工具 | 关页后写工具继续运行 | 服务端以 principal 合成请求；`write` 需页面审批；未知工具显式失败 | `durable-host` / `durable-tool-attach` 测试 | 审批超时语义与取消窗口需继续补齐 |
| T14 | 导出包或证据包泄露敏感内容 | 用户下载 Session bundle、失败证据包 | 导出按 principal 校验；证据包不含 prompt、只保留最后 12 条精简事件 | `product-visibility`、`observability.test.mjs` | 导出内容本身是用户数据，无加密与访问审计保留期 |

## 已知未闭环项与关闭条件

| 项 | 风险等级 | 当前事实 | 关闭条件（需可判定证据） |
| --- | --- | --- | --- |
| 预览页内 XSS | 高 | HTML 预览内容已在无同源权限的 sandbox 与严格 CSP 下隔离，注入脚本读不到 cookie、OPFS 与同源 API；预览页自身仍与 API 同源，页面脚本仍持该 principal 的完整权限 | 预览页与 API 分离到不同 origin，或预览页只读且 API 要求不可伪造的 per-tab token；用注入脚本用例断言 API 拒绝 |
| 同机进程互认证 | 高 | 回环端口对同机任意进程开放，identity 端点自签 principal | 每次启动生成 0600 启动令牌，所有路由要求该令牌，且令牌不经 HTTP 暴露；用第二个进程无令牌请求断言 401 |
| 预览 origin 与 API 同源 | 中 | 静态预览与 `/api/browser-native/*` 共享 origin 与 cookie 作用域 | API 部署到独立 origin，cookie 限定到 API origin，CORS 仅放行预览 origin；用跨 origin 页面断言读不到 API |
| 工具策略/预算执行在客户端 | 高 | 常规 turn 的策略、审批与预算阻断在 Worker 内 | 服务端在发出上游请求前复核预算，并在工具执行前复核策略；用篡改客户端跳过判定的用例断言服务端拒绝 |
| 审计完整性 | 中 | JSONL 可被同机同用户进程改写，无签名 | 只追加卷、文件完整性签名或外部采集；用篡改文件后重启对账断言报告不一致 |

## 本轮新增验证

`tests/threat-model-invariants.test.mjs` 2/2：

```text
✔ the backend keeps the provider key out of every client-visible response (36.7ms)
✔ access audit stores a principal digest instead of the raw principal cookie (29.4ms)
ℹ pass 2  fail 0
```

| 断言 | 观测 |
| --- | --- |
| 凭据不回显 | real 模式下配置探测密钥后，`/health`、`/config` 与上游不可达时的 502 错误体都不含该密钥；`/health` 仍报告 `llmMode=real`，`/config` 只暴露 `provider=gpt` |
| 无 CORS | 三个响应都没有 `access-control-allow-origin`，且都带 `x-content-type-options: nosniff` |
| 审计脱敏 | 带 principal 的 404 拒绝写入一条审计，`principalDigest` 为 cookie 值的 SHA-256 前 16 位；响应体与审计 JSON 都不含原始 cookie |
| 响应类型 | 拒绝响应为 `application/json; charset=utf-8` |

## 预览内容隔离验证

`apps/web/tests/document-preview.e2e.ts` 在 Session workspace 写入带探测脚本的 `smoke.html`，以 Coding Tools 交互模式打开后观测：

```text
- Parent access: parent-blocked (SecurityError)
- Parent unchanged: true
- Cookie access: blocked:SecurityError
- Web storage: blocked:SecurityError
- OPFS: blocked:SecurityError
- Same-origin API: blocked:TypeError
- Policy blocks network, frames and forms: true
```

iframe 恰为 `sandbox="allow-scripts"`（无 `allow-same-origin`），写入文档首位带 CSP：`connect-src`、`frame-src`、`form-action`、`object-src`、`base-uri` 均为 `'none'`。同一用例的静态模式仍经 DOMPurify 清理并在无权限 sandbox 中运行。

既有证据复用：[Worker 隔离与安全](worker-isolation-and-security.md)（Chrome 156，三套响应头，`crossOriginAuthorizationHeaders=0`、CSP 使跨源请求数为 0）、[凭据隔离](credential-isolation-proxy.md)（Worker 无 key、白名单外拒绝、不跟随重定向）、[提示注入边界](prompt-injection-boundaries.md)（工具结果不能提升权限）、[principal 隔离](principal-scoped-session-isolation-progress.md)（跨 principal 一律 404）。

```sh
node docs/drafts/browser-native-dsh-poc/tests/threat-model-invariants.test.mjs
node docs/drafts/browser-native-dsh-poc/tests/local-request-guard.test.mjs
pnpm run test:web:built -- -t "opens text, isolated HTML"
```

## 非目标

- 不覆盖生产认证（OIDC/SSO）、多租户隔离、跨主机网络与多实例接管；这些在[服务端交付物](server-delivery-boundaries.md)中列为多实例前置条件。
- 不覆盖浏览器扩展自身的恶意行为；扩展与 XSS 等价，均视为已持有页面权限。
- 不覆盖宿主机被攻破后的文件读写；此时 `dataDir`、`.env` 与审计文件都已在攻击者权限内。
- 不改变当前单实例、Chromium 桌面的试点范围（见[浏览器支持矩阵](browser-support-matrix.md)）。
