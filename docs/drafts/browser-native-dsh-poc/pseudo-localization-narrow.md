---
description: "Browser-Native DSH PoC 的中英双语字典覆盖检查，以及伪本地化加长 40% 后窄屏状态条的溢出与截断验证。"
---

# 双语字典与伪本地化窄屏验证

`tests/pseudo-localization-narrow.e2e.mjs` 在真实 Chrome 里把每个可见文本节点逐词重映射为带重音的伪本地化文本并追加 40% 填充字符，然后在 320px 宽视口里测量新增状态面是否溢出视口或产生截断。`apps/web/tests/browser-native-copy.spec.ts` 覆盖页面文案 helper 的中英字典完整性。

## 字典完整性

页面状态文案集中在 `apps/web/src/locales/browser-native-workspace.ts`，按 `document.documentElement.lang` 是否以 `zh` 开头选择字典。单测逐项断言：中英文本非空且不相等、数字占位符在两侧保留、首次使用引导固定 3 步、未知语言回退英文。

移动端 UI-only 页面 `mobile-ui-only.html` 原先硬编码英文，现按 `navigator.language` 选择中英字典，覆盖标题、存储状态、输入占位与无障碍名称、发送/就绪/运行/完成/失败状态与角色标签。

## 伪本地化方法

- 只改写文本节点，跳过 `script`、`style`、`textarea` 与 `contenteditable` 区域；先完成真实 turn、真实导出与真实排队，再应用伪文本，避免把加长文本送进模型或 Session API。
- 测量根覆盖首次使用引导、导出按钮父级、Workspace/排队/离线状态条、移动端状态/存储/转录/表单；对根及其后代检查 `rect` 超出视口与 `scrollWidth > clientWidth` 的截断。
- 一次运行只覆盖一个语言与一个视口，失败可直接复现：`DSH_POC_LOCALE`、`DSH_POC_WIDTH` 驱动。

## 修复

- 导出控件在语言插件发布语言之前创建，标签文本被固化为页面默认英文。`syncExportControl()` 现在每次同步都按当前 `document.documentElement.lang` 重写导出与支持包按钮文本。
- 不可用的导出控件使用内联 `display:flex`，覆盖了 `[hidden]` 的 UA 规则，在 320px 下仍占据固定角落并拦截工作区选择对话框的点击。现在同时设置 `hidden` 与 `display`。
- 页面控件层级的固定定位控件使用 `z-index: 2147483000`，会盖住 z-index 1000 的 Modal。统一降到 900，保留在页面内容之上但低于对话框。

## 结果与边界

- en-US 320×720 与 zh-CN 320×720 各覆盖 queued、main、export、offline-recovery、collaboration-session-conflict、mobile-ui-only，全部 `problems: []`，pageerror 0。
- 伪本地化只验证渲染后的溢出与截断，不验证语义翻译质量、朗读顺序或文字重排后的视觉美观。
- 40% 加长是固定近似值，不模拟具体语言的实际膨胀率；德语、俄语等更长语言仍需各自的真实译文验收。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run apps/web/tests/browser-native-copy.spec.ts
DSH_POC_BROWSER=chrome DSH_POC_LOCALE=en-US DSH_POC_WIDTH=320 node docs/drafts/browser-native-dsh-poc/tests/pseudo-localization-narrow.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_LOCALE=zh-CN DSH_POC_WIDTH=320 node docs/drafts/browser-native-dsh-poc/tests/pseudo-localization-narrow.e2e.mjs
```
