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

## Area Labels（子系统轴，2026-06-18 建）

与上面的 triage 标签正交，用于按子系统筛选大 issue 面：

| Label | 范围 |
|-------|------|
| `area:matcher` | 采集 / 检索底座 / matcher 仲裁器 / 出卷 |
| `area:kg` | 知识图谱 / 知识点 / typed 边 / 一致性闸 |
| `area:practice` | 练习流 / FSRS / 组卷 / 题库 / 诊断引擎 |
| `area:copilot` | Copilot 编排者 / DomainTool / reach-endurance / artifact |
| `area:memory` | mem0 / 调和层 / 长期记忆 |
| `area:ui` | 前端 / SPA / design 重绘 / 视觉 |

一个 issue 通常带一个主 area 标签。triage 标签管「状态/就绪度」，area 标签管「在哪个子系统」，二者叠加。

## Applying Labels

When the `triage` skill processes issues, it applies these labels with the Linear connector. For not-planned work, set Linear state to `Canceled` and add `wontfix` only when the label carries useful historical context.

## Closeout Defaults

- Use `ready-for-agent` for a repo-evidenced issue that an agent can execute without another decision.
- Use `needs-info` when the next step is a human/product decision rather than implementation.
- Use `needs-triage` only when the issue is valid but project, milestone, estimate, or owner is unclear.
- Use `drift` for mismatches between codebase source of truth and docs, plans, Linear status, or stale tracker state.
- Do not use labels to restate workflow status. Move the issue state instead.
