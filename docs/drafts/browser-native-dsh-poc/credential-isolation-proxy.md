---
description: "最小服务端 egress 代理与白名单原型：验证 Worker 内没有凭据、跨源目标、请求头与重定向都受控。"
---

# 凭据隔离与服务端代理原型

## Summary

[credential-isolation.e2e.mjs](tests/credential-isolation.e2e.mjs) 在真实 Chrome 156.0.8078.79 的 Dedicated Worker 中执行 [`egress-probe`](browser-native-isolation-probe.ts) 测试通道，页面的 CSP 为 `connect-src 'self' data:`，所有外部调用只能经过 PoC backend 新增的 `POST /api/browser-native/egress/fetch`。backend 用 [egress-proxy-v2.mjs](egress-proxy-v2.mjs) 维护部署侧能力白名单：每条授权绑定 `capability`、`origin`、`pathPrefix`、允许方法与可选凭据，目标 origin、路径段边界与方法全部匹配后才注入 `authorization`，并在发出前执行 capability 级固定窗口限流；每次允许或拒绝都写入审计环形缓冲。代理拒绝浏览器自带的凭据头、拒绝非 http(s) scheme、不跟随重定向、对上游响应做密钥脱敏。

一次完整运行的结果：Worker realm 只有 `DSH_HOME`、`HOME` 两个环境变量，没有 `<API_KEY|SECRET|TOKEN|PASSWORD|AUTH>` 命中的键；白名单内的请求成功、上游收到注入的凭据且没有收到浏览器 principal cookie；白名单外目标返回 `EGRESS_HOST_NOT_ALLOWED` 且该服务收到 0 个请求；Worker 自带 `authorization` 返回 `EGRESS_FORBIDDEN_HEADER` 且白名单服务仍只收到 1 次 `/private/echo`；`file:` scheme 返回 `EGRESS_SCHEME_REJECTED`；302 重定向作为数据返回（未跟随），非白名单服务 0 个请求；上游故意回显凭据时响应体只出现 `[REDACTED]`、`set-cookie` 被剥离；Worker 直接 fetch 白名单 origin 被 CSP 拦截、上游收到 0 个请求；授权路径外的 `/admin/secret` 与只共享字符串前缀的 `/privatex/echo` 都以 `EGRESS_PATH_NOT_ALLOWED` 拒绝且上游各 0 请求；`POST /private/echo` 以 `EGRESS_METHOD_NOT_ALLOWED` 拒绝且该路径仍只有 1 次允许请求；`/limited/echo` 的 4 次连续请求返回 `[200, 200, 429, 429]`，上游只收到 2 次；13 次探针请求各产生 1 条审计记录，路径拒绝、方法拒绝与限流都能按 request id 追溯，审计不含 query、原始凭据或密钥；脚本 turn 仍正常完成（19 个 Session 事件），Session 事件、页面文本和探针输出都不包含凭据值。`failures` 为空，`pageErrors` 与 `nonLocalRequests` 为空。

## 结论

- **能闭环的部分**：密钥不进入 Worker realm 与页面；浏览器不能选择任意目标，origin 内的路径与方法也必须落在某个 capability 授权内；浏览器不能自带凭据或借代理把凭据头换成自己的值；重定向不能把请求带出白名单；允许列表内的上游也无法通过响应把密钥回灌给浏览器；CSP 关闭了绕过代理的直连通道；capability 级固定窗口限流能在发出前拦截超额请求；允许与拒绝都留下可按 request id 追溯的审计。
- **不能闭环的部分**：密钥仍存在于 backend 进程环境；审计默认只在 backend 内存环形缓冲（200 条），没有集中式持久审计；限流是单进程 capability 级窗口，不是 per-Session/per-用户配额，也没有凭据轮换；CSP 是页面级控制，不能约束同源 backend 自身被攻破；allowlist 是静态部署配置，不随用户授权动态收缩。
- 因此“浏览器不是凭据边界”这一结论保持不变：真正的信任边界是持有密钥的 backend 进程与它的能力白名单；本原型只是把这条边界做成可验证的最小实现。

## 原型设计

```js
egress: {
  allow: [{
    capability: 'upstream.private',       // 审计与限流键，必须唯一
    origin: 'http://127.0.0.1:PORT',
    pathPrefix: '/private',              // 按路径段边界匹配 /private 与 /private/...
    methods: ['GET'],                    // 默认 GET + POST
    credential: { header: 'authorization', value: API_KEY },
    rateLimit: { windowMs: 60_000, maxRequests: 2 }, // 可选，按 capability 共享
  }],
  audit: record => sink.write(record),   // 可选；默认只进内存环形缓冲
}
```

| 层 | 规则 | 拒绝码 / 结果 |
| --- | --- | --- |
| 能力授权 | 每个请求必须匹配一条 `capability` + `origin` + `pathPrefix` 授权；同 origin 可有多条授权，取最长匹配前缀 | `EGRESS_HOST_NOT_ALLOWED` / `EGRESS_PATH_NOT_ALLOWED`（403），请求不发出 |
| 路径边界 | `pathPrefix: '/private'` 匹配 `/private` 与 `/private/x`，不匹配 `/privatex` | `EGRESS_PATH_NOT_ALLOWED`（403），上游 0 请求 |
| URL 形态 | 只接受 `http:` / `https:`，禁止 userinfo | `EGRESS_SCHEME_REJECTED` / `EGRESS_URL_CREDENTIALS_REJECTED` |
| 方法 | 全局只接受 `GET`、`POST`；每条授权可再收窄；`GET` 不得带 body | `EGRESS_METHOD_NOT_ALLOWED`（405），上游 0 请求 |
| 请求头 | 拒绝 `authorization`、`cookie`、`host`、`origin`、`proxy-authorization` 等浏览器可伪造的敏感头 | `EGRESS_FORBIDDEN_HEADER`（400），请求不发出 |
| 凭据注入 | 只在能力授权通过后才由 backend 写入该授权的 `authorization`；客户端无法提供该值 | 上游收到的值等于部署配置值 |
| 限流 | 每条授权的固定窗口（默认无限制）；按 capability 共享计数，超限时不发上游 | `EGRESS_RATE_LIMITED`（429），正文与审计含 `retryAfterMs` |
| 审计 | 每次允许或拒绝写一条 `at`、`requestId`、`decision`、`capability`、`origin`、`path`、`method`、`code`、`status`、`durationMs`（允许时另有 `upstreamStatus`、`credentialInjected`、`truncated`）；不记 query、请求头或 body | 内存保留最近 200 条，可注入 sink |
| 重定向 | `redirect: 'manual'`，3xx 原样作为数据返回，不跟随 | 最近的非白名单目标保持 0 请求 |
| 响应头 | 剥离 `set-cookie`、`www-authenticate`、`proxy-authenticate`、连接相关头 | 上游 cookie 不进入浏览器 |
| 响应体 | 64 KiB 上限；把注入值替换为 `[REDACTED]` | 上游回显凭据时浏览器只能看到占位符 |

CSP `connect-src 'self' data:` 与代理是配套的：CSP 阻止 Worker 直接访问任何外部 origin，代理提供受控通道。缺少 CSP 时，Worker 内的通用 fetch 仍可绕开白名单直连；本轮 E2E 用 `directFetch.ok === false` 和上游 0 请求确认 CSP 生效。

## 合同测试

[backend-v2.test.mjs](tests/backend-v2.test.mjs) 新增三个用例：一个用真实本地 HTTP 上游验证注入、拒绝主机、拒绝头、拒绝 scheme、路径边界与方法拒绝、capability 限流、审计追溯、不跟随重定向、响应脱敏与 `set-cookie` 剥离；一个拒绝缺少 capability/pathPrefix、非 GET/POST 方法、重复 capability 或重复 origin+path 授权的配置；一个确认未配置 `egress` 时该路由返回 404，不会隐式开放代理。整个文件 64/64 通过。

本项未修改 `packages/`，因此不需要 `build:check`；E2E 前重建了 preview（Worker 与 probe 产物）。

## 证据

```json
{"result":"passed","browser":"chrome","scope":"server-mediated-egress-and-credential-isolation",
 "allowlist":["http://127.0.0.1:63039"],
 "secret":{"digest":"75dbf64b9744aa8d","length":42},
 "workerRealm":{"processEnvKeys":["DSH_HOME","HOME"],"holdsCredential":false},
 "proxy":{"allowlisted":{"status":200,"credentialInjected":true,"upstreamAuthorizationPresent":true,"upstreamRequestCount":1},
  "blockedHost":{"status":403,"code":"EGRESS_HOST_NOT_ALLOWED","upstreamRequests":0},
  "injectedHeader":{"status":400,"code":"EGRESS_FORBIDDEN_HEADER"},
  "invalidScheme":{"status":400,"code":"EGRESS_SCHEME_REJECTED"},
  "redirect":{"proxyStatus":200,"targetStatus":302,"followed":false,"nonAllowlistedRequests":0},
  "echoedCredential":{"redacted":true,"secretInResponse":false,"setCookieStripped":true},
  "pathPolicy":{"outside":{"status":403,"code":"EGRESS_PATH_NOT_ALLOWED","upstreamRequests":0},
    "boundary":{"status":403,"code":"EGRESS_PATH_NOT_ALLOWED","upstreamRequests":0}},
  "methodPolicy":{"status":405,"code":"EGRESS_METHOD_NOT_ALLOWED","upstreamEchoRequests":1},
  "rateLimit":{"statuses":[200,200,429,429],
    "codes":[null,null,"EGRESS_RATE_LIMITED","EGRESS_RATE_LIMITED"],"upstreamRequests":2},
  "audit":{"entries":13,"capability":"upstream.private","pathDeniedTraceable":true,
    "methodDeniedTraceable":true,"rateLimitTraceable":true,"secretInAudit":false,"queryRetained":false}},
 "csp":{"directFetchBlocked":true,"directUpstreamRequests":0},
 "loop":{"turn":"completed","sessionEvents":19,"secretInSession":false},
 "pageErrors":[],"nonLocalRequests":[],"failures":[]}
```

报告只输出凭据的长度和 SHA-256 前 16 位摘要，不打印原值。

复跑：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/credential-isolation.e2e.mjs
```

## 限制

- 上游是本地 Node HTTP 服务，不是真实模型 provider；本点验证的是通道与拒绝语义，不是真实 provider 的鉴权、配额或计费行为。
- 白名单是静态部署配置；能力授权不随用户或会话动态签发短期令牌。限流按 capability 单进程固定窗口，没有分布式计数、per-Session/per-用户配额或凭据轮换。
- 审计默认是 backend 内存里的 200 条环形缓冲，可选 sink 未接入持久化或集中审计；进程重启即丢失，跨实例不可追溯。
- CSP 只在预览页面响应头中设置，不是 PoC 通用部署配置；`connect-src 'self'` 也意味着代理必须与页面同源，跨域 backend 需要额外设计。
- 没有覆盖 WebSocket、SSE 直连、Service Worker、嵌套 iframe 或浏览器扩展等其它外联路径。
- 没有验证 backend 进程被攻破或配置文件泄露时的后果；在这种前提下的隔离不是浏览器层能解决的。
