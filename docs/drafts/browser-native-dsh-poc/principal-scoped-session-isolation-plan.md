---
description: "规划 Browser-Native DSH PoC 的 Session principal 授权、浏览器账号切换和本地 Workspace 缓存隔离验证。"
---

# Browser-Native Session 身份隔离验证计划

## 目标

验证同一 Browser origin 轮换 PoC principal 后，Session 历史、工具结果、模型调用与 OPFS/IndexedDB Workspace 缓存不会跨身份读取或写入；旧数据不因切换身份而删除，授权拒绝也不泄露 Session 内容。

本批复用 PoC Workspace identity，不实现用户名、登录、租户管理或生产认证。PoC principal 只用于验证服务端对象授权和本地缓存选择；生产环境必须由正式认证层提供身份并在服务端授权。

## 候选范围与取舍

| 候选验证点 | 价值 | 本批取舍 | 理由 |
|---|---:|---|---|
| Session create/list/open/read/stat/append/flush/close/handoff 的 principal 授权 | P0 | 纳入 | 当前 Session API 接受裸 Session ID；列表、历史和工具结果没有 Workspace identity 约束。 |
| LLM 请求绑定已授权 Session 与 owner epoch | P0 | 纳入 | owner token 已限制写者，但必须确认其它 principal 不能借已知 Session ID触发模型或读取上下文。LLM route 仍不接收 principal cookie。 |
| Session 文件与目录游标的身份归属及重启恢复 | P0 | 纳入 | Session 所属 principal 必须随 durable record 恢复；旧无主记录不能自动归给首个访问者。 |
| 同源账号切换时 OPFS/IndexedDB Workspace 缓存隔离 | P0 | 纳入 | 多账号共享 origin 存储；用真实 Chrome 在不清理本地数据库的情况下切换 PoC principal 并核对各自文件。 |
| Session ID 跨 principal 冲突与 enumeration 侧信道 | P1 | 纳入 | 覆盖已知 ID、随机 ID、列表 cursor 和创建冲突，避免区别响应泄露外来 Session 是否存在。 |
| 多实例 backend 的共享 principal/session 授权与并发写入 | P0 产品风险 | 不纳入 | 当前 dataDir lock 明确只支持单 backend；既有测试已记录双实例 unsafe，不重复包装成 HA。 |
| 正式 SaaS 登录、租户角色、资源级业务授权 | P0 产品工作 | 不纳入 | 当前 PoC 没有认证服务、租户模型或业务 API，不能用模拟 principal 冒充产品能力。 |
| OPFS/IndexedDB 加密与抵御同源恶意脚本 | P1 产品风险 | 不纳入 | 同源应用脚本可访问本 origin 存储；本批验证身份切换不串数据，不宣称抵御 XSS 或本机用户。 |
| Session 本地离线副本、离线读取授权与撤销 | P1 | 保留候选 | 当前 Session authority 在 backend；离线副本会引入独立保留和撤销协议。 |
| catalog UI 多 Session 切换和虚拟化 | P1 | 保留候选 | 应在身份隔离成立后单独验证 UI 状态与授权切换，不与后端访问控制混为一项。 |
| Worker capability manifest 动态匹配任意插件组合 | P1 | 保留候选 | 当前 docs-owned manifest 和默认 profile 已有局部验证；逐插件兼容矩阵是另一独立批次。 |
| 大 Session 历史流式恢复与浏览器内存预算 | P1 | 保留候选 | DSH Session API 仍返回事件数组；必须先选定可流式重建的正式消费接口。 |
| 活跃执行迁移到 Cloud Durable Worker | P0 产品风险 | 保留候选 | 当前 safe-point handoff 不迁移 JS 堆、模型流、工具 Promise 或 HITL，需独立定义服务端执行模型。 |

## 当前 checkout 的实现事实

- Workspace identity endpoint 在服务端生成 PoC principal，并将 Workspace 绑定到该 principal；Workspace API 验证 cookie 与 workspace ID 的映射。
- Workspace principal cookie 只发送到 `/api/browser-native/workspace`，Session principal cookie 限定 `/api/browser-native/session`；handoff 使用同一 Session API 身份。真实 Chrome header 观测确认 principal cookies 不发送到 `/api/browser-native/llm`。
- Session backend 以 Session ID 为 map/file key，并在 durable record 中绑定 principal；目录只返回当前 principal 的记录，单 Session 操作按归属授权。owner token/epoch 仍只标识执行写者，不取代用户或租户授权。
- Durable Workspace snapshot 和 OPFS bytes 按 Workspace ID 存取；Chrome 同一 browser context 在不清理 OPFS/IndexedDB 的情况下切换 A/B principal，确认两个 Workspace ID、manifest、blob 和 Session catalog 相互隔离，两个身份各自刷新后均恢复自己的文件与 Session。
- 上述结论针对当前 checkout 的 PoC，不表示生产认证、租户隔离或正式 Session API 的行为。

## 实施阶段

### M0：基线与威胁范围

- 核对 Session routes、LLM owner check、Workspace identity cookie、Session durable schema 和 OPFS/IndexedDB key。
- 运行现有 backend tests、Session/Workspace focused tests 和 Chrome 基线；确认无未提交修改或隔离 worktree。
- 将攻击者限定为另一个已签发 PoC principal；不把同源恶意脚本、网络管理员或真实 SaaS 租户纳入 PoC 威胁模型。

### M1：Session 服务端 principal 绑定

- 从现有 Workspace identity store 读取 principal；身份 cookie 只覆盖 `/api/browser-native/session`，不覆盖 LLM route。
- `create` 将 Session 绑定创建者 principal；所有 Session 单体操作先检查绑定；`list` 仅枚举当前 principal 的记录。
- 持久化 principal 归属并在 backend restart 后恢复。缺少归属的旧 Session 保留原数据但按不可访问的 legacy-unowned 处理，不自动认领、不删除。
- 外来或无效身份对已知 Session ID 统一返回不可区分的 not-found 响应；`create` 的全局 ID 冲突不返回外来 Session 数据。
- 将现有 handoff cookie 改为 Session-scope principal cookie，路径限定 `/api/browser-native/session`；该 cookie 同时授权 Session handoff 对应的 Workspace owner 核验，但不会发送到 `/api/browser-native/llm`。
- `/llm` 保持 Session owner token/epoch bearer 授权，不接收 principal cookie；其它 principal 若没有该 Session 的 owner capability，不能发起模型请求。PoC 不宣称 token 泄漏后的生产级身份隔离。

### M2：授权合同与恢复测试

- 覆盖同 principal 正常操作、未认证操作、principal B 对 principal A 的已知 Session ID、随机 ID、跨身份 catalog cursor、handoff、append 和缺少 A owner capability 的 LLM 调用。
- 验证读拒绝不会返回 header/events/nextSeq；写拒绝不会改变 Session file、owner epoch 或 durable watermark；列表只返回本 principal 数据。
- 验证 legacy record 冷启动不被自动绑定，以及合法 record 在 backend restart 后保留原 principal。
- 验证每个 principal 的 Session ID 冲突、pagination cursor 和并发创建不会泄露其他 principal 的条目。

### M3：真实 Chrome 同源身份切换

- 在一个真实 Chrome profile/origin 中建立 principal A，使用真实 Worker/DSH Host 执行文件写入，记录 Session、Workspace revision、IndexedDB/OPFS 状态。
- 只轮换 PoC identity cookie，不清空 origin storage；建立 principal B，断言 catalog、已知 Session API、Workspace manifest 和文件工具均不能读取 A 的数据。
- B 写入同路径的不同内容并刷新；再恢复 A cookie，验证 A 仍看到原 Session 与原 Workspace 内容，B 的写入不改变 A 的 revision/hash。
- 检查 LLM 请求不带 principal cookie，Session/Workspace 响应不泄露 owner bearer，页面和日志不输出 cookie 值；请求保持同源。
- 另以两个 Chrome page 同一 principal 验证现有单写者 fencing 仍有效，身份分区不绕过 owner lease。

### M4：真实 LLM smoke、文档和交付

- 在身份授权稳定后使用 `docs/drafts/.env` 跑真实 Chrome + 真实 LLM 普通文件工具和刷新恢复 smoke；真实模型凭据仅由 backend 读取。该 smoke 不替代身份 A/B scripted 测试。
- 更新 PoC README、兼容矩阵、本计划/进度、change ledger 和必要的 draft 索引；准确写明 PoC identity 不是认证。
- 运行 backend 合同测试、相关 Vitest、Chrome scripted 身份切换、真实 LLM smoke、preview build、typecheck、docs quick/doc-sync 和 diff checks；Safari/WebKit 暂停。

## 验收矩阵

| 场景 | 预期 | 证据 |
|---|---|---|
| principal A 创建并写 Session | Session durable record 固定 A 的 principal | backend 测试与磁盘记录断言 |
| principal B 列表 | 不返回 A 的 Session、标题、cwd、计数或 cursor | backend API 响应与 Chrome catalog 请求 |
| B 用已知 A Session ID 读取/写入/hand off/调用 LLM | Session 内容不返回，副作用不执行，返回不区分存在性的拒绝 | backend/API 测试、LLM request/tool/Workspace 计数 |
| backend 重启 | A 仍访问自己的 Session；B 仍被拒；legacy 无主记录仍不可访问 | restart contract test |
| 同源身份切换但保留 OPFS/IndexedDB | B 使用自己的 Workspace ID、manifest 与内容；不加载 A cache | Chrome 双 principal E2E、hash/revision 检查 |
| A → B → A | A 原内容与 revision 未变，B 数据只属于 B | Chrome E2E 文件 hash、Session catalog 和 revision |
| 浏览器请求和 LLM 上游 | principal cookie 只发 Session/Workspace API；LLM 请求与上游不含 cookie | Chrome request header 观测与 backend fake upstream |
| 同 principal 双标签页 | Session/Workspace 仍只有一个有效 writer | Chrome 双页面 stale owner 断言 |

## 限制

PoC principal 由现有同源 Workspace identity endpoint 自动签发，身份 cookie 不是登录凭据，不能抵御伪造身份签发、XSS、同源恶意插件、Cookie 窃取或生产多租户授权缺陷。本批只验证对象归属在 PoC API、持久化和浏览器缓存选择中一致；不提供加密静态数据、离线撤销、跨实例 backend 或跨设备并发协议。
