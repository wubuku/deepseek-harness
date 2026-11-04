---
description: "把 PoC 的 Node 合同测试、产品路径 E2E、性能守门与混沌套件收成一条全量回归命令，逐项输出 PASS/FAIL 与耗时，失败即非零退出。"
---

# 一键全量回归

## 目的

[poc-gate.mjs](tests/poc-gate.mjs) 是 PoC 的唯一日常回归入口。它顺序执行合同测试、E2E、[性能回归守门](perf-gate.md)与[混沌回归套件](chaos-regression-suite.md)，每项在独立子进程中运行，因此一项失败不会中断或掩盖后续项。每个子项打印一行 PASS/FAIL 与耗时，失败时附上该子进程最后 30 行诊断；汇总行之后输出含全部条目状态与耗时的 JSON，任一项失败或超时进程以非零退出。

## 一条命令

```sh
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs
```

首次运行或 preview 产物缺失时先构建再跑：

```sh
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --prepare
```

`--prepare` 只执行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`。不传时，若 `apps/web/dist/preview/vfs-image.tar.gz` 缺失，门禁在运行浏览器项之前直接报错并给出该命令。

## 分组与覆盖

| 分组 | 条目 | 内容 |
| --- | --- | --- |
| `contract` | `tests/*.test.mjs` 共 38 项 | 包含 `node:test` 的文件以 `node --test` 运行，其余以普通 Node 进程运行 |
| `e2e` | 默认 10 个产品路径 | 冷启动、v2 端到端、cold hydrate 完整性、Session 挂载、只读共享、离线重连、principal 导出、数据删除、工具能力矩阵、Session 传输韧性 |
| `perf` | `perf/perf-gate` | 内部运行性能基线、长转录渲染、9,990 文件同步与弱网画像四组套件 |
| `chaos` | `chaos/chaos-suite` | 内部运行断流、Worker 崩溃、OPFS 配额、durable 重启、lease 丢失与审计截断六个用例 |

`e2e` 默认名单只包含不依赖外部 provider、MinIO、WebKit 或主机级故障注入的文件。`DSH_POC_GATE_FULL_E2E=1` 展开全部 `.e2e.mjs`；`DSH_POC_GATE_E2E_ROSTER` 用逗号分隔的文件名替换默认名单。两个变量同时设置会直接报错。

## 选择与复现单项

```sh
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --group contract
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --group e2e --filter offline-reconnect
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --list
```

`--group` 接受 `contract,e2e,perf,chaos` 的任意组合；`--filter` 按条目 id 子串过滤；`--list` 只打印条目与超时时间。合同与 E2E 子项各 300 秒超时，`perf` 与 `chaos` 聚合项各 25 分钟超时。门禁按固定顺序串行执行，避免固定端口与 CPU 争用造成的伪失败。

环境变量沿用各子套件的既有约定：`DSH_POC_BROWSER` 默认 `chrome`，`DSH_POC_PLAYWRIGHT_MODULE` 未设置时从本地解析 Playwright。`DSH_POC_GATE_UPDATE_BASELINE=1` 只在全部条目通过时重写 [poc-gate-baseline.json](poc-gate-baseline.json)。

## 全绿基线

2026-11-04 本机 macOS、Chrome 156、已构建 preview，全量命令 50/50 通过，总耗时 784.0 秒：

| 分组 | 条目 | 结果 | 耗时 |
| --- | --- | --- | --- |
| `contract` | 38 | 38/38 | 68.1 s |
| `e2e` | 10 | 10/10 | 134.5 s |
| `perf` | 1 | 1/1 | 523.2 s |
| `chaos` | 1 | 1/1 | 58.2 s |

[poc-gate-baseline.json](poc-gate-baseline.json) 保存这次运行的逐项状态与耗时，用于判断后续变慢来自环境波动还是真实回归。该基线只在门禁全绿时写入；红跑不会覆盖。

## 边界

- 合同测试与 E2E 组覆盖协议、恢复、隔离和产品路径，不等于全部 176 个 E2E 文件；全量 E2E 需要显式 `DSH_POC_GATE_FULL_E2E=1`，且部分文件需要真实 provider、MinIO、WebKit 或主机级故障注入。
- `perf` 与 `chaos` 作为聚合项计一项，其内部逐套件/逐用例结果已由各自脚本打印；门禁不重复解析这些内部行，避免与既有输出格式耦合。
- 门禁证明“本次构建上这些既有测试可重复通过”，不提供跨机型容量承诺，也不替代真实设备、真实网络或生产基础设施验证。
