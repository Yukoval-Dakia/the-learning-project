# Data-Activation Drive Closeout — Layer-8 lit up + validated (2026-06-01)

> The post-P5 drive that turned the Layer-8 intelligence stack from **dark** to **observable +
> regression-guarded**. Follows the P5 chain closeout (`2026-05-31-p5-chain-closeout.md` §4), which
> diagnosed *why* the stack was dark and scoped this drive.

## §1 The problem (from the P5 closeout §4 investigation)

A read-only multi-agent investigation found the Layer-8 stack (Dreaming / Copilot / memory brief /
proposal-quality + adaptive bias / FSRS / North-Star goals) dark for **separable** reasons — and that
**collection was already fully wired** (~0% of the blockage):

- **Cold-start data desert** — a fresh DB has no events, so FSRS / proposal_signals / edge-propose /
  brief-detection all read emptiness (correct, but starved). The only learnable corpus (wenyan) was
  eval-locked with no DB seed route.
- **Two wiring-gated linchpins** — `defaultGenerateBrief` *threw* (the brief writer was never
  injected), and `runGoalScopeAndWrite` had *no caller* (no goal was ever materialized).

User direction (2026-06-01): **synthetic data first**, pre-product posture (validate Layer-8 now;
real ingestion deferred). The trigger shape for goals: **a nightly cron** (not a chip/UI).

## §2 Stations shipped

| Station | Outcome | PR | Linear |
|---|---|---|---|
| **1** Synthetic data generator | `scripts/seed-synthetic.ts` — manufactures a causally-chained, time-distributed event history via the **production `writeEvent` path** (so events flow to the inference layers like real capture); seeds wenyan questions + knowledge nodes; synthesizes proposal decisions; prod-fenced (loopback DB + opt-in env) + idempotent + `--reset`. | #231 | YUK-184 |
| **2A** Brief generate-writer (T-37) | A real `generateBrief` (new `MemoryBriefTask`, reusing the AI runner) injected at `registerMemoryHandlers` — replaces the throwing default. Lights up `query_memory_brief`, the Copilot brief slot, the P5.3 freshness score. F-1 per-scope try/catch (missing key → logged skip, not a retry storm). | #232 | YUK-185 |
| **2B** Goal-scope propose cron (D1) | A nightly cron (`goal_scope_propose_nightly`) that proposes a goal-scope from accumulated mastery by reusing `runGoalScopeAndWrite` (PROPOSE-only; user accepts). Dedup keyed on `caused_by_event_id` (excludes accepted/dismissed/retracted). Lights up the Coach/Dreaming/review goal-bias layer. | #233 | YUK-186 |
| **3** Layer-8 end-to-end validation | `tests/integration/layer8_e2e.db.test.ts` — drives the **whole flywheel** on the synthetic seed (brief regen → goal cron → accept → dreaming → coach → edge-propose, all stubbed LLM) and asserts 8 cross-layer slices. | (this PR) | YUK-188 |

Main: `origin/main` = `8ed672fa` (Station 2B) → + Station 3.

## §3 The flywheel turns — what's now observable (Station 3, all 8 slices green)

The e2e ran **green on the first cycle → ZERO real integration bugs** — the layers, each previously
testable only in isolation or against an empty DB, compose cleanly end-to-end:

- **A** global brief write→read round-trip + P5.3 `long_term_freshness_score` non-null + evidence ids.
- **A′** `subject:wenyan` brief independently readable (distinct scope).
- **B** goal cron → real `acceptAiProposal` → `listActiveGoals` join finds it, `scope_knowledge_ids` non-empty.
- **C** Coach received the goal AND persisted `today_plan.goal_strand` tagged to the goal.
- **D** Dreaming input carries the active goal + its scope.
- **E** Review due-list **goal-bias reorder** — every goal-relevant overdue item precedes every non-relevant one (stable-partition contract, via the real `listActiveGoals` join).
- **F** `proposal_signals` digest non-empty (`total>0`) + `resolveEdgeGateBump` `tightenMediumToStrong=true`.
- **G** FSRS due-count > 0; **H** active-subject detection finds `wenyan`.

The e2e test is now a **regression guard** for the whole Layer-8 composition.

## §4 Cross-cutting notes

- **Bots earned their keep.** Every Station PR's bot review (CodeRabbit/Codex/Augment) caught a real,
  gate-invisible issue: a P1 dotenv/ESM import-ordering bug (the seed CLI would have thrown), a HIGH
  prod-fence substring hole (`localhost.evil.com` passing), the brief writer being blind to
  `event.outcome` (a column, not `payload.outcome`), the `searchFacts` Mem0-init storming before the
  F-1 catch, and a P1 in the goal cron (consuming the brief-refresh watermark → it would almost never
  fire). **CI runs only CodeQL/Analyze — not `pnpm test`** — so the local full `pnpm test` + the bot
  review are the real safety nets (a P5.3 SCHEMA_VERSION test drift slipped through exactly this gap;
  fixed in #231).
- **Reuse-first held.** 2A/2B reuse the AI runner + the nightly-handler clone + `runGoalScopeAndWrite`;
  no hand-rolled tool loops. Zero production schema change across the whole drive (seed + brief score
  column were P5.3-era; 2A/2B/3 added none).

## §5 Deferred backlog (carry-forward)

| Item | Linear / note |
|---|---|
| Goal dismiss-churn cooldown | YUK-187 (P-low, ship-and-watch) |
| **Real ingestion + capture UX (Strategy D)** | the genuine long-term data flywheel — the next chapter once pre-product validation is trusted; not yet ticketed |
| Goal chip / explicit goal UI | deferred with the UI redraw (the cron is the v0 trigger) |
| Mem0 fact ingest | needs `OPENAI_API_KEY` (embedder) in the worker env — config, not code |
| **Worker deploy note** | the pg-boss worker container needs `XIAOMI_API_KEY` for brief + goal LLM calls; without it both degrade to a logged skip (F-1/F-2 WARN), never a crash |
| Dreaming goal-tagged-proposal write | scoped out of the e2e (needs the live MCP bridge); input-echo is validated |

## §6 Retrospective

- **The data problem was the real bottleneck**, not missing features — the P5 chain built the
  intelligence, this drive made it *run*. Synthetic-first (the user's call) was the anti-inert move:
  it turned every "verified empty no-op" into a "verified real behavior" and is the harness that
  validated 2A/2B the moment they landed.
- **Two linchpins + a seed = a turning flywheel.** The whole stack was three small wirings away from
  observable. Station 3's clean first-cycle green is the evidence.
- **Data-activation drive: DONE.** Next natural chapter: Strategy D (real ingestion) — surface to the
  user before starting, per the standing "big product fork" rule.
