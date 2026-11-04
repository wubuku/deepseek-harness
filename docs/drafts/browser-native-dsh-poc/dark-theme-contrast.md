---
description: "Browser-Native DSH PoC 的新增界面在暗色与亮色主题下的对比度验收，以及状态面统一复用 design-platform token 的记录。"
---

# 暗色主题与视觉一致性

新增状态面（首次使用引导卡、Workspace/排队/离线状态条、导出控件、协作冲突提示、移动端 UI-only 页面）原先使用固定的深色内联配色，既无法跟随主题，也与客户端设计系统脱节。现在统一改用 `design-platform` token，并由 `tests/dark-theme-contrast.e2e.mjs` 在真实 Chrome 中按 WCAG 2 AA 计算对比度。

## 主题接入

- 页面内注入的状态面在 `document.body` 上声明颜色，因此使用 `--dsw-alias-*` token 后自动跟随 `body[data-ds-dark-theme]`。
- 卡片底：`--dsw-alias-bg-layer-2`；强调底：`--dsw-alias-bg-layer-3`；文字：`--dsw-alias-label-primary`/`--dsw-alias-label-secondary`；描边：`--dsw-alias-border-l3`。
- 动作按钮：`--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`，两套主题下都是高对比的实心按钮。
- 状态描边：成功 `--dsw-alias-state-success-primary`、等待 `--dsw-alias-state-warn-primary`、失败 `--dsw-alias-state-error-primary`、重放 `--dsw-alias-state-business-primary`。
- 移动端 UI-only 页面没有加载客户端样式表，改为自适应变量：暗色下新增 `--accent-fg`（深色文字配浅蓝按钮）与 `--error`（浅红错误文字），修复白字浅蓝按钮与暗红错误文字的低对比。

## 验收方法

- Playwright `colorScheme: dark|light` 走真实主题引导，断言 `data-ds-dark-theme` 与 `prefers-color-scheme` 一致。
- 逐文本节点计算前景色与最近不透明背景的合成色，按 WCAG 2 AA 阈值（普通文本 4.5、大文本 3）判定；同一脚本覆盖首次使用、导出/Workspace、排队、离线恢复、协作冲突与移动端。
- 注入的状态卡必须解析出不透明底色；透明底视为 token 未解析失败，避免出现“对比度合格但卡片看不见”的假通过。

## 结果与边界

- 暗色与亮色各一轮：六个状态全部 `problems: []`，pageerror 0；每轮测量文本节点 12/4/5/5/3/4 个（按状态）。
- 仅覆盖文本与实心底色，不覆盖渐变、图片、焦点环、字形抗锯齿；不替代人工视觉走查。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/dark-theme-contrast.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_COLOR_SCHEME=light node docs/drafts/browser-native-dsh-poc/tests/dark-theme-contrast.e2e.mjs
```
