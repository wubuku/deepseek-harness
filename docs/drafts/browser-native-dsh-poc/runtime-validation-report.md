---
description: "Browser-Native DSH v2 下一轮运行时验证结果：记录真实 Worker/Agent Loop、工具、Session、生命周期和浏览器差异的证据与限制。"
---

# Browser-Native DSH v2 运行时验证报告

## Summary

本报告记录截至 2026 年 10 月 21 日的 Browser-Native DSH v2 运行时验证。目标是确认现有 DSH Cordis Host、插件和 `ctx.agentLoop` 是否能在浏览器 Dedicated Worker 内工作，并明确浏览器工具能力、Session durability、VFS 易失性和页面生命周期边界；SaaS 业务 GUI 联动不属于本轮主验收。

验证使用真实 DSH Web UI、真实 Worker Host、同源 LLM/Session backend、真实浏览器以及真实模型后端。此前 Chrome 与 Playwright WebKit 的对照均记录了 VFS `read → write → read`、三轮对话和刷新恢复；按用户要求，本轮后续测试暂停 Safari.app 和 Playwright WebKit，只继续使用 Chrome。最新 Chrome Browser-specific E2E 复测了 VFS、Session 记忆和刷新后的 VFS 易失性；另一个基础 E2E 完成三轮真实聊天和 todo 工具。Chrome 真实 Stop/恢复与长回复流式 UI 也有新证据。Scripted Chrome 生命周期测试覆盖刷新续聊、Stop、写租约冲突、模型请求失败后恢复、backend 重启和 Worker 强制终止后的 lease 回收。

结论是：**DSH 的选定运行时组合已在 Dedicated Worker 中跑通真实 Agent 回路；这不是把完整 Node DSH 搬进浏览器，也不是浏览器可持续后台执行的产品级 Agent。**Session 可以由同源 backend flush 后恢复，Worker VFS 不会随页面刷新持久化。WebKit 自动化通过不等于 Safari.app 验收，生产级持久化、授权、跨进程租约、Exactly-once 和性能目标仍未证明。

## Table of Contents

- [验证范围](#验证范围)
- [代码考古](#代码考古)
- [实验设计](#实验设计)
- [结果矩阵](#结果矩阵)
- [失败与差异](#失败与差异)
- [结论与后续](#结论与后续)

## 验证范围

| 验证项 | 本轮范围 |
|---|---|
| Agent 执行位置 | 现有 DSH Cordis Host、插件树和 Agent Loop 在 Dedicated Worker；Main Thread 提供 DSH Web UI。 |
| 模型连接 | Node backend 读取本机 `docs/drafts/.env`，浏览器只请求同源 `/api/browser-native/llm`。 |
| Session | DSH 正式 Session event DTO，经正式 `SessionPersistence` provider 写到 PoC JSON backend。 |
| 浏览器工具 | Browser-specific 临时 profile 只暴露经过筛选的 VFS 文件工具、搜索工具和 todo；真实闭环专项断言 `read`、`write`、`read`。 |
| 页面生命周期 | 刷新、Stop、双页面写权竞争、backend 重启、Worker terminate；不把 Worker 当作后台服务。 |
| 不在范围 | 生产 SaaS API、Agentic UI 业务集成、跨设备 Workspace、生产多租户与 HA；Safari.app 工具输入只完成部分验证，OPFS 只完成能力探测。 |

本次验证是 PoC checkout 的真实执行结果，不由 preview fixture 的历史消息推导。证据摘要可复核于 `/tmp/dsh-browser-next-validation/` 下的构建、contract、runtime 和 lifecycle 日志；临时日志不作为仓库持久化证据，本文保存了必要的脱敏结果和边界。

## 代码考古

`apps/web/src/preview.ts` 在 preview 页面实例化 docs-owned Worker，并沿用 `connectWorkerHost`、既有 Web Client 启动顺序和 VFS preview image。`browser-native=1` 才追加 Browser-Native overlay；overlay 切换模型和 Session provider，不替换 DSH Agent Loop。

`browser-native-worker.ts` 通过 `createWorkerHost()` 加载实际 Cordis Host 和 Browser-specific static modules；`browser-native-providers.ts` 提供 DSH 正式 `LlmAdapter` 和 `SessionPersistence` 的远端实现。真实文件读写测试镜像由 `runtime-validation.mjs` 临时组装，使用独立 `runtime-validation.cordis.patch.yml`；当前正式 PoC overlay 也已覆盖 `preset-standard`，实际 roster 和本批证据见[运行范围验证进度](operational-envelope-validation-progress.md)及[插件兼容矩阵](operational-compatibility-matrix.md)。测试不会修改共享 VFS build output。

`backend-v2.mjs` 只在 Node 进程加载真实模型凭据，并将 Session JSON 的 `durableThroughSeq` 与真实文件内容作为 durability 证据。`append` 只表示当前 backend 内存接受事件；测试中显式验证文件 flush 与 backend 重启恢复。测试也发现 `listen(0)` 必须返回实际系统分配端口，backend 已修正为读取 `server.address().port`。

`apps/web/src/browser-native-page-control.ts` 通过 `MessageChannel` 收取 Worker owner token，存入 tab-scoped `sessionStorage`，刷新后交给新 Worker；`pagehide` 使用 close beacon 请求 flush/释放。`preview.ts` 在 Browser-Native opt-in 页面卸载时 terminate 页面拥有的 Worker；若该页面正等待 boot payload，只忽略卸载阶段特定的 tunnel boot failure，活动页面的启动错误仍会抛出。该 bridge 位于 Web TypeScript 项目内，因为推送钩子的项目类型检查拒绝从 `docs/drafts` 导入项目外源码。复查发现旧刷新测试在 `page.reload()` 后又调用含 `page.goto()` 的 `openPreview()`，Worker terminate recovery 也曾有同样的双重导航；两处改为只等待已加载页面后，WebKit scripted 五次连续刷新和真实 Chrome/WebKit 各两次刷新均未出现该 503。该证据支持测试夹具双重导航是此前复现条件，但不能证明所有浏览器卸载竞态都已消除。强制进程退出和浏览器崩溃仍不能保证 unload beacon 完成。

`symbol-dispose.ts` 在 Worker realm 缺少 `Symbol.dispose` / `Symbol.asyncDispose` 时补上 registry symbols，不覆盖现有原生实现；Worker 入口最先加载此兼容模块。对应单测和真实 WebKit Session 启动均通过。

## 实验设计

### 真实模型 VFS 与窗口记忆

第一轮真实 prompt 要求 Agent 读取 `/dsh/home/browser-validation/input.txt`，用 DSH `write` 工具创建 `/dsh/home/browser-validation/output.txt`，写入随机 token 和固定结果文本，再用 DSH `read` 工具回读。第二轮不重复给 token，要求 Agent 从同一 Session 记忆中恢复 token，且不调用工具。之后刷新页面，在原 Session 发送第三轮，要求 Agent 重新读取刚才写入的路径并报告实际结果。

自动断言核对模型实际收到的工具 schema、首轮 read/write/read 的调用参数、每个 `tool/call` 对应的同一 call id `tool/result`、错误标记、token、第二轮没有额外工具调用、第三轮 VFS 探测、Session 终态、同源 LLM origin、provider secret 未进入浏览器网络记录，以及 Session 文件中的 `durableThroughSeq`。

### 生命周期与异常恢复

scripted 浏览器 E2E 走真实 DSH UI 和 Worker，但模型响应可控。每个独立 E2E 进程使用动态 loopback port 和私有临时目录。生命周期脚本依次刷新并续聊、通过真实 Stop 按钮取消、让竞争页面尝试获取同一 Session 写权、注入单次 LLM 请求故障、确认下一轮成功、关闭并重启 backend、强制 terminate Worker、等待 lease 过期后重新 claim，再恢复同一 Session。

### 浏览器安全观测

真实模型测试读取浏览器请求列表和 provider 凭据环境文件，仅检查密钥是否意外出现在请求或日志内容中，不输出密钥。LLM 请求 origin 必须仅等于当前 preview 的 loopback origin。真实模型命令通过 Node 环境代理选项运行；缺代理时的超时记录为测试环境失败，不算功能通过。

## 结果矩阵

| 能力 | 状态 | 实际证据 |
|---|---|---|
| 真实 DSH Agent Loop 在浏览器 Worker 执行 | 已验证 | 真实 Chrome/WebKit 中实际产生模型请求、工具调用、工具结果、assistant 消息和 `turn/end`；测试路径未使用 PoC 自写 Agent Loop。 |
| 历史 Browser-specific validation roster | 已验证（独立测试配置） | 先前 Chrome/WebKit 请求只见 `edit`、`glob`、`grep`、`read`、`read_image`、`todo_write`、`write`；没有 `bash`、`web_search`、`web_fetch`。当前 PoC 默认 profile 有另一份经 Chrome 验证的 roster，见[兼容矩阵](operational-compatibility-matrix.md)。 |
| VFS 正向 read/write/read | 已验证 | Chrome 与 WebKit Session 均有匹配 call id 的成功工具结果；随机 token 和写入内容与断言相符。 |
| 多轮 Session 窗口记忆 | 已验证 | 刷新前后同一个 Session 的第二轮在无新工具调用时回忆第一轮随机 token。 |
| Session flush 与 backend 重启恢复 | 已验证（PoC backend 范围） | JSON 文件 `durableThroughSeq` 等于最终事件尾；scripted 生命周期在 backend 重启后继续同一 Session。 |
| Worker VFS 跨刷新持久化 | 配置相关 | memory-only 模式刷新后文件返回 `FS_NOT_FOUND`；durable Workspace 模式中已提交的 `/dsh/home/workspace` 文件可从 OPFS/IndexedDB hydrate 并在刷新后读取。其他 VFS 路径不因此获得持久化保证。 |
| Scripted 流式 UI | Chrome 已验证 | Chrome 动画帧采样观察到 8 次递增 assistant DOM 更新；脚本模型每个文本块延迟 120 毫秒，避免输出在 UI 首次刷新前结束。既有 WebKit 数据仅作对照。 |
| 真实模型流式 | Chrome 已验证（长回复） | 真实 Chrome 生成 9,523 字符，观察到 84 次递增 assistant DOM 样本、约 15.8 秒流式跨度、输入草稿交互约 20 毫秒、滚动位置变化和空 long-task 记录；WebKit/Safari 流式表现未由本轮验证。 |
| Stop、失败后继续、双标签写权冲突 | Chrome 已复测（scripted） | Chrome `turn/end` 记录 `aborted`、`error` 和后续 `completed`；竞争写入收到 `SESSION_ALREADY_OWNED`。WebKit 既有 scripted 结果仅作历史对照。 |
| 真实模型 Stop 后恢复 | Chrome 已复测 | 最新 Chrome 独立 E2E 记录同一 Session 的 `aborted → completed`，`durableThroughSeq=25`、两个模型请求 HTTP 200、page error 为空。此前一次恢复请求产生空 assistant message，见下文；改动后的成功运行不代表稳定性分布。 |
| Provider 空完成 | 已处理并覆盖代理 contract | 无文本、无工具调用的上游 `finish_reason=stop` 或空 `[DONE]` 现在返回 `UPSTREAM_LLM_EMPTY`，不再被包装为空 assistant 成功；backend contract test 覆盖两条终止路径。有内容但缺 finish event 的 `[DONE]` 会补发 finish chunk。 |
| 强制 Worker terminate、lease reclaim | Chrome 已复测（scripted） | Chrome 强制 terminate 后等待 owner lease 到期、重新 claim 并继续同一 Session；WebKit 既有结果仅作历史对照。 |
| provider secret 不进浏览器 | 已验证（单次 PoC E2E） | 脚本检查真实 provider 凭据是否出现在浏览器 request body；LLM traffic 只到同源 backend。不是通用安全审计。 |
| Safari.app 聊天与刷新恢复 | 部分验证 | Safari 26.6.2 真实 WebDriver 完成三轮真实模型记忆对话和刷新恢复；Safari 工具长文本输入超时，工具闭环仍未验证。 |
| OPFS / 浏览器存储 | 部分验证 | Chrome OPFS 临时文件读写通过；Playwright WebKit 的 OPFS 读写返回 `UnknownError`。两者都不等同于 DSH VFS 或 Session durability。 |
| 生产 durability / HA / exactly-once | 未验证 | PoC backend 只提供本地文件、进程内 owner 和 flush；没有跨进程 fencing、请求去重账本、复制或灾备。 |

2026-10-21 Chrome scripted lifecycle `turn/end` 顺序为 completed、completed、aborted、error、completed、completed、completed，最终 `durableThroughSeq=70`，无 page error；Chrome 新增的 scripted streaming 回归采到 8 次递增 DOM 更新。backend `close()` 主动释放 HTTP keep-alive connections，PoC E2E 正常退出。

2026-10-21 最新 Chrome Browser-specific E2E 完成三轮任务、一次刷新、同 Session token 记忆和 VFS 文件易失性探测；工具调用严格为 `read → write → read`，第三轮 read 得到 missing，Session JSON 有 57 个事件、`durableThroughSeq=56`，8 个模型请求均为 HTTP 200，`pageErrors` 为空。基础 Browser-Native E2E 另完成三轮聊天和恰好一次 `todo_write`，Session 有 40 个事件、`durableThroughSeq=39`。模型工具 roster 中的 `read_image` 等暴露不代表那些工具已验证。

2026-10-24 用户要求重新验证真实 LLM 闭环。第一次 Chrome run 中同源模型请求返回 HTTP 200，但默认 profile 和 Browser-specific 测试都观察到空 assistant 完成；源码检查发现代理在 `[DONE]` 时绕过空内容检查。backend contract test 新增空 `[DONE]` 与有内容 `[DONE]` 场景；修复后默认 Browser profile 的真实 E2E 完成三轮，Session 中恰有一个 `todo_write`，三轮 marker 和记忆断言通过，5 个 LLM 请求均为 HTTP 200。Browser-specific durable Workspace 真实 E2E 完成严格的 `read → write → read`，两次 Workspace commit 均为 HTTP 200，Session 有 59 个事件且 `durableThroughSeq=58`；刷新后同一 Session 回忆 token，并从 OPFS/IndexedDB 恢复已提交文件。该 run 的 8 个 LLM 请求均为 HTTP 200，模型凭据未出现在浏览器请求中，页面无 page error。首次真实响应的原始 SSE 未保存，因此空 `[DONE]` 是由源码路径和合同注入确认的缺陷，不是对首次上游帧的直接抓包证明。

真实 Chrome 长回复实验生成 9,523 个字符，记录 84 次递增 assistant DOM 样本和约 15.8 秒增长跨度；输入草稿交互约 20 毫秒，滚动位置可变，long-task 列表为空，两个模型请求 HTTP 200、page error 为空、turn 为 completed。截图和摘要临时保存在 `/tmp/dsh-browser-native-streaming-evidence-20261021/`。

### 单次真实模型时延观测

本次计时来自同一台开发机上的单次成功运行，只用于后续实验设计，不是产品 SLA。Browser-specific Chrome 工具实验首个 assistant DOM 更新约 11.08 秒、首个 Session text chunk 约 11.06 秒、首轮 settlement 约 11.16 秒；该次 UI 响应探针中的 animation frame 约 19.5 毫秒，Stop 可用。长回复实验记录 84 次 DOM 增长样本、约 15.8 秒可见流式跨度和约 18.8 秒完整 turn。既有 WebKit 短消息时间不作为本轮复测，也不能外推为 Safari 或通用性能结论。

该 Browser-specific Chrome run 首次 flush 约在提交后 91 毫秒开始，末次约 11.06 秒完成。长回复 Chrome 另观察到约 20 毫秒输入草稿交互、可滚动输出和无 long task。样本仍不足以形成性能分布，也不覆盖掉电、进程崩溃或跨进程存储语义。

## 失败与差异

2026-10-21 使用 Safari 26.6.2 真实 WebDriver 完成工作区选择、真实 LLM 三轮对话、Session 记忆和刷新后继续；三轮分别得到 `SAFARI_REAL_FIRST_OK`、`SAFARI_REAL_MEMORY_OK SAFARI_REAL_MEMORY_7F3A` 和 `SAFARI_REAL_REFRESH_OK SAFARI_REAL_MEMORY_7F3A`。尝试继续输入包含三个工具步骤的长 prompt 时，Safari WebDriver 的 `element/value` 请求超过 60 秒且没有产生新的 `user/message`，随后 driver session 需要重启；这次不计为 Safari 工具闭环通过，也不能仅凭 Chrome/WebKit 结果补齐 Safari 工具证据。

新增 `tests/browser-storage-boundary.e2e.mjs`，以真实 Preview 页面探测浏览器的 Storage API 和 OPFS 基本读写；OPFS 若不可用只报告 capability，不把缺失视为 DSH 运行失败。该脚本不会把 OPFS 文件写入 DSH VFS，也不改变 Session JSON 持久化路径。

一次真实 Stop 后的恢复 turn 曾收到上游无文本、无工具调用的完成，旧 backend 将空流转换为空 assistant message，Session 却以 `completed` 结束。代码还存在另一条更早结束路径：收到 `[DONE]` 就正常结束，而没有验证此前是否有文本或工具调用。2026-10-24 两项真实 E2E 首次复测再次观察到 HTTP 200 的空 assistant；首次上游原始 SSE 未保存，不能把它认定为特定终止帧。contract test 复现了空 `[DONE]` 路径后，backend 将空 `finish_reason` 和空 `[DONE]` 归为 `UPSTREAM_LLM_EMPTY`，并为有内容的 `[DONE]` 输出 finish chunk。修复后的默认 profile 和 Browser-specific durable Workspace 真实 Chrome E2E 均通过；Stop/恢复原有复测仍记录 `aborted → completed`。这些是有限次闭环证据，不代表上游稳定性统计。

一次 Browser-specific 真实 Chrome 多工具用例在 240 秒整轮预算到期时仍处于第四个模型步骤，Session 已记录三次成功 VFS 工具调用、没有 `turn/end`，模型 HTTP 响应均为 200。该次不应解读为 Agent Loop 失败。将脚本整轮预算提高到 600 秒后重跑完成，三个真实 turn 都有终态。真实模型延迟变化较大，时间预算不是产品 SLA。

初次真实 Chrome E2E 没有向 Node 进程提供本机代理环境，模型请求在 backend 60 秒 deadline 后返回 `UPSTREAM_LLM_TIMEOUT`。使用本机代理、`node --use-env-proxy` 和加大的测试 timeout 重跑后通过；不带代理的那次失败保留为环境诊断，不计入通过次数。

一次真实 WebKit 运行在工具闭环完成后多做了一次目标文件只读探测，严格工具顺序断言因此失败；测试 prompt 随后明确要求不预读目标文件，Chrome 与 WebKit 重跑均得到准确的 `read → write → read`。模型额外探测作为失败记录保留，不将其混算为通过。

早期 WebKit 刷新测试报告 tunnel boot `HTTP 503`。定位后发现测试在 `page.reload()` 后又通过 `openPreview()` 对相同 URL 再导航一次；Worker terminate recovery 也曾保留同样的双重导航。两处均改为只等待当前页面后，WebKit scripted 五次连续刷新、真实 Chrome/WebKit 各两次刷新以及多次 lifecycle 重跑均无 tunnel boot 503 或 page error。另修正测试 helper：它现在按本次 `user/message` 后的终态等待，并在关闭页面前等待 recovery marker 进入 durable JSON，避免把上一轮 `turn/end` 当作本轮完成。preview 仍在 `pagehide` terminate 所属 Worker，并仅在卸载期间处理特定 boot failure；目前证据没有证明 Safari.app 或任意刷新压力下绝无竞态。

WebKit lifecycle E2E 曾观察到迟到的 `/api/browser-native/session/close` 返回 409。该请求使用旧 owner token，backend 拒绝旧写者覆盖当前 owner，属于过期关闭请求与 fencing 的交错；不会让新 owner 失去写权。这个冲突保留在原始测试摘要，不把它改写为“没有 HTTP 错误”。其他 preview 辅助 endpoints 的 404 也保留记录。

## 结论与后续

本轮支持一个窄而明确的结论：**DSH 选定的 Host、插件、Agent Loop、VFS 工具和正式 Session/LLM provider 能在 Dedicated Worker 中完成真实模型任务；此前 Chrome/WebKit 都有同一 Session 停止后继续的记录，本轮最新 Stop/恢复与 lifecycle 复测只在 Chrome 完成。浏览器化必须通过 profile 明确裁剪工具，并将模型凭据和可恢复 Session 放在同源 backend；Session 记忆和 Worker 文件系统不是同一种持久化。**

按用户要求，本轮新测试只继续使用 Chrome；WebKit/Safari 的旧结果保留为历史对照。跨设备恢复、生产级多租户授权、跨进程 fencing、operation id 幂等、未知副作用恢复和服务端 handoff 仍未验证。

完整可执行命令和人工操作路径见[运行时验证说明](runtime-validation-manual.md)；规划边界见[下一轮验证计划](next-validation-plan.md)，阶段状态见[进度记录](next-validation-progress.md)，目录外代码的维护和删除条件见[变更账本](change-ledger.md)。
