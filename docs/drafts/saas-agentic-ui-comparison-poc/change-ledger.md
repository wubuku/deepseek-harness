# 变更清单

## 本目录

新增共享 mock SaaS API、GUI/业务表单、精确调用身份的页面桥、Worker 工具插件和三种聊天层接线。复用原 PoC 的 DSH Session 投影、AG-UI 适配器和 Worker 运行时，不重新实现 Agent Loop。依赖固定在局部 package 与 lockfile。

## 目录外

- `../browser-native-dsh-poc/backend-v2.mjs`：真实模型验收发现 SSE 先发文本再发工具参数时，旧代理因 `started` 已为 true 而未创建 `toolCall`，随后访问 `toolCall.arguments` 失败。修正为独立文本 index 和按上游 index 归集的工具集合，同时避免仅处理首个并行调用。共用 backend 修复使三条路线仍走相同代理；回归用例在本目录 `tests/llm-proxy.test.ts`。上游重放时将修复与测试一起带入代理的正式维护位置，不需要修改 DSH Loop。
- `../../i18n/README.md`、`../../i18n/README.zh.md`、配对记录与根 `scripts/translation-pairing.manifest.json`：仅登记本实验目录的中文文档豁免，沿用原 PoC 机制，不扩大到其他目录。
- `../README.md` 和选型报告：索引新实验，区分原三份 PoC 的验证范围与本轮同口径结果，不将 mock API 当成生产 SaaS 已验收。

## 构建产物

首次构建复用了相同已提交 checkpoint 的 CopilotKit worktree 已生成的 `packages/*/*/lib`、vendor `lib` 与 `apps/web/dist/preview` 等被忽略产物，未复制 `.env`，未清理共享缓存。这些产物不提交；干净环境应先完成原 Browser-Native PoC 的 preview/VFS 构建，再构建本目录。
