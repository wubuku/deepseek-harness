---
description: "Browser-Native DSH 数据集格式升级与回滚：版本化备份、升级步骤、回滚步骤，以及每条失败边界与实测证据。"
---

# 数据格式升级与回滚

## 结论

数据目录现在带版本标记 `data-format.json`，升级先写一份带 `dataset.version` 的备份包，再逐步迁移；迁移失败会自动用备份恢复原目录并把半成品保留在旁边。回滚把备份校验、导入到 staging、再原子换入，原目录保留而不删除。实测从 v1（无标记、share 文件 v1）升到 v2 后 backend 仍可读；回滚后目录与升级前**逐字节一致**，backend 仍能读到同一 Session。

## 操作步骤

升级（backend 必须停止）：

```sh
node docs/drafts/browser-native-dsh-poc/hosted/check-data.mjs --data-dir <data>
node docs/drafts/browser-native-dsh-poc/hosted/upgrade-data.mjs --data-dir <data> --backup-root <backups>
```

`upgrade-data` 的顺序是：拒绝运行中的目录 → 读 `data-format.json`（缺失按 v1）→ 拒绝比本 build 新的数据 → 导出备份 `<backups>/dsh-data-v<from>-<时间戳>` → 依次执行迁移 → 写新标记（含 `upgradedFrom`、`backup`、`steps`）。当前迁移只有 `session-shares-v2`：把 share 文件从 v1 写成 v2，补 `links: []` 并把缺失的 `role` 落成 `viewer`。

回滚（backend 必须停止）：

```sh
node docs/drafts/browser-native-dsh-poc/hosted/rollback-data.mjs --data-dir <data> --bundle <backups>/dsh-data-v1-<时间戳>
```

`rollback-data` 的顺序是：拒绝运行中的目录 → 校验 manifest 与全部文件摘要 → 要求备份记录 `dataset` → 拒绝比本 build 新的备份 → 导入到 `<data>.rollback-staging-<时间戳>` → `<data>` 改名为 `<data>.pre-rollback-<时间戳>` → staging 换入 `<data>`。换入失败会把原目录改回来并报 `ROLLBACK_SWAP_FAILED`。

## 失败边界

| 场景 | 结果 |
| --- | --- |
| 升级时 backend 仍在运行 | `BACKEND_RUNNING`，不创建备份，不改数据 |
| 目录标记比本 build 新 | 启动报 `DATA_FORMAT_TOO_NEW`；升级同样拒绝 |
| 缺少对应迁移 | `DATA_FORMAT_NO_MIGRATION`，不创建备份 |
| 某个迁移抛错 | `UPGRADE_FAILED_ROLLED_BACK`：用备份恢复原字节，半成品留在 `<data>.upgrade-failed-<时间戳>` |
| 备份恢复也失败 | `UPGRADE_FAILED_RESTORE_FAILED`，报出备份与保留目录两条恢复路径 |
| 回滚备份没有 `dataset` | `BACKUP_UNVERSIONED`，当前目录不动 |
| 回滚备份比本 build 新 | `BACKUP_TOO_NEW`，当前目录不动 |
| 回滚时 backend 仍在运行 | `BACKEND_RUNNING`，当前目录不动 |
| staging 换入失败 | `ROLLBACK_SWAP_FAILED`，原目录改名恢复，staging 保留供排查 |
| 目录已是当前版本 | `up-to-date`，不产生第二份备份 |

进程在 `<data>` 改名与 staging 换入之间崩溃时，现场是 `<data>.pre-rollback-<时间戳>` 加 staging；把前者改回 `<data>` 即恢复原状。

## 实测输出

```text
{
  "result": "passed",
  "scope": "dataset-upgrade-rollback",
  "preUpgradeFiles": 8,
  "upgrade": {
    "from": 1,
    "to": 2,
    "steps": [{ "id": "session-shares-v2", "from": 1, "to": 2, "changed": true, "shareFileVersion": 2 }],
    "backupDataset": 1,
    "backupFiles": 8
  },
  "upToDate": "up-to-date",
  "rollback": { "datasetVersion": 1, "files": 8, "byteIdentical": true },
  "refusals": ["BACKUP_UNVERSIONED", "BACKUP_TOO_NEW", "BACKEND_RUNNING", "DATA_FORMAT_TOO_NEW", "UPGRADE_FAILED_ROLLED_BACK"],
  "v1Read": 200, "v2Read": 200, "afterRollback": 200
}
```

复跑：

```sh
node docs/drafts/browser-native-dsh-poc/tests/data-upgrade-rollback.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/backup-restore.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
```

## 限制

- 只验证了本 build 内的升级与回滚；真正的“旧 build 读新数据”没有可运行的旧构建，靠 v2 标记让本 build 拒绝新数据，回滚前必须先停服并换回旧构建。
- 迁移按版本号顺序执行但不支持降级迁移；回滚靠备份整目录恢复，不做逐文件反向迁移。
- `session-shares-v2` 之外没有别的迁移，Session 日志与 Workspace 元数据版本未变化。
- 备份目录必须在数据目录之外；同一时间戳的重复升级会追加 `-2` 后缀，避免覆盖。
- 回滚保留的 `.pre-rollback-*` 与 `.upgrade-failed-*` 目录不自动清理，需要操作者确认后删除。
