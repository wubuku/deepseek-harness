---
description: "最小服务端 egress 代理与白名单原型：验证 Worker 内没有凭据、跨源目标、请求头与重定向都受控。"
---

# 凭据隔离与服务端代理原型

## Summary

[credential-isolation.e2e.mjs](tests/credential-isolation.e2e.mjs) 在真实 Chrome 156.0.8078.79 的 Dedicated Worker 中执行 [`egress-probe`](browser-native-isolation-probe.ts) 测试通道，页面的 CSP 为 `connect-src 'self' data:`，所有外部调用只能经过 PoC backend 新增的 `POST /api/browser-native/egress/fetch`。backend 用 [egress-proxy-v2.mjs](egress-proxy-v2.mjs) 维护部署侧白名单，在目标 origin 通过校验后才注入 `authorization`，并且拒绝浏览器自带的凭据头、拒绝非 http(s) scheme、不跟随重定向、对上游响应做密钥脱敏。

一次完整运行的结果：Worker realm 只有 `DSH_HOME`、`HOME` 两个环境变量，没有 `<API_KEY|SECRET|TOKEN|PASSWORD|AUTH>` 命中的键；白名单内的请求成功、上游收到注入的凭据且没有收到浏览器 principal cookie；白名单外目标返回 `EGRESS_HOST_NOT_ALLOWED` 且该服务收到 0 个请求；Worker 自带 `authorization` 返回 `EGRESS_FORBIDDEN_HEADER` 且白名单服务仍只收到 1 次 `/private/echo`；`file:` scheme 返回 `EGRESS_SCHEME_REJECTED`；302 重定向作为数据返回（未跟随），非白名单服务 0 个请求；上游故意回显凭据时响应体只出现 `[REDACTED]`、`set-cookie` 被剥离；Worker 直接 fetch 白名单 origin 被 CSP 拦截、上游收到 0 个请求；脚本 turn 仍正常完成（19 个 Session 事件），Session 事件、页面文本和探针输出都不包含凭据值。`failures` 为空，`pageErrors` 与 `nonLocalRequests` 为空。

## 结论

- **能闭环的部分**：密钥不进入 Worker realm 与页面；浏览器不能选择任意外部目标；浏览器不能自带凭据或借代理把凭据头换成自己的值；重定向不能把请求带出白名单；允许列表内的上游也无法通过响应把密钥回灌给浏览器；CSP 关闭了绕过代理的直连通道。
- **不能闭环的部分**：密钥仍存在于 backend 进程环境；白名单按 origin 而不是按路径/能力授权，因此白名单 origin 上的任意 GET/POST 路径都会获得同一凭据；没有 per-Session 配额、审计或凭据轮换；CSP 是页面级控制，不能约束同源 backend 自身被攻破；allowlist 是静态部署配置，不随用户授权动态收缩。
- 因此“浏览器不是凭据边界”这一结论保持不变：真正的信任边界是持有密钥的 backend 进程与它的白名单；本原型只是把这条边界做成可验证的最小实现。

## 原型设计

| 层 | 规则 | 拒绝码 / 结果 |
| --- | --- | --- |
| 目标 origin | 必须逐字匹配 `egress.allow[].origin`（scheme + host + port） | `EGRESS_HOST_NOT_ALLOWED`（403），请求不发出 |
| URL 形态 | 只接受 `http:` / `https:`，禁止 userinfo | `EGRESS_SCHEME_REJECTED` / `EGRESS_URL_CREDENTIALS_REJECTED` |
| 方法 | 只接受 `GET`、`POST`；`GET` 不得带 body | `EGRESS_METHOD_NOT_ALLOWED` |
| 请求头 | 拒绝 `authorization`、`cookie`、`host`、`origin`、`proxy-authorization` 等浏览器可伪造的敏感头 | `EGRESS_FORBIDDEN_HEADER`（400），请求不发出 |
| 凭据注入 | 只在 origin 通过后才由 backend 写入 `authorization`；客户端无法提供该值 | 上游收到的值等于部署配置值 |
| 重定向 | `redirect: 'manual'`，3xx 原样作为数据返回，不跟随 | 最近的非白名单目标保持 0 请求 |
| 响应头 | 剥离 `set-cookie`、`www-authenticate`、`proxy-authenticate`、连接相关头 | 上游 cookie 不进入浏览器 |
| 响应体 | 64 KiB 上限；把注入值替换为 `[REDACTED]` | 上游回显凭据时浏览器只能看到占位符 |

CSP `connect-src 'self' data:` 与代理是配套的：CSP 阻止 Worker 直接访问任何外部 origin，代理提供受控通道。缺少 CSP 时，Worker 内的通用 fetch 仍可绕开白名单直连；本轮 E2E 用 `directFetch.ok === false` 和上游 0 请求确认 CSP 生效。

## 合同测试

[backend-v2.test.mjs](tests/backend-v2.test.mjs) 新增两个用例：一个用真实本地 HTTP 上游验证注入、拒绝主机、拒绝头、拒绝 scheme、不跟随重定向、响应脱敏与 `set-cookie` 剥离；另一个确认未配置 `egress` 时该路由返回 404，不会隐式开放代理。整个文件 60/60 通过。

## 证据

```json
{"result":"passed","browser":"chrome","scope":"server-mediated-egress-and-credential-isolation",
 "workerRealm":{"processEnvKeys":["DSH_HOME","HOME"],"holdsCredential":false},
 "proxy":{"allowlisted":{"status":200,"credentialInjected":true,"upstreamAuthorizationPresent":true,"upstreamRequestCount":1},
  "blockedHost":{"status":403,"code":"EGRESS_HOST_NOT_ALLOWED","upstreamRequests":0},
  "injectedHeader":{"status":400,"code":"EGRESS_FORBIDDEN_HEADER"},
  "invalidScheme":{"status":400,"code":"EGRESS_SCHEME_REJECTED"},
  "redirect":{"proxyStatus":200,"targetStatus":302,"followed":false,"nonAllowlistedRequests":0},
  "echoedCredential":{"redacted":true,"secretInResponse":false,"setCookieStripped":true}},
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
- 白名单是静态部署配置，没有按用户/会话签发短期能力令牌，也没有请求级审计日志或速率限制。
- CSP 只在预览页面响应头中设置，不是 PoC 通用部署配置；`connect-src 'self'` 也意味着代理必须与页面同源，跨域 backend 需要额外设计。
- 没有覆盖 WebSocket、SSE 直连、Service Worker、嵌套 iframe 或浏览器扩展等其它外联路径。
- 没有验证 backend 进程被攻破或配置文件泄露时的后果；在这种前提下的隔离不是浏览器层能解决的。
