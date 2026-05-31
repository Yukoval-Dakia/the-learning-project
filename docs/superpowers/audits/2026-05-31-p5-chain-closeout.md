# P5 Chain Closeout — brainstorm-open-questions chain 达成（2026-05-31）

> P5 = the "open questions" chain off YUK-143 (scenario B intelligence track): the Layer-8
> readiness gaps surfaced in `docs/superpowers/specs/2026-05-30-p5-open-questions-readiness-brief.md`.
> This closeout records the full ship, the cross-cutting decisions, the consolidated deferred
> backlog, and — critically — the **data-gate landscape investigation** that defines where the
> drive goes next.
> **主分支**：`origin/main` = `82ba1df1`（P5.3 #229 merged，2026-05-31）。

## §1 P5 chain ship 全貌

All seven phases shipped to `main` via per-commit-`Closes` rebase-merge (repo forbids merge-commit).

| Phase | Outcome | PR | Linear |
|---|---|---|---|
| **P5.1** Context Budget Policy | `budgets.ts` single-source budget consts + Copilot per-message throttle + graceful soft-stop on exhaustion | (YUK-143) `6fbd6b0c`/`0ca46d05` | YUK-143 |
| **P5.2** Activity-gated brief refresh | per-subject brief refresh gated on knowledge-resolved activity; capped per run; global/cluster stays on 24h stale loop | #218 | YUK-143 |
| **P5.4-L1** Proposal-quality rubric (enforce) | evidence-level + relation-specific gates between LLM output and `writeAiProposal` | #219 | YUK-143 |
| **P5.4-L2** Adaptive accept-learned bias | per-`(kind,relation)` feedback digest → adaptive gate-bump + Dreaming/Coach bias injection | #220 (spec) / #221 (impl) | YUK-174 |
| **P5.6** Suggestion semantics | `suggestion_kind` on proposals + full-KPI exclusion (both writers) + accept-chip endpoint + drawer corrective | #225 | YUK-178 |
| **P5.5** Tool-eval fixtures (Phase 1) | `fixtures-assert.ts` `assertAgentReadable` 4-limb contract + 6 scenario fixtures (math tools) | #227 | YUK-180 |
| **P5.8** Wenyan eval fixture | 11-item wenyan fixture gating the **semantic** judge route (translation/reading) via `judgeAnswer` `runTaskFn` stub + e2e.smoke | #228 | YUK-182 |
| **P5.3** Long-term brief freshness | `long_term_freshness_score` (nullable `real`) evidence-decay, compute→store→surface, NO row mutation | #229 | YUK-183 |

## §2 Cross-cutting decisions & discoveries

1. **P5.3 reframe (archive → render-annotation).** The readiness brief's Option-B archive design
   (blank `long_term_md` + archive to a `long_term_stale_claims` JSONB) was found INCOHERENT by
   adversarial critique: the LLM `generate` rewrites all three brief windows from scratch every
   regen and the upsert overwrites them, so any post-generate row mutation is undone next run
   (the archive would be a lagging copy). Dropped the archive column + blanking entirely; staleness
   is now an advisory render-time annotation off the stored score. Cleaner, one fewer column, no
   row mutation. (Decision made autonomously — technical correctness fix, no product divergence.)

2. **⚠️ The brief LLM `generate` writer is UNWIRED in production.** `registerMemoryHandlers(boss, db)`
   (`handlers.ts:50`) passes no `generateBrief`, so `defaultGenerateBrief` (`triggers.ts:329`)
   **throws**. Every brief regen job that passes its freshness gate dies at the LLM call → the entire
   memory-brief surface (`query_memory_brief`, the Copilot global-brief slot, and P5.3's freshness
   score) is dead — **not for lack of data, but for one missing constructor argument**. P5.1/P5.2/P5.3
   therefore built the brief layer *ahead of its writer* (consistent staging), verified via injected
   `generate` fakes. This is the single highest-leverage gap — see §4.

3. **Bounded-impl discipline.** P5.8's impl agent thrashed 700+ tool-uses by self-checking
   "loop-until-green" on a Docker DB test. From P5.3 on, impl-agent prompts mandate "run tests a
   bounded number of times, report pass/fail" — P5.3's impl ran 2 agents / 75 tool-uses, no thrash.

4. **Self-merge autonomous loop.** P5.8/5.5/5.3 ran the pattern: open PR → 13-min bot-review buffer →
   auto read+fix valid findings (re-gate scoped) → reviewer-reply → required-CI-green → self-merge
   `--rebase` → verify Linear Done → branch cleanup. (User-authorized for this drive only.)

## §3 Consolidated deferred backlog

| Item | Linear | Notes |
|---|---|---|
| P5.5 tool-eval fixtures **Phase 2** | YUK-181 | **UNBLOCKED by P5.8** (wenyan subject-graph corpus now exists) |
| P5.6 cooldown-parity test | YUK-179 | low |
| P5.4 batch-edge follow-ups | YUK-175 / YUK-176 | |
| P5.3 Phase-C | (in spec §11) | per-prefix half-life/threshold override; explicit re-verify task; per-evidence confidence weighting; `learning_record.created_at` resolution; UI "may be dated" section; feeding staleness INTO the generate prompt; widening `maxEventsPerBrief` |
| reading-note product clarification | — | P5.8 §9 Q1: is P5.8 "5 subjects" or "5 fixture types"; is reading-note a subject or a Living-Note category |
| **brief generate-writer wiring (T-37)** | — | the §2.2 / §4 linchpin |

## §4 What's next — the data-gate landscape (investigation 2026-05-31)

A read-only multi-agent investigation mapped why the Layer-8 intelligence stack is dark. Findings:

- **Collection is already fully wired (~0% of the blockage).** Every capture route (mistake/review/
  inline-check/ingestion/proposal-decision) reaches the single `writeEvent` spine, and the per-minute
  outbox poller delivers events to the brief/dreaming/proposal layers. There is **no missing
  write-path** to build for the core loop.
- **Two wiring-gated linchpins (not data-gated), each cascading to ~3-4 dependents:**
  - **A3 — brief `generate` writer unwired** (`handlers.ts:50` → `defaultGenerateBrief` throws).
    Cascades to `query_memory_brief`, the Copilot global-brief slot, and P5.3 freshness.
  - **D1 — `runGoalScopeAndWrite`** (`goals/scope.ts`) has **no caller** anywhere (no route/UI/cron),
    so no North-Star goal is ever materialized → the whole goal-bias layer (Coach/Dreaming/review) is
    permanently inert. Plus 1 config flip: Mem0 fact ingest needs `OPENAI_API_KEY` (blank in env).
- **Cold-start data desert (the dominant blocker by feature count).** ~10 features (FSRS due, the
  proposal_signals → acceptance/feedback digest → adaptive gate-bump chain, the L1 edge evidence
  floor, subject-brief activity detection) are **inert-on-data**: correct, but starved on a fresh DB.
  They degrade cleanly to no-op/empty (no throws). The only learnable corpus — wenyan (11 items) — is
  **eval-locked** (no DB seed route to turn it into answerable questions).

**The fan structure:** one upstream substrate — graded, attributed `attempt`/`review` events — is the
root that, if rich, lights up FSRS + the proposal stack + brief detection simultaneously. But A3 and
D1 are bolted shut regardless of data volume.

**Recommended sequence (critical path, least wasted inert-building):**
1. **Synthetic data generator FIRST** — kernel already exists (`tests/helpers/event-seed.ts`
   `seedAttempt`/`seedUserCause`; `knowledge_mastery` is a PG view, `material_fsrs_state` an FSRS
   projection → synthetic attempts auto-produce mastery + schedule). A `scripts/seed-synthetic.ts`
   producing causally-chained, time-distributed events + a wenyan/math/physics question seed + a batch
   of accept/dismiss decisions. This is the **anti-inert move**: it's the test+demo harness that
   validates every station after it, and it lets the Layer-8 features finally be *seen* working.
2. **Wire the two linchpins against the now-real data** — A3 (inject a real `generateBrief` at
   `handlers.ts:50`) then D1 (design the goal-scope *trigger*).
3. **Resume roadmap P5.x validation on a live flywheel** — the readiness brief flags P5.1/P5.3/P5.4
   validation as currently impossible "because there is no realistic event history"; synthetic data
   removes that blocker.

Strategy D (real ingestion + capture-UX usage) is the long-term real-signal source, runs in parallel,
but is not on the critical path for lighting up + validating Layer-8.

**Open product forks (owner-only) gating the next station:** (1) bootstrap with synthetic data vs grow
real-only; (2) is the tool meant for daily use *now* (→ ingestion UX jumps queue) or still pre-product;
(3) the A3 brief-generator model/route + the D1 goal-scope trigger shape (cron / copilot chip / explicit
UI). Full briefing: this closeout + the investigation synthesis.

## §5 Retrospective

- **What worked:** the spec→adversarial-critique→revise→impl→independent-review→gate→PR→self-merge
  loop caught a real blocker in *every* phase spec (P5.6 mechanism, P5.5 LLM-mock-seam, P5.8
  fastTestInclude allowlist, P5.3 the archive-incoherence). Bounded-impl ended the thrash.
- **What the chain revealed:** the project's intelligence build is well ahead of its data + two key
  wirings. P5 closed the *design* open-questions; the *activation* open-question (data + A3/D1) is the
  next chapter, now scoped in §4.
- **P5 chain: DONE.**
