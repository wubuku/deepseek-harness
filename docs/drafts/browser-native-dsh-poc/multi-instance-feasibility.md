---
description: "Browser-Native DSH 横向扩展可行性判定：同机多 backend 的前置条件、单节点约束、外置 store 缺口，以及触发扩展的可测量条件。"
---

# 横向扩展可行性

## 判定

当前实现不能支撑“多实例共享外置 store”的横向扩展。可运行的多实例形态只有一种：同一主机上若干 backend 把 Session、Workspace、operation 和 LLM owner 校验全部转发给一个 `stateAuthorityOrigin`；该 authority 是单进程，状态仍写在自己的本地 `dataDir`，没有外部数据库或对象存储适配层。跨主机、跨可用区或节点故障不丢 Session 都不成立。

| 能力 | 现状 | 证据 |
|---|---|---|
| 两个 backend 服务同一 Session | 可行，但必须共用同一 authority | `tests/shared-authority-concurrency.test.mjs`、`tests/multi-instance-backend.e2e.mjs` |
| authority 自身多实例 | 不可行 | 同一 `dataDir` 的第二个实例 `BACKEND_ALREADY_RUNNING`，见 `tests/multi-instance-feasibility.test.mjs` |
| 不同 `dataDir` 互相可见 | 不可行 | 身份重放 401、Session 404、Workspace 列表互不包含，见同一测试 |
| 外置 store 适配层 | 不存在 | Session、Workspace、身份、durable 记录路径全部由 `dataDir` 拼出 |
| 跨主机锁与租约 | 不存在 | 锁是 pid 文件；租约在 authority 进程内裁决，epoch 存在本地 JSON |

## 单节点约束

1. **一个 `dataDir` 只能有一个写者**。[backend-v2.mjs](backend-v2.mjs) 的 `acquireDataDirLock` 用 `dataDir/.browser-native-backend.lock` 记录 pid；存活 pid 存在时第二个实例以 `BACKEND_ALREADY_RUNNING` 拒绝启动。容器、PID 复用与 NFS 下该判断会退化。
2. **Session 与 Workspace 是本地文件**。Session 在 `<dataDir>/sessions/<id>.json`，Workspace 在 `<dataDir>/workspaces/`、`blobs/`、`layouts/`，身份在 `<dataDir>/identities.json`，durable 运行在 `<dataDir>/durable-runs.json`。测试断言 backend 自身不保留 Session 副本，权威状态只存在于 authority 的 `dataDir`。
3. **owner lease 与 fencing 由单进程裁决**。`ownerToken` / `ownerEpoch` 的校验在 authority 进程内完成，epoch 持久化在 Session JSON；没有分布式租约、心跳或故障转移。`durable-multi-host.md` 的强杀恢复也只覆盖同机重启。
4. **用量与审计账本按进程**。`usageAudit` 在内存中并由本地 observability journal 恢复，`accessAuditEntries` 上限 200 条；metrics、admission、attachment sweeper 都是进程内状态。两个 backend 的 operator 视图不能合并。
5. **authority 没有冗余**。authority 重启需要按原端口重建；重启窗口内所有 backend 的 Session/Workspace 请求返回 `SHARED_STATE_UNAVAILABLE`，没有副本、选举或自动接管。
6. **跨 store 对账不是事务**。operation ledger 与 Session/Workspace 写入分步持久化，只在同一 authority 的串行执行下可对账；没有跨实例 CAS 或原子提交。
7. **浏览器身份绑定 dataDir**。cookie 指向的 principal 只存在于签发它的 `dataDir` 的 `identities.json`；把 cookie 重放到另一个实例得到 `UNAUTHENTICATED`。

## 触发扩展的可测量条件

满足任一条才进入横向扩展立项；未满足时继续单节点，并用下列指标持续证明容量与恢复在阈值内。

| 触发条件 | 可测量信号 | 当前判定方式 |
|---|---|---|
| 同一 Session 需要跨主机写入 | 部署拓扑要求两个以上主机同时服务同一 Session 或 Workspace | 现有 authority 只能同机转发 |
| 单节点恢复时间超预算 | authority 重启到首个 Session 读成功的耗时，或 durable turn 恢复耗时超过约定 RTO | `/api/browser-native/observability/reconciliation` 的 `processStartedAt`、`recoveredTurns` |
| 容量饱和 | `activeRequests` 持续接近准入上限，或 admission 拒绝率非零 | `/api/browser-native/admission`、`dsh_browser_native_admission_*` 指标 |
| 启动恢复退化 | `store.load()` 全量读取 `sessions/` 的启动耗时随 Session 数线性增长并超出预算 | `processStartedAt` 与就绪时间差 |
| 节点故障不得丢 Session | 需求明确 RPO = 0 且单机不可接受 | 当前只有本地 JSON 与同机重启恢复 |
| 多租户需要独立存储边界 | 需要按租户独立备份、配额或删除 | 当前一个 `dataDir` 对应一个身份空间 |

## 复跑

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/multi-instance-feasibility.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/durable-multi-host.test.mjs
```

第一条输出两个 `passed`：`independent-dataDirs-share-nothing`（跨实例读 404、身份重放 401、leases 1/0）与 `shared-authority-single-writer`（重复 authority `BACKEND_ALREADY_RUNNING`、跨 backend 读 200、Session 文件只在 authority）。

## 边界

- 只用 scripted 模型与回环 HTTP，不调用真实 provider；未改 `packages/`，无需 `build:artifacts`/`build:check`。
- Chrome 与真实模型的多 backend 证据见[多 backend 与共享 authority 验证](multi-instance-backend-authority-validation-progress.md)，本文不重复其指标。
- 不覆盖跨主机网络分区、生产数据库事务、对象存储事务、跨区域复制、RPO/RTO 或自动故障转移。
