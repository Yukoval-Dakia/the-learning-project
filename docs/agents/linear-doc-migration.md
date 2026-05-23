# Linear Document Migration

This is the control plane for migrating repo Markdown into Linear without losing
the codebase as source of truth.

## Ground Rules

- The repo remains the source of truth for executable facts: code, schema, ADRs,
  implementation plans, audit trails, agent skills, and local setup.
- Linear is the management surface: current status, roadmap execution map,
  issue ownership, milestones, status updates, and searchable document index.
- No document is copied to Linear until its freshness verdict is known.
- Linear documents must include source path, source commit, verification date,
  freshness verdict, and a note that the repo remains source of truth.
- Do not migrate secrets, webhook secrets, API keys, `.env*`, personal MCP
  config, or local-only machine paths except as non-sensitive repo paths.
- GitHub Issues are historical only. New planning, triage, and roadmap work uses
  Linear `YUK-*` identifiers.

## Linear Containers

Create and maintain one Linear project for the migration:

| Linear object | Name | Purpose |
|---|---|---|
| Project | `Project Ops — Roadmap & Docs SOT` | Central project for repo-to-Linear docs governance. |
| Milestone | `M1 — Freshness Audit + Manifest` | Establish repo freshness rules and generated manifest. |
| Milestone | `M2 — Linear Document Migration` | Publish current docs and indexes into Linear. |
| Milestone | `M3 — Issue/Status Reconciliation` | Reconcile existing `YUK-*` issues against shipped code. |

Create these project documents:

| Linear document | Source | Migration mode |
|---|---|---|
| `Doc Catalog — Repo ↔ Linear Manifest` | this file + `pnpm docs:linear-manifest` | full doc + generated manifest summary |
| `Current Status Snapshot` | `docs/superpowers/status.md` | full doc after freshness refresh |
| `Roadmap Execution Map` | `docs/planning/v0.3-generalized-ai-learning-framework.md` | summarized execution map |
| `Historical References Index` | ADRs, audits, plans, specs, design bundles | index only; repo keeps full text |

## Freshness Verdicts

| Verdict | Meaning | Linear action |
|---|---|---|
| `current` | Verified against current code and recent commits. | Eligible for full or summarized Linear migration. |
| `current-reference` | Active reference for current work but not the top-level status source. | Link from Linear; do not duplicate unless useful. |
| `needs-refresh` | Known stale or materially behind current code. | Refresh repo first, then migrate. |
| `needs-review` | Not proven stale, but not yet verified against adjacent code. | Catalog only until reviewed. |
| `historical-reference` | Valuable evidence/history, not current execution state. | Put in Historical References Index only. |
| `scratch-do-not-migrate` | Temporary handoff or session-local state. | Extract still-valid work into issues; do not mirror. |

## Generated Manifest

Run this from the repo root:

```bash
pnpm docs:linear-manifest
```

The command maps every `git ls-files --cached --others --exclude-standard
'*.md' '*.mdx'` path to:

- `repo_path`
- `role`
- `freshness`
- `last_source_commit`
- `verified_against`
- `linear_destination`
- `migration_action`
- `notes`

As of HEAD `ced8f75`, the repo has 153 tracked Markdown files before this
migration control file, and the generated manifest also includes untracked
Markdown created during the current migration session. The generated
manifest is the complete path-level mapping; this file defines the policy and
the Linear destinations.

## Current Migration Decisions

| Source | Verdict | Linear destination | Action |
|---|---|---|---|
| `docs/superpowers/status.md` | `current` after 2026-05-23 refresh | `Current Status Snapshot` | Full doc. |
| `docs/planning/v0.3-generalized-ai-learning-framework.md` | `current` after 2026-05-23 refresh | `Roadmap Execution Map` | Summary with source link. |
| `docs/agents/*.md` | `current` | `Doc Catalog — Repo ↔ Linear Manifest` | Mirror operational docs or link from catalog. |
| `PLANNING.md` | `historical-reference` | `Historical References Index` | Link only; not active roadmap. |
| `RESUME.md` | `scratch-do-not-migrate` | Linear issues | Extract only still-valid leftovers. |
| `README.md` | `needs-refresh` | Catalog only | Refresh before any Linear current doc. |
| `docs/adr/*.md` | `historical-reference` | `Historical References Index` | Link only. |
| `docs/audit/*.md` | `historical-reference` | `Historical References Index` | Link only. |
| `docs/superpowers/{plans,specs,brainstorms,audits}/*.md` | `historical-reference` or `current-reference` | `Historical References Index` | Link only. |
| `docs/modules/*.md` | `needs-review` | `Historical References Index` | Review against module code before promoting. |
| `docs/design/**` | `historical-reference` | `Historical References Index` | Link only unless refreshed by a new design pass. |
| `src/**/README.md` | `needs-review` | Catalog only | Keep near code; Linear links only. |

## Update Procedure

1. Run `git status --short --branch` and `git rev-parse --short HEAD`.
2. Run `pnpm docs:linear-manifest`; if `tsx` hits sandbox IPC `EPERM`, rerun
   outside sandbox with the same command.
3. Refresh repo docs first when a source is `needs-refresh`.
4. Create or update Linear documents only after source paths and commits are
   known.
5. Reconcile Linear issues with code evidence; mark issues `Done` only when the
   shipped code, tests, and docs satisfy the issue description.
6. Add or update `YUK-*` references in PR titles/descriptions/commits; do not
   create new GitHub Issues for planning work.
