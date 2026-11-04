---
description: "Skill 目录加载、渐进式披露、skill 与 fs 协同的浏览器端验证；scripted 证据通过，真实模型因上游配额不可用而未完成。"
---

# Skill 在浏览器端的应用验证

`tests/skill-application.e2e.mjs` 在同一个真实 Chrome Worker 中先跑无 Skill 的对照 turn，再把 `SKILL.md` 写进 Workspace skill 根并跑同一探针的 treatment turn。脚本同时断言 UI 回复、Session 事件、工具调用和模型请求体，用来证明 Skill 内容确实改变了行为且只在需要时进入上下文。

## 机制

- **目录加载**：验证 profile 暴露 `dsh-skill-filesystem`、`dsh-skill`、`dsh-tool-skill`；skill 根为 `/dsh/home/workspace/.agents/skills`，写盘后 watcher 更新目录。
- **渐进式披露**：首轮模型请求只带 `<available_skills>` 目录项（name + description）；`skill` 工具结果才包含正文，后续请求才携带正文。
- **与 fs 协同**：Skill 正文要求模型调用 `read` 读取 `/dsh/home/workspace/proof.txt`，最终回复必须使用该文件内容。

## Scripted 实测

Chrome 156.0.8078.80 / macOS，`llmMode: 'scripted'`，roster `browser-skill`：

| 步骤 | 结果 |
| --- | --- |
| 对照 turn（无 Skill） | 回复 `BROWSER_NATIVE_SKILL_APPLICATION_ABSENT`；无工具调用；1 次模型请求；请求中没有 `browser-proof`，也没有正文 marker |
| 写入 `SKILL.md` 后 treatment | 工具调用 `skill → read`；回复 `BROWSER_NATIVE_SKILL_APPLICATION_APPLIED:BROWSER_SKILL_APPLICATION_CODEWORD_7F3A` |
| 目录请求 | 含 `browser-proof` 与 description，**不含**正文 marker |
| 续接请求 | 含正文 marker（`skill` 结果之后）；共 3 次模型请求 |
| 可见 UI | 最终 marker 出现在 transcript；无审批卡 |
| 错误 | 页面错误、Worker 错误、跨源请求均为 0 |

同一 Session 的两条探针文本只差一个 `Probe label`，避免同文重复触发 UI 的旧消息匹配；对照与 treatment 的行为差异只来自 Skill 是否存在。

## 真实模型状态

本机 `docs/drafts/.env` 的三组端点在 2026-11-05 均不可用，未拿到真实模型回复：

| 端点 | 探测结果 |
| --- | --- |
| `OPENAI_*` `/chat/completions` | HTTP 402（配额/付款限制） |
| `OPENAI_NEXT_GPT_*` | HTTP 403（凭据被拒绝） |
| `ANTHROPIC_*`（Anthropic-compatible） | HTTP 429；E2E 首轮 `turn/end` 为 `error`，`UPSTREAM_LLM_RATE_LIMITED` / 503 |

因此本项结论是“浏览器端 Skill 机制可行，真实模型应用证据待配额恢复后补跑”；这不等于真实模型不会遵循 Skill。测试已支持 real 模式，恢复凭据后直接复跑：

```sh
DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/skill-application.e2e.mjs
```

real 模式复用同一套断言：对照必须回 ABSENT，treatment 必须 `skill → read` 并以文件内容作答，首个请求不得含正文，续接请求必须含正文。

## 结论

- Skill 目录在浏览器 Workspace 中可加载；写盘后目录更新可被下一 turn 看到。
- 渐进式披露在请求层成立：正文不会提前进入上下文，只在 `skill` 工具返回后出现。
- Skill 与 `read` 工具可组合，最终回答能引用 Workspace 文件内容。
- 默认 Browser profile 仍未启用该能力；它只在验证 profile 中成立。

## 边界

- scripted 分支是测试支撑，不证明真实模型会主动选择 Skill；真实模型结论待上游配额恢复。
- 只覆盖单 Session、单 Skill；多 Skill 冲突、超大正文、Skill 内引用其他文件、刷新后的目录状态由[Skill 文件系统验证](worker-skill-filesystem-validation-progress.md)覆盖。
- 页面关闭后 watcher 不运行，外部 VFS 删除依赖异步通知。
