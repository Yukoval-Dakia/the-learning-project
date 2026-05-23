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
| **Project**      | 一条 lane / phase（如 "Foundation B — SubjectProfile"）。            |
| **Milestone**    | Project 内的执行节点（M1 / M2...）。带 target date。                  |
| **Issue**        | 单个可独立 grab 的工作单元。带 estimate（Fibonacci 1/2/3/5/8）+ priority。 |
| **Cycle**        | 1–2 周冲刺。Issue 可挂 cycle 做短期排程。                            |

## Workflow

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
3. Create a new Linear issue when the follow-up is executable, repo-evidenced, and not already covered.
4. Do not create an issue for speculative ideas, answered questions, already-fixed work in the current diff, historical archive notes, or vague "improve X" work without a concrete next action.
5. If the Linear connector is unavailable, include an exact issue draft in the final response and say the connector was unavailable.

The final response must say which Linear issues were created or updated. If none were needed, say "No Linear issue needed" with a one-sentence reason.

### Issue shape

New issues should be small enough for one agent pass. Required content:

- title with the concrete action, not the symptom alone;
- project and milestone when known;
- estimate 1/2/3/5/8, with >8 split before creation;
- priority 2/3/4 unless urgency is explicitly known;
- labels from `docs/agents/triage-labels.md`;
- description with source paths, observed evidence, acceptance criteria, and validation command when applicable.

Default labels:

- `ready-for-agent` when the issue is executable without a product decision;
- `needs-info` when a human/product decision is required;
- `needs-triage` when the project or milestone is not clear yet;
- `drift` when the issue is about code/doc/status mismatch.

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

Fibonacci 1 / 2 / 3 / 5 / 8 points。> 8 的 issue 应拆分。

## PR ↔ Issue link

Linear 的 GitHub integration 已开启。当前仓库 webhook 只订阅 `push`，用于 commit magic-word link；PR / branch link 由 Linear GitHub integration 处理。预期行为：

- PR 标题或描述里包含 `YUK-XX` → 自动 link issue。
- PR 进 review → issue 自动转 "In Review"。
- PR merged → issue 自动转 "Done"。
- branch 名以 `yuk-xx-` 开头（Linear `save_issue` 返回的 `gitBranchName`）也会自动 link。

**Commit message / PR title / PR description 写 `YUK-XX`，不要给新工作写裸 `#N`。** `Closes YUK-XX` / `Fixes YUK-XX` / `Part of YUK-XX` 会由 Linear 处理。旧 GitHub issue 的 `#N` 只在追溯历史上下文时使用。

## Migration note (2026-05-23)

从 GitHub Issues 迁到 Linear。老 GitHub issue 不批量迁，保留为历史 archive；只在 Linear 开新 issue。如果新 Linear issue 需要承接旧 GitHub issue，请在 Linear issue description / link attachment 中放旧 GitHub URL，而不是反向继续用 GitHub issue 做主 tracker。

## Repository (for PR / commit context)

- Repository: Yukoval-Dakia/the-learning-project
- Base URL: https://github.com/Yukoval-Dakia/the-learning-project
