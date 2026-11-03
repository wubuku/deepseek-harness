---
description: "验证 Browser-Native Dedicated Worker 内工具执行对网络、凭据与跨源数据的可达面，以及 CSP、COOP、COEP 下的行为，给出能力 seam 的最小证明与产品安全结论。"
---

# Worker 隔离与安全

## Summary

[worker-isolation-security.e2e.mjs](tests/worker-isolation-security.e2e.mjs) 在 Chrome 156.0.8078.79 中以同一份 preview 镜像启动三套响应头（baseline、`connect-src 'self' data:`、COOP `same-origin` + COEP `require-corp`），每套使用独立 backend、独立 `dataDir` 与独立 `BrowserContext`，探测 Worker realm 能触碰什么，再用 scripted `bash` turn 证明普通工具分派在三套响应头下都完成。

结论：Worker 与页面共享浏览器网络栈，但不是独立的授权主体。它没有 `document`、`window`、`localStorage`、`sessionStorage`、`CookieStore` 与 CommonJS `require`；`process` 是 polyfill，`process.env` 只有 `DSH_HOME` 与 `HOME`，没有 provider 凭据。网络可达面由浏览器同源策略与响应头决定：同源请求成功；无 CORS 的跨源响应不可读（`type: "opaque"` 或 `TypeError`）；Worker 从不附加 `Authorization`；DSH principal cookie 是 `HttpOnly; SameSite=Strict` 且 `Path` 限定在 `/api/browser-native/...`，探测中未出现在跨源端点。

CSP `connect-src` 在请求离开 Worker 之前就拦截跨源 fetch（服务端记录 0 次请求）；COEP `require-corp` 使页面进入 `crossOriginIsolated=true`，拦截缺 CORP 的 `no-cors` 加载，但不影响 `cors` 读取。三套响应头下 scripted 工具都正常执行。

产品结论：浏览器不能作为工具执行的网络与凭据边界。需要限制可达域名或隔离凭据时，必须由服务端常驻 host 持有凭据并代理调用，或至少由部署方下发 CSP `connect-src` 白名单；`IndexedDB` 在 Worker 内可用，工具代码可以写入 Workspace 与 Session 之外的数据，审计与回收不覆盖它。

## 能力 seam 的最小证明

| 能力面 | 观察到的事实 | 对能力 seam 的意义 |
| --- | --- | --- |
| 同源 HTTP | `GET /api/browser-native/health` 返回 200、body 含 `"ok":true` | Worker 复用页面 origin，可驱动既有 PoC API |
| 跨源 `cors` 读取 | 目标返回 `access-control-allow-origin: *` 时 `type:"cors"`、body 可读（`cors-ok`） | 任意愿意开放 CORS 的站点都可被工具读取 |
| 跨源无 CORS | `type:"opaque"`，body 为空，`response.text()` 抛 `TypeError` | 不能读取未授权跨源内容，但请求本身已发出 |
| 跨源带凭据 | `credentials:'include'` 仍 `TypeError`；服务端未收到 principal cookie | 跨源读取不因携带凭据而放宽 |
| `Authorization` | 所有跨源记录均为 `null`，含 turn 后探测 | 工具执行不会自动附加 bearer token |
| provider 凭据 | `processEnvKeys` 仅 `["DSH_HOME","HOME"]`，无 `DEEPSEEK`/`OPENAI`/`API_KEY`/`SECRET`/`TOKEN` | 模型凭据不在 Worker 进程环境里 |
| DOM 与页面存储 | `hasDocument=false`、`hasWindow=false`、`hasLocalStorage=false`、`hasSessionStorage=false`、`hasCookieStore=false` | 工具不能直接读页面 DOM、cookie store 或前端状态 |
| `IndexedDB` | `hasIndexedDB=true` | 工具代码可持久化任意数据，绕过 Workspace manifest 与 Session 日志 |
| CommonJS | `hasRequire=false` | 不能 `require('fs')`、`child_process` 或原生模块 |

## 响应头行为

| 响应头 | `crossOriginIsolated` | 跨源 `cors` 读取 | 无 CORP 的 `no-cors` 加载 | 同源请求 | Worker 工具 turn |
| --- | --- | --- | --- | --- | --- |
| 无（baseline） | false | 成功（`cors-ok`） | 成功（opaque，body 为空） | 200 | 成功 |
| `content-security-policy: connect-src 'self' data:` | false | `TypeError`，服务端记录 0 次 | `TypeError`，服务端记录 0 次 | 200 | 成功 |
| COOP `same-origin` + COEP `require-corp` | true | 成功（`cors-ok`） | `TypeError`（缺 CORP） | 200 | 成功 |

`data:` 必须留在 bootstrap 的 `connect-src` 中：preview 以 `data:application/gzip;base64,…` 内联 profile overlay，缺 `data:` 时 Host 启动阶段就 `Failed to fetch`。COEP 的 CORP 要求只作用于 `no-cors` 加载；带 ACAO 的 CORS 读取不受 CORP 限制。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| Worker 能否作为工具的网络边界 | 不能 | 无 CORS 的跨源请求仍会发出；有 CORS 的跨源响应可读；只有部署侧 CSP 才能阻止请求离开 Worker。 |
| Worker 能否作为凭据边界 | 不能作为唯一边界 | provider 环境变量与 `Authorization` 不在 Worker 内，但同源请求携带页面已登录的 principal cookie；工具可驱动任意同源 API。 |
| 是否依赖 CSP `connect-src` 限制工具出口 | 是，部署方可选 | 探测证明它在 Worker 内生效且不破坏工具 turn；不配置时默认可达任意 CORS 站点。 |
| COOP/COEP 是否应默认开启 | PoC 不默认开启，生产按需 | `require-corp` 会拦截缺 CORP 的第三方 `no-cors` 资源；本次未观察到它对 DSH 工具链路有副作用，但会改变嵌入资源与第三方依赖的加载行为。 |
| 工具产生的非 Workspace 持久化是否被审计 | 否 | `IndexedDB` 在 Worker 内可用，现有 GC/Session 审计只覆盖 Workspace 与附件，不覆盖任意工具写入的 IDB。 |
| 是否因此需要服务端常驻 host | 需要，当产品要求网络白名单或凭据隔离时 | 只有服务端持有 provider 凭据并代理出口时，浏览器才不是凭据与出口策略的执行者。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [browser-native-isolation-probe.ts](browser-native-isolation-probe.ts) | Worker 侧探测：realm 事实、同源/跨源/opaque/带凭据/CORP 差分 fetch。 |
| [browser-native-worker.ts](browser-native-worker.ts) | Workspace test port 新增 `isolation-probe` action 与其请求校验。 |
| [backend-v2.mjs](backend-v2.mjs) | `createBrowserNativeV2Server({ responseHeaders })`：校验后为每个响应设置安全头；新增 scripted 规则 `BROWSER_NATIVE_ISOLATION_TOOL_E2E` 发出 `bash` 工具调用。 |
| [tests/worker-isolation-security.e2e.mjs](tests/worker-isolation-security.e2e.mjs) | 三场景 harness + 独立 cross-origin Node server，记录 path/cookie/authorization/`sec-fetch-mode`。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增 Worker 隔离与安全行。 |

探测只挂在 `browser-native-test=workspace-recovery` 的 test port 上；`responseHeaders` 是 PoC backend 选项，不改变正式 DSH profile、Session 格式或 Agent Loop。

## 证据

```sh
node docs/drafts/browser-native-dsh-poc/tests/worker-isolation-security.e2e.mjs
```

Chrome 156.0.8078.79 输出（三场景逐项，节选）：

```json
{"result":"passed","browser":"156.0.8078.79","scope":"worker-isolation-and-response-headers",
 "scenarios":[
  {"scenario":"baseline","headers":{},"realm":{"crossOriginIsolated":false,"hasDocument":false,
   "hasWindow":false,"hasProcess":true,"hasLocalStorage":false,"hasSessionStorage":false,
   "hasCookieStore":false,"hasIndexedDB":true,"hasRequire":false,"processEnvKeys":["DSH_HOME","HOME"]},
   "sameOrigin":{"ok":true,"status":200},"cors":{"ok":true,"type":"cors","body":"cors-ok"},
   "noCors":{"ok":true,"type":"opaque","body":""},"cookie":{"ok":false,"error":"TypeError: Failed to fetch"},
   "corp":{"ok":true,"body":""},"noCorp":{"ok":true,"body":"no-corp-ok"},
   "crossOriginRequests":6,"crossOriginAuthorizationHeaders":0,"credentialedRequests":1,
   "postTurnCookie":{"forwarded":false},"toolTurn":{"toolText":"BROWSER_NATIVE_ISOLATION_TOOL_OK\n"}},
  {"scenario":"csp","headers":{"content-security-policy":"connect-src 'self' data:"},
   "realm":{"crossOriginIsolated":false},"sameOrigin":{"ok":true,"status":200},
   "cors":{"ok":false,"error":"TypeError: Failed to fetch"},
   "noCors":{"ok":false,"error":"TypeError: Failed to fetch"},
   "crossOriginRequests":0,"crossOriginAuthorizationHeaders":0,"credentialedRequests":0,
   "postTurnCookie":{"forwarded":false},"toolTurn":{"toolText":"BROWSER_NATIVE_ISOLATION_TOOL_OK\n"}},
  {"scenario":"coep","headers":{"cross-origin-opener-policy":"same-origin",
   "cross-origin-embedder-policy":"require-corp"},"realm":{"crossOriginIsolated":true},
   "cors":{"ok":true,"type":"cors","body":"cors-ok"},"noCors":{"ok":false,"error":"TypeError: Failed to fetch"},
   "corp":{"ok":true,"body":""},"noCorp":{"ok":true,"body":"no-corp-ok"},
   "crossOriginRequests":6,"crossOriginAuthorizationHeaders":0,"credentialedRequests":1,
   "postTurnCookie":{"forwarded":false},"toolTurn":{"toolText":"BROWSER_NATIVE_ISOLATION_TOOL_OK\n"}}],
 "verdict":{"workerRealmLacksDocumentAndCookieAccess":true,"workerHoldsProviderCredentials":false,
  "crossOriginResponseReadableWithoutCorsOptIn":false,"sessionCookieForwardedToCrossOriginPorts":false,
  "crossOriginAuthorizationHeaders":0,"cspStopsCrossOriginRequestsBeforeTheyLeave":true,
  "coepBlocksNoCorsLoadsWithoutCorp":true,"coepLeavesCorsReadsUnaffected":true,
  "toolDispatchSurvivesResponseHeaders":true}}
```

- realm：三场景一致，`hasDocument=false`、`hasWindow=false`、`hasLocalStorage=false`、`hasSessionStorage=false`、`hasCookieStore=false`、`hasRequire=false`、`hasIndexedDB=true`、`processEnvKeys=["DSH_HOME","HOME"]`。
- baseline：`cors` 可读、`noCors` 为 opaque、`noCorp` 可读、`corp` 为 opaque；6 次跨源请求，0 个 `Authorization`，principal cookie 未出现在 `/cookie`。
- csp：跨源请求数为 0，说明请求没有离开 Worker；同源 health 仍为 200，工具 turn 完成。
- coep：`crossOriginIsolated=true`；带 CORP 的 `no-cors` 加载成功，缺 CORP 的 `no-cors` 失败，CORS 读取不受影响。
- turn 后再次探测：`postTurnCookie.forwarded=false`，`crossOriginAuthorizationHeaders=0`。

## 限制

cross-origin 服务与 preview 同为 `127.0.0.1`、仅端口不同，因此这次未覆盖真正跨站（不同 registrable domain）的 cookie 与 SameSite 行为；principal cookie 未出现还受 `Path=/api/browser-native/...` 限制，不能单独归因于 SameSite。未验证：`fetch` 之外的出口（WebSocket、EventSource、`XMLHttpRequest`、WebRTC、`sendBeacon`）、`importScripts`、动态 `import()` 跨源模块、SharedArrayBuffer/Atomics 的实际可用性、COEP 对 Worker 脚本与子 Worker 的影响、Service Worker 拦截、真实模型的工具参数、生产认证与多租户、Safari/WebKit 与 Firefox，以及 CSP `report-uri`/`trusted-types` 等其它指令。
