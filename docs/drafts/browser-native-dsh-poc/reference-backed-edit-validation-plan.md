---
description: "规划 Browser-Native DSH 外部文件引用、range edit、Workspace 持久化与刷新恢复的端到端验证。"
---

# Browser-Native DSH 外部引用编辑验证计划

## Summary

本批验证当前大文件路径的真正技术阻塞：只读 OPFS range backing 和 PoC-local copy-on-write 已经可用，但 VFS mutation、Workspace outbox 和 Session 工具结果仍以完整文件 bytes 为中心。目标是让一个局部编辑结果以不可变外部文件引用进入 Worker VFS，再由 Workspace 从 range reader 计算 hash、缓存、分块上传并在刷新后重新挂载；结果只返回摘要，不把 `before`/`after` 全文写入工具结果。

这不是把标准 `edit` 工具悄悄改成另一种协议，也不是正式 Session event 或生产 Workspace API 的承诺。它验证的是接入正式能力前必须解决的四个接口：外部文件引用、无内容 mutation、range 上传/本地缓存和 compact edit receipt。

## 候选范围

| 候选验证点 | 价值 | 决定 |
|---|---|---|
| VFS 以 hash/bytes 引用发布 external file，不在 mutation 中携带完整 bytes | P0；决定大文件是否能离开 `MemoryVfs` 全量写入 | 纳入 |
| Workspace 从 VFS range reader 本地缓存并分块上传 | P0；验证本地 durable 与云端 commit 不要求完整 JS `Uint8Array` | 纳入 |
| 刷新后从 OPFS/IndexedDB 重新挂载 pending/committed reference | P0；验证 external backing 不只在一次 Worker 生命周期内有效 | 纳入 |
| compact edit result 与 Workspace receipt 关联 | P0；验证工具结果不会重复记录大文件内容 | 纳入 |
| copy、替换、hash、发布和 commit 失败后的保留/重试 | P0；验证失败不伪造成功且 operationId 不重复提交 | 纳入，结合已有故障矩阵 |
| range mutation 接入所有 Node `fs` 写入、append、hard link、watch 和标准 `edit` | P1；需要完整正式 API 设计 | 记录缺口，不在本批伪装完成 |
| byte-level cloud delta、VCDIFF、rsync、CRDT | P1/P2；与 external reference 不是同一层问题 | 延后 |
| 真实 LLM 自主生成大型 edit arguments | P1；模型变量和上游超时会污染存储结论 | 仅做普通文件真实模型回归 |

## 交付面

### 1. External reference VFS seam

为 experimental `MemoryVfs` 增加 PoC 可审计的 range read 和 external replacement mutation。mutation 只包含路径、模式、hash、bytes 和 entry 状态；VFS 持有外部 backing，Workspace 通过路径 range reader读取内容。hydration 场景不得为了替换旧 external file 而先完整 materialize旧 bytes。

### 2. Reference-aware Workspace persistence

`WorkspaceChange` 和 IndexedDB metadata 能表达 `contentReference`。浏览器 durable store 使用固定块从 VFS range reader 写入 OPFS，并在 metadata 提交前校验完整 hash；上传使用同一引用读取固定块。Memory store 只作为确定性单测实现，不代表浏览器存储能力。

### 3. Compact edit protocol

新增 PoC-only 的 Worker test action，使用现有 chunk copy-on-write 在 OPFS 临时文件中编辑大文件，然后发布 external reference。返回 `beforeHash`、`afterHash`、字节数、替换摘要、operationId 和 durability receipt，不返回全文。它不注册为标准 DSH `edit`，不绕过 Agent Loop。

### 4. Recovery and evidence

真实 Chrome Worker/OPFS/IndexedDB 完成局部编辑、CAS commit、刷新 hydrate、range read 和 resident-bytes 检查；失败样本证明源文件 hash 不变。测试记录 mutation JSON 没有 `content`，commit JSON 只有 metadata，刷新后仍是 external backing。真实 LLM 只回归普通文件多轮，不为大型工具参数背书。

## 验收矩阵

| 证据 | 通过条件 |
|---|---|
| VFS 单测 | external file 以 range 读取；reference mutation 不含 bytes；替换和冷 hydrate 不增加整文件 resident bytes；旧 backing 被正确关闭 |
| Workspace 单测 | reference change 可本地保存/恢复；上传只发固定块；hash、bytes、CAS、operationId、receipt 与已有路径一致 |
| Chrome 正常 E2E | 至少 16 MiB 文件完成局部替换，manifest 只有最终文件，commit revision 增加一次，页面无错误 |
| Chrome 刷新 E2E | 同一 Workspace 刷新后从 OPFS/IndexedDB 挂载 external backing；range read/hash 成功，resident bytes不因 hydrate 变成文件大小 |
| Chrome 失败 E2E | copy/hash/publish 或 cloud failure 后源 hash 不变；重试不重复 revision；不显示成功但未确认的 receipt |
| 载荷证据 | tool/result 和 Session 记录只含 compact metadata；不能把 scripted test action当作真实 Agent Loop 工具调用 |

## 非目标

本批不修改 Agent Loop，不把 PoC test action注册为正式工具，不实现任意 Node `fs` API 的 range mutation，不宣称块级 delta 或零拷贝，不验证自然 eviction、OS/断电崩溃、Safari、生产对象存储、多设备合并或真实模型生成大型 tool arguments。

## 实施顺序

1. 先扩展 experimental VFS 类型和最小单测，再接 Workspace reference metadata。
2. 加入 compact reference edit Worker action和模型无关的 Chrome E2E。
3. 运行 focused TypeScript/Vitest、Workspace/backend 测试、preview build 和 Chrome E2E；真实 LLM只做普通回归。
4. 根据实际证据更新进度、README、兼容矩阵、目录索引和变更账本；没有证据的正式接入项保留为限制。

## Dev Note

本计划定义的是当前 checkout 的实验边界。任何带有函数、OPFS handle或 Worker对象的 reference 都不能直接进入 Session、IndexedDB JSON metadata或HTTP JSON；持久化数据只能是校验过的 hash、bytes、路径和操作关联字段。
