---
description: "记录 Browser-Native DSH PoC Session principal 授权与同源浏览器身份切换隔离的实施证据和限制。"
---

# Browser-Native Session 身份隔离验证进度

## 当前状态

状态：实现与运行时验收完成，文档门禁、commit 和 push 尚待执行。计划见[验证计划](principal-scoped-session-isolation-plan.md)。本批在 `research` 主工作区实施；起始时与 `origin/research` 同步且无隔离 worktree。Safari/WebKit 暂停，仅运行 Chrome。

## 实施前基线（M0）

| 项目 | 当前证据 | 状态 |
|---|---|---|
| Session 归属 | Session record 没有 principal 字段；list 遍历全局 Session map；read/open/stat 等按 Session ID 取对象 | 缺口确认 |
| Session 写权 | owner token/epoch fencing 已存在，但它标识执行者，不标识用户 principal | 不可替代身份授权 |
| Workspace 身份 | identity endpoint 为 principal 建立 Workspace 映射；Workspace API 校验 cookie 与 Workspace ID | 已实现，未覆盖跨身份 Chrome 切换 |
| 浏览器本地缓存 | IndexedDB/OPFS 数据按 Workspace ID 查询；真实账号切换与已有 origin cache 隔离尚无验收 | 待验证 |
| LLM 凭据与请求 | 真实模型凭据由 backend 环境配置读取；现有 Chrome handoff E2E 检查 principal cookie 不发送到 LLM | 回归范围 |

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：基线与威胁范围 | `complete` | 已读 Session routes、Workspace identity、durable store 和既有 Chrome 证据；确认 Session API 缺少 principal authorization | 已完成 |
| M1：Session principal 绑定 | `complete` | Session record 保存 principal；Session API 与 catalog 按 principal 授权；旧无主记录 fail closed；Session-scope cookie 不发往 LLM route | 已由 M2/M3 验收 |
| M2：授权合同测试 | `complete` | backend contract 47/47；覆盖跨身份列表/读取/创建冲突、cursor、未认证、legacy record、LLM 不存在态及重启归属恢复 | 已由 M3 验收 |
| M3：Chrome 身份切换 E2E | `complete` | Chrome 155.0.8059.85 通过：同一 context 保留 origin 的 OPFS/IndexedDB，A→B→A 切换；B 不可读取 A Session/Workspace，A/B 各自写入相同路径后均刷新恢复自己的 Session、manifest、文件和 OPFS blob；principal cookie 未发往 LLM，无页面错误或跨源请求。 | PoC principal 不是用户认证；不能推及 XSS、cookie 窃取或生产租户隔离 |
| M4：真实 LLM、文档与交付 | `in-progress` | 真实 Chrome + `gpt-5.6-sol` 完成 `read → write → read`、刷新后 Session 记忆与 Workspace 文件恢复；8 次请求中 7 个 HTTP 200，刷新中止的请求为 `ERR_ABORTED`。handoff scripted 三场景通过；文档门禁、commit/push 待执行。 | 真实 LLM smoke 不是 A/B principal 双身份真实模型测试；密钥只在 backend |

## 命令与环境

| 命令或检查 | 结果 |
|---|---|
| `git status --short --branch` | `research` 与 `origin/research` 同步，输出无工作区修改 |
| `git log -1 --oneline --decorate` | `feat(browser-native): coordinate session and workspace handoff` |
| Node/pnpm | `v24.6.0` / `11.28.5` |
| Chrome 实际版本 | `155.0.8059.85` |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；构建有既有平台、tsdown 与 chunk-size 警告 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/principal-scoped-session-isolation.e2e.mjs` | 通过；A/B 两个 principal 分别刷新恢复 Session 和 Workspace，A→B→A 内容隔离；无外部请求、页面异常或 LLM principal cookie |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs` | scripted normal、Session response loss、Workspace release response loss 均通过；旧 Session/Workspace writer 被 fencing，LLM 请求不带 principal cookie |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 通过；`gpt-5.6-sol` 完成 read/write/read、刷新记忆与文件恢复，Session `durableThroughSeq=57`、Workspace commits 2/2 成功；7 个请求 HTTP 200，1 个刷新取消；无页面异常或跨源请求 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 47/47 通过 |
| E2E/helper `node --check` | principal isolation、execution handoff 与 runtime test support 均通过 |

## 风险与下一步

- Session identity 复用 PoC principal，不代表真实登录；自动签发身份不能抵御身份签发端滥用、XSS、同源恶意脚本或 Cookie 窃取。
- 旧 Session record 没有可证明的 owner；记录原样保留并对所有 principal fail closed，不按当前 cookie 自动绑定。
- 不得把 Session owner token、Workspace writer token、principal cookie 或模型密钥写入日志、截图或测试输出。
- OPFS、IndexedDB 与页面代码共享同源安全域；本批验证 Workspace ID 分区，不提供静态加密或抵御同源恶意代码的能力。
- Backend 是单实例 PoC；principal 与 Session/Workspace 持久数据没有跨实例事务或 HA 保证。

## M0 结果

- `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`：基线 45/45 通过；包含 Session handoff、Workspace identity、LLM owner fencing 与现有 backend 回归。
- `git worktree list --porcelain`：仅主 worktree，分支为 `research`；没有隔离 worktree 需要合并。
- `test -f docs/drafts/.env`：真实模型配置文件存在；没有读取或打印其内容。
- `openIdentity()` 分别签发 Workspace 与 Session principal cookie；Session cookie 的 Path 为 `/api/browser-native/session`，避免发送到 `/api/browser-native/llm`。
- `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`：实施后 47/47 通过；跨身份访问统一为 `SESSION_NOT_FOUND`，身份绑定的 catalog cursor 不接受其它 principal 的 cursor。
- Session 文件记录 `principalId`；缺少归属的旧文件仍保留原字节并且不出现在任何 principal 的 catalog。测试显式检查旧记录不会自动认领或覆盖。
- Session 路由需要由 identity endpoint 签发的 HttpOnly Session cookie；LLM route 继续只接受 Session owner bearer，不收 principal cookie。缺少 owner token 的请求对已知/未知 Session ID 均返回相同 not-found 状态。
- 旧 Session durable JSON 缺少 principal 归属；它们保留原样且对所有 principal 不可访问，不自动绑定或删除。

## M1–M4 结果

- Session durable record 保存 PoC principal；Session list/cursor、单 Session 操作与 handoff 按 principal 授权。跨 principal 已知 Session ID 返回 `SESSION_NOT_FOUND`；无主 legacy record 保留原字节且 fail closed。
- Workspace cookie 限定 `/api/browser-native/workspace`，Session cookie 限定 `/api/browser-native/session`；真实 Chrome request headers 确认两者均不发送给 LLM route。
- Chrome E2E 在一个 browser context 中切换 A→B→A，不清除 IndexedDB/OPFS；A 与 B 对同路径写入不同内容。两边各自刷新后恢复自己的 Session catalog、manifest、revision、blob 与 Worker 文件内容；foreign Session/Workspace 请求被拒；没有跨源请求或页面异常。
- handoff 既有 scripted normal、Session response loss、Workspace release response loss 三场景复归通过。测试修正了旧 stale-append fixture 未携带 Session cookie 的问题，确保断言覆盖 409 writer fencing，而非 401 身份缺失。
- 真实模型 smoke 通过普通 read/write/read、Session 记忆和 durable Workspace 刷新恢复；身份 A/B 场景本身使用 scripted 模型，不能据此宣称真实模型双身份测试。
- Chrome 初次复归还修正了 Path-limited cookie 查询路径、非 JSON body 观测、identity 响应序列化、turn-scoped 工具断言，以及重开页面时对 disabled onboarding 控件的误点击。
- 未覆盖真实登录/租户授权、恶意同源代码、共享数据库/多 backend、跨设备授权、自然 eviction、OS/磁盘 crash、静态加密和 Safari/WebKit。
