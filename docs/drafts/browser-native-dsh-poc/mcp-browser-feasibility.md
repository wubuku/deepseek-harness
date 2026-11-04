---
description: "浏览器端 MCP 接入判定：stdio 不可用，直接 HTTP/SSE 受 CORS 与凭据限制，同源服务端代理是可落地的最小路径，已实现并验证。"
---

# MCP 浏览器接入判定

## 结论

| 路径 | 判定 | 依据 |
| --- | --- | --- |
| stdio | 不可行 | 浏览器 Worker 没有子进程 API；DSH `mcp-client` 的 transport 还静态依赖 `@modelcontextprotocol/client/stdio` 与 `@deepseek-ai/dsh-subprocess` |
| 浏览器直接连 HTTP/SSE MCP | 有条件可行 | MCP SDK 的 `StreamableHTTPClientTransport` 基于 `fetch`/Streams，可打包进浏览器；但跨源需要目标服务提供 CORS，且浏览器会暴露上游地址，OAuth/凭据也要进入页面 |
| 同源服务端代理 | 可行，最小路径 | 后端代理按 id 转发 Streamable HTTP，剥离 Cookie/Origin，注入上游凭据，流式回传 SSE；浏览器只见 `/api/browser-native/mcp/<id>` |

因此当前 PoC 的立场是：**浏览器不直连 MCP；由同源 backend 代理 Streamable HTTP，stdio 只在 Node/Host 侧存在。**

## 已实现的最小代理

`backend-v2.mjs` 新增 `mcpServers` 配置与 `POST/GET/DELETE /api/browser-native/mcp/<id>`：

- 启动时校验 id 格式、绝对 URL（仅 http/https）与 headers 字符串 map；未知 id 返回 404 `MCP_SERVER_UNKNOWN`。
- 只接受 POST/GET/DELETE，其余 405 `METHOD_NOT_ALLOWED`。
- 请求体复用 8 MiB 上限；转发 `content-type`、`Accept`、`mcp-session-id`、`mcp-protocol-version`、`Last-Event-ID`，**不转发** Cookie、Origin、Referer。
- 上游不可达返回 502 `MCP_UPSTREAM_UNAVAILABLE`；重定向按错误处理，避免被上游带到未授权地址。
- 响应只回传 `content-type`、`mcp-session-id`、`cache-control`、`retry-after`、`www-authenticate`、`last-event-id`，并用 `pipeline` 流式转发，SSE 不缓冲。
- 路由继承 backend 的本地进程认证与同源来源检查；`requireLocalAuth: true` 时无认证请求为 401 `AUTH_REQUIRED`。

测试夹具 `tests/mini-mcp-server.mjs` 实现 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`；`tools/call` 以 SSE 返回，用来覆盖流式路径。

## 实测

Chrome 156.0.8078.80 / macOS，`tests/mcp-browser-proxy.e2e.mjs`：

| 检查 | 结果 |
| --- | --- |
| `initialize` | 200；返回 `dsh-mini-mcp` 与 `mcp-session-id` |
| `tools/list` | 200；工具为 `echo` |
| `tools/call` | 200 `text/event-stream`；文本 `MCP_ECHO:MCP_PROXY_BROWSER_ECHO_9C41` |
| 页面直接跨源请求夹具 | `TypeError: Failed to fetch`（夹具不发 CORS 头） |
| 未知 server id | 404 `MCP_SERVER_UNKNOWN` |
| 上游不可达 | 502 `MCP_UPSTREAM_UNAVAILABLE` |
| 不支持的方法 | 405 `METHOD_NOT_ALLOWED` |
| 无进程认证的 Node 请求 | 401 `AUTH_REQUIRED` |
| 上游收到的请求头 | 4 次 POST；无 Cookie、无 Origin；每次带注入的 `x-mcp-upstream-key` |
| 页面/Worker 错误、跨源请求 | 0 |

## 接入 DSH Agent 还缺什么

代理与浏览器协议栈已成立，但把 MCP 工具接进 Agent Loop 还需要一处 product 侧改造：`packages/mcp/mcp-client` 的 `createTransport` 同时静态引入 stdio 与 `dsh-subprocess`，浏览器打包会带入 Node 依赖；需要一个浏览器安全的 transport 入口（只暴露 Streamable HTTP），并让 profile 配置接受同源相对路径或运行时 origin。当前批次没有修改 `packages/`，因此这一层未实现。

## 边界

- 代理不实现 OAuth 授权码流程；上游凭据由部署方配置。需要用户级 OAuth 的 MCP 服务仍需额外的凭据代理。
- 只验证单上游、单 Session、无分页的 `tools/list`；分页、资源订阅、任务、采样均未覆盖。
- GET 流（服务端主动通知）在夹具中返回 405；代理会透传该状态，但未验证长期通知流。
- 代理不做工具权限/审批映射；MCP 工具进入 Agent 后的审批语义仍由 `dsh-mcp-client` 与 preset 决定。
- 测试用页面 `fetch` 驱动协议，未把 SDK 打进 Worker；SDK 本身无 Node 内建依赖，但完整打包仍需上节的 transport 拆分。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/mcp-browser-proxy.e2e.mjs
```
