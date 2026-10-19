# 变更清单

## 本目录

新增复杂客户续约业务 API、工单/报价页面、可复用报价编辑器、DSH 页面工具插件、分段 AG-UI adapter、三路聊天接线与单测/E2E。所有新增业务代码和文档留在 `complex/`，没有修改正式 packages、apps 源码、默认 Agent Loop 或旧两份 PoC。

`dsh-client.ts` 与 Worker bootstrap 是从父实验复制的隔离入口，修改导入路径、工具插件、overlay 和按路线/workspace 隔离的 Session 本机记忆键。它们不是已产品化的解耦 SDK；上游更新时需核查 bootstrap 的生命周期和配置变化。

## 父目录

- `package.json`：增加复杂实验的启动、检查、测试命令，并在局部构建里生成新的 overlay；依赖版本不变，不需要改 lockfile。
- `vite.config.ts`：增加 `complex/index.html` 为多入口，仍写入原 PoC 自有 dist 子目录，不清理共享产物。
- README 与评估：链接新实验并注明第一轮 renderer-only 结论的适用范围。
- 复杂实验评估、测试记录与证据索引：记录真实模型复测结果、三路线 scripted 对照及按场景限定的初步结论；流式采样改为 MutationObserver 加 20ms 定时读取，避免原生 renderer 的 DOM 更新批处理导致误报。

这些父目录变更是让新入口可构建、可发现的最小接线，不改变原入口的工具或业务故事。重放时一并保留本目录和这几处局部接线即可。

## 本机忽略产物

隔离 worktree 复用相同 checkpoint 的 `lib` 与 preview/VFS 忽略构建产物，使用已有的固定 npm 依赖；没有复制 `.env`。本机 dependency symlink 仅是开发缓存，不提交；文档站构建另连接了既有 website 依赖。doc-sync 的 Host 构建仍因其他 workspace 局部依赖缺失失败，未为此改动仓库源码或安装全仓依赖。新实验沿用父目录已有中文文档翻译豁免，没有扩大豁免范围。
