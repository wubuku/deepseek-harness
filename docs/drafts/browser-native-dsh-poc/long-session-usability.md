---
description: "300 turn 长会话的操作可用性：历史搜索、跳转已加载/未加载 turn、折叠工具输出、回到最新，以及窗口展开后的 DOM 成本。"
---

# 300 turn 长会话可用性

本验证回答长会话里四个日常动作是否仍然可用：历史搜索、从轮次导航跳转到指定 turn（含窗口外需要补历史的 turn）、折叠/展开工具输出、以及从远处回到最新。测量对象是真实 Chrome 中的 preview UI、真实 Cordis Worker 与 PoC backend；300 个 turn 全部通过真实 composer 与 scripted 模型完成，不使用注入 DOM。

## 方法与预算

`tests/long-session-usability.e2e.mjs` 先跑 300 个 turn（第 280 个 turn 带一次真实 `write` 工具调用，使该 turn 有可折叠的过程内容），然后在同一页面依次执行：

| 动作 | 断言 |
| --- | --- |
| 历史搜索 | 在尾部窗口只挂载 turn 151–300 时，搜索 turn 1 的 prompt 标记必须命中；记录检索耗时 |
| 跳转已加载 turn | 点击轮次导航第 280 个标记后，该 turn 进入视口、`aria-current` 指向 280 |
| 折叠工具输出 | 第 280 个 turn 的过程按钮可折叠；展开/折叠各一次，`aria-expanded` 双向切换，折叠后成员行标记隐藏且可见文本减少 |
| 跳转未加载 turn | 点击第 20 个标记先补历史再落位；视口显示 turn 20，`aria-current` 指向 20 |
| 回到最新 | 在 turn 20 点击 “Back to bottom”，恢复跟随尾部并滚到物理底部 |

预算：已加载跳转 ≤ 1,500 ms、未加载跳转 ≤ 5,000 ms、历史搜索 ≤ 2,000 ms、折叠/展开 ≤ 1,000 ms、回到最新 ≤ 1,500 ms、单次长任务 ≤ 100 ms、DOM ≤ 20,000 节点；页面错误与非本地请求必须为 0。

## 结果

300 个 turn 全部完成，turn 中位数 671 ms、最大 1,220 ms。

| 动作 | 实测 | 长任务 | 视口/状态变化 |
| --- | --- | --- | --- |
| 历史搜索 turn 1 | 服务内 24.3 ms（整体 55 ms），命中 4 | — | 搜索前 turn 1 不在 DOM |
| 跳转 turn 280（已加载） | 26 ms | 0 | active 280，DOM 8,239 → 8,243 |
| 展开过程（turn 280） | 59 ms | 0 | `aria-expanded` false → true，隐藏成员 1 → 0，文本 37,635 → 37,647 |
| 折叠过程（turn 280） | 57 ms | 0 | `aria-expanded` true → false，隐藏成员 0 → 1，文本回到 37,635 |
| 跳转 turn 20（补历史） | 99 ms | 1 个 / 89 ms | active 20，隐藏 turn 150 → 19，DOM 8,243 → 14,924 |
| 回到最新（从 turn 20） | 128 ms | 0 | 恢复跟随尾部，DOM 14,923，隐藏 turn 仍为 19 |

页面错误 0、跨源请求 0。历史搜索在 Worker 内走 `linear-fallback`：浏览器 Worker 没有 `node:sqlite.DatabaseSync`，SQLite 索引打不开（`searchError` 明确报告），检索改为读取 Session 快照并逐事件匹配；命中数 4 来自 turn 1 的 user message 与 assistant 回显。

## 结论

- **四个动作在 300 turn 下都可用**，最慢的未加载跳转也只有 99 ms，回到最新 128 ms；没有超过预算的单项延迟。
- **跳转未加载 turn 会展开整个后缀**：窗口模型只隐藏 floor 之前的 turn，`floor = 目标 turn` 时 turn 20–300 全部挂载，DOM 从 8,239 升到 14,924（仍低于 20,000 预算）。这次展开是 89 ms 长任务的来源。
- **回到最新不会重新隐藏已展开的 turn**（这是既有决策：读者主动展开的内容不因回到底部而消失），因此深处跳转后 DOM 维持在 14,923 节点，而不是回到 150 turn 的 8,239。继续跳得更早（如 turn 1）会把后缀扩张到接近 300 turn 的规模；150 turn 窗口只保证“跟随尾部且没有深处跳转”的常态成本。
- **历史搜索不依赖渲染窗口**：turn 1 已被窗口隐藏时仍能命中，说明搜索覆盖完整持久化历史，而不是只搜当前 DOM。代价是浏览器内没有索引，检索为线性扫描；本批 300 turn（约 1,200 事件）为 24 ms，更长历史会线性增长，需要服务端索引。

## 边界与未覆盖

- 只验证 300 turn；600/1000 turn 的搜索线性成本与跳转展开规模未实测。
- 深跳后 DOM 停留在展开状态，没有“回到底部时重新收敛窗口”的策略；若产品要求常态成本固定，需要引入按目标 turn 附近的有限窗口，而不是只隐藏前缀。
- 历史搜索只测文字命中与耗时，没有验证高亮、跳转到命中位置或结果分页的 UI；`session-query-probe` 也只返回命中计数。
- 折叠只测单个 turn 的过程块，没有测多个超长工具输出同时折叠的总内存收益。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/long-session-usability.e2e.mjs
```

可用 `DSH_POC_USABILITY_TURNS` 调整 turn 数（默认 300，最低 200），`DSH_POC_USABILITY_UNLOADED_TURN` 指定窗口外的跳转目标（默认 20）。
