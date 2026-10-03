---
description: "Browser-native DSH PoC 的实施进度、验证记录和恢复入口。"
---

# Browser-native DSH PoC 实施进度

## 当前状态

状态：协议级 PoC 已完成；真实后端 provider proxy 和真实 Chromium E2E 已完成；真实 DSH `ctx.agentLoop` 接入未完成，作为后续独立评估项保留。

实施 worktree：`research-browser-native-poc`。

实施基线：`research` 分支当前提交，对应上游基线 tag `dsh-v0.2.0-rc.2` 之上的研究文档版本；不要依赖提交 hash 作为未来同步标识。

代码约束：除非变更账本新增经过证明的例外，PoC 代码、后端、页面、Worker、测试、启动脚本和运行说明全部放在 `docs/drafts/browser-native-dsh-poc/`；不修改 `packages/`、`apps/`、根级 `package.json`、现有 profile 或 Desktop/Web 入口。

## 完成目标

按 [implementation-plan.md](implementation-plan.md) 实现并验证最小闭环：浏览器页面启动 Worker，Worker 运行目录内的 PoC-local Agent-loop adapter，通过同源后端完成 Session 状态存储和 scripted/real LLM proxy，经过 typed `browser_echo` Tool bridge 返回最终结果，并支持 flush 后的新 Worker resume。

第一阶段先用 PoC-local loop adapter 验证协议和生命周期；当前 checkout 的 WebWorker preview 只有 Host tree/fixture boot，没有现成的 live Agent bootstrap。只有确认现有 WebWorker runtime 能在不修改核心代码的前提下承载真实 DSH Agent Loop 后，才把实现升级为真实 `ctx.agentLoop` 闭环。任何暂时不能满足真实 DSH Loop 完成定义的阶段，都必须在本文件和 README 中明确标注为 partial PoC。

## 阶段记录

### Phase 0：协议、目录和测试基座

状态：已完成。

已完成：

- 创建独立 worktree `research-browser-native-poc`。
- 固定实现基线为 `dsh-v0.2.0-rc.2` 之上的 `research` 文档版本。
- 创建本进度文件。
- 核对 `SessionPersistence` 的 `create/open/read/append/flush/close` 语义、`AgentLoop` 的 `ctx.agents` 创建/恢复入口和 WebWorker preview 的实际覆盖范围。
- 确认 preview 目前没有可直接复用的 live Agent bootstrap；不修改核心包或现有 Web profile，先实现目录内协议级 loop 和 backend。
- 选择零新增 npm 依赖：Node 内置 `http`/文件系统作为 backend，静态 HTML/ESM 作为页面，Dedicated Worker 作为 loop runtime。
- 将 PoC-local loop 与真实 `ctx.agentLoop` 接入明确分开；当前实现不宣称真实 DSH Agent Loop 已在浏览器 Worker 中运行。

入口勘察结果：现有 WebWorker runtime 能启动完整 Host tree 和页面隧道，但当前 preview 没有公开的 live Agent bootstrap；`createWorkerHost()` 也不会把自定义页面代码自动转换为 `ctx.agents.create()` 调用。直接接入真实 loop 需要新增可被 image packer 收集的 bootstrap/plugin，或新增通用核心 extension point；这两种方案都超出当前“目录内、低侵入”PoC 的范围，因此本阶段冻结为 PoC-local loop adapter。

验证：目录结构、启动方式和测试路径已确定；所有实现代码仍在本目录内。

实现目录计划：

```text
docs/drafts/browser-native-dsh-poc/
├── backend.mjs              # 同源 HTTP backend、文件持久化、scripted/real LLM proxy
├── protocol.mjs             # backend/Node tests 使用的 DTO 校验、限额和错误定义；Worker 保持 browser-local guards
├── run.mjs                  # 启动 backend 的开发入口
├── public/
│   ├── index.html            # 可观察的 PoC 页面
│   ├── main.js               # Main Thread、Worker 生命周期和 Tool registry
│   └── worker.js             # PoC-local Agent loop、Session adapter、LLM client
└── tests/
    ├── backend.test.mjs      # Session、lease、幂等和恢复测试
    ├── browser.e2e.mjs       # 浏览器 Worker/Tool/恢复闭环测试
    └── browser.real.e2e.mjs  # 真实 provider、真实 Chromium 和 Session 持久化测试
```

### Phase 1：Session backend 和协议 adapter

状态：已完成。

当前实现：`backend.mjs` 提供 exact Session routes、JSON 文件 flush、owner lease、renew、request-id replay、scripted route 和 OpenAI-compatible real provider route；`public/` 提供 Dedicated Worker 与 Main Thread Tool bridge。

已完成：Node contract tests 覆盖 flush/reopen、request-id replay、owner fencing/renew、sequence conflict atomicity 和 NDJSON terminal item。

退出条件：Node contract tests 覆盖 create/open/read/append/flush/close、owner lease、renew、idempotency、sequence fencing 和 reopen。

结果：最近一次记录的 backend contract tests `node --test docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs` 为 21 passed、0 failed；阶段早期的 17/20 passed 记录只保留在下方历史日志中。

### Phase 2：Worker loop 和 LLM proxy

状态：已完成。

当前实现：Worker 通过同源 backend 完成两次 LLM request，request 可以选择 scripted fixture 或 backend 配置的真实 OpenAI-compatible provider；Session event 在每次 mutation 后 flush；页面 Main Thread 提供 `browser_echo`。

退出条件：Worker 通过同源 backend 完成一次包含 `browser_echo` Tool 的 agent turn，Session flush 后可读取连续 event。

结果：浏览器 E2E `DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test --test-timeout=70000 docs/drafts/browser-native-dsh-poc/tests/browser.e2e.mjs` 为 6 passed、0 failed；真实页面观察到 `LLM → browser_echo → LLM`、4 个连续 event、`durableThroughSeq = 3`、graceful close、allowlist rejection、terminate、lease expiry 和 resume，并覆盖 durable Tool result 后继续生成 final、late Worker message、超长 NDJSON 行、malformed error item 和累计 stream limit。backend restart/reopen 由 backend contract test 单独验证。

### Phase 3：故障语义和可移植性加固

状态：已完成。

已完成：

- backend tests 覆盖 graceful `close` 的 flush、空 Session 清理、lease expiry 后旧 owner 拒绝、sequence conflict 的原子性、request-id replay、backend restart 后的 durable `flush`/`close` replay、原型名称 request id、NDJSON terminal item、malformed JSON、unsupported protocol、unapproved model、未知顶层字段、控制字符和未知 stat 查询。
- browser test 通过 `DSH_POC_PLAYWRIGHT_MODULE` 注入现有 checkout 的 Playwright 模块，不在 PoC 目录新增依赖。
- Worker 在每次 Session mutation 后 flush；Main Thread 只执行 `browser_echo` allowlist 中的 Tool。
- README、协议文档和本进度文档均标明当前是 protocol-level/PoC-local loop，不是真实 DSH `ctx.agentLoop`。

结果：最近一次记录的 backend contract tests 为 21 passed、0 failed；最近一次记录的 browser E2E 为 6 passed、0 failed。阶段早期的 17/20 backend 和 1/2/3/5 browser 结果只保留在下方历史日志中。

后续修正：发现 graceful close 的空 Session 清理函数使用了未定义的文件 id；已改为使用 Session 自身 id，并新增 empty-session close regression test。发现恢复路径可能自动重放没有持久化结果的 browser Tool call；已改为 fail closed，返回 `REQUEST_OUTCOME_UNKNOWN`，避免把未知的浏览器副作用当作可重试操作。最终一致性检查又发现 stat 路由未执行协议版本校验、flush 未同步临时文件和目录、进站 DTO 未拒绝未知顶层字段；已补齐并新增对应 regression tests。修正后的 backend tests 和 browser E2E 已通过，后续仅执行只读一致性检查。

入口 smoke：使用 README 的 `run.mjs` 启动命令验证 health、静态页面、Session create、append、flush 和 stat；全部通过。该 smoke 使用临时数据目录，结束时由 Node `fs.rm` 清理，不写入 PoC 目录。

文档门禁：首次运行 `pnpm run test:docs` 发现实施基线使用裸 commit hash；改为 `dsh-v0.2.0-rc.2` 后重新运行 `pnpm run doc-sync`，43 个 gate 全部通过。门禁产生的 pnpm 安装输出和临时构建结果不属于 PoC 源码变更。

最终文档快检：在写入上述门禁记录后再次运行 `pnpm run test:docs`，21 个 gate 全部通过。

最终契约审计修正：backend 现在在 Session lookup 前执行 operation-specific top-level key allowlist，并新增“缺失 Session + 未知字段”回归测试；协议和规划文档明确当前使用最小 JSON-safe fixture，不把 protocol-level PoC 写成正式 DSH Session format 兼容实现。对应 focused tests 和文档门禁需要重新运行。

### Phase 3b：Main Thread Tool bridge

状态：已完成。

退出条件：`LLM → browser_echo → LLM` 自动闭环，Tool result 只能经 loop 进入 Session。

结果：browser E2E 已验证；未授权 Tool 由 Main Thread 拒绝，Tool result 由 Worker 追加并 flush 到 Session。

### Phase 4：crash/restart 和恢复

状态：已完成。

退出条件：Worker 中断后的新 Worker 能 resume 已 flush Session；旧 owner 和重复 request 不会造成重复写入。

结果：backend tests 验证 owner fencing、lease expiry、request-id replay 和 sequence conflict；browser E2E 验证 terminate 后等待 lease expiry，再由新 Worker resume 已 flush Session。

### Phase 5：真实 DSH Agent Loop 和 provider proxy

状态：真实 provider proxy 已完成；真实 DSH `ctx.agentLoop` 接入未实施，明确不属于当前协议级 PoC 的完成范围。

已完成：backend 读取启动时提供的 `.env`，按配置选择 GPT/Grok provider，密钥只留在 backend；real route 将受限 PoC messages 转换为 OpenAI-compatible Chat Completions request，固定注入 `browser_echo` schema，解析上游 SSE 并输出 PoC NDJSON；页面通过 config route 只看到 mode/provider/model。`browser.real.e2e.mjs` 使用真实 Chromium、真实上游模型和真实 JSON Session store 验证 `user.message → assistant.tool-call → tool.result → assistant.final` 以及 `durableThroughSeq = 3`。

保留限制：当前 WebWorker preview 没有公开的 live Agent bootstrap，把真实 `ctx.agentLoop` 接入浏览器仍需要新增 image/plugin/bootstrap 组装路径。Provider credentials 仍不得进入浏览器；未来若实施真实 DSH loop，应先登记核心代码或 profile 变更，再增加正式 provider adapter、snapshot 和 e2e 覆盖。

## 当前决策日志

- 2026-10-02：实施从独立 worktree 开始；主 `research` worktree 保持提交后的干净状态。
- 2026-10-02：默认不修改 DSH 核心代码；先用目录内 adapter、backend、Worker/page fixture 和测试验证可行性。
- 2026-10-02：PoC worktree 没有独立 `node_modules`，但仓库 pnpm store 中存在 Playwright；浏览器 E2E 不新增依赖，测试通过显式模块路径或可解析的 workspace module 使用现有安装。
- 2026-10-02：浏览器 E2E 已通过；强制 terminate 后必须等待 owner lease 过期，才能验证新 Worker 重新取得 write ownership。
- 2026-10-02：协议级 PoC 的完成边界冻结为“同源 backend + scripted LLM + PoC-local Worker loop + Main Thread Tool bridge + durable resume”；不将其描述为真实 DSH `ctx.agentLoop` 浏览器运行时。
- 2026-10-02：真实 DSH Agent Loop 接入调查完成；现有 runtime/packer 提供 Host tree 和 image 装载能力，但没有不改核心代码即可从本目录启动 live `ctx.agents.create()` 的公开 bootstrap，因此暂不扩大变更范围。
- 2026-10-02：修复空 Session graceful close 的清理路径，并为未完成 browser Tool 的恢复增加 `REQUEST_OUTCOME_UNKNOWN` 拒绝策略；对应回归测试已通过。
- 2026-10-02：协议一致性检查发现 stat 版本校验和文件 durability 语义实现不足；已增加 stat 版本拒绝、临时文件 `fsync`、Session 目录 `fsync` 和对应回归测试。该修正不改变 DSH 核心代码。
- 2026-10-02：README 启动入口 smoke 已通过；health、静态页面、Session create/append/flush/stat 均可用。
- 2026-10-02：文档门禁已通过；`pnpm run doc-sync` 报告 43 passed、0 failed、0 skipped。
- 2026-10-02：最终文档快检已通过；`pnpm run test:docs` 报告 21 passed、0 failed、0 skipped。
- 2026-10-02：最终契约审计发现并修正 schema 校验顺序和 Session format 过度承诺；修正后的验证待运行。
- 2026-10-02：契约复核发现 protocol.md 对 `GET stat` 的 `requestId` 规则自相矛盾；已明确 stat 只要求 `protocolVersion` 和 `sessionId`，其他 API 请求仍要求非空 `requestId`。本次修改后重新开始连续无修改检查，focused 验证待运行。
- 2026-10-02：重新运行 focused 验证：全部 PoC JavaScript 通过 `node --check`；backend contract tests 为 10 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。覆盖内容包括协议 allowlist、owner fencing、request replay、flush/reopen、Worker Tool bridge 和 crash resume。
- 2026-10-02：首次入口 smoke 的临时断言误把 health 响应的 `ok: true` 写成 `status: "ok"`，导致 smoke 脚本失败；backend 已正常启动，未发现实现错误。修正临时断言后，health、静态页面、Session create/append/flush/stat 的入口 smoke 全部通过。
- 2026-10-02：入口 smoke 后运行 `pnpm run test:docs`，结果为 21 passed、0 failed、0 skipped。随后待运行完整 `pnpm run doc-sync`；门禁通过后开始三轮只读一致性审计，审计期间不修改文档。
- 2026-10-02：完整 `pnpm run doc-sync` 已通过，结果为 43 passed、0 failed、0 skipped。该结果记录后需要重新运行轻量文档门禁，再开始连续三轮只读一致性审计。
- 2026-10-02：记录完整门禁结果后重新运行 `pnpm run test:docs`，结果为 21 passed、0 failed、0 skipped。接下来开始三轮只读一致性审计；审计期间不修改 PoC 文档或代码。
- 2026-10-02：第 1 轮只读审计发现 protocol.md 对 health probe 的版本校验描述比实现更严格；已明确 health/static 不参与协议版本校验，Session/LLM API 才要求 `protocolVersion`。本次修正后审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：协议修正后的 focused 验证已通过：7 个 PoC 脚本通过 `node --check`；backend contract tests 为 10 passed、0 failed；浏览器 E2E 为 1 passed、0 failed；随后运行 `pnpm run test:docs`，结果为 21 passed、0 failed、0 skipped。
- 2026-10-02：第 1 轮审计继续发现 Session response DTO 与实现缺少字段、空 Session close 行为未在规划中说明，以及 header/message 输入校验未落地；已补齐 `inheritedEventCount`、append receipt、flush/close 状态、stat header、header/message validators 和 operation-scoped replay，并增加回归断言。语法检查和 backend tests 目前为通过，浏览器 E2E 与文档门禁待运行；审计计数保持 0。
- 2026-10-02：继续审计发现缺失 Session 时部分非法字段会被错误报告为 `SESSION_NOT_FOUND`，以及 bridge 内部控制消息与 versioned DTO 的封装不一致；已将 Session/LLM 校验顺序前移，增加缺失 Session 的非法请求回归测试，并统一 Worker/Main Thread bridge 的 `protocolVersion`、`kind`、`call`/result 结构。当前 7 个脚本通过 `node --check`、backend tests 10 passed、浏览器 E2E 1 passed；文档门禁待运行，审计计数保持 0。
- 2026-10-02：继续审计发现 NDJSON stream、重复 JSON key、非有限/过深 JSON、durable event log 加载和过期 owner replay 仍缺少可执行约束；已增加 JSON/消息/event 校验、stream terminal/版本/大小检查、durable log fail-closed、owner fencing-before-replay，并新增回归测试。当前 7 个脚本通过 `node --check`、backend tests 12 passed；浏览器 E2E 与文档门禁待运行，审计计数保持 0。
- 2026-10-02：严格 stream/message 校验首次运行浏览器 E2E 时发现 assistant tool-call event 的内部 `type` 被错误带入 LLM DTO；已在 `messagesFromEvents()` 中显式投影 `callId/name/args`，不放宽 DTO validator。修正后浏览器 E2E 为 1 passed、backend tests 为 12 passed，全部脚本通过 `node --check`；文档门禁待运行，审计计数保持 0。
- 2026-10-02：最终幂等审计发现 owner fencing 在 replay 查询之前会阻断已成功提交但响应丢失的 mutation 重试；已改为 exact replay 命中先返回 immutable receipt，未命中才执行 owner fencing，并将回归测试改为验证 lease 过期后的 committed replay。协议同步说明该顺序；focused 验证待重跑，最终三轮审计尚未开始。
- 2026-10-02：收尾复核发现实施规划仍把实际 NDJSON `chunk` item 写成 `data`，并把 Tool bridge 的嵌套 `call`/`type` envelope 写成扁平字段；已同步规划文档。Worker 还新增统一错误收尾：LLM、Tool、Session 或 close 失败都会停止活动状态、清理 owner renew timer，并拒绝未完成的 pending Tool，避免异常后继续续租。该修正后 focused 验证和文档门禁待运行，连续无修改审计计数重置为 0。
- 2026-10-02：收尾修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 12 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。浏览器测试再次观察到 Worker loop、`browser_echo`、连续 Session events、graceful close、lease expiry 和 crash-style resume。下一步运行文档门禁，之后开始三轮只读一致性审计。
- 2026-10-02：文档门禁已在收尾修正后重新运行并通过：`pnpm run test:docs` 为 21 passed、0 failed、0 skipped；`pnpm run doc-sync` 为 43 passed、0 failed、0 skipped。现在开始连续三轮只读一致性审计；审计期间不再修改 PoC 文档或代码。
- 2026-10-02：第 1 轮审计发现 `flush` 和非空 `close` 的 replay record 原先只留在当前 backend 内存，重启后无法 replay 已提交的 request id；已增加 durable replay persist/失败回滚，并补充 backend restart 后的 `flush`/`close` replay 回归测试。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：第 1 轮审计继续发现 replay 表使用普通对象时会把 `toString`/`__proto__` 等 request id 与对象原型混淆，且持久记录未完整保存结果摘要、序号和 durability 序号；已改为无原型 replay 表、只认自有键，补齐 replay metadata，并增加原型名称 request id 回归测试。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：replay 修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 13 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。下一步重新开始连续三轮只读一致性审计。
- 2026-10-02：审计同步修正了 Phase 1/Phase 3 的当前结果摘要，将 backend 测试数更新为 13，并补入 durable `flush`/`close` replay 与原型名称 request-id 覆盖；历史验证记录保持原样。该次仅修正文档事实，连续无修改审计计数重置为 0。
- 2026-10-02：第 1 轮审计继续发现 owner renew 失败时 pending Tool 未被立即拒绝，以及 Main Thread bridge 未严格校验 call envelope、未拒绝重复 call id、异步旧 Worker 结果可能投递到新 Worker；已收紧 renew 错误收尾、call DTO allowlist、duplicate call-id 检查和 Worker identity 检查。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：bridge 收紧后的浏览器回归发现 Worker 把 LLM `tool-call` chunk 的内部 `type` 字段原样带入 bridge `call`，导致 Main Thread 按协议正确拒绝；已在 Worker 出站时显式投影 `callId/name/args`，保留内部 `type` 仅用于 loop 和 Session event。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：bridge 字段投影修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 13 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。当前重新开始只读一致性审计。
- 2026-10-02：第 1 轮审计发现 durable replay 记录加载缺少 fail-closed 校验，以及 LLM NDJSON item 和 bridge envelope 未完全拒绝未知字段；已增加 replay record validator、NDJSON/bridge exact-key 校验、call id 长度限制和 malformed replay regression test。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：replay/strict DTO 加固后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 14 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。当前继续第 1 轮只读一致性审计。
- 2026-10-02：第 1 轮审计继续发现 durable replay record 未验证 receipt digest、`nextSeq` 和 `durableThroughSeq` 与 response 一致；已增加一致性校验、删除未使用的 replay helper，并补充 inconsistent replay receipt regression test。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：一致性校验修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 15 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。当前重新开始完整只读一致性审计，计数为 0。
- 2026-10-02：第 1 轮审计发现异步 `flush`/`close` 与并发 Session mutation 可能交错，导致 durable snapshot、`durableThroughSeq` 和 replay receipt 观察到不同状态；已增加单 backend 实例内按 `sessionId` 的 Session/stat 串行队列，并增加并发 append/flush/reopen regression test。LLM stream 不持有该队列，避免长 stream 阻塞 owner renew。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：Session/stat 串行队列修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 16 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。当前重新开始第 1 轮只读一致性审计，计数为 0。
- 2026-10-02：第 1 轮审计发现 replay validator 把合法的 `append/open/renew` response（其 DTO 不含 `durableThroughSeq`）错误当成不一致，影响“已有 durable event 后再次 append/flush 再重启”的恢复；已改为条件校验 response 中实际存在的 durable 字段，并增加该路径的 restart/replay regression test。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-02：replay validator 修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 17 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。当前重新开始第 1 轮只读一致性审计，计数为 0。
- 2026-10-03：审计同步修正 Phase 1/Phase 3 的当前结果摘要，将 backend 测试数更新为 17；历史验证记录保持原样。该次仅修正文档事实，连续无修改审计计数重置为 0。
- 2026-10-03：第 1 轮审计发现 `create/open/renew` 的 owner-bearing replay response 会随 flush 持久化，backend 重启后可能返回 stale owner token；已限制 durable replay 只保存 `read/append/flush/close`，并增加重启后重复 create 不返回旧 owner receipt 的回归测试。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-03：owner-bearing replay 修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 17 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。当前继续第 1 轮只读一致性审计，计数为 0。
- 2026-10-03：第 1 轮审计发现 Worker 对入站 `tool-result` 只做宽松类型检查，未拒绝额外字段、超长 call id、结果字段不匹配或 length/text 不一致；已补齐 result DTO exact-key、大小和一致性校验。连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-03：Worker `tool-result` 校验修正后的 focused 验证已通过：PoC 目录内 7 个 JavaScript 文件通过 `node --check`；backend contract tests 为 17 passed、0 failed；浏览器 E2E 为 1 passed、0 failed。下面开始连续三轮只读一致性审计，审计期间不再修改 PoC 文档或代码。
- 2026-10-03：第 2 轮只读审计发现已提前 `flush` 的 Session 随后执行 `close` 时，内存中的 `durabilityReceipt: undefined` 会在 JSON 持久化时被省略，导致重启加载时 durable replay digest 不一致并错误地丢弃整个 Session 文件。已让 `close` response 只在有 receipt 时输出该字段，并新增“已提前 flush 后 close、backend 重启后 close replay”回归测试；backend tests 为 18 passed、0 failed。该问题修正后连续无修改审计计数重置为 0，后续必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 durable replay 将完整 request/result canonical JSON 直接保存为受 512 字符限制的 digest 字段；Session 日志跨越多个 append batch 后，重启会因 replay record 校验失败而错误丢弃合法文件。已统一改为固定长度 SHA-256 digest，并新增超过单次 batch 上限的 Session 重启恢复回归测试；backend tests 为 19 passed、0 failed。该修正后连续无修改审计计数重置为 0，后续必须重新完成三轮只读审计。
- 2026-10-03：第 2 轮只读审计发现协议限额表遗漏实现中的 `MAX_DURABLE_EVENTS = 1,000,000`；该上限用于限制重启加载的完整 durable Session log，与单次 append batch 上限不同。已补充 `protocol.md` 的限额表，未改变运行时行为；本次文档修正后连续无修改审计计数重置为 0，focused 验证待重跑。
- 2026-10-03：重新开始的第 2 轮只读审计发现静态资源路径解码异常、目录越界和缺失文件会由通用异常处理返回 HTTP 500，而协议级 PoC 的未知资源应稳定返回 `NOT_FOUND`。已先记录该发现，随后补充静态资源错误映射和负向回归测试；本次发现使连续无修改审计计数重置为 0。
- 2026-10-03：静态资源错误映射修正完成：非法 URL 编码、缺失文件和目录路径现在返回 `NOT_FOUND`/404；新增静态路径负向回归测试，backend tests 为 20 passed、0 failed。该修正后连续无修改审计计数保持 0，后续必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现页面替换 Worker 后，旧 Worker 的 `ready/status/events/final/error` 消息仍可能通过共享 `worker` 变量影响新 Worker 的 UI；此前只有异步 Tool result 做了实例检查。已先记录该竞态，随后增加所有 Worker 入站消息的实例 fencing 和浏览器回归覆盖；本次发现使连续无修改审计计数重置为 0。
- 2026-10-03：Worker 实例 fencing 修正完成：每个 Worker 的消息处理器只接受仍为当前实例的消息，旧 Worker 的 `ready/status/events/final/error` 和错误事件不会覆盖新 Worker；浏览器 E2E 增加 late-message 回归。focused 浏览器 E2E 为 2 passed、0 failed。该修正后连续无修改审计计数保持 0，后续必须重新完成三轮只读审计。
- 2026-10-03：第 2 轮只读审计发现 Phase 1/Phase 3 阶段摘要仍把早期的 17 个 backend tests 和 1 个 browser E2E 写成当前结果；已改为最近一次记录的 20 个 backend tests 和 2 个 browser E2E，并保留历史验证记录。该文档事实修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 `protocol.md` 将当前 LLM message 的 `content` 写成 JSON-safe 值，而 `protocol.mjs` 实际只接受有 64 KiB 限额的文本字符串；已同步协议描述，并保留 assistant `toolCall` 的 allowlist 说明。该文档事实修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 2 轮只读审计发现 Worker 只在收到换行或流结束时检查 NDJSON 行长度，持续的无换行 partial line 可能先无限增长并绕过 `maxResponseLineBytes` 的内存上限语义；已记录该缺口，随后修复 Worker 的 partial-buffer 检查并增加回归覆盖。本次发现使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：partial-buffer 修正已完成：Worker 在每次网络读取后检查未终止 NDJSON 行的 UTF-8 大小；浏览器 E2E 新增超过 1 MiB 且没有换行的 stream 回归。
- 2026-10-03：修正后的第 1 轮只读审计发现新增 partial-buffer 浏览器回归后，Phase 3 阶段摘要仍记为 2 个 browser E2E；已更新为最近一次的 3 passed，并把旧数量留作阶段历史。本次文档修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：修正后的第 1 轮只读审计发现已终止 NDJSON 行在长度校验前先执行 `.trim()`，超长空白填充的物理行可绕过 `maxResponseLineBytes`；已记录该缺口，随后改为按原始物理行字节数校验，并把超长终止行与超长未终止行合并到同一个浏览器回归用例。本次发现使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：原始物理行长度修正后的 focused 验证已通过：PoC 5 个 JavaScript 文件通过 `node --check`；backend contract tests 为 20 passed、0 failed；浏览器 E2E 为 3 passed、0 failed，覆盖超长 terminated 和 unterminated NDJSON 行。当前重新开始修正后的第 1 轮只读审计，连续无修改计数为 0。
- 2026-10-03：重新开始的第 1 轮只读审计发现协议声明 `maxDurableSessionEvents = 1,000,000`，但 `append` 未限制可见 Session 总事件数；超过上限的事件可以被 flush，随后又会被启动加载器拒绝，导致重启后无法恢复该 Session。已先登记该问题；本次发现使连续无修改审计计数重置为 0，下一步补齐 append 上限和回归测试。
- 2026-10-03：已修复 durable Session event 上限缺口：`append` 在 batch 校验后、写入可见日志前拒绝超过 `MAX_DURABLE_EVENTS` 的结果，并新增回归测试确认失败保持日志长度不变。修复后 5 个 PoC JavaScript 文件通过 `node --check`，backend contract tests 为 21 passed、0 failed；连续无修改审计计数仍为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 Worker 对 LLM NDJSON `error` item 只检查 `code`/`message` 字段存在，未验证字符串类型和文本上限；异常响应可把对象或超长值带入本地错误状态。已先登记该问题；本次发现使连续无修改审计计数重置为 0，下一步补齐 error item schema 校验和回归覆盖。
- 2026-10-03：已修复 LLM NDJSON `error` item 校验：`code` 必须是受限非空字符串，`message` 必须是受限文本；新增 malformed error browser regression。修复后 5 个 PoC JavaScript 文件通过 `node --check`，backend contract tests 为 21 passed、0 failed，browser E2E 为 4 passed、0 failed；连续无修改审计计数仍为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 Worker 仅限制单条 NDJSON 行和 item 数量，未限制整个 LLM response 的累计字节数；按现有限额仍可让 Worker 保留不受控的大响应。已先登记该问题；本次发现使连续无修改审计计数重置为 0，下一步增加累计 stream limit 和回归测试。
- 2026-10-03：已补齐 LLM response 累计字节上限：Worker 现在限制单行、item 数量和每个 response 的 8 MiB 总字节数；协议限额表已同步，新增 cumulative stream regression。修复后 5 个 PoC JavaScript 文件通过 `node --check`，backend contract tests 为 21 passed、0 failed，browser E2E 为 5 passed、0 failed；连续无修改审计计数仍为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 Phase 1/2/3 顶部摘要仍保留旧的 20/1/3 测试数字，和当前实现及历史日志不一致；已统一为当前 backend 21 passed、browser 5 passed，并保留旧数字为历史记录。本次文档修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 Phase 2 退出条件仍写成“无 Tool agent turn”，而当前实现验证的是 `LLM → browser_echo → LLM`；已改为包含 `browser_echo` Tool 的 agent turn。本次文档修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现 `protocol.md` 的 `LlmWireError` 声明了当前 Worker exact-key 校验不接受的可选字段 `status`、`requestId`、`retryable`；已先登记该不一致，下一步收窄当前 PoC DTO 并标明未来扩展必须另行登记。本次发现使连续无修改审计计数重置为 0。
- 2026-10-03：重新开始的第 1 轮只读审计发现 `change-ledger.md` 的 BN-DOC-000 使用裸版本 `0.2.0-rc.2`，与当前可重放的 `dsh-v0.2.0-rc.2` tag 约定不一致；已统一为完整 tag 名称。本次文档修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：第 2 次只读检查发现 `progress.md` 的实现目录注释把 `protocol.mjs` 写成 Node/browser 共用模块，但实际 Worker 使用独立 browser-local guards，只有 backend 和 Node tests 导入它；已修正注释以匹配当前依赖关系。本次文档修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：修复后的第 1 轮只读审计发现 Worker 在 `tool.result` 已持久化但 `assistant.final` 尚未写入时，恢复路径仍按第一轮 Tool call 处理，无法完成中断回合。已先登记该缺口；本次发现使连续无修改审计计数重置为 0，下一步增加“从已完成 Tool 结果继续请求 final”分支和浏览器回归。
- 2026-10-03：已修复中断回合恢复：若最后一个 Tool call 已有 durable `tool.result` 且没有 final，Worker 直接请求 final，不重放 browser Tool；新增 seeded Session browser regression。修复后 5 个 PoC JavaScript 文件通过 `node --check`，backend contract tests 为 21 passed、0 failed，browser E2E 为 6 passed、0 failed；连续无修改审计计数仍为 0，必须重新完成三轮只读审计。
- 2026-10-03：重新开始的第 1 轮只读审计发现新增 durable Tool result recovery regression 后，Phase 2/3 顶部摘要仍写 5 个 browser E2E；已更新为当前 6 passed，并补充该回归覆盖。本次文档修正使连续无修改审计计数重置为 0，必须重新完成三轮只读审计。
- 2026-10-03：修复后的第 1 轮只读审计发现页面的 `window.__browserNativePoc.state()` 在 Worker 启动后仍返回空 `sessionId`，虽然输入框和 Worker 使用了实际 Session id；已先登记该 projection 缺口，下一步同步页面状态并增加回归断言。本次发现使连续无修改审计计数重置为 0。
- 2026-10-03：已修复页面 state projection：初始化和每次安装 Worker 时都写入实际 `sessionId`，browser regression 增加对应断言。修复后 5 个 PoC JavaScript 文件通过 `node --check`，backend contract tests 为 21 passed、0 failed，browser E2E 为 6 passed、0 failed；连续无修改审计计数仍为 0，必须重新完成三轮只读审计。
- 2026-10-03：修复后的第 1 轮只读审计发现文档把 owner `generation` 写成跨重启必然递增的全局值，但当前 backend 只在 flush 时持久化 generation；未 flush 的 owner claim 在重启后可能重复数值，旧 token 仍会被进程重启 fencing。已先登记该语义缺口，下一步同步 protocol/implementation plan 的 generation 说明。本次发现使连续无修改审计计数重置为 0。
- 2026-10-03：generation 语义已同步到 `protocol.md` 和 `implementation-plan.md`：当前 backend 只保证当前状态中的递增，不把未 flush claim 的数值连续性写成跨重启保证。随后运行 `pnpm run test:docs`（21 passed、0 failed、0 skipped）和 `pnpm run doc-sync`（43 passed、0 failed、0 skipped）；focused 结果仍为 5 个 PoC JavaScript 文件通过 `node --check`、backend 21 passed、browser 6 passed。现在开始修复后的连续三轮只读检查，计数为 0。
- 2026-10-03 17:33 CST：连续三轮只读审计完成，期间没有发现需要修改的内容。第 1 轮检查了当前测试摘要、7 个 PoC JavaScript 的语法、backend contract tests（21 passed）和 browser E2E（6 passed）；第 2 轮交叉核对了实现路由、协议限额、PoC-local/真实 DSH 边界和文档门禁，`pnpm run test:docs` 为 21 passed、0 failed、0 skipped，`pnpm run doc-sync` 为 43 passed、0 failed、0 skipped；第 3 轮验证了 README 启动 smoke、health/静态页面/Session create-append-flush-stat、13 个文件的尾换行、`git diff --check` 和目录范围。三轮均无发现、无修复，审计计数达到 3；当前仍只包含 `docs/drafts/browser-native-dsh-poc/` 内的变更。
- 2026-10-03：复核用户提供的 backend provider 配置，先以不打印凭据的方式验证 `/v1/models` 和 `gpt-5.6-sol` Chat Completions 可用；此前 PoC 仅允许 `poc-scripted`，不能宣称真实 LLM 已完成。
- 2026-10-03：新增 real provider route：backend 读取显式 `--env-file` 或环境变量，按 model 选择 GPT/Grok key，向 OpenAI-compatible Chat Completions 发送固定 `browser_echo` tool schema，解析 SSE tool call/text delta，再输出浏览器协议 NDJSON；浏览器和 Session event 中不出现 provider secret。
- 2026-10-03：首次真实 provider Playwright E2E 因上游默认推理耗时超过 180 秒失败；诊断确认 loop、Tool bridge 和 Session 没有错误，真实 backend 浏览器流程随后完成。为减少 real E2E 的无界等待，GPT provider request 明确发送 `reasoning_effort: low`，Grok 可由环境变量覆盖。
- 2026-10-03：`tests/browser.real.e2e.mjs` 使用真实 Chromium、真实 backend、真实上游模型和真实 JSON Session store 通过：`1 passed、0 failed`，观察到 `user.message`、`assistant.tool-call`、`tool.result`、`assistant.final` 四个事件，`durableThroughSeq = 3`；测试输出只报告 mode/provider/model/event types/sequence，不打印凭据或完整 prompt。
- 2026-10-03：用 `run.mjs --llm real --env-file ...` 启动真实 dev server，并用独立 Playwright 脚本连接 `http://127.0.0.1:<port>/` 完成最终验收。默认 `gpt-5.6-sol` 运行通过，真实浏览器观察到 `browser tool: browser_echo` 和 `completed`，Session 读取到四个连续事件，`durableThroughSeq = 3`，config response 未暴露 `apiKey`。同一验收期间 provider 曾有两次超过 180 秒未返回的尝试，随后重试成功；这属于上游服务延迟波动，不能被 PoC 当作稳定性保证。
- 2026-10-03：再次用实际 `run.mjs` dev server 和真实 Chromium 做状态轮询验收，通过两次真实 LLM 请求完成 `user.message → assistant.tool-call → tool.result → assistant.final`，浏览器无 page error，Session read 返回 `durableThroughSeq = 3`。随后复跑目录内 `tests/browser.real.e2e.mjs` 时，固定 180 秒等待的两次尝试都因上游首轮响应延迟超时；这不否定已成功的真实 dev-server 闭环，但说明当前 real provider 测试不能作为稳定 SLA，后续应增加显式 upstream timeout/retry 和诊断耗时记录。文档门禁同时通过：`pnpm run test:docs` 为 21 passed、`pnpm run doc-sync` 为 43 passed，8 个 PoC JavaScript 文件通过 `node --check`，无残留 dev server。

## 恢复入口

下一次继续工作时，先阅读本文件，然后检查：

```text
git -C /Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-browser-native-poc status --short --branch
git -C /Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-browser-native-poc diff --stat
```

再从本文件最后一个未完成阶段继续；不要假设未记录的命令、测试或实现已经发生。

## Dev Note

本文是实施记录，不是稳定架构文档。每个阶段完成关键性进展后先更新本文件，再执行下一阶段；命令、结果和失败原因必须记录为当前事实，不能把计划性措辞写成已完成能力。
