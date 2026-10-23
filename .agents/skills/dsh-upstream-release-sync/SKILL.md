---
name: dsh-upstream-release-sync
description: Find the latest published DeepSeek Harness release, including prereleases, and merge its upstream tag into the local research branch. Use when asked to sync an upstream DSH release to research, including "同步 DSH 上游 release 到 research".
---

# Sync an Upstream DSH Release

Use this workflow when the user asks to bring the newest published release from `deepseek-ai/deepseek-harness` into this repository's `research` branch.

Follow the repository's `AGENTS.md` while resolving the release diff. Read `docs/architecture.md` before changing packages, update every consumer of changed public APIs, follow the persistence review guidance for durable types, and record externally perceptible breaking changes in an upgrade guide.

## Check the checkout

1. Run `git status --short --branch`, `git rev-parse --show-toplevel`, and `git remote -v`.
2. Continue only from the repository's `research` branch with a clean worktree. Do not switch branches, stash user changes, or merge over unrelated work; report the blocker if either precondition fails.
3. Confirm that the `upstream` fetch URL points to `https://github.com/deepseek-ai/deepseek-harness.git`. `origin` may point to a fork and is not the source for release tags.

## Identify and fetch the release

1. Read `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100` or the GitHub Releases page. Include prereleases, ignore drafts, and select the published release with the newest `published_at`; paginate if the newest record is not in the response. Do not use `/releases/latest`: it excludes prereleases and can return 404 when the repository has no stable release.
2. Take the exact `tag_name` from the release record. DSH release names look like `v0.2.1-rc.2`, while their Git tags look like `dsh-v0.2.1-rc.2`; merge the tag, not the display name. Do not infer the release from local tag ordering alone.
3. Fetch from upstream with `git fetch --tags upstream`. Confirm the exact tag exists locally and resolves to a commit with `git rev-parse '<tag>^{commit}'`; inspect the release name and commit subject before merging.
4. If the tag is already an ancestor of `HEAD`, report that research already contains it and stop without creating another merge.

## Merge and verify

1. Save the current research commit, then merge the exact release tag with `git merge --no-ff --no-edit <tag>`. Do not push; release synchronization only updates the local research branch unless the user separately asks to publish it.
2. Resolve conflicts by comparing both sides with the merged source and its tests. Preserve independent research behavior when it remains supported, adopt upstream behavior where the source has moved on, and combine public exports when both sets of types still exist. Regenerate committed generated files with their owning generator instead of editing generated output by hand. Check links, bilingual README records, snapshots, and release upgrade guides when their source files change.
3. Run focused tests for each resolved behavior and the relevant documentation checks. Follow the repository's testing policy; do not default to the full test suite. Report any command that could not run and the environment evidence.
4. Complete the merge commit after all conflicts and selected checks are handled. Verify that the saved research commit is the first parent, the release tag commit is an ancestor of `HEAD`, and the worktree is clean apart from changes intentionally made for this request.

Report the release name, exact tag, tag commit, merge commit, conflicts resolved, checks run, and whether anything was pushed. Never publish the branch unless explicitly asked.
