---
description: "在 wubuku/deepseek-harness 研究 fork 上存档研究文档并推送的操作备忘：环境前置检查、推送被拒的两个原因、一次性修复、日常流程、推送后校验与故障对照表。"
---

# 研究分支存档与推送备忘

## Summary

本备忘记录在本机 checkout 上把研究成果存档到 `docs/drafts/` 并推送到研究用 fork 的完整方法。它不解释 DSH 的架构，只回答“改完之后怎么推上去”这一件事，供日后继续做研究和存档时直接照做。

本机 checkout 路径为 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness`，当前分支为 `research`，工具版本为 git 2.51.0 与 pnpm 11.7.0。

核心结论是：推送本身只有一条命令 `git push origin research`，但它能否成功取决于两个容易反复踩到的环境问题——OAuth token 缺少 `workflow` scope，以及全局 git 配置里的 SSH 地址重写规则。两者都已在本机修好，修复方式记录在下面，重新克隆或换机器时需要重做。

## 仓库布局

| 远端 | 地址 | 用途 |
|---|---|---|
| `origin` | `https://github.com/wubuku/deepseek-harness.git` | 研究用 fork，研究成果推送到这里 |
| `upstream` | `https://github.com/deepseek-ai/deepseek-harness.git` | 官方仓库，只用于同步 `master` |

`origin` 的 fetch 走 HTTPS，push 走 SSH。这个不对称是刻意的，原因见后文。

本地 `master` 跟踪 `upstream/master`，`research` 跟踪 `origin/research`。研究文档只提交到 `research`，不要推到 `master`。

## 推送前的前置检查

每次开始存档前，先确认这三件事都是通的：

```sh
cd /Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness
git remote get-url --push origin
ssh -T git@github.com
pnpm run test:docs
```

期望结果分别是：打印出 `ssh://git@github.com/wubuku/deepseek-harness.git`；SSH 问候返回 `Hi wubuku! You've successfully authenticated...`；文档门禁全绿。

如果第一条打印的是 `https://` 开头的地址，说明 pushurl 被重置了（换机器、重新克隆、或有人改过配置），按下一节的命令重设。

## 推送被拒的两个原因

### 原因一：OAuth token 缺少 workflow scope

同步上游 `master` 后，分支上会带上 `.github/workflows/` 下若干文件的改动。GitHub 对 workflow 文件的创建、更新和删除都强制要求 token 具备 `workflow` scope，缺少时远端直接拒绝：

```text
! [remote rejected] research -> research (refusing to allow an OAuth App to
  create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
```

这是 GitHub 服务端的策略，与仓库是否真的需要 CI 无关。研究 fork 不需要 CI，所以正确做法不是去申请 scope，而是换一种不受该策略约束的凭据。

### 原因二：全局 git 配置把 SSH 地址重写回 HTTPS

本机全局配置里有一条重写规则：

```sh
git config --global --get-regexp '^url\.'
# url.https://github.com/.insteadof git@github.com:
```

它会把 `git@github.com:` 开头的地址改写成 `https://github.com/`。因此把 pushurl 设成常见的 `git@github.com:wubuku/deepseek-harness.git` 是无效的——`git remote get-url --push origin` 仍会显示 HTTPS 地址，推送继续走 OAuth token，继续被 workflow scope 挡住。

## 一次性修复

把 pushurl 设成 `ssh://` 协议形式。该前缀不匹配上面的重写规则，因此能真正走 SSH key：

```sh
git remote set-url --push origin ssh://git@github.com/wubuku/deepseek-harness.git
git remote get-url --push origin
```

第二条命令必须打印 `ssh://git@github.com/wubuku/deepseek-harness.git`；如果仍显示 HTTPS，就是被重写规则改回去了，需要检查该规则。

这个改动只影响 `origin` 的 push URL，修改的是本仓库的 `.git/config`，不改动全局 git 配置，也不改动任何 GitHub 权限。fetch 仍然走 HTTPS。

如果哪天 SSH key 不可用，退路是给凭据补 `workflow` scope（`gh auth login --scopes workflow` 后 `gh auth setup-git`，或更换带该 scope 的 PAT），但那是备选，不是首选。

## 日常存档与推送流程

新增或修改研究文档后，按顺序执行：

```sh
# 1. 确认在 research 分支且工作区状态清楚
git status --short --branch

# 2. 新增草稿时，登记进配对清单的 excluded 名单
#    scripts/translation-pairing.manifest.json 的 "excluded" 数组
#    按字典序插入新文件的仓库相对路径

# 3. 跑文档门禁
pnpm run test:docs

# 4. 提交（pre-commit 会跑 whitespace 与 vendor 检查）
git add docs/drafts/<新文件>.md scripts/translation-pairing.manifest.json
git commit -m "docs(drafts): <描述>"

# 5. 推送（pre-push 会跑增量 typecheck）
git push origin research
```

第 2 步容易漏。`docs/drafts/` 下的文档都是中文单语，不参与中英配对，因此必须在 `scripts/translation-pairing.manifest.json` 的 `excluded` 数组里登记；漏登记时 translation pairing 门禁会失败。

## 依赖未装齐时的处理

`pre-push` 钩子会运行增量 typecheck。同步上游 `master` 后 lockfile 可能新增依赖，本地未安装时 typecheck 会以 `Cannot find module` 失败，例如：

```text
packages/boot/hmr/tests/profile.spec.ts(10,27): error TS2307: Cannot find module 'chokidar'
packages/boot/plugin-manager/tests/manager.spec.ts(19,38): error TS2307: Cannot find module 'yaml'
```

这不是代码问题，先装依赖再推送。本机默认 registry 是 `registry.npmmirror.com`，实测不可达（请求超时），必须显式换官方 registry：

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
```

验证依赖是否就位时注意 pnpm 使用包内链接结构，根目录 `node_modules/chokidar` 不存在并不代表没装。应检查真正需要它的包：

```sh
ls -d packages/boot/hmr/node_modules/chokidar
ls -d packages/boot/plugin-manager/node_modules/yaml
```

## 推送后校验

推送完成后核对远端 ref 与本地 `HEAD` 一致，并确认工作区已回到干净状态：

```sh
git ls-remote origin refs/heads/research
git rev-parse HEAD
git status --short --branch
```

前两条命令输出的 SHA 必须完全相同。第三条应打印 `## research...origin/research`，不带 `[领先 N]`，且没有任何未提交或未跟踪的改动。

文档门禁的完整集合是 `pnpm run doc-sync`。它比 `test:docs` 多跑若干项，其中 `doc-typecheck` 会先执行 `pnpm run build:lib:host`，因此同样依赖完整安装；报 `Cannot find module` 时按上一节处理，不要绕过。

## 故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `refusing to allow an OAuth App to create or update workflow` | pushurl 落回 HTTPS，token 缺 `workflow` scope | 重设 pushurl 为 `ssh://` 形式并确认生效 |
| `git remote get-url --push origin` 显示 HTTPS | 全局 `url.*.insteadof` 重写规则 | 使用 `ssh://` 形式而不是 `git@host:` 形式 |
| typecheck 报 `Cannot find module 'chokidar'` 等 | 同步上游后依赖未安装 | 用官方 registry 执行 `pnpm install --frozen-lockfile` |
| translation pairing 门禁失败 | 新草稿未登记 | 加入 `scripts/translation-pairing.manifest.json` 的 `excluded` |
| `verify-md-links` 报链接失效 | 上游删除了被引用的示例文件 | 改指向仍存在的目标，不要留下死链 |
| `verify-package-paths` 报 packages 引用不存在 | 文档里写了尚未创建的包路径，且其中某段与真实包同名 | 改为以包根为基准的相对路径 |

## 不要做的事

不要用 `git push --no-verify` 绕过 pre-push 钩子。它掩盖的是真实的依赖或类型问题，而这些问题在下次推送时仍然存在。

不要为了推送去申请 `workflow` scope 或改动全局 git 配置。SSH 方式已经足够，且不改动本机其他仓库的行为。

不要用 `git push --force`。本分支不需要重写历史；确需重写时也必须用 `--force-with-lease` 并在推送前记录远端 OID。

不要在 `research` 上推送与存档无关的代码改动，也不要推到 `master`。

`gh` 当前未登录，因此推送后无法用 `gh pr checks` 查看远端 CI 状态。研究 fork 不承载 CI 结论，验收以本地 `pnpm run test:docs` 与推送后 ref 校验为准；需要远端 CI 信号时先执行 `gh auth login`。
