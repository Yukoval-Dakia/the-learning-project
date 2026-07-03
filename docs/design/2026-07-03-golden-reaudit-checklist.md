# Q4b retained-golden re-audit — pre-PR checklist (YUK-548)

> The non-tautological post-flip drift guard (register `event-sourcing-fold-sot-flip-status` line 673).
> Companion to `docs/design/2026-07-03-sot-flip-oracle-spec.md` §4 component 7.

## What it is

A **frozen, imperative** reference for each projection entity that has been flipped ON. The golden ROW
is the imperative path's output (mapped straight off the live table, **not** the fold), captured under
the B3-gate-certified code. `pnpm audit:golden --kind=<X>` re-folds the golden's own events with the
**current** reducer and diffs against the golden imperative row — so a later reducer/gather change that
no longer reproduces the imperative row is caught. Non-tautological because the reference is imperative
(never a re-interpretation of the current fold).

Scope (spec §4 component 7): meaningful teeth for **goal / mistake_variant / learning_item** (the OFF
entities). artifact / question_block are genesis-only (golden constructively equals the row → no
retroactive teeth); knowledge / knowledge_edge predate this leg. `learning_item` **must** have a golden
captured before it is flipped ON (register hard requirement).

## Capture (once, before flipping an entity ON)

On a PROD-CLONE that has **cleared the entity's B3 gate** (`pnpm b3:gate` GO for that kind, so
fold == imperative row is certified at capture time):

```
pnpm capture:golden --kind=<X>     # writes scripts/golden/<X>-YYYY-MM-DD.json  (COMMIT it)
```

Commit the JSON — it is an evidence artifact.

## Pre-PR trigger (the checklist item)

**When a PR touches `src/core/projections/**` (any reducer) OR the `<entity>` branch of
`src/server/projections/gather.ts`, AND that entity is already ON**, run:

```
pnpm audit:golden --kind=<that entity>
```

- **CLEAN (exit 0)** → the change preserves fold == golden imperative row. Proceed.
- **DRIFT (exit 1)** → the change no longer reproduces the golden imperative row. Either:
  - it is a **regression** → revert/fix; or
  - it is an **intentional model change** → re-verify the new imperative rows are correct, then
    `pnpm capture:golden --kind=<X>` to re-baseline and commit the new golden in the same PR.

This is a **manual path-triggered gate**, not CI-enforced. The register's "reducer-code-hash-triggered"
form is landed as this checklist item (n=1 sufficient); hash automation is an optional future upgrade
(open question in the spec §8).

## Coverage boundary (what this leg does NOT catch)

`pnpm audit:golden` re-folds **offline** (no DB) — it covers **reducer drift only**, NOT a
`gather.ts` predicate drift (the golden carries its own frozen event superset, so a changed gather
query never runs). Gather drift is covered by (a) the CI gather/shell-parity DB tests and (b) a
prod-clone `pnpm audit:projection` / `pnpm b3:gate` re-run, which fold through the REAL gather
against the already-materialized rows. When a PR touches `gather.ts` for an ON entity, rely on those
two legs (CI is automatic; the clone re-run is the manual belt-and-suspenders).

## Non-goals

- NOT a runtime double-write (Q1) — offline snapshot + offline re-fold only.
- NOT auto-repair — reports drift; the owner decides.
