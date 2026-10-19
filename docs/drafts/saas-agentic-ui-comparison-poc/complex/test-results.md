# 复杂 SaaS 实验的实际测试记录

## 范围与结论

记录日期为 2026-10-19。主验收对象是 CopilotKit 原生前端工具、HITL 与页面协作，执行者始终为 Dedicated Worker 内的真实 DSH。安装版 Chrome 和 Playwright WebKit 均通过 scripted 故障矩阵、真实模型完整业务故事、真实模型生命周期测试。WebKit 结果不是 Safari.app 的验收结论。

真实模式由 backend 读取主工作区 `docs/drafts/.env`，浏览器只请求同源代理。没有复制密钥、给前端设置模型凭据或启用 CopilotKit 云。版本固定在父 lockfile：CopilotKit 1.79.1、AG-UI 1.0.2、assistant-ui 0.15.29、React 19.1.0。

## 实际命令

从父实验目录执行：

```sh
npm run build
npm test
npm run test:complex
npm run check:complex
npm run test:e2e
npm run test:complex:e2e
node --import tsx complex/tests/experiment.e2e.mjs --ui=copilot
node --import tsx complex/tests/experiment.e2e.mjs --ui=copilot --webkit
node --import tsx complex/tests/lifecycle.e2e.mjs --ui=copilot
node --import tsx complex/tests/lifecycle.e2e.mjs --ui=copilot --webkit
```

真实模型完整故事和生命周期分别执行了以下两条命令，并分别追加 `--webkit` 再执行：

```sh
https_proxy=http://127.0.0.1:9981 http_proxy=http://127.0.0.1:9981 all_proxy=socks5://127.0.0.1:9981 \
  NO_PROXY=127.0.0.1,localhost,::1 \
  node --use-env-proxy --import tsx complex/tests/experiment.e2e.mjs --real --ui=copilot
https_proxy=http://127.0.0.1:9981 http_proxy=http://127.0.0.1:9981 all_proxy=socks5://127.0.0.1:9981 \
  NO_PROXY=127.0.0.1,localhost,::1 \
  node --use-env-proxy --import tsx complex/tests/lifecycle.e2e.mjs --real --ui=copilot
```

两条真实模型命令都再追加 `--webkit` 执行。测试进程需要 `--use-env-proxy`；仅设置代理环境变量时 Node 不会自动把模型 fetch 路由到 HTTP 代理。`NO_PROXY` 保证本机 E2E 请求直连本机服务。

`npm test` 的父实验 9 个单测通过，新实验 `test:complex` 的 11 个单测通过。后者覆盖字段补丁、版本/审批、角色、跨客户选择、幂等、数据库/HTTP 快照校验、精确调用结算、取消与晚到结果、detach、历史 hydration、输入去重，以及错误 call id 的续接不能遗失原 waiter。`check:complex` 的 strict 检查通过，但范围仅为业务域、桥和分段适配器，依赖已构建的 DSH 声明，不是全 GUI 或全仓 typecheck。

局部多入口构建通过，保留 Vite 大 chunk 告警。首次环境的 `npm ci` 没有重新执行；此次复用相同实验 checkpoint 的忽略构建产物与固定局部依赖，不能据此宣称已验证干净机器安装。没有单独执行全仓构建；`doc-sync` 中的 doc-typecheck 触发 Host 构建时因 workspace 依赖未安装而失败，详见文末。

## CopilotKit 完整业务证据

| 模式 / 浏览器 | 用户消息 | 场景检查点 | DSH 工具调用 / 结果 | 对话模型请求 / DSH step | 辅助标题请求 | AG-UI 段 | 结果 |
|---|---:|---:|---:|---:|---:|---:|---|
| scripted / Chrome | 11 | 13 | 16 / 16 | 28 / 28 | 1 | 25 | 通过 |
| scripted / WebKit | 11 | 13 | 16 / 16 | 28 / 28 | 1 | 25 | 通过 |
| 真实模型 / Chrome | 10 | 12 | 21 / 21 | 31 / 31 | 1 | 29 | 通过 |
| 真实模型 / WebKit | 10 | 12 | 16 / 16 | 26 / 26 | 1 | 24 | 通过 |

四份[原始 evidence JSON](evidence/README.md)均保存调用 id、结果 id、原生 handler 计数、协议段、模型请求归属、已记录页面上下文、流式采样、同源网络地址和业务 receipt。脚本断言新用户消息数等于 DSH turn 数，不因续接新增 prompt；每个原工具调用都有对应结果，没有重复原生执行身份。

最近一次 scripted Chrome 对照中，三路线均完成同一 13 个检查点，用户输入各 11 条；每条路线有 16 次工具调用/结果和 10 份业务 receipt。真实模型 Chrome 与 WebKit 分别记录 21/21、16/16 次工具调用/结果；模型工具策略不同会改变只读查询次数和续接段数，不代表业务重复写入。真实 Chrome、WebKit 分别观测到 17、6 个不同长度的助手文本片段；scripted 原生 renderer 观测到 3 个增长长度。`pageErrors` 均为空；这不等于所有 console 信息均为空。

逐项验证包括：选择两张工单批量分配且不改第三张；切客户后的新上下文；人工预算与 Agent 折扣字段协作；8% 到 9% 更新中的并发版本冲突；拒绝不发送；等待审核时停止；后续继续和真实多轮代号记忆；聊天中编辑共享表单、批准后同一 turn 发送一次；刷新不重放；只读服务端拒绝；operation id 重放与丢响应重试。模型故障注入只在 scripted 批中执行，不能冒充真实模型自行出错。

总模型请求比对话 step 多一条，来自 DSH 自己的标题服务；它也可携带同一 Session id。测试按标题输入辨别辅助请求，再断言其余同 Session 请求逐一对应默认 Loop 的 step。该断言适用于此实验不重试的执行路径，不声称一般 DSH 的一次 step 永远只能有一个模型 attempt。

最近一次三路线 scripted Chrome 故事因旧采样只监听 MutationObserver 而漏掉 DSH 原生 renderer 的批量 DOM 更新，产生过一次流式断言失败；浏览器截图和文本确认回答最终存在，但单靠失败截图不能作为流式证据。采样改为 MutationObserver 加 20ms 定时读取后，三条路线重新全通过，并保存三路完成截图。该修改只提升采样可靠性，没有放宽“至少观察到两个不同文本长度”的断言。

审核截图使用实际 viewport，避免全页截图改变聊天高度后产生误导。保存的[Chrome 审核界面](evidence/shared-form-real-chrome.png)和[WebKit 审核界面](evidence/shared-form-real-webkit.png)可直接比较左右两处相同报价组件，而不是只有气泡截图。

## 生命周期与持久化

真实模型 Chrome 和 WebKit 的[生命周期结果](evidence/README.md)均验证：第二标签页的写权被拒绝而原标签继续可用；关闭页面并重启同端口、同数据目录的 backend；DSH 历史和业务数据/receipt 一起恢复；恢复后继续回答代号；等待人工审批时刷新不重放旧 handler、不保留旧批准按钮、不新增业务写入，之后仍可对话。

恢复的是已持久化事实，不是旧 React 函数、正在等待的表单 Promise 或页面关闭后的后台执行。业务数据测试先由已有 GUI 完成一次分配，再重启并逐值比较，避免只证明空数据库可以重启。

## 对照与回归

父实验原入口的 scripted Chrome 三路线回归全部通过，每条各有 10 条用户消息、6 次工具调用/结果和 4 份业务凭据，见[日志](evidence/parent-regression-chrome.txt)。原 Browser-Native DSH 与 assistant-ui PoC 的源码未修改；本次不声称重新执行过它们各自全部真实模型测试。

复杂实验的较早真实 WebKit 三路线完整批均通过，见[对照汇总](evidence/controls-real-webkit-summary.json)。真实 Chrome 对照批中 CopilotKit 与 assistant-ui 完整通过，DSH 原生在新增的审核卡视口检查处失败，不能把该批写成全部通过，见[原始部分结果](evidence/controls-real-chrome-partial-summary.json)。为新入口的原生 scrollport 增加 composer 高度留白后，其 Chrome scripted 全故事和视口检查通过，见[修正后结果](evidence/native-layout-recheck-chrome.json)；修正后没有继续强求其重跑真实 Chrome 全故事。

生命周期的早期 scripted Chrome、WebKit 三路线批也已通过；最后扩充的“非空业务数据重启”断言只重点重跑了 CopilotKit 的两次真实模型生命周期测试。不把其他路线未重跑的新增断言算作通过，也不为等量打磨对照而更改旧 PoC。

新实验的默认 `npm run test:complex:e2e` 还完成一次三路线 Chrome scripted 全故事回归，含新增模型请求归属断言，见[默认命令汇总](evidence/controls-scripted-chrome-summary.json)。最终补充快照校验后，CopilotKit 又通过两种浏览器的完整 scripted/真实模型故事，以及两种浏览器的 scripted 非空数据重启测试；这些是输入校验的回归，不改变前述真实生命周期结果的含义。

## 失败、修正与残留限制

开发中遇到过真实上游 60 秒超时，现在会显示本轮错误而允许下一轮继续；它不是一次业务成功。原生审核卡曾被 composer 遮挡，跨 renderer 的 Context 曾停留在旧报价版本，CSS 变量曾与框架冲突；修正和责任说明见[设计与评估](design-and-assessment.md#已验证的工程经验)。没有删除业务断言来把失败改成成功。

DSH bootstrap 的非核心主机功能仍可能产生同源的 `open-in-app/apps`、`plugins/events` 404，浏览器也可能请求不存在的 favicon；此次网络断言验证没有外部请求与凭据暴露，不声称 console 零错误。原生路线仍带工作区外壳和默认工作区提示，未改造成生产 SaaS 组件库。

CopilotKit 使用开发期 `agents__unsafe_dev_only`，生产注入未验收；没有验证真实身份认证、多租户授权、完整离线、任意页面导航、A2UI、生产包体/性能和总工时。GUI operation id 保障一次提交与该次 receipt 查询，不保证跨刷新自动恢复未知操作或网络分区下的全局 exactly-once。前端工具与 API 的版本、权限、幂等仍是 SaaS 自己的责任。

## 仓库检查

本机隔离 worktree 通过以下环境设置避免 pnpm 因共享依赖路径不同而自动清理/重装缓存，不跳过文档检查本身：

```sh
pnpm_config_verify_deps_before_run=false pnpm run test:docs
pnpm_config_verify_deps_before_run=false pnpm run doc-sync
pnpm_config_verify_deps_before_run=false pnpm run docs:build
git diff --check
```

`test:docs` 为 21 passed。完整 `doc-sync` 为 41 passed、2 failed：documentation build 起初缺少隔离 worktree 的 VitePress 依赖，连接已有 website 依赖后单独重跑 `docs:build` 通过，4984 个内部片段链接可解析；doc-typecheck 则触发仓库 Host 构建，因 CLI/desktop 等 workspace 未安装 `commander`、`electron`、`koffi` 等局部依赖而失败，伴有这些既有源码的类型诊断。没有为本实验修改这些源码、安装全仓依赖或声称完整 doc-sync 已绿。详细本机日志见进度。

局部构建、单测、strict 与父入口回归记录如前，最终差异检查通过。未运行全仓单测、覆盖率、生产发布构建或 Safari.app，不将这些列入通过清单。
