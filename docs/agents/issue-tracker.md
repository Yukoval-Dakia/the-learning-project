# Issue Tracker Configuration

This project uses **Linear** as its primary issue tracker. GitHub Issues are historical / fallback context only; all new planning, triage, and roadmap work goes through Linear.

## Workspace

- Workspace: **Yukoval Studios**
- Team key: **YUK** (issue identifier 形如 `YUK-123`)
- Base URL: https://linear.app/yukoval-studios
- Repository: **Yukoval-Dakia/the-learning-project**
- GitHub webhook: configured 2026-05-23 at repository level, active, `push` event only, `application/json`. Do not store or print the webhook secret in this repo.

## Layer mapping

Linear 原生层级 → 项目语义：

| Linear           | 用途                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| **Initiative**   | 跨多 phase 的大版本（v0.3、v0.4...）。可选，phase 不大时不必建。     |
| **Project**      | 一条主线 / lane / phase。当前活的 4 条：**领域模型重构 (YUK-203)** / **私人教研团 rethink (YUK-405)** / **记忆层 (YUK-322)** / **UI 重绘 (YUK-169)**。新 issue 优先挂对应 Project。 |
| **Milestone**    | Project 内的执行节点（M1 / M2...）。带 target date。                  |
| **Issue**        | 单个可独立 grab 的工作单元。带 priority；estimate 可选（做 cycle 排程时再设 Fibonacci）。 |
| **Cycle**        | 1–2 周冲刺。只把当前焦点 issue 挂 cycle，别灌整个 backlog。           |

> 配套：`docs/agents/linear-agent-guidance.md`（Agent guidance 源，粘贴进 Settings→AI）+ `docs/agents/linear-maximization.md`（最大化方案 + PR→状态自动流转开关说明）。

## Workflow

### 纪律（standing rules，每次都遵守）

- **Linear = 驾驶舱，不是 compute**：绝不用 Linear 原生 coding session（委派 issue→Linear 跑 agent 出 PR）——它按 AI credits 真金白银扣（$0.5–5+/次，opt-in，不充钱没有此功能）。委派一律走 `W`→`O`（Open in coding tool）把 issue 丢进**本地 Claude Code**（owner 的 Max 订阅/机器，0 Linear 充值）。其它面（Projects / Cycles / Labels / Agent chat / project update / PR 状态自动流转）全不碰 credits，放心用。
- **活的工作进 Project**：为当前主线建/更新 issue 时挂到对应 live Project——**领域模型重构 (YUK-203)** / **私人教研团 rethink (YUK-405)** / **记忆层 (YUK-322)** / **UI 重绘 (YUK-169)**；新主线就建新 Project。别让活跃工作裸飘成 parent-issue 树（2026-06-18 重组前的旧病）。
- **带 area 标签**：每个 issue 挂一个 `area:matcher|kg|practice|copilot|memory|ui`（子系统轴，与 triage 标签正交）。
- **Cycle 只装焦点**：只把当前在跑的 issue 挂 cycle，别灌整个 backlog。
- 完整说明见 `docs/agents/linear-maximization.md` + `docs/agents/linear-agent-guidance.md`。

### Closeout issue capture gate

Every implementation, audit, planning, or migration task must reconcile Linear before the final response. This is a gate, not a nice-to-have.

1. Collect actionable follow-ups discovered during the turn:
   - repo/code/doc drift verified against current files;
   - work intentionally left out of scope but needed for the current roadmap;
   - stale docs confirmed against the codebase source of truth;
   - Linear issue state that no longer matches shipped code;
   - failed validation or environment blockers that need a concrete follow-up;
   - TODO/FIXME/comment evidence only when it is still valid and not already covered.
2. Search existing Linear issues first by `YUK-*`, title keywords, file path, symbol name, and project/milestone. Update the existing issue when it covers the same work.
3. Create a new Linear issue when the follow-up is executable, repo-evidenced, and not already covered. 新建时按上面的纪律挂对应 live Project（YUK-203/405/322/169 之一，或新建 Project）+ 一个 `area:*` 标签 + 合适的 triage 标签。
4. Do not create an issue for speculative ideas, answered questions, already-fixed work in the current diff, historical archive notes, or vague "improve X" work without a concrete next action.
5. If the Linear connector is unavailable, include an exact issue draft in the final response and say the connector was unavailable.

The final response must say which Linear issues were created or updated. If none were needed, say "No Linear issue needed" with a one-sentence reason.

### Issue shape

New issues should be small enough for one agent pass. Required content:

- title with the concrete action, not the symptom alone;
- project and milestone when known;
- estimate 可选（默认不设；做 cycle velocity 排程时再补 Fibonacci 1/2/3/5/8，>8 拆分）；
- priority 2/3/4 unless urgency is explicitly known;
- labels from `docs/agents/triage-labels.md`;
- description with source paths, observed evidence, acceptance criteria, and validation command when applicable.

Default labels:

- `ready-for-agent` when the issue is executable without a product decision;
- `needs-info` when a human/product decision is required;
- `needs-triage` when the project or milestone is not clear yet;
- `drift` when the issue is about code/doc/status mismatch.

### Issue body template

When the issue maps to a plan-doc task (the common case for phase work), use this 6-section template. It is the shape that worked for the P0 milestone (YUK-27..33). Skip sections that don't apply rather than leaving them empty.

```markdown
## Files
- Create: <abs path>
- Modify: <abs path>:<line range>

## Acceptance
- <verifiable bullet — command + expected output>
- ...

## Spec
- spec: <doc path + section anchor>
- plan: <doc path + Task #>

## Commit
- <commit message hint + `Closes YUK-NN`>

## Depends on
- <YUK-NN that must complete first>

## Boundaries (out of scope)
- <thing this issue explicitly does NOT do; point to the issue that will>
```

Title format: `[<phase>/<task#>] <verb phrase>` (e.g. `[P0/4] Physics e2e smoke test`). Makes filtering by phase trivial in the Linear UI and keeps phase order visible.

### Granularity

- **Merge** two plan tasks into one issue when they must commit together (e.g. P0/1 + P0/2 — profile literal + registration — would leave the registry in an inconsistent half-state if shipped separately).
- **Split** a plan task into multiple issues when each step is independently reviewable / mergeable.
- Floor: ≥ 3 issues per milestone. Fewer and the granularity is too coarse to give meaningful progress signal.
- Ceiling: avoid 1 issue per commit. Debugging fixes / formatter passes / rebase collateral don't get their own issue — mention them in the parent issue's PR body or commit trailer.

### 创建 issue

通过当前 agent runtime 暴露的 Linear MCP / app connector（不要再用 `gh issue create`）：

- `save_issue` — 创建或更新 issue。必填 `team` + `title`。建 issue 时同时指定 `project` + `milestone` + `estimate` + `priority`。
- `save_project` — 创建或更新 project。
- `save_milestone` — 创建或更新 milestone（必须挂 project）。

Tool name depends on runtime: Codex app exposes names like `mcp__codex_apps__linear._save_issue`; Claude Code may expose names like `mcp__claude_ai_Linear__save_issue`. Prefer the available Linear tool with matching semantics over exact name matching.

### 读 issue

- `list_issues` — 列表 + structured filter。
- `search` — full-text search across issues / projects / docs.
- `fetch` or `get_issue` — 单条详情（取决于 runtime 暴露的工具）。
- `list_projects` / `list_milestones` — 浏览 roadmap。

### 状态流转

标准 status（团队 `Yukoval Studios`）：

```
Backlog → Todo → In Progress → In Review → Done
                                         ↘ Canceled / Duplicate
```

通过 `save_issue` 的 `state` 字段设置。

### Priority

`0=None, 1=Urgent, 2=High, 3=Medium, 4=Low`。

### Estimate

**可选字段**（默认不设——本工作区实践里多数 issue 无 estimate）。需要 cycle velocity / project 按点进度时再补 Fibonacci 1 / 2 / 3 / 5 / 8 points，> 8 的 issue 应拆分。不要为凑字段编估值。

## PR ↔ Issue link

Linear 的 GitHub integration 已开启。当前仓库 webhook 只订阅 `push`，用于 commit magic-word link；PR / branch link 由 Linear GitHub integration 处理。

### Confirmed behaviours

These are observed working in the YUK-27..33 (P0 milestone) execution:

- ✅ **commit message** containing `Closes YUK-XX` → integration auto-adds the commit as an attachment on the issue, and auto-sets the issue assignee to the commit author.
- ✅ PR title / description containing `YUK-XX` → integration auto-adds the PR as an attachment on the issue (separate from commit attachments).

### Unconfirmed (verify before relying on)

The following are advertised behaviours of Linear's GitHub integration but were **not** observable in the YUK-27..33 run, because the issues were manually moved to Done before the PR merged. The Linear settings may or may not have the matching automation enabled — verify by leaving one issue in `In Progress`, merging its PR, and observing the state after ~1 minute.

- ❓ PR moved to review state → issue auto-transitions to `In Review`
- ❓ PR merged → issue auto-transitions to `Done`
- ❓ Branch named `yuk-xx-<slug>` (Linear's `gitBranchName`) auto-links to the issue. Our branches used `<phase>/<slug>` form instead of `yuk-xx-`, so this was never exercised.

### Important nuance: commit > PR body

Integration scans **commit messages**, not PR descriptions alone, for link triggers. Observed in YUK-33: its PR body said `Closes YUK-33 (this PR)` but no commit message referenced YUK-33, and the issue got no auto-attachment. Put `Closes YUK-XX` in at least one commit message on the branch, not only in the PR body.

### Keyword convention

**Use `YUK-XX` in commit messages, PR titles, and PR descriptions for all new work — never bare `#N`.** Linear recognises `Closes YUK-XX` / `Fixes YUK-XX` / `Resolves YUK-XX` / `Part of YUK-XX`. Legacy `#N` is reserved for historical GitHub-issue references during archaeology.

When one commit or PR references multiple Linear issues, repeat the keyword for every issue. Do:

```text
Closes YUK-27
Closes YUK-28
```

Do **not** write `Closes YUK-27 + YUK-28` / `Fixes YUK-27, YUK-28` / `Part of YUK-27 and YUK-28`. Observed failure (2026-05-23): Linear linked the first issue and missed the later bare `YUK-XX` references. `.claude/hooks/linear-guard.mjs` blocks this shorthand on Linear-tracked branches.

### Manual overrides — when you still need to call `save_issue`

The integration does not know when **you start** a task. These transitions stay manual:

- `Todo → In Progress` when you write the first line of code / open the first tool call for the issue. The integration has no signal for this. Call `save_issue` once.
- Adding a PR URL as a Linear attachment via `links` field on `save_issue` — only useful if the PR body / commits don't reference the issue (the integration would otherwise add it for you). Rare.
- Re-opening / cancelling an issue mid-work because scope shifted.

After `Closes YUK-XX` lands in a commit and the PR merges, the integration **should** finish the loop. If the issue is still `In Progress` an hour after merge, that's a real desync — file it as feedback so this doc can be tightened.

### What we don't auto-sync (intentional)

Do **not** build these without an explicit owner decision:

- **No reverse sync** (Linear → git). E.g. moving an issue to In Progress should not auto-create a branch / checkout. Treats git as the source of truth; Linear UI actions shouldn't have repo side-effects.
- **No commit-hook parser** that calls Linear API on every commit. The integration already covers magic words; doubling up causes duplicate attachments / re-toggled state.
- **No cron reconcile**. If a desync is observed, write it in plain text first; whether to introduce automation is an owner decision.

## Migration note (2026-05-23)

从 GitHub Issues 迁到 Linear。老 GitHub issue 不批量迁，保留为历史 archive；只在 Linear 开新 issue。如果新 Linear issue 需要承接旧 GitHub issue，请在 Linear issue description / link attachment 中放旧 GitHub URL，而不是反向继续用 GitHub issue 做主 tracker。

## Repository (for PR / commit context)

- Repository: Yukoval-Dakia/the-learning-project
- Base URL: https://github.com/Yukoval-Dakia/the-learning-project
