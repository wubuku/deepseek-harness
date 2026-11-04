# 本地后端请求准入与凭据位置

本专题记录 Browser-Native PoC 同源 backend 在“本机回环 HTTP 服务”这一形态下的攻击面验证，以及本批采用的请求准入修复。结论边界：它证明浏览器页面无法从其它 origin 读取 Workspace 或消耗模型额度；进程认证在 `run-v2.mjs` 启动路径上要求 0600 令牌或握手 cookie，但不覆盖同用户进程读取令牌文件、预览 origin 内的 XSS、生产登录或跨主机部署。

## 威胁与判定口径

| 攻击 | 可利用条件 | 判定 |
| --- | --- | --- |
| CSRF / 伪造 Origin | 外部页面能以受害者 cookie 发起状态变更 | 伪造 Origin 的请求必须被拒，且拒绝体不含 Workspace 数据 |
| 跨站表单与简单请求 | `form` POST、`no-cors` `text/plain` 简单请求绕过 preflight | 状态变更必须声明精确同源 `Origin`；`Sec-Fetch-Site: cross-site` 一律拒绝，且 0 副作用 |
| 跨站读取 | 外部页面能读回 manifest/Session/模型输出 | `Sec-Fetch-Site: cross-site` 必须被拒；API 响应不得带 `access-control-allow-origin`，并带 `Cross-Origin-Resource-Policy: same-origin` |
| 同站兄弟 origin 读取 | 同 site 的子域或不同端口（如分离源）用 `same-site` 读取 | `same-site` 必须同时声明精确且已允许的 `Origin`，否则拒绝 |
| DNS rebinding / 端口探测 | 攻击者域名解析到 `127.0.0.1`，浏览器把它当作同源 | 非回环 Host 必须在任何路由前被拒 |
| URL 携带凭据 | token 进入查询串，从而落入历史、Referer 或日志 | 凭据形状的查询参数必须被拒；身份 cookie 必须 HttpOnly + SameSite=Strict |

## 修复前证据

探针脚本直接用 `node:http` 控制 `Host`/`Origin`/`Sec-Fetch-Site`（浏览器 fetch 禁止设置这些头），对 `createBrowserNativeV2Server({ llmMode: 'scripted' })` 运行：

| 探针 | 修复前 |
| --- | --- |
| 合法 cookie + `Origin: http://evil.example` 读取 manifest | 200，返回完整 manifest |
| 合法 cookie + `Sec-Fetch-Site: cross-site` 读取 manifest | 200 |
| `Origin: http://evil.example` + cross-site 调用 `/api/browser-native/llm` | 200，模型流开始 |
| `Host: attacker.example` 访问 `/api/browser-native/health` | 200，返回 `llmMode`/`model` |
| `/api/browser-native/health?access_token=probe-secret` | 200 |

修复前只有 cookie 的 `SameSite=Strict` 与 `Path` 限定，没有 Origin/Host 检查，也没有拒绝 URL 凭据；rebinding 页面拿到同源地位后即可读写全部 API。

## 修复

`backend-v2.mjs` 在路由之前执行 `assertLocalRequest`：

- Host 头必须解析为 `127.0.0.1`、`localhost`、`::1` 之一，否则 403 `HOST_FORBIDDEN`；rebinding 页面带自己的域名，被拒后才读取 cookie。
- `/api/browser-native/` 请求若携带任一浏览器来源头（`Origin`、`Referer`、`Sec-Fetch-Site`、`Sec-Fetch-Dest`），就按浏览器请求执行严格校验：`POST`/`PUT`/`PATCH`/`DELETE` 必须声明精确同源 `Origin`（服务 Host、`DSH_POC_PUBLIC_ORIGIN` 或分离源允许列表之一），`Sec-Fetch-Site` 只允许 `same-origin`/`none`，`same-site` 仅在 `Origin` 精确命中分离源允许列表时成立；不满足则 403 `ORIGIN_FORBIDDEN`。
- 读取请求同样拒绝 `cross-site`；`same-site` 读取必须声明精确且已允许的 `Origin`；缺少 `Origin` 但带 `Referer` 时，`Referer` 的 origin 必须精确同源。
- 完全没有浏览器来源头的请求视为非浏览器客户端（SDK、curl、测试进程），沿用回环 Host 与 principal 授权；`sec-fetch-mode` 不计入来源头，因为 Node `fetch` 会固定发送 `cors`。
- API 响应统一带 `Cross-Origin-Resource-Policy: same-origin` 与 `referrer-policy: no-referrer`，跨站 `no-cors` 嵌入（`img`/`script`/`link`）在浏览器网络层被丢弃，即使请求准入被绕过也读不回响应体。
- 查询参数名匹配 token/secret/password/credential/authorization/api key/access key 时返回 400 `CREDENTIAL_IN_QUERY`，让误把凭据放进 URL 的客户端显式失败。
- 携带共享 state token 的服务端转发只跳过浏览器 Origin 检查，Host 规则与 principal 授权仍然生效。
- API 与静态响应补充 `x-content-type-options: nosniff`；CORS 仍然不启用。

身份 cookie 保持 `HttpOnly; SameSite=Strict; Max-Age=31536000`，Workspace 与 Session 各自 Path 限定。owner token、GC token、egress 凭据只经 JSON body 或服务端 header 传输。

## 修复后证据

同一探针复跑：

| 探针 | 修复后 |
| --- | --- |
| 伪造 Origin 读取 manifest | 403 `ORIGIN_FORBIDDEN`，响应体不含 workspaceId |
| cross-site 读取 manifest | 403 `ORIGIN_FORBIDDEN` |
| 伪造 Origin 调用 `/llm` | 403 `ORIGIN_FORBIDDEN`，上游请求 0 |
| `Host: attacker.example` 访问 health | 403 `HOST_FORBIDDEN`，不返回模型信息 |
| 查询串带 `access_token` | 400 `CREDENTIAL_IN_QUERY` |
| 同源 `Origin` 调用 `/llm` | 200，5 行 NDJSON，末行 `finish` |

合同测试 [`tests/local-request-guard.test.mjs`](tests/local-request-guard.test.mjs) 5/5；既有 [`tests/backend-v2.test.mjs`](tests/backend-v2.test.mjs) 64/64；真实 Chrome scripted E2E 完成 1 个 turn、19 个事件、2 次 `/llm` 200，浏览器路由仍包含 identity/manifest/session/read 全部同源调用。

### 状态变更的严格 Origin 校验

第一批只校验“存在 `Origin`/`Sec-Fetch-Site` 时才比对”，`curl` 风格的无头请求与不带 `Origin` 的表单穿越仍是空白。本批把校验改为默认拒绝：

| 探针（合法 cookie，直接构造头） | 结果 |
| --- | --- |
| 跨站表单 `application/x-www-form-urlencoded` + `Origin: http://evil.example` + `cross-site` | 403 `ORIGIN_FORBIDDEN` |
| `no-cors` `text/plain` 简单请求（JSON 伪装体） | 403 |
| 仅伪造 `Origin`、无 `Sec-Fetch-Site` | 403（状态变更必须先声明 `Origin`） |
| `Origin: null`（沙箱 iframe / `data:` 页面） | 403 |
| 仅 `Referer: http://evil.example/page` | 403 |
| 精确 `Origin` + `Sec-Fetch-Site: cross-site` | 403（Fetch metadata 与 Origin 不能互相豁免） |
| 攻击后 `workspace/list` 数量 | 与攻击前相同，0 新增 Workspace |
| 无任何浏览器来源头（非浏览器客户端） | 200，仍受回环 Host 与 principal 授权约束 |
| `same-site` 读取且未声明 `Origin` | 403 |
| 同源 `Origin` + `same-origin` 读取 | 200，带 `Cross-Origin-Resource-Policy: same-origin`、`referrer-policy: no-referrer`、`cache-control: no-store` |

真实浏览器证据来自 [`tests/csrf-cross-site.e2e.mjs`](tests/csrf-cross-site.e2e.mjs)：攻击页由 `http://localhost:<port>` 提供、backend 在 `http://127.0.0.1:<port>`，Chromium 判定为 cross-site。结果原样输出：

```json
{"result":"passed","scope":"cross-site-form-no-cors-simple-request-cors-read-sse","attackerOrigin":"http://localhost:63692","backendOrigin":"http://127.0.0.1:63691","formPostStatus":403,"noCorsAttempts":{"create":{"outcome":"blocked-at-network"},"session":{"outcome":"blocked-at-network"},"llm":{"outcome":"blocked-at-network"}},"corsRead":"blocked","eventSource":"blocked","workspacesBefore":1,"workspacesAfter":1,"sessionsBefore":0,"sessionsAfter":0,"ownerWorkspaceUnchanged":"38f987b8-0f0f-44e4-a93d-c6b3b45f778a"}
```

跨站表单得到 403；`no-cors` `text/plain` 对 `workspace/create`、`session/create`、`/llm` 均在浏览器网络层被 `Cross-Origin-Resource-Policy` 丢弃（攻击页既读不到状态也读不到响应体）；CORS 读取 `usage-audit` 与 `EventSource` 订阅 `session/durable/stream` 均失败；攻击前后 Workspace 与 Session 计数不变，owner 的 Workspace id 不变。合同测试 [`tests/local-request-guard.test.mjs`](tests/local-request-guard.test.mjs) 7/7，[`tests/backend-v2.test.mjs`](tests/backend-v2.test.mjs) 70/70，`tests/browser-native-v2.e2e.mjs`、`tests/preview-api-origin-split.e2e.mjs`、`tests/first-use.e2e.mjs` 回归 PASS（分离源仍能以 CORS 读取 allowlisted origin）。

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/local-request-guard.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
node docs/drafts/browser-native-dsh-poc/tests/csrf-cross-site.e2e.mjs
```

## 未覆盖与残余风险

- 本机其它进程可以自行构造回环 Host 与 `Origin`；`run-v2.mjs` 现在启用进程令牌，identity 与全部 browser-native API 在缺少 `x-browser-native-auth` header 或握手 cookie 时返回 401，但同一 OS 用户下的进程仍可读取 0600 令牌文件，进程隔离依赖用户隔离。
- 完全没有浏览器来源头的请求仍被当作非浏览器客户端放行；这是 SDK/curl/测试进程的既定通道，浏览器无法构造这种“无来源头且带 cookie”的状态变更（`SameSite=Strict` cookie 也不会随跨站请求发送）。
- 早于 `Sec-Fetch-Site` 的浏览器（Safari < 16.4）在跨站表单 POST 中仍会发送 `Origin`，因此按 `Origin` 拒绝；不发送 `Origin` 的旧引擎同时也不发送 `SameSite=Strict` cookie，状态变更因未认证失败。
- 预览 origin 内的 XSS 或恶意插件代码与服务同源，能执行用户已授权的操作；请求准入不替代 CSP 与代码审计。
- 端口探测只能被削弱而不能消除：浏览器仍可观察到回环端口是否接受连接；非回环 Host 与指纹字段已不再响应。
- owner token 仍是 JSON body 中的 bearer 凭据；本批没有轮换、短期化或一次性化。
- 未验证 Safari/WebKit 的 `Sec-Fetch-Site` 行为、生产身份授权、跨主机 backend 与 HTTPS 终止代理。
