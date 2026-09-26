# Owner answers applied — 2026-09-26

Source: `/Users/yuqi/Documents/questions-answers.json` (owner UI over `questions.md` + yuk1042 census).

| Group | Choice | Decision applied |
|---|---|---|
| Q-1028/1029 (Astra P2/P3) | c + "暂时不接入Astra模型" | P2 stays paused; **P3 Hold — no Astra integration**. 1028 comment; 1029 → Backlog, needs-info removed |
| Q-416 (de-bias) | "a" + "继续搁置" | **Keep deferred** (note text wins over ambiguous label); Astra pause makes double-frontier moot anyway. → Backlog |
| Q-572 (shadow lane) | a + a | Flip `RESEARCH_MEETING_AGENT_ENABLED` now + ≥2wk comparison (owner-ops, pending execution); P3 charter approved → **YUK-1085** created. → Backlog + ready-for-human |
| Q-588 (quota ledger) | b | Fold per-night quota/cost ledger into YUK-580 overnight-digest surface. → Backlog + ready-for-agent |
| Q-452 (day-one epic) | b + a | Epic **Done** as substantially delivered; inc-D → **YUK-1086**, inc-F → **YUK-1087** (standalone backlog); `DAY_ONE_PRIOR_ENABLED` flip when ready (owner-ops) |
| Q-766 (backup semantics) | a | checkpoint/delivery **into backups** (recommended option). → ready-for-agent |
| Q-922 (self_confidence) | b / a / a | Slot on ResponseSet contract (1052); UI per-question in PfPaper (1051); folded into 1052 schema decision → **Done**. Amendments queued to running lanes imp-27 + des-1 |
| Q-1033 (deferral) | a + "1007加速排期" | Confirmed deferral; now formal child of + blockedBy YUK-1007; acceleration note on 1007. → Backlog |
| Q-1040 (seed:*:root) | a/b/a/b | θ̂ = FSRS parity (mixed→real KCs only, roots-only→no rows);存量 FSRS row → knowledge-merge proposal; 4 绑题 → propose→accept re-bind; coarse fallback → empty-bind + auto-attribution proposal. → **Done**; YUK-1082 → ready-for-agent; YUK-1083 commented (still owner-ops gated) |
| Q-1042 (stalled rows) | a | 8 stalled `add_started` → fence release + one paid re-ingest each (recover review-facts). → ready-for-human; execution via reviewed ops path, assoc YUK-1060 |

## New tickets

- **YUK-1085** — 572 P3: dreaming + maintenance charter 化 (parent 572, area:copilot, Backlog)
- **YUK-1086** — 452 inc-D: AutoElicit LLM θ prior, dark-ship on THETA_GRID (parent 452, area:practice, Backlog)
- **YUK-1087** — 452 inc-F: LLM 学生模拟, optional backlog pending value decision vs YUK-376 conclusion (parent 452, area:practice, Backlog)

## Pending owner-ops (approved, not yet executed)

- `RESEARCH_MEETING_AGENT_ENABLED` flip + ≥2wk shadow comparison (YUK-572)
- `DAY_ONE_PRIOR_ENABLED` flip when ready (YUK-452, now closed)
- 8 stalled `add_started` fence release + paid re-ingest (YUK-1042)
- YUK-1083 dispositions via reviewed ops path (merge proposal, re-bind 4 questions, coarse-fallback change)
