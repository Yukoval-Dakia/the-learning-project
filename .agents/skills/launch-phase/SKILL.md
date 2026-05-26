---
name: launch-phase
description: 启动 phase 多 lane 实施，把 phase spec 拆成独立 lane，每条 lane 在隔离 worktree 里跑 superpowers 完整 loop（impl -> spec review -> fix -> quality review），pre-merge gate 通过后顺序 chain-merge 到 main 并报告 lane state 表。Use when user says "launch phase", "启动 phase", "跑 phase X", "/launch-phase", or hands a phase spec to execute.
---

# Launch Phase

把一个 phase spec 拆成独立 lane，每条 lane 在隔离 worktree 里跑完整 superpowers loop，最后顺序 chain-merge 到 main。

Codex 迁移约束：

- 用 Codex `update_plan` 维护当前 orchestration 状态；需要 lane 级并发状态时，在工作回复中维护 lane state 表。
- 如果可用 multi-agent tools，按 `superpowers:subagent-driven-development` 的要求派 lane subagent；否则在当前会话逐 lane 执行。
- 项目 git guard 由 `.codex/hooks.json` 复用 `.claude/hooks/git-guard.mjs`；触发 hook 时停下来查原因，不绕过。

核心原则：不重复造轮子。所有实际工作 delegate 给 superpowers 既有 skill：

- `superpowers:writing-plans`：给每条 lane 写 plan
- `superpowers:using-git-worktrees`：worktree 隔离
- `superpowers:subagent-driven-development`：per-lane 派 impl/review/fix subagent
- `superpowers:verification-before-completion`：pre-merge gate
- `superpowers:finishing-a-development-branch`：ff-merge gate

本 skill 只管 orchestration 顺序、lane state 表、worktree 污染 guard、chain-merge 安全。

## 何时用 / 何时不用

用：

- 有 phase spec 文档，如 `docs/superpowers/plans/<phase>.md`、`docs/phases/current.md`
- spec 能拆出至少 2 条独立 lane，文件不重叠、不共享 schema 改动
- 想最小化人工介入

不用：

- 单 lane：直接用 `superpowers:subagent-driven-development`
- lane 间有 schema / 同文件依赖：拆 spec 或顺序执行，不走本 skill
- spec 还在 brainstorm：先用 `superpowers:brainstorming`，再用 `superpowers:writing-plans`

## 执行步骤

### 1. 拆 lane

读用户指定的 phase spec。抽取：

- Lane 列表：每条 = 一个 deliverable + 一组 acceptance test
- Lane 依赖：哪些必须 sequential，哪些可并行
- 共享约束：schema / migration 顺序 / 全局配置

Lane 切分标准：一条 lane = 一个 PR = 一个 worktree branch；文件不重叠；自带 acceptance test 集合。

用 `update_plan` 建 orchestration todo。需要更细的 lane task 时，维护一张 lane state 表，字段至少包括 lane、branch、worktree、status、blocked_by、tests、notes。

### 2. Per-lane loop（按依赖拓扑顺序）

对每条 lane：

1. Worktree：用 `superpowers:using-git-worktrees` 建独立 worktree。Guard：subagent prompt 必须显式约束所有 bash 操作只能在 worktree 路径内（见下方模板）。
2. Plan：用 `superpowers:writing-plans` 把 lane spec + acceptance test 转成可执行 plan。
3. Impl：用 `superpowers:subagent-driven-development` 跑 impl -> 自审 -> spec review -> fix -> quality review -> fix。不要并行 dispatch implementation subagent；superpowers 明确反对这种会互相冲突的做法。
4. Pre-merge gate：用 `superpowers:verification-before-completion` 配项目 PR gate：

   ```bash
   pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm test
   ```

   任一失败，回 step 3，不进 step 5。

5. 标 lane `completed`，但不删 worktree、不删 branch；chain-merge 阶段统一清理。

### 3. 顺序 chain-merge

在主 worktree 执行，不在 lane worktree。git guard hook 会拦危险操作；触发即停下找原因，不许绕过。

对每条 ready lane（按依赖顺序）：

```bash
git checkout main
git pull --ff-only origin main

# Verify ff-merge feasibility before touching branch state.
git log --oneline main..<lane-branch>
git log --oneline <lane-branch>..main

# 第二条非空表示 ff-merge 不可能，停下让用户决定 rebase 还是 merge commit。
git merge --ff-only <lane-branch>

# Full gate after merge.
pnpm test

# 测试通过才清理。
git worktree remove <path>
git branch -d <lane-branch>
```

如果 merge 后测试失败，立即停下。不要私自 destructive rollback；说明失败、当前 HEAD、`ORIG_HEAD`，让用户确认下一步。

### 4. 报告

输出表格：

```markdown
# Phase <name> Execution Report

| Lane | Branch | Commits | Tests | Status | Notes |
|------|--------|---------|-------|--------|-------|
| 1. <deliverable> | lane/<id> | N | passing | merged | - |
| 2. <deliverable> | lane/<id> | N | failing | blocked | <reason> |

## Human-decision points
<列 BLOCKED lane 需要人介入的点>

## Cleanup
- Removed worktrees: <list>
- Deleted branches: <list>
- Remaining (manual): <list>

## Push
未自动 push 到 remote。确认后手动：`git push origin main`
```

## Worktree 污染 guard（subagent prompt 模板）

派 lane subagent 时 prompt 必含：

```text
所有 bash 操作（git / pnpm / node 等）只能在 worktree 路径 <path> 内执行。
不许 cd 跳出。不许操作主 repo 路径 <main_path>。
任何 git checkout main / git checkout <other-lane> / 切到非本 lane 的 branch 都是错的。
完成时 commit 在本 lane branch，不 push、不 merge。
git guard hook 会拦 git branch -D / git push --force / git commit on main / git worktree remove --force。这些是兜底，你不要触发。
```

## 不做的事

- 不并行 dispatch implementation subagent
- 不在 ff-merge 验证前删 lane branch / worktree
- 不用 `git branch -D` / `git worktree remove --force`
- 不跳过 pre-merge typecheck / lint / audit / test gate
- 不自动 push 到 remote main
- 不绕过 git guard hook
- 不重复 superpowers 已有的逻辑

## 边界场景

- 共享 migration：必须 sequential，按依赖顺序，不许并行。
- 跨 lane integration test：单独拆一条 "integration lane" 放最后。
- subagent 反复 blocked：至少 2 次同因 blocked 即 escalate 给用户，不无限 retry。
- ff-merge 不可能：让用户决定 rebase 还是 merge commit，不私自处理。
- acceptance test 在 lane 内 flaky：标 lane `blocked` 不 merge，写进报告，让用户决定 rerun / 修测试 / 改 spec。
