# T-AR — Acceptance-rate / dismiss signal (foundation + additive Dreaming wiring)

Branch: `yuk-tar-acceptance-signal` · Worktree: `/private/tmp/tlp-tar` · Linear: `Refs YUK-TAR` (placeholder; coordinator confirms)

## Goal

Roadmap T-AR: "Acceptance-rate / dismiss-reason 信号 → Maintenance ranking + Dreaming prioritization."
Build the SIGNAL foundation + light additive use. DEFER the deep maintenance-ranking
algorithm (T-MR, roadmap-gated on >=100 proposals of data) and the dismiss-REASON capture UI.

## Approach (verified against scout findings)

The `proposal_signals` table already exists and already tracks, per `(kind, cooldown_key)`:
`accept_count`, `dismiss_count`, `acceptance_rate` (real), `dismiss_reason`, `cooldown_until`.
It is maintained incrementally on every `rate` event via `recordProposalDecisionSignal()` and
rebuilt by `ensureProposalDecisionSignal()` (Pattern 3 — incremental + rebuild).

So the acceptance-rate SIGNAL data **already exists in the event-derived `proposal_signals`
aggregate**. T-AR does NOT need a new column / table / view — it needs a **read-only roll-up
across `cooldown_key` grouped by `kind`** (the dimension Dreaming/Coach reason about), plus the
additive Dreaming feed. This matches the mastery-view precedent ("prefer deriving from the
existing log; no schema change").

### 1. Aggregation helper (read-only) — `src/server/proposals/signals.ts`

`getProposalAcceptanceRates(db)` →
`{ kind, accept_count, dismiss_count, total, acceptance_rate }[]`:

- `SELECT kind, SUM(accept_count), SUM(dismiss_count) FROM proposal_signals GROUP BY kind`
  (rolls the per-`cooldown_key` rows up to the per-`kind` dimension Dreaming/Coach reason about).
- `acceptance_rate = accept / total`, guarded with `total === 0 -> skip` (no div-by-zero).
- Sorted by `acceptance_rate DESC, total DESC` so callers can take "top N proven kinds".
- **Cold start:** zero `proposal_signals` rows → `[]`. Kinds with only-zero counts
  (`total === 0`) are filtered out (no uniform 0.5 sentinel injected — an empty list is the
  honest cold-start signal and keeps the Dreaming feed a true no-op).

Chose a **query helper over a view**: it is a tiny GROUP BY over a small,
constant-per-kind aggregate table (not the unbounded event log), read once per nightly run —
the established `signals.ts` module already owns this aggregate, and a view would add a
migration + `.existing()` registration for no read-throughput benefit (Pattern 1 fit; the
scout's "why not view" rationale).

### 2. Additive Dreaming wiring — `src/server/boss/handlers/dreaming_nightly.ts`

Mirror the YUK-143 goal-aware additive feed exactly:

- New deps-injectable reader `loadProposalAcceptanceRatesFn` (defaults to
  `getProposalAcceptanceRates`); DB unit tests inject fixtures, mirroring `listActiveGoalsFn`.
- New input field `proposal_acceptance_rates: { kind, acceptance_rate, accept_count,
  dismiss_count }[]` alongside `active_goals` (top N kinds; N small, e.g. 8).
- New objective append `DREAMING_ACCEPTANCE_RATE_BIAS_GUIDANCE` (one line):
  "prefer proposal kinds with higher historical acceptance; avoid kinds the user routinely
  dismisses" — explicitly ND-5 additive, never suppress the existing signal-driven proposals.
- **No-op degrade:** empty signal (cold start) → `proposal_acceptance_rates: []`; objective
  hint references the (empty) field, so the model has nothing to bias on and behaves exactly
  as before. The guidance string is static (same back-compat shape as the goal-bias string,
  which always appends but is conditioned on `active_goals` presence in its own text).

Dreaming still only PROPOSES — no FSRS / review / state changes; this is read-only input.

### 3. No schema change

Deriving from the existing `proposal_signals` aggregate → no new column → `audit:schema`
unaffected. (If a column had been needed: add write path or allowlist; not needed here.)

## Tests

- DB (signals.test.ts, already db partition): `getProposalAcceptanceRates` — cold start `[]`;
  rolls multiple cooldown_keys of same kind into one row; groups distinct kinds; sort order;
  div-by-zero guard (a kind with 0/0 filtered out).
- Unit (dreaming_nightly.test.ts, already fast partition, mocked deps):
  threads `proposal_acceptance_rates` into the DreamingTask input; objective carries the
  acceptance-rate hint; empty signal → `proposal_acceptance_rates: []` (back-compat no-op).

## DEFERRED

- **T-MR deep maintenance-ranking algorithm** — roadmap-gated on >=100 proposals of real
  decision data. This lane builds only the signal + the lightest additive Dreaming feed.
- **dismiss-REASON capture UI** — the "why did you dismiss" flow needs UI → design pre-flight;
  the signal already stores `dismiss_reason` from the existing rate path, but no new capture UI.
- **Coach prioritization wiring** beyond the Dreaming feed — optional; Dreaming first as the
  cleanest additive use. `getProposalAcceptanceRates` is generic so Coach can reuse it later.

## Gate

typecheck / lint / audit:schema / audit:partition / audit:profile / `pnpm test` /
`DATABASE_URL=postgres://x INTERNAL_TOKEN=x pnpm build` — all green.

## Commit

On `yuk-tar-acceptance-signal`, do NOT push, do NOT merge. Message ends `Refs YUK-TAR`.
