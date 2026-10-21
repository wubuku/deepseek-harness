---
description: "Browser-Native DSH 下一轮高价值验证规划：验证 DSH 在浏览器 Worker 中的能力一致性、工具闭环、生命周期和浏览器差异。"
---

# Browser-Native DSH 下一轮验证规划

## Summary

`docs/drafts/browser-native-dsh-poc` 的主要问题不是再做一个 SaaS 聊天演示，而是小心求证：DSH 默认运行在非浏览器主机中时，哪些运行时能力可以迁移到浏览器 Dedicated Worker，哪些能力必须裁剪、替换或明确不支持，以及在刷新、终止、网络退化和多标签并发下能否保持诚实的 Session 语义。

本计划以真实 DSH Cordis Host、真实 `ctx.agentLoop`、浏览器 Worker、同源 LLM proxy、Session persistence 和真实浏览器为验证对象。SaaS/Agentic UI 联动只作为可选外部价值实验，不作为本 PoC 的主要完成条件，也不重新建设已有的 SaaS 对照场景。

每个实验先定义可观察证据，再执行 scripted 对照和真实 LLM 实验。未执行的项目保持“未验证”；架构推断不能替代浏览器和 Session 证据。默认不修改 DSH Agent Loop 核心语义；如果 profile、provider 或持久化扩展点不足以表达浏览器语义，记录缺口和最小修复方向，不用 UI 或提示词掩盖缺口。

执行范围调整：Chrome 长回复流式 UI 已完成真实模型验证；后续验证和回归只使用 Chrome。Safari.app 测试按用户要求暂停，Playwright WebKit 已有结果仅作为既有对照，不在本轮扩展复测。恢复 Safari 测试需要先单独处理 WebDriver 长文本输入超时。

## Table of Contents

- [一、验证问题和判断标准](#一验证问题和判断标准)
- [二、共同证据和实验纪律](#二共同证据和实验纪律)
- [三、批次一：能力一致性和正向执行](#三批次一能力一致性和正向执行)
- [四、批次二：生命周期、恢复和并发](#四批次二生命周期恢复和并发)
- [五、批次三：浏览器差异和运行边界](#五批次三浏览器差异和运行边界)
- [六、实施顺序和退出条件](#六实施顺序和退出条件)
- [七、交付物和范围约束](#七交付物和范围约束)

## 一、验证问题和判断标准

本轮回答以下浏览器运行时问题，而不是回答“聊天 UI 是否好看”：

1. **能力声明是否诚实。** 第一次模型请求中的工具 schema、profile/preset composition、Worker provider 和实际执行能力是否一致。不可用的主机 `bash`、Node-only 网络工具或缺少凭据的搜索工具不能只依赖模型自行猜测。
2. **真实 DSH Loop 是否在 Worker 成立。** Agent 是否能在浏览器 Worker 中完成多轮上下文、流式文本、工具调用、工具结果回传、工具失败后的终止或恢复，并把模型可见事实写入 Session。
3. **浏览器可用工具是否有正向闭环。** 至少验证 Worker VFS 中的读取、写入和查询类工具，以及一个 DSH 内置状态工具；区分浏览器 VFS、Session JSON 文件和用户本机文件系统，不能把它们混称为“文件系统持久化”。
4. **生命周期语义是否可解释。** 刷新、页面卸载、Worker terminate、backend 重启、网络中断、取消和重新连接分别能恢复什么，不能恢复什么；未 flush 的尾部、进行中的工具等待和页面 JavaScript 函数不能被伪称为可恢复。
5. **写权和迟到结果是否安全。** 双标签页、旧 lease、重复 request、迟到的工具结果和重连是否不会越过 Session 写权；detach/unsubscribe 不得等同于用户 stop。
6. **不同浏览器是否暴露不同边界。** Chrome/Chromium 与 WebKit 自动化结果必须分别记录；WebKit 结果不直接等同于真实 Safari.app，真实 Safari 只在实际执行后声明。
7. **浏览器化成本是否可控。** 主机工具的裁剪、Browser-specific preset、Worker provider 和 Session persistence 是否能通过现有扩展点实现；需要复制主机环境或修改核心 Loop 才能成立的能力要标记为高成本或不支持。

能力结论使用四种状态：`已验证`、`部分验证`、`未验证`、`明确不支持`。每个状态必须附带实验入口、浏览器类型、LLM 模式和 Session 证据。

## 二、共同证据和实验纪律

### 2.1 对照和运行模式

每个需要比较的实验保留以下对照：

- **当前原始 roster：** 记录现有 profile/preset 让模型看到的工具，以及 Worker 实际能执行的工具，用于暴露能力不一致。
- **Browser-specific roster：** 通过 profile/preset 裁剪或替换不可用的主机工具，只声明已经验证的浏览器能力，用于验证配置修正是否减少无意义尝试。
- **真实 DSH 执行：** 使用正式 Worker Host 和 `ctx.agentLoop`；不得用历史自写 loop 协议实验替代 v2 证据。

脚本模型只用于稳定协议、错误和恢复测试；真实 LLM 结论必须同时有真实浏览器、真实模型请求和 Session 事件证据。SaaS 联动若执行，只能作为独立附录，不得改变主线验收标准。

### 2.2 共同观测字段

每次实验保存脱敏 manifest、命令、浏览器类型、页面 URL、日志和必要截图，至少包含：

- `sessionId`、`requestId`、`ownerToken` 的脱敏标识、Session `seq`、turn/step、事件类型；当前实现没有 owner generation/epoch，不得虚构该字段。
- 模型请求次数、输入消息摘要 hash、工具 schema 摘要、tool call id、工具实际执行次数、结果状态和错误分类。
- 页面、Worker、backend 的请求 id；取消发起时间、收到时间、连接关闭和重连时间；是否执行 `flush`。
- durable Session 文件中的事件与内存事件的差异；刷新/重启前后是否出现重复 user message、tool call 或模型请求。
- 浏览器 console/page error、网络请求、Worker error、主线程响应和测试脚本版本。

所有报告必须区分“请求已被 backend 接收”“Session 已 append”“Session 已 flush 到磁盘”“模型已生成最终回复”四个阶段。

### 2.3 失败分类

统一区分：配置未声明、模型选择错误工具、工具运行时不支持、工具参数错误、用户取消、Worker 终止、lease 冲突、网络/LLM 错误、Session 未 flush 和未知结果。不要把这些失败统一显示为“Agent 失败”，否则无法判断浏览器能力边界。

## 三、批次一：能力一致性和正向执行

批次一先证明“浏览器中有什么能力”，再证明真实 Loop 能使用这些能力。

### 3.1 工具 roster 审计

从当前 overlay、base Web roster、standard preset 和实际第一次 `/api/browser-native/llm` 请求生成工具清单，逐项标记 provider 所在执行平面、Worker 依赖、所需凭据和已知限制。复现一次原始 roster 下模型尝试不可用工具的行为；再用 Browser-specific overlay 做最小裁剪，比较请求 schema、工具调用次数和最终错误。

验收证据：模型请求中的工具清单、Cordis composition、Worker provider 日志和 Session 工具事件相互对应；不能只根据模型回答声称“没有该工具”。

### 3.2 Worker VFS 正向工具闭环

选择不依赖本机文件系统的最小文件场景：读取已存在的 VFS fixture，写入一个新文件，重新读取并查询匹配内容。通过真实 DSH tool call 完成 `LLM → Worker tool → result → LLM → final`，记录 VFS 数据、Session 事件和刷新后的可见性。

验收证据：工具 call id 在模型请求、Worker 执行、Session result 和最终投影中一致；重复发送或重连不会重复写入；明确写入的是 Worker/VFS 数据，不承诺写入用户本机磁盘。

### 3.3 多轮、流式和内置状态工具

在同一 Session 内执行至少三轮：第一轮写入一个随机标识或 todo，第二轮只引用该事实，第三轮要求总结。观察文本是否逐块呈现、Session 是否按顺序记录，以及刷新后是否能从 Session 重建模型可见上下文。工具调用应至少覆盖一个 DSH 内置状态工具，例如 todo/询问类能力；若某工具需要页面交互，单独标记其等待状态。

验收证据：第二轮不依赖页面内存中的隐藏变量；模型请求消息可从 Session 事件重建；没有第二个独立模型历史。

### 3.4 失败、停止和继续

构造三类失败：模型选择被裁剪的工具、工具参数错误、真实工具执行错误。分别验证 Loop 是否将错误交回模型、何时停止、用户发送后续消息能否继续，以及 stop 是否只取消当前 turn。不要预设“错误后固定重试一次”；记录实际 DSH Loop 语义和模型选择。

验收证据：失败事件有明确错误分类；失败后 Session 仍可继续或明确进入不可继续状态；停止不会删除已持久化的历史。

## 四、批次二：生命周期、恢复和并发

批次二验证 Browser-Native 不是只在页面一直打开、网络一直正常时成立。

### 4.1 刷新与 Session 重连

在一轮已 flush 的多轮对话后刷新页面，重新连接同一 `sessionId`，验证历史、工具结果和模型可见上下文。再在模型流式输出中刷新，区分已 flush 事件和丢失尾部；不声称刷新能够恢复原 Worker 中的 Promise 或未落盘工具等待。

### 4.2 Worker terminate 和页面卸载

在工具等待、模型流式输出和空闲三种时点主动 terminate Worker 或关闭页面，记录 backend lease、Session flush 和残留 waiter。重新打开 Session，验证它显示的是已持久化事实和可继续性，而不是假装原执行仍在后台运行。

### 4.3 backend 重启与 lease 边界

在已 flush Session 后重启 backend，验证新 backend 能读到正式 Session 文件；在 lease 未过期时用另一个连接尝试写入，验证冲突；等待或模拟 lease 过期后重新 claim，验证旧 token 的迟到写入被拒绝。当前实现只有 backend-instance token 和 lease，没有跨重启 generation/epoch，报告必须明确这个限制。

### 4.4 网络退化、取消和恢复

分别中断 LLM 请求、Session append/flush 请求和页面连接，观察取消传播、错误 settlement、lease 释放和后续消息。比较用户 stop、网络断开、页面 detach 三种路径；验证同一个 `requestId` 重试是否会产生重复请求或重复副作用，并记录当前实现没有 requestId 去重/结果重放时的风险。

### 4.5 双标签页

两个真实浏览器标签页连接同一 Session：一个持有 write lease，另一个只读观察或尝试写入；验证历史同步、冲突提示、旧页面恢复和关闭后的重新 claim。不要把 `session/list` 中固定的 `running`/`agentAvailable` 字段当作实时活动状态。

## 五、批次三：浏览器差异和运行边界

### 5.1 当前 Chrome 范围与跨浏览器延期项

本轮后续自动化只使用 Playwright Chrome。既有 Playwright WebKit 和 Safari.app 结果保留为历史对照，不在当前批次复跑；WebKit 结果不能代替 Safari.app 验收。只有单独重新确认测试范围后，才继续比较 Worker、Streams、structured clone、crypto、timers、VFS 和页面卸载行为差异。

### 5.2 性能与主线程响应

在不扩大功能范围的前提下测量 Worker 启动到 Host ready、第一次模型请求、首个文本块和最终 Session flush 的时间；在流式输出和工具等待期间检查输入框、停止按钮和页面滚动是否仍响应。长上下文、多个 Worker 和大 VFS 只做小规模边界实验，不把一次机器上的时间写成产品 SLA。

增量实验使用独立 [`runtime-streaming.e2e.mjs`](tests/runtime-streaming.e2e.mjs)：让真实模型输出足够长的逐行文本，在每个动画帧采样 assistant 正文，要求 turn 结束前已出现多个不同长度的画面；同时验证输入草稿、滚动和 Stop 按钮。它与短 marker 工具实验分开，避免以单次最终更新判断流式能力。旧 owner 的迟到 close 则通过可注入时钟的 backend 测试验证拒绝后新 owner 仍能 append、flush 和 renew。

### 5.3 浏览器存储能力边界

使用 [`browser-storage-boundary.e2e.mjs`](tests/browser-storage-boundary.e2e.mjs) 分别探测 `navigator.storage.estimate()`、持久化状态和 OPFS 基本读写；该实验只说明浏览器是否提供存储能力，不把 OPFS 当作 DSH VFS 或 Session durability，也不把一次配额估计当作生产容量保证。

### 5.4 可选 SaaS 联动

如前两批稳定，可增加一个极小的 mock SaaS 只读/确认场景，用来观察 Browser-Native capability 如何接入页面；它只作为外部价值附录，不能替代 VFS、Session、工具 roster、恢复和浏览器兼容性结论，也不复制已有 `saas-agentic-ui-comparison-poc` 的复杂业务实验。

## 六、实施顺序和退出条件

按以下顺序实施，每完成一个里程碑更新 `next-validation-progress.md` 和脱敏证据：

1. 完成工具 roster 审计和 Browser-specific overlay 的最小可复现实验。
2. 完成真实 Worker VFS 工具闭环、多轮/流式/状态工具和失败后继续。
3. 完成刷新、Worker terminate、backend 重启、lease、取消和双标签页的脚本或手动证据；无法稳定自动化的路径记录手动步骤和限制。
4. 完成 Chrome/Chromium 的最小运行时验证并测量启动、首块输出和 flush 延迟；跨浏览器差异测试保留为后续延期项，不阻塞本轮退出。
5. 汇总已验证/部分验证/未验证/明确不支持矩阵，修订 README、手动验收说明和 `docs/drafts/README.md` 入口链接。

本轮可以退出的条件是：主线实验均有实际命令和证据；失败和未执行项没有被写成通过；已发现的限制对应到 profile/provider/Worker/backend 的具体位置；没有因为 SaaS demo 的视觉效果或聊天气泡渲染而提前宣布 Browser-Native 成功。

## 七、交付物和范围约束

交付物包括：本规划、`next-validation-progress.md`、按批次保存的脱敏结果或汇总、必要的 docs-local 测试/脚本、README 更新、手动验收步骤和研究索引更新。新增代码优先放在 `docs/drafts/browser-native-dsh-poc/`；若必须修改 `apps/web`、packages 或根配置，先在 `change-ledger.md` 说明原因、验证和可回放方式。

不得修改已有 assistant-ui/CopilotKit PoC 来制造对照，不得把历史自写 loop 当作正式 DSH 证据，不得提交 `docs/drafts/.env` 或任何密钥，不得把 Worker 描述为页面关闭后仍运行的后台 Agent。SaaS 联动可以保留为低优先级附录，但不能改变本计划的浏览器运行时主线。
