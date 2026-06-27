# YUK-471 Wave 3 — W3-D SoT flip runbook (owner-run prod op)

**Status**: runbook / not executed. The per-entity SoT flip is an owner-run production operation. The driver prepared everything up to (not including) the flag flip.
**Scope**: flip `artifact` and `question_block` from imperative-write-is-SoT → projection (fold→row) is SoT, per-entity, behind `PROJECTION_IS_WRITER_<ENTITY>` (default OFF). Mirrors the W2 goal/mistake_variant/learning_item flip.
**Code state (main @ ed35a66d — Wave 3 CODE-COMPLETE)**: A1/A2 (event schemas) · B1/B2 (fold reducers) · C0 (GIN index, pre-existing) · C1 β/δ/γ (all artifact writers emit events) · C2 (gathers hoisted, artifact in materialized_id_index, idempotent genesis backfill) · C3 (parity asserts + per-entity flags + `audit:projection` coverage + hardening) · qb-lifecycle (#619 — the 5 eventless question_block writers now emit `question_block_lifecycle`) — **all MERGED**. Both entities' KNOWN-UNFOLDED lists are empty (review-confirmed: no remaining eventless fold-truth writer).

---

## 0. The flip model (recap)

- **Flag OFF (current)**: the imperative write is the SoT; the canonical event is shadow; `assertXParity` (dev/test throw, prod warn) catches drift. Every artifact/question_block mutation ALSO emits a faithful canonical event (C1).
- **Flag ON**: the wired writers call `projectXGuarded` (re-fold the events → upsert the row) as the SoT writer; the imperative UPDATE is skipped. Unwired writers keep imperative-writing + emitting events (consistent, since fold==row holds — proven by `audit:projection`).
- **The gate**: a flip is only safe when `pnpm audit:projection` (full-table fold-diff) is CLEAN for that entity — i.e. every row's `fold(events) == row`. The genesis backfill (C2) writes the anchor events for pre-Wave3 rows so they fold; the backfill **fails loud** on a row whose snapshot fails the strict barrier (now batched — fix all bad rows in one YUK-502 bbox-clamp pass).

## 1. Hard prerequisites (must clear BEFORE the flip)

| # | Prereq | Entity | Status |
|---|--------|--------|--------|
| P1 | All live writers emit fold-reducible events (KNOWN-UNFOLDED empty) | artifact | ✅ done (C1-γ) |
| P2 | All live writers emit fold-reducible events | question_block | ✅ code done (#619 — the 5 eventless writers now emit `question_block_lifecycle`). Runtime gate = `audit:projection` clean on a fresh prod-clone. |
| P3 | Legacy overflow-bbox rows clamped (structured/figure bbox within 0-1) | question_block | ⏳ **YUK-502** one-time bbox-clamp sweep — the genesis backfill fails loud on these; clamp them (the C1-δ flat8ToBBox fix prevents NEW ones). Run the backfill on a prod-clone first to surface the list (now batched: one error lists every bad id). |
| P4 | (accepted-low) ON-path lost-update window | artifact/question_block | The wired edit writers now take `FOR UPDATE` (C3 fix); the broader ON-path version-guard hardening matches the W2-goal posture (tracked, YUK-499-class). Not a flip blocker. |

## 2. Per-entity flip order

1. **artifact** first (no fold-visibility gap; flip-safe per C3 independent review).
2. **question_block** after P2 + P3 clear.
3. **learning_item** (W2) flip after artifact, per the existing learning_item docblock ordering (W3 retract path couples artifact + learning_item archive).

## 3. Procedure (per entity X ∈ {artifact, question_block})

1. **Rebuild a prod-clone** (a copy of the live DB — the same prod-clone harness W2 used for its SoT-flip gate, `runB3Gate`).
2. **Backfill genesis** on the clone: `node dist/migrate.cjs` path or the `backfillGenesisEvents` script (writes `experimental:genesis` + materialized_id_index for pre-Wave3 X rows). If it throws the batched "N rows failed the genesis parse barrier" error → that's P3 (**YUK-502**): clamp every listed row's bbox into [0,1] (`width=min(w,1-x)`, the same rule C1-δ's flat8ToBBox now applies to new extractions), re-run until it seeds clean. Idempotent (skips already-anchored rows).
3. **`pnpm audit:projection`** on the clone → MUST report `checkedArtifacts`/`checkedQuestionBlocks` > 0 and ZERO drift for X. Any drift = a writer that mutates fold-truth without a faithful event (STOP — do not flip; fix the writer).
4. **Flip the flag** in the prod env: set `PROJECTION_IS_WRITER_ARTIFACT=1` (or `_QUESTION_BLOCK=1`) in the docker-compose `.env` (must reach all 3 processes — api / worker / migrate read it at startup via `loadEnv`).
5. **Restart** the app + worker containers (they read the flag at boot; `loadEnv` only fills blanks, container env wins).
6. **Post-flip verify**: re-run `audit:projection` against live → still CLEAN. Smoke a few X mutations (edit an artifact / a question_block) and confirm the row + the event agree.
7. **Rollback** (if anything is off): unset the flag in `.env` + recreate the containers. The imperative writes resume as SoT; the events keep flowing (the double-write never stopped), so no data is lost on rollback.

## 4. Notes
- The per-entity flags are independent — flip one, observe, then the next. Do NOT flip all at once.
- `audit:projection` is the load-bearing gate; never flip an entity whose audit isn't clean on a fresh prod-clone.
- Local/NAS prod stack: the W2 flip used `docker-compose.mac.yml` (localhost:8787, pg 5433, no cloudflared). Same mechanics here.
- Follow-ups that are NOT flip-blockers but should be tracked: YUK-499-class ON-path version-guard hardening; the question_block writers audit (symmetric with artifact's step9 audit); the C1-β legacy `record_promotion` body_blocks validation test.
- **Ref disambiguation**: P3's bbox-clamp sweep is **YUK-502** (this runbook's only data-fix flip-blocker). The design doc's own §9.3 (`docs/design/2026-06-25-yuk471-wave3-artifact-question-block-fold-CORRECTED.md` §9 item 3) is a SEPARATE, optional `crop_refs` staleness fix — NOT a flip blocker (folds clean even when consistently stale). Don't conflate the two.
