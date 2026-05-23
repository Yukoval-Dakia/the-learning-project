# Triage Label Configuration

This project uses Linear labels for triage overlays. The canonical workflow state is still the Linear status (`Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled`, `Duplicate`); labels should not duplicate status.

## Label Mapping

| Role | Label |
|------|-------|
| `needs-triage` | `needs-triage` |
| `needs-info` | `needs-info` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-human` |
| `drift` | `drift` |
| `wontfix` | `wontfix` |

## Applying Labels

When the `triage` skill processes issues, it applies these labels with the Linear connector. For not-planned work, set Linear state to `Canceled` and add `wontfix` only when the label carries useful historical context.

## Closeout Defaults

- Use `ready-for-agent` for a repo-evidenced issue that an agent can execute without another decision.
- Use `needs-info` when the next step is a human/product decision rather than implementation.
- Use `needs-triage` only when the issue is valid but project, milestone, estimate, or owner is unclear.
- Use `drift` for mismatches between codebase source of truth and docs, plans, Linear status, or stale tracker state.
- Do not use labels to restate workflow status. Move the issue state instead.
