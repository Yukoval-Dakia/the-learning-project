# Offline Urnings Replay — Results Template & Decision Gate

**Date:** 2026-06-15
**Status:** Decision-gate template (verdict DATA-GATED — pending data accumulation)
**Part of:** YUK-361 personalized calibration roadmap (`docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md` Phase 7 / Task 12)
**Tool:** `scripts/replay-urnings-lite.ts` (run `pnpm replay:urnings`)
**Estimators:** `scripts/lib/urnings-replay-estimators.ts`
**Decision it re-examines:** ADR-0042 (Elo-over-Urnings verdict for the ONLINE engine) + `docs/design/2026-06-15-urnings-lite-calibration-amendment.md` (full Urnings deferred to THIS offline replay decision gate)

---

## What this is (and is not)

This is an **offline analysis spike**, not a production feature. There is no schema,
no migration, no production wiring, no pg-boss job, no route. The deliverable is:

1. A working **replay tool** that reads historical attempts and replays four
   θ-estimation models over the time-ordered stream, read-only and in-memory.
2. This **decision framework** — the criteria + the results table to fill when
   data exists.

The **verdict itself is data-gated**. ADR-0042 already chose Elo over Urnings for
the *online* engine (adaptive-selection correction is `O(|items|)`, mandatory
Metropolis-Hastings, closed-form SE degenerates at small-N). The urnings-lite
amendment deferred *full Urnings* to this offline gate, to be re-examined **after
family-level observation density exists**. On the fresh `n=1` post-rebuild stack
there is little/no historical attempt data, so the script honestly reports
**INSUFFICIENT DATA** rather than fabricating a conclusion, and the default stays
on **Elo + precision** per ADR-0042.

---

## The four variants

| # | Variant id      | Model                              | Math source | Notes |
|---|-----------------|------------------------------------|-------------|-------|
| 1 | `elo_point`     | Elo/MLE point estimate             | **production reuse** (`src/core/theta.ts`: `conjunctiveCredits` / `eloK` / `updateTheta`) | The actual online behavior, not a re-impl. |
| 2 | `elo_precision` | Elo/MLE + `theta_precision`        | **production reuse** (`src/core/theta.ts`: `updateThetaPrecision` / `thetaSe` — Phase 2) | Same θ̂ trajectory as #1; adds Fisher-info uncertainty + SE-shrunk prediction. The **reference** for the MFI-regret proxy. |
| 3 | `glicko_rd`     | Glicko/RD-style uncertainty        | **spike impl** | Glicko-2-ish, one game per period vs the fixed item-difficulty `b` as a zero-RD opponent. Simplifications: fixed RD-inflation `c` (not elapsed time); volatility σ held constant (no Step-5 σ′ iteration); internal glicko-400 scale rescaled to logit on export. |
| 4 | `urnings`       | Full Urnings urn prototype         | **spike impl** | Binomial player urn of size N (default 16), **player half only** — the item half is a fixed `b` anchor, never co-estimated (matches the ADR-0042 amendment: online item-half co-estimation is unsafe at `n=1`). Core paper update implemented: ±1 proposal toward the observation, accepted via the Metropolis-Hastings ratio so the stationary distribution is Beta-binomial around the true success prob. θ̂ = logit(green/N), clamped off the 0/1 boundary. **OMITTED:** adaptive-selection correction (`O(|items|)` reweighting) — this replay is offline over a fixed historical stream, not an adaptive selector. |

Variants 1 & 2 are the production baseline; 3 & 4 are deliberately-scoped spikes
whose simplifications are documented in `VARIANT_META` and surfaced verbatim in the
script's `--json` output.

---

## Metrics (per variant, lower is better for all four)

- **next-answer log loss** — prequential cross-entropy of `P(correct)` predicted
  *before* each outcome. Primary predictive metric.
- **Brier score** — prequential squared error of the probabilistic prediction.
- **θ volatility** — mean absolute step of θ̂ between consecutive attempts
  (instability of the estimate over the stream).
- **MFI top-k regret proxy** — fraction of stream steps where the variant's
  MFI-selected item (argmax Fisher info = argmin |θ̂ − b_q| over the candidate `b`
  pool) **disagrees** with the `elo_precision` reference's pick. A wobbly θ̂ churns
  which item is "most informative"; this measures that churn. 0 = always agrees.
- **dense families** — number of knowledge families with ≥ `DEFAULT_DENSITY_THRESHOLD`
  (default **30**) repeated objective observations. **This gates whether ANY verdict
  is possible** — sparse families make the log-loss/Brier deltas noise, not signal.

---

## Decision criteria (Task 12 step 4)

Full Urnings proceeds **ONLY if ALL hold**:

1. it **beats** `elo_precision` on **log loss**, AND
2. it **beats** `elo_precision` on **Brier score**, AND
3. it **reduces MFI instability** (lower θ-volatility and/or lower MFI top-k regret
   vs the reference), AND
4. the implementation complexity is **justified by DENSE repeated observations** —
   i.e. there are enough dense families that the win is real signal, not small-N
   luck, and the `O(|items|)` adaptive-selection machinery Urnings needs online is
   worth carrying.

If any criterion fails → **default = stay on Elo + precision** per ADR-0042.

This is intentionally a **high bar**: ADR-0042 already rejected Urnings online on
cost/identifiability grounds. The offline gate only reopens that if the data shows
a clear, dense, multi-axis win.

---

## Results table — TO BE FILLED WHEN DATA EXISTS

Run `pnpm replay:urnings` and transcribe the `variant × metric` table here. (The
script's own output is authoritative; this is the human-readable record.)

| Variant | log loss | Brier | θ-volatility | MFI top-k regret (vs ref) | reuse |
|---------|---------:|------:|-------------:|--------------------------:|-------|
| `elo_point`     | _tbd_ | _tbd_ | _tbd_ | _tbd_ | prod |
| `elo_precision` (ref) | _tbd_ | _tbd_ | _tbd_ | 0.0000 | prod |
| `glicko_rd`     | _tbd_ | _tbd_ | _tbd_ | _tbd_ | SPIKE |
| `urnings`       | _tbd_ | _tbd_ | _tbd_ | _tbd_ | SPIKE |

Dense families (≥30 obs): _tbd_ / _total_. Anchor source split:
`item_calibration=_tbd_ / difficulty_proxy=_tbd_`.

> **Anchor-quality caveat for the eventual verdict:** if `item_calibration` is
> absent and every row used the `difficulty_proxy` fallback (ordinal 1–5 →
> `difficultyToLogitB`, a weak un-calibrated anchor), the `b` values are not
> trustworthy difficulty and the metric deltas should be treated as suggestive at
> best — a real verdict wants `item_calibration`-sourced anchors.

---

## CURRENT VERDICT: INSUFFICIENT DATA

> **Populated by the script's own output. Re-run and update when data accumulates.**

As of the last recorded run against the local stack:

- **scorable attempts:** 49
- **dense families (≥30 obs):** **0** / 5
- **`item_calibration` table:** ABSENT → all 49 anchors via `difficulty_proxy`
  fallback (weak, un-calibrated)

**Verdict:** No family meets the density threshold, so the variant log-loss / Brier
deltas are **noise, not signal**. NO verdict is drawn. The earlier-run numbers (for
the record, all on the weak `difficulty_proxy` anchor and below density) were:
`elo_point` log-loss ≈ 0.783 / Brier ≈ 0.287; `elo_precision` ≈ 0.774 / 0.284;
`glicko_rd` ≈ 0.767 / 0.271 (but θ-volatility ≈ 0.43, the highest — unstable);
`urnings` ≈ 0.805 / 0.288. These are **not** a basis for a decision.

**Default = stay on Elo + precision** per ADR-0042 (and the urnings-lite amendment).
Re-run `pnpm replay:urnings` when objective attempt data accumulates; if/when a dense
family graph exists, fill the results table above and apply the four decision
criteria.

---

## Relationship to ADR-0042

ADR-0042 §备选(已否决) records "Urnings 作 θ 载体 — 否决 (urnings-elo 核验)" for the
**online** engine. The urnings-lite amendment's **exit gate** says a future agent can
answer "why not full Urnings now?" because (a) per-item online co-estimation of θ and
`b` is unsafe at `n=1`, and (b) we have not yet proven *via this Phase 7 offline replay*
that full Urnings beats Elo+uncertainty on log loss / Brier / MFI stability with a
dense-enough observation graph. **This document + tool are the mechanism for (b).** Until
the data clears the gate, (b) remains unproven and the online verdict stands unchanged.
