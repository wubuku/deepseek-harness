---
description: "Browser-Native 黄金路径产品回归：真实模型下完成提问、只读拒绝、审批升级、写工作区、刷新恢复与会话导出导入。"
---

# 黄金路径端到端

## Summary

`golden-path.e2e.mjs` 用真实 LongCat-2.5 在预览 UI 里走完整产品链路：首轮建立 Session，切到 Read Only，模型调用 `write` 被拒后按拒绝指引升级到 workspace-write，审批卡点 Allow once，文件写入成功，刷新页面后从 durable log 重建 44 个事件且不重放模型请求，最后用 `dsh-session-bundle` v1 导出并以新 id 导入 45 个事件。

这不是手工演示，而是脚本断言：审批请求与决定、`allowed-once` 结果、工具失败与成功结果、工作区文件内容、刷新前后事件前缀一致、LLM 请求数不增加、导入事件序号和 `durableThroughSeq` 对齐、页面错误与跨源请求为 0。

## 复跑方式

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/golden-path.e2e.mjs
```

需要真实 OpenAI-compatible 凭据；脚本从 env 文件读取 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`，不打印凭据。默认 LLM 超时 240 秒，可用 `DSH_POC_GOLDEN_LLM_TIMEOUT_MS` 调整。

## 实测结果

单次真实运行：

| 阶段 | 结果 |
|---|---|
| 启动到工作区 synced | 2,267 ms |
| 黄金 turn（含拒绝、审批等待、第二次模型请求） | 70,144 ms |
| 模型请求数 | 5（含首个 READY 轮和刷新前后的读取，不因刷新增加） |
| 审批 | 1 次 `approval/asked`，`write` 工具，`allowed-once`，审批卡可见 |
| 工作区文件 | `/dsh/home/workspace/golden-path.txt`，20 bytes，内容 `GOLDEN_PATH_REAL_OK\n` |
| 刷新恢复 | 5,006 ms，重建 44 个事件，刷新后仍读到同一文件 |
| 导出 | `dsh-session-bundle` v1、`sessionFormatVersion` 4、45 个事件、33,174 bytes |
| 导入 | 新 id `golden-import-f0086356`，45 个事件，`durableThroughSeq` 一致 |
| 页面错误 / 跨源请求 | 0 / 0 |

事件里保留了一次被只读策略拒绝的 `tool/result` 和一次审批后成功的 `tool/result`；这证明链路经过拒绝指引和审批，而不是直接放行。

## 断言清单

- Read Only 通过真实 Access mode 菜单切换，等待 `aria-label` 变为 `Access mode, current: Read Only`。
- 模型按提示调用 `write`，首轮结果 `isError` 为 true；DSH 的拒绝指引促使模型以 workspace-write 重试。
- 页面上出现 `[data-approval-key]` 卡片，包含 `Allow once` 与 workspace-write 文案；点击后产生唯一 `approval/decided`，结果 `outcome` 为 `allowed-once`。
- 审批后的 `tool/result` 为 `isError: false`，工作区测试探针读到精确文件内容。
- 刷新后首 44 个事件与刷新前完全一致，`assistantText` 仍包含 `GOLDEN_PATH_REAL_DONE`，LLM 请求数保持 5。
- 导出包的 `format`/`formatVersion`/`sessionFormatVersion` 与事件序号 0..44 连续；导入包只改 Session id，导入后事件集合、附件数 0、`durableThroughSeq` 和文件内容一致。

## 缺口

- 审批卡文案没有展示文件路径或工具参数（本次 `cardMentionsArguments` 为 false）；用户只能从模型说明或事件里确认目标文件。该可见性缺口在本批点 4 继续处理。
- 黄金 turn 依赖提示词给出精确 `write` JSON 参数；模型仍会先被只读策略拒绝再重试，因此黄金路径包含两次工具结果。真实自然语言需求下不保证一次命中。
- 导出导入走 HTTP Session API，预览 UI 没有导出入口；只覆盖单 Session 与工作区文件未打包。
- 只跑 LongCat-2.5 OpenAI-compatible；Anthropic-compatible 流程由双 provider 测试单独覆盖，未在本回归里重跑。
- 70 秒 turn 与 5 秒刷新是单机单次采样，不是性能预算；未覆盖网络抖动、审批超时、并发刷新和导入同名冲突。
- 未覆盖附件、fork/handoff 继承链、跨 backend 实例迁移和模型不遵循工具提示时的降级路径。
