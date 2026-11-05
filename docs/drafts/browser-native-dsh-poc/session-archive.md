---
description: "Browser-Native DSH 的 Session 冷存储：把未活跃 Session 压缩归档，启动只读元数据，打开时按需解压并恢复附件。"
---

# Session 归档与按需加载

## Summary

未活跃或超过工作集的 Session 会被移出 `sessions/`，写成 `archives-v1/<id>.json.gz`。压缩包同时保存 durable Session 记录与该 Session 引用的附件字节，索引 `archives-v1/index.json` 只存元数据。启动时 `FormalSessionStore.load()` 只解析活跃 Session 与索引，不读取或解压归档事件；列表、搜索与 retention 查询仍能看到归档 Session。打开、读取、导出或 durable turn 首次访问归档 Session 时，才解压该 Session 并把缺失的附件对象写回 Workspace。

归档不是删除。归档数据不受活跃 Session 的 retention 清理影响，误删 `sessions/<id>.json` 后可以从归档恢复；需要真正销毁时走既有数据删除流程。

## 触发与管理

管理员接口：

- `POST /api/browser-native/admin/session/archive`：`{ sessionIds }` 或 `{ inactiveMs, limit }`。后者按 `lastActivityAt` 从旧到新选择活跃 Session，`limit` 默认 100、上限 1,000。
- `POST /api/browser-native/admin/session/restore`：`{ sessionId }`。解压归档并写回 `sessions/`；已在活跃集合中时幂等。

归档前若存在未 flush 的 durable 事件，会先 flush。归档文件的临时文件 rename 与索引的原子重写完成后，才删除活跃文件；崩溃只会留下活跃记录、待重建的孤儿归档，或两者并存，不会只剩缺失的 Session。活跃文件删除失败会显式返回错误，Session 仍保持活跃。

## 数据布局与加密

```text
archives-v1/index.json             归档元数据（id、principal、header、事件数、revision、附件哈希、时间）
archives-v1/<sessionId>.json.gz    压缩包：{ version, archivedAt, session, attachments }
```

配置 at-rest 加密时，归档文件与索引使用与 Session 文件相同的 AES-256-GCM 信封和 AAD（`archive/<id>.json.gz`、`archive-index/index.json`）；压缩包内是明文结构，落盘仍是密文。附件字节在归档包内解密保存，写回时再按 Workspace 附件规则加密。密钥轮换把 `archives-v1` 的归档文件与索引纳入重加密目标，旧钥退休后归档仍可读。

## 实测

`tests/session-archive.e2e.mjs` 在 300 个 Session（每个 50 事件、含一个附件引用）、100 条审计拒绝记录与 1 条 usage 的 dataDir 上归档 250 个 Session，重启后：

- `FormalSessionStore.load()`：多次运行 41–65 ms → 8–11 ms。
- `load()` 堆增量：5.5 MiB → 1.0 MiB。
- 列表仍返回 300 条，其中 250 条带 `archived: true`；归档 Session 可 open、read 50 条事件并导出附件。
- 删除 Workspace 附件对象后打开归档 Session，附件字节从归档写回，导出包含原始 base64。
- 归档前后 `access-denials.jsonl` 与 `usage.jsonl` 字节一致，`restore()` 链校验通过，usage 与 100 条审计记录仍在。
- 恢复后的活跃文件被删除并从索引重新列出，再次 restore 后可读。

该规模下归档收益约为 5–8 倍 load 降幅与 5 倍堆降幅；启动成本仍随“活跃 Session 数 + 元数据条目数”增长，而不是总 Session 数。

## 边界

- 只在显式管理员调用时归档；本原型没有定时扫描或自动 retention 调度。
- 索引仍随归档 Session 数线性增长，但每项只有元数据；索引损坏会在启动时显式失败，不会静默隐藏归档。
- 归档包嵌入附件字节，会与仍被其他 Session 引用的 Workspace 对象重复占用磁盘；附件 GC 也把归档元数据中的哈希视为引用，避免误删。
- 首次打开归档 Session 会在请求路径上同步解压；本规模下为毫秒级，但没有后台预热或异步流式解压。
- 归档没有合并成单个大文件或分片索引；超过数万归档 Session 时索引解析本身会成为下一个启动瓶颈。

## 复跑

```sh
node --expose-gc docs/drafts/browser-native-dsh-poc/tests/session-archive.e2e.mjs
```
