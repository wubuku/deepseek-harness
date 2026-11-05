---
description: "Browser-Native DSH PoC 用 axe-core 扫描主界面与新增状态的 serious/critical 可访问性违规，并记录修复与边界。"
---

# 可访问性自动审计

`tests/accessibility-audit.e2e.mjs` 用 axe-core 扫描 Browser-Native preview 的主界面与新增状态，只把 `serious` 和 `critical` 违规判为失败；`moderate`/`minor` 作为后续清单输出，不阻塞本轮验收。审计范围是真实 Chrome 渲染的文档，包含固定定位的导出控件、状态条与移动端页面。

## 方法与范围

- axe-core `4.14.0`，以 `addScriptTag` 注入页面，`wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`/`best-practice` 规则集。
- 每个状态独立扫描一次；同一页面重复扫描复用已注入的 axe 与测试样式。
- 临时提示条（`role="alert"`）的淡出动画会在末段把文字混入页面底色。扫描前把这些提示钉在全不透明帧，避免把动画过渡帧误判成对比度缺陷；提示条组件本身仍被检查。
- 覆盖状态：

| 状态 | 如何产生 |
| --- | --- |
| main | preview 首页完成一次 `A11Y_MAIN` turn |
| export | 点击 `[data-browser-native-session-export]`，等待下载与导出结果文本 |
| failure | `failLlmRequest` 使 `A11Y_FAIL` turn 以错误结束 |
| queued | `maxConcurrentTurns: 1` 下先用 barrier 占住唯一 turn 槽，再由第二个标签页提交 turn，等待 `[data-browser-native-queue-status]` |
| offline-recovery | `context.setOffline(true)` 后等待 `[data-browser-native-offline-status]` |
| collaboration | 第二个标签页打开同一 Session，等待 `[data-browser-native-workspace-status]` 的 `lease-conflict`/`session-conflict`/`recovery-conflict` |
| archive-menu | 侧边栏 Session 行菜单打开归档动作，再按 Escape 关闭 |
| archived-row | 归档后通过 View options 的键盘 Enter 选择 “All conversations (show archived)”，扫描灰显行 |
| mobile-ui-only | 390×844 视口打开 `/mobile` |
| failure-zh | `zh-CN` 视口 390×844 下产生失败 turn，检查中英文案与溢出 |
| mobile-ui-only-zh | `zh-CN` 视口打开 `/mobile` |
| budget-exceeded-zh | scripted usage 触发预算耗尽，检查预算条文案、对比度、Tab 顺序与 Enter 动作 |

## 修复

首次扫描在主界面发现 2 个 `serious` 违规，均为 `label-content-name-mismatch`（WCAG 2.5.3）：控件的可见文本没有出现在 accessible name 中，语音输入用户说出可见文字时无法命中控件。

- 侧边栏品牌按钮：可见文本是本地构建版本号，但 `aria-label` 是 `New session`。现在用 `aria-labelledby` 同时引用品牌标识与一个视觉隐藏的 `New session` 文本，accessible name 包含两者；视觉隐藏样式放在 `SidebarRoot.module.css`。
- 账号菜单按钮：宽布局下可见文本是 `More` 或账号名，但 `aria-label` 是 `Account menu`。现在 accessible name 为 `<菜单名>: <可见文本>`，可见文本仍在名称内。

两处都没有新增用户可见文案：品牌按钮复用了已有 `session.new.label`，账号菜单复用已有 `menu`/`signedIn`/`more` 词条。组件测试中的精确名称查询改为正则，快照按新标记重新生成。

本轮新增状态又发现两处：

- 无 Workspace 时 composer 触发区同时声明 `role="textbox"`、`aria-expanded` 与 `aria-haspopup="menu"`，`aria-expanded` 不允许出现在 textbox 上。现在该触发区渲染为 `button`，且仅在 `textbox` 角色下输出 `aria-multiline`；可编辑 composer 不受影响。
- 预算耗尽提示用的 `--dsw-alias-state-error-primary` 在浅色 13px 文本上只有 4.49:1，低于 WCAG AA 4.5:1。提示颜色改为与主题 `label` 混合的表达式，浅色下变深、深色下变浅。

失败建议的 zh 文案原先嵌入英文 `(turn N)`，现已改为 `（第 N 轮）`。

## 结果与边界

- 12 个状态全部 0 个 `serious`/`critical` 违规，无 pageerror。
- 键盘检查覆盖：Session 行菜单与 View options 的 `Enter` 打开、`Escape` 关闭；预算条的 Tab 顺序（管理员说明 → 导出诊断包）、两个动作的可见焦点环与 `Enter` 触发；归档行的 `aria-description` 暴露归档状态。
- zh/en 文案检查覆盖预算条、失败建议、归档菜单/标记与移动端页面；390px 视口下预算条与失败建议无横向溢出，`verify-client-ui-i18n` 无硬编码告警。
- 仍报告的 `moderate` 项是页面级地标与标题（`landmark-one-main`、`page-has-heading-one`、`region`），它们属于既有 AppFrame 结构，不是本轮新增状态；axe 的 `best-practice` 规则把它们归为 `moderate`。
- 审计不能替代屏幕阅读器实测：它不覆盖朗读顺序、焦点管理、键盘陷阱和动画时序；这些仍按各状态的手动验收记录检查。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/accessibility-audit.e2e.mjs
```

脚本在 PoC 目录的 `devDependency` 中声明 `axe-core`，不进入 Workspace 根依赖。`DSH_POC_A11Y_DEBUG=1` 会额外打印品牌与账号按钮的当前标记，便于失败时定位。
