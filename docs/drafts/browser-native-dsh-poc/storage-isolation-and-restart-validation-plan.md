---
description: "规划 Browser-Native DSH 下一批 Chrome 验证：OPFS 配额错误恢复、backend 重启后的 Workspace lease fencing，以及同源多 Workspace 本地存储隔离。"
---

# Browser-Native DSH 存储隔离与重启验证计划

## Summary

本批继续验证 Browser-Native DSH 的文件持久化安全，不扩展 SaaS 联动或聊天 UI。验证三个高风险场景：OPFS 写入遇到 quota 类错误时不得把文件报告为已保存或提前提交；Workspace backend 重启后必须拒绝旧 writer 凭据并维持递增 fencing epoch；同源下不同浏览器身份的 Workspace 必须使用独立本地存储和远端 manifest。全部采用真实 Chrome、Dedicated Worker、真实 OPFS/IndexedDB API 与 scripted DSH runtime，不依赖真实 LLM。

## 验证点

### P1：OPFS quota 错误与本地持久化重试

- 在真实 Chrome Worker 的 BrowserDurableWorkspaceStore 写入路径注入一次 `QuotaExceededError`，不声称人为异常等价于真实磁盘耗尽或浏览器 eviction。
- 通过真实 Worker VFS 写文件；首次本地持久化失败必须让操作得到错误，并观察 Workspace 状态为 error/dirty，不允许 backend blob/manifest commit 抢先成功。
- 解除一次性故障后，确认 OPFS blob 与 IndexedDB retry batch 都落盘，沿原 `operationId` 最终 commit 一次，revision 单调增加且页面明确回到 synced。
- 记录本地内存 VFS 与 durable snapshot 的差别：quota 错误后 Worker 内存仍可能暂时持有文件，页面关闭前的恢复承诺只从已确认 durable 的 OPFS/IndexedDB 内容开始。

### P2：backend 进程重启时的 writer lease 恢复

- 真实 Chrome Worker 获取 lease 并提交 Workspace 文件后，关闭并重建 PoC backend，复用原 `dataDir` 和浏览器上下文。
- 验证 manifest、blob、revision 与持久化 fencing epoch 可读取；backend 重启后不恢复旧 writer token/活跃租约。
- 用旧 token 请求 renew/commit 必须被拒；刷新原标签页时，旧 resume 凭据被拒后应通过新 claim 获取更高 fencing token，恢复已提交文件且不重复提交。
- 明确此结果只适用于单 backend 实例的 PoC JSON 存储；不推断多实例协调、分布式租约或 HA。

### P3：同源多身份 Workspace 本地存储隔离

- 使用同一真实 Chrome BrowserContext：先由身份 A 写入并完成同步，再在保留同一 origin 存储的情况下清除身份 cookie，由身份 B 获得新的 Workspace；两个身份先后写入相同相对路径但不同内容。
- 验证 Workspace ID 不同、IndexedDB snapshot 以 Workspace ID 分离、OPFS blob namespace 不串用、各自 manifest/blob 只返回本身份内容。
- 交叉查询另一身份的 workspace/blob 时确认 backend 拒绝访问；刷新任一 context 后只恢复自己的文件。
- 该测试只验证 PoC 的身份隔离和浏览器存储命名，不代替生产 SaaS 身份认证、授权审计或租户安全评估。

## 实施范围

- 新增一个 PoC-only OPFS fault hook、backend 重启 E2E 和多身份存储隔离 E2E；可以新增 quota fault E2E 专门验收首次失败与重试。
- 不修改正式 Agent Loop、Session format、正式 Workspace API、默认 profile 或 Browser-Native UI。
- 修改范围限制在 `docs/drafts/browser-native-dsh-poc/`；只有确实需要正式 runtime seam 时才扩大目录，并先记录理由和 upstream 重放步骤。
- 运行真实 Chrome；Safari/WebKit、真实磁盘 quota exhaustion、浏览器 eviction、OS 级浏览器进程崩溃不纳入本批。

## 退出条件

- quota 类本地写入错误在 durable store 成功前不会导致远端 commit 或 synced；恢复后相同业务操作可安全提交一次。
- backend 重启后旧 writer 凭据失效，fencing epoch 不回退，刷新通过新 claim 恢复已有数据且没有重复 commit。
- 两个 Chrome context 的同源 Workspace manifest、OPFS blob 和 IndexedDB snapshot 不互相泄露或覆盖。
- 新增脚本输出通过/失败、revision、operation/fencing 相关标识、页面错误及跨源请求；更新进度、README、`change-ledger.md` 和 drafts 索引。
- 若测试揭示实现缺陷，先修复再重跑所有受影响测试；如测试仅暴露天然限制，精确记录，不把失败改写成通过。
