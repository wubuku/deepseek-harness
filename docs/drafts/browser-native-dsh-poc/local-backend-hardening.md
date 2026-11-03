# 本地后端请求准入与凭据位置

本专题记录 Browser-Native PoC 同源 backend 在“本机回环 HTTP 服务”这一形态下的攻击面验证，以及本批采用的请求准入修复。结论边界：它证明浏览器页面无法从其它 origin 读取 Workspace 或消耗模型额度；它不证明本机其它进程、预览 origin 内的 XSS、生产登录或跨主机部署已安全。

## 威胁与判定口径

| 攻击 | 可利用条件 | 判定 |
| --- | --- | --- |
| CSRF / 伪造 Origin | 外部页面能以受害者 cookie 发起状态变更 | 伪造 Origin 的请求必须被拒，且拒绝体不含 Workspace 数据 |
| 跨站读取 | 外部页面能读回 manifest/Session/模型输出 | `Sec-Fetch-Site: cross-site` 必须被拒；API 响应不得带 `access-control-allow-origin` |
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
- `/api/browser-native/` 请求要求 `Sec-Fetch-Site` 为 `same-origin` 或 `none`，且存在 `Origin` 时必须与服务 Host 完全同源；否则 403 `ORIGIN_FORBIDDEN`。
- 查询参数名匹配 token/secret/password/credential/authorization/api key/access key 时返回 400 `CREDENTIAL_IN_QUERY`，让误把凭据放进 URL 的客户端显式失败。
- 携带共享 state token 的服务端转发只跳过浏览器 Origin 检查，Host 规则与 principal 授权仍然生效。
- API 与静态响应补充 `x-content-type-options: nosniff`，静态响应补充 `referrer-policy: no-referrer`；CORS 仍然不启用。

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

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/local-request-guard.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_DIST_ROOT=$PWD/apps/web/dist DSH_POC_BROWSER=chrome \
  DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs
```

## 未覆盖与残余风险

- 本机其它进程可以自行构造回环 Host 与 `Origin`，并调用 `/workspace/identity` 取得自己的 principal；本批不提供进程级互认证或启动 token，因此“同机进程隔离”仍未成立。
- 预览 origin 内的 XSS 或恶意插件代码与服务同源，能执行用户已授权的操作；请求准入不替代 CSP 与代码审计。
- 端口探测只能被削弱而不能消除：浏览器仍可观察到回环端口是否接受连接；非回环 Host 与指纹字段已不再响应。
- owner token 仍是 JSON body 中的 bearer 凭据；本批没有轮换、短期化或一次性化。
- 未验证 Safari/WebKit 的 `Sec-Fetch-Site` 行为、生产身份授权、跨主机 backend 与 HTTPS 终止代理。
