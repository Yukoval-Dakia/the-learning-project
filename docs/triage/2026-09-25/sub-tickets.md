# Proposed sub-ticket splits — 2026-09-25

Each entry: parent, proposed title, body brief, acceptance, blockedBy, suggested labels.

---

## 1. Split of YUK-1040 (mixed code + owner-ops)

YUK-1040 currently mixes (a) a real code gap (θ̂ axis writes to `seed:*:root`) and (b) owner-ops dispositions. Recommended split:

### 1a. YUK-1040-A — θ̂ 轴 `seed:*:root` 过滤（review-settlement knowledgeIds）

- **Parent:** YUK-1040
- **Suggested labels:** `area:practice`, `needs-info` (flip to `ready-for-agent` once owner confirms semantics parity — see questions.md Q-1040-1)
- **What:** `src/capabilities/practice/server/review-settlement.ts` already filters `seed:<subj>:root` out of the **FSRS** subject pick (YUK-1037), but the two `theta.knowledgeIds` call sites (solo settle ~line 519, paper settle ~line 955) pass the unfiltered `referencedKnowledgeIds`/`q.knowledge_ids` to `updateThetaForAttempt`. Latent pollution: production has no `mastery_state` seed-root rows yet, but the write path is live for the 4 `knowledge_ids=["seed:math:root"]` questions.
- **Brief (ready once owner confirms):** apply the same `SYNTHETIC_SUBJECT_ROOT_RE` filter to the ids feeding `updateThetaForAttempt`, matching the FSRS parity rule — mixed bindings write only real KCs; a roots-only label set produces **no** knowledge-level mastery rows (the θ axis has no question-level fallback, unlike FSRS which falls back to a `subject_kind='question'` card).
- **Acceptance:**
  - [ ] Solo + paper settlement paths strip `seed:*:root` before `updateThetaForAttempt` (same regex as FSRS pick, single source — `SYNTHETIC_SUBJECT_ROOT_RE` in `placement-scope.ts`).
  - [ ] DB test: question bound to `['seed:math:root', 'k_real']` → mastery_state written only for `k_real`.
  - [ ] DB test: question bound to `['seed:math:root']` only → zero mastery_state rows; attempt + judge events still written.
  - [ ] Scoped unit/DB tests green; no behavior change for non-root ids.
- **blockedBy:** none (code-wise); semantically gated on owner answer Q-1040-1.

### 1b. YUK-1040-B — 存量 `seed:*:root` 数据 owner-ops 处置

- **Parent:** YUK-1040
- **Suggested labels:** `ready-for-human`, `area:practice`
- **What:** pure owner-ops — (i) disposition of the existing `material_fsrs_state('knowledge','seed:math:root')` row (options already enumerated in the ticket: lazy + guard / owner-approved knowledge-merge / reviewed one-off ops script); (ii) disposition of the 4 active questions bound to `seed:math:root` (re-bind to real KCs via attribution propose→accept, per `docs/audit/2026-09-24-question-binding-audit.md` §6-1, or keep coarse binding). No SQL direct edits — through reviewed ops path only.
- **Acceptance:** owner picks an option per item and records the decision; execution follows the chosen reviewed path.
- **blockedBy:** none. Not delegable — production data disposition requires owner.

### 1c. (fold into parent comment, no separate ticket)
Optional semantics question: whether plan-executor coarse fallback should keep writing `knowledge_ids=['seed:<subj>:root']` (design-intended `attribution_state='coarse'` signal) — leave to owner's answer on the parent ticket.

---

## 2. YUK-572 P3 — dreaming/maintenance charter 化（epic remainder）

The epic's P1 (shared scout primitives) and P2 (agent-led meeting shadow lane, `research_meeting_agent_nightly`, dark-shipped) are landed. The only unlanded implementation work is P3; the shadow-lane flip is owner-ops (tracked on the parent via `needs-info`).

### YUK-572-P3 — dreaming + maintenance charter 化（接 evidence-scout + objective 升章程）

- **Parent:** YUK-572
- **Suggested labels:** `area:copilot` (agency), `ready-for-agent` (direction already owner-approved 2026-07-06; spec exists)
- **What:** bring `dreaming_nightly` and `knowledge_maintenance` (both already tool-loops) up to the charter-agent shape the meeting lane uses: attach the shared `evidence-scout` AgentDefinition (spawn-contract enforced, read-only, budget-shared), lift their objective prompts into charter form ("here is learner state, budget, tools — decide tonight's agenda"), and keep the deterministic versions as fallback. Single-writer exit stays `writeAiProposal`/`writeAgentNote` via the orchestration layer. Guardrails unchanged: single-level spawn, run-level budget hard cap, scout read-only, spawn+agenda events, settlement layer stays 0-agency forever.
- **Spec:** `docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md` (P3 section) + `src/capabilities/agency/server/scout/` shared primitives (already extracted, not meeting-private).
- **Acceptance:**
  - [ ] Both jobs can spawn the shared evidence-scout via the existing spawn contract (depth-1, read-only).
  - [ ] Both jobs carry run-level budget caps that account scout spend to the parent run.
  - [ ] Deterministic fallback paths are preserved (not deleted) and selectable.
  - [ ] Spawn + agenda events recorded; settlement layer untouched.
  - [ ] Scoped unit + DB tests green; prompt-hash oracle regenerated if prompts change.
- **blockedBy:** none technically; recommend sequencing **after** the P2 shadow lane has produced a comparison signal (the flip decision is the parent's owner-ops remainder), but P3 can be dark-shipped in parallel.
- **Note:** this is a separate ticket because it is the epic's only remaining *implementation* slice; the flip/comparison-window is owner-ops on the parent.

---

## 3. YUK-452 — closeout vs inc-D/F split (conditional)

Epic is ~4/6 landed (inc-A anchor, inc-B placement+flag, inc-C onboarding, inc-E propagation landed-dark). Remaining = owner decisions, not implementation. Proposal:

- **Primary recommendation:** owner answers Q-452 (questions.md) → either (a) close the epic as substantially delivered with inc-D/inc-F captured as standalone backlog tickets, or (b) keep the epic open until `DAY_ONE_PRIOR_ENABLED` flips.
- **Conditional sub-ticket (only if owner wants inc-D):**

### YUK-452-inc-D — AutoElicit 式 LLM θ 先验（dark-ship on THETA_GRID）

- **Parent:** YUK-452
- **Suggested labels:** `area:practice`, `ready-for-agent` (only after owner approves inc-D value)
- **What:** per `docs/design/2026-06-20-cold-start-day-one-design.md` §5 inc-D — an LLM task that takes goal + owner self-report and returns a single-learner θ prior distribution; seeds `theta_grid`'s initial prior (dark-ship on `THETA_GRID_ENABLED`, which is already `false`); does not touch Elo SoT. Lowest-priority inc (θ=0 seed is already adequate per design doc).
- **Acceptance:**
  - [ ] Prior seeds `theta_grid` initial state only when `THETA_GRID_ENABLED` is on; flag-off path byte-identical.
  - [ ] θ̂ / precision / FSRS SoT paths unchanged.
  - [ ] Scoped unit tests + prompt-hash regen green.
- **blockedBy:** none; gated on owner Q-452 value decision.
- **Not created by default** — listed here for completeness; only create if owner answers "still worth it".
