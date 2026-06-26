# Product Sketch — The Day-One Auditable Diagnostic Coach
### Cold-start constellation #123 (prior-propagation) · #125 (MAP/EM θ̂) · #124 (deterministic plan) · #30 (the Twin) · #41 (reproducible profile)

- **Status**: Sketch / ideation (NOT committed work). Built by a 5-agent workflow (3 grounded lenses → sketch → red-team), 2026-06-25. **This doc is the red-team-corrected version** — the rosy claims the red-team caught are already fixed inline.
- **Companion**: the calibration beachhead → `docs/design/2026-06-24-rust-napi-calibration-beachhead.md`. Idea catalog → `docs/design/2026-06-25-rust-product-ideas-catalog.md`.

**One-line thesis (corrected):** this constellation is five views of one pure, locked-`b`, seeded-RNG arithmetic family that is **~70% already written in TS**; the new code is one Rust crate + three numeric pieces (graph propagation, batch EM, forward-MC) + a WASM target + a trust badge. **BUT** two red-team caveats reshape the plan: (1) the beachhead crate is an *uncommitted throwaway spike*, so it must be landed first; (2) the determinism `Object.is` story is broken by a *pervasive* `Math.exp` (in `logistic`/`expectedScore`/`klpScore`/`pLearnedBand`) — so "bit-for-bit" is an explicit fidelity *decision*, not a free inheritance.

---

## 1. The Experience — day-one, concrete

**T+0s — Open the app. DB empty except what you uploaded.** Last night you uploaded a past exam + two chapters; ingestion grew a small tree under the subject root (`seed.ts:39`). You've answered nothing. The screen does NOT say "take a test to begin." It shows a **coherent per-KC diagnostic profile**: each concept a mastery estimate with a **visibly wide band**. A downstream concept whose prereqs you also haven't touched sits lower with a badge "⚠️ cold start — inferred from prerequisites." Numbers from **#123**: a deterministic forward pass over the prereq DAG seeded by the LLM/owner difficulty priors. Nothing fabricated; bands honestly huge because you've answered nothing.

**T+30s — "Start diagnostic" → a reproducible first plan, instantly, offline.** ~12 cards appear immediately, no spinner, no per-question round-trip (**#124**: computed in one WASM pass from the seeded profile + fixed anchors off one `planSeed`). Max-information-first order from the live KLP scorer, made batch + reproducible. Caption `plan #a3f9 · 12 cards`; reload → identical 12 cards (deterministic `mulberry32(planSeed)`).

**T+90s — Answer four.** Two things move live: the **profile tightens** (#125: a fast MAP/EM folds your answers into a confident θ̂ per touched KC, over *fixed* difficulty anchors → identifiable at n=1; untouched KCs nudge via prereqs but stay honestly wide), and the **Twin fan-chart narrows** (#30: thousands of forward Monte-Carlo trajectories from your current state; the near-term mouth clamps down as precision rises).

**T+120s — Tap "recompute ✓".** The browser re-derives the displayed numbers from the resolved evidence scalars, in WASM, offline, and checks them against the server. *Honest version (post-red-team):* the integer/structural/PRNG parts match `Object.is`; the σ-derived display fields (p(L), SE bands) match to a tight tolerance (≤1–2 ULP) — unless a shared-polynomial `exp` ships, which buys literal byte-equality. Either way: **your profile's arithmetic is reproducible from stated evidence, not a black box.**

**The product:** a coach that has an opinion on day one, is honest about how sure it is, sharpens as you work, and can (provably) re-derive its own numbers.

---

## 2. Component / Data Flow (EXISTING = reused · NEW = to build)

```
UPLOAD (existing) → SEEDED GRAPH + PRIORS
  • subject root seed:{subj}:root            [EXISTING seed.ts:39]
  • prereq edges knowledge_edge[prerequisite] [EXISTING schema.ts ~:1102-1131; today: acyclicity only, NOT consumed for diagnosis]
  • per-KC b anchors effectiveB=b_calib??b_anchor??b [EXISTING; read candidate-signals.ts:203, def recalibration.ts:90]
        │
        ▼  #123 propagate_priors()  ▶ NEW (deterministic topo DAG pass; root=uniformPrior theta-grid.ts:104; downstream = prior shrunk by Σ(1−E[mastery(prereq)]); output per-KC pmf[41] on frozen GRID_THETA theta-grid.ts:78)
        │ priors[]
        ▼  first few answers (placement probe, EXISTING loop) → #125 solve_theta_map_em() ▶ NEW
           (EM over coupled KC offsets; M-step = EXISTING gridUpdate/binaryLikelihood theta-grid.ts:120-182; estimates θ̂ ONLY, b LOCKED; output θ̂/SE/pmf)
        │ θ̂ + precision + counts
   ┌────┼─────────────────────────────┬──────────────────────────────┐
   ▼                                  ▼                              ▼
 #124 plan_select() ▶ NEW        #30 forward_twin() ▶ NEW        #41 profile_derive() ▶ NEW
 batch K-draw, one planSeed,     replay.ts FLIPPED: draw         re-derive se/point/lo/hi from
 offline; reuses KLP/MFI         outcome~Bernoulli(σ(θ−b))       {precision,succ,fail,β}; mirrors
 (selection-signals.ts:81,169)  over horizon×M seeds; reuses    state.ts:313-319; → tolerance-parity
 + seeded sampler                @/core/theta credit loop        badge vs server
 (selection-sampler.ts:156)      (replay.ts:32-41)
   ▼                                  ▼                              ▼
 the day-one PLAN              the Twin FAN-CHART            the AUDITABLE PROFILE
                                                            (read models EXISTING:
                                                             state.ts:280-338 getMasteryProjection;
                                                             calibration-maturity.ts:139 loadCalibrationMaturity)
```

---

## 3. The ONE Isomorphic Rust Kernel — `crates/coldstart-core`

One crate, two targets (napi + WASM), **depending on `crates/calibration-native`** for `mulberry32` + the f64 parity harness. TS `@/core/theta`, `@/core/theta-grid`, `replay.ts` stay as the always-on **JS oracle + fallback** (beachhead stance). All functions pure (scalars/arrays in/out, no IO).

> **Why one crate, not five paths:** all five share the ICC `σ(θ−b)` (`theta.ts:27`), the same per-KC scalars, the same seeded RNG, the same determinism invariants. Splitting re-derives the ICC/RNG/op-order five times — exactly the bug `replay.ts:6-13` forbids.

```rust
// crates/coldstart-core/src/lib.rs — depends on calibration-native (mulberry32, f64 harness)
// Frozen support: GRID_THETA, 41 pts on [-4,4] step 0.2 (theta-grid.ts:78). Identical both targets.

// #41 — re-derive one KC's displayed numbers. PURE; the trust badge.  [both] [WASM-client + native parity]
pub fn profile_derive(precision: f64, succ: u32, fail: u32, beta: f64) -> KcDisplay
//   reuses thetaSe + pfaLogit + pLearnedBand, per state.ts:313-319.  ⚠ routes through σ→exp (see §4)

// #123 — deterministic prereq-edge prior propagation at n=0. PURE, no RNG.  [both] [WASM-client + determinism]
pub fn propagate_priors(kc_ids, prereq_edges:(prereq_idx,dep_idx)[], b_per_kc, domain_theta_global, shrink_coeff) -> GridPosterior[]
//   reuses uniformPrior (theta-grid.ts:104), GRID_THETA (:78). shrink_coeff = owner-fixed const, NEVER estimated.

// #125 — coupled MAP/EM θ̂ solver. CPU-heavy. Estimates θ̂ ONLY; b is input data.  [napi] [native-compute]
pub fn solve_theta_map_em(priors, prereq_edges, b_per_kc, domain_theta_global, answers, max_iters, tol) -> SolveResult
//   M-step reuses gridUpdate/binaryLikelihood (theta-grid.ts:120-182), posteriorMean/Se (:185-201).
//   NEW = EM wrapper: mean-field message-passing over the graph + convergence loop (~80 lines). ⚠ sweep-order is the #1 NEW determinism risk (§4).

// #124 — batch deterministic plan: K cards in ONE pass off one seed. PURE.  [both] [WASM-client + determinism]
pub fn plan_select(candidates, target_n, seed) -> u32[]   // seed → mulberry32 (rng.ts:14)
//   reuses KLP/MFI scoring (selection-signals.ts:81,169) + Poisson-IPPS sampler (selection-sampler.ts:99,156). NEW = one-pass K-draw vs per-/next loop.

// #30 — forward Monte-Carlo Twin. replay.ts flipped: DRAW outcomes.  [napi] [native-compute] (+wasm for what-if)
pub fn forward_twin(init: TwinInitState[], steps, n_paths, seed) -> TwinFanChart
//   reuses the @/core/theta credit loop the way replay.ts does (:32-41). NEW = forward draw + quantiles.
//   ⚠ init draw ~ Normal(θ̂, thetaSe(precision)) needs Box-Muller/inverse-CDF → exp/log/sqrt → exp-fragile (§4).
```

---

## 4. Determinism Reality (red-team-corrected — this is the crux)

The beachhead proved bit-exact for a kernel that was **`+`/`*`/compare/sort/divide only**. This constellation is **not** that — it pervasively calls `Math.exp`:

- `logistic`/`expectedScore` = `1/(1+exp(−x))` (`theta.ts:18-19,27-29`) — the deepest, most-reused primitive.
- live `klpScore` = `exp(−0.5 z²)` (`selection-signals.ts:179`); `fisherInformation`, `pLearnedBand` (σ-band), `srtOutcome` — all flow through `exp`/`pow`.
- **`profile_derive` (the first-slice badge) calls `thetaSe→pLearnedBand→σ→exp`.**

Rust `f64::exp` vs V8 `Math.exp` are **not** guaranteed bit-identical across libms. So:

1. **σ/`exp` fidelity is a Phase-1 GATING decision, not a footnote.** Pick before Phase 1: **(a)** drop `Object.is` for σ-derived display fields, assert ≤1–2 ULP there (badge copy = "reproducible to <1 ULP", not "bit-for-bit"); keep `Object.is` for PRNG/integer-index/structural parts — *recommended, cheapest*; or **(b)** ship a shared fixed-polynomial `exp`/σ routed through BOTH the JS oracle and Rust → the only path to literal `Object.is` on σ (more work than a "~30-line serializer + badge").
2. **EM sweep-order (#125) = the largest NEW determinism risk.** `gridUpdate` is order-free per step, but the mean-field message-passing sweep + `tol`-based convergence is new: needs a **frozen index-sorted, FMA-free accumulation contract** + **iteration-count-deterministic** convergence (a 1-ULP intermediate divergence — which `exp` guarantees — can flip an early-exit by one iteration). Specify before coding.
3. **Twin MC (#30) parity = ULP, not bit-exact.** The `Normal(θ̂, SE)` init draw needs Box-Muller/inverse-CDF (`exp`/`log`/`sqrt`) → reintroduces `exp` divergence *inside* the RNG path. The replay engine never *drew* (it *read* logged outcomes); flipping it to draw adds an `exp`-fragile transform. Spec the exact Normal transform + tolerance.
4. **Shared inherited invariants (still hold):** seed-not-closure (pass `seed:u32`, run the whole stream in Rust); no `mul_add`/FMA; exact f64 round-to-nearest-ties-to-even; GRID_THETA a frozen const both sides; mulberry32 already `Object.is`-proven in the spike.

---

## 5. Plug-in Points (citations red-team-corrected)

| Piece | Attaches at | Note |
|---|---|---|
| grid posterior substrate | `theta-grid.ts:104` uniformPrior, `:120-182` binaryLikelihood/gridUpdate, `:185-201` posteriorMean/Var/Se, `:78` GRID_THETA | port verbatim; TS stays oracle |
| θ-grid write seam (flag) | `state.ts` shadow `theta_grid_json` write; `theta-grid.ts:54` THETA_GRID_ENABLED=false | new solver ships behind sibling `COLD_START_SOLVER_ENABLED`, same dark-ship playbook |
| placement ("first few answers") | `placement-select.ts`, `placement-next.ts`, `placement-start.ts`; termination `placement-termination.ts:59` | #124 = NEW sibling endpoint `{cards[],planSeed}`; live adaptive `/next` untouched |
| cold-start scorer (KLP/MFI) | `selection-signals.ts:81` mfiScore, `:169` klpScore; gate `candidate-signals.ts:389` EARLY_KLP_ENABLED (LIVE) | `plan_select` reuses; no fork of item-information def |
| fixed `b` anchors | `fixed-anchor.ts:95` setFixedAnchor (const `ANCHOR_BUCKET_LOGITS` at `:49`); `effectiveB` **def `recalibration.ts:90`**, read `candidate-signals.ts:203` | read `b` as input; NEVER write (locked-b) |
| profile read model (#41 read side) | `calibration-maturity.ts:139-194`, thresholds `:39-47`, route `observability/manifest.ts` | recompute badge attaches here + placement profile `placement-profile.ts` |
| profile derive math (#41 parity target) | `state.ts:313-319` getMasteryProjection derive chain; β median **`state.ts:359-395` getRepresentativeKcBeta (Postgres `percentile_cont`)** | server sends 4 resolved scalars (β pre-collapsed); badge asserts on them |
| replay engine (#30 substrate) | `replay.ts:32-41` imports, `:134` replayTheta, **`:107-118` float32-persistence caveat** | flip from reading logged outcomes to drawing Bernoulli(σ(θ−b)) |
| event-sourcing / schema (Tier-2 parity) | mastery_state `schema.ts` `theta_hat`/`theta_precision` are **`real`/float32** | Tier-2 bit-exact only in pure float64 unless schema widens to `double precision` |
| onboarding UI | placement-profile reveal, calibration-maturity card, Twin fan-chart (new) | each needs a **design-doc pre-flight** before code (CLAUDE.md UI rule) — seams only, not designed |

**Locked-`b` is structurally real** (red-team confirmed): `conjunctiveCredits(thetas, b, outcome)` (`theta.ts:111`) reads `b`, never writes; `gridUpdate` takes `b'` as input scalar; `updateThetaForAttempt` is in `state.ts:482`. (The sketch's earlier `theta.ts:78-87` cite was `updateTheta`, a different fn — claim true, anchor was wrong, fixed here.)

---

## 6. First Demoable Slice (reframed)

**#41 Tier-1 (reproducible profile recompute badge), on top of a *committed* beachhead crate.** Smallest end-to-end thing delivering the headline trust moment — read-only, live-safe (observes existing `getMasteryProjection` output).

But honestly (red-team): this slice is **the σ/`exp` fidelity DECISION POINT**, not "inheriting a solved foundation." `profile_derive` exercises the `exp` path and little else hard — so it's the right probe for the §4 risk, but it does NOT touch the two genuinely-novel risks (EM sweep-order #125, Normal-draw MC #30). So **also stand up a non-UI one-KC `solve_theta_map_em` differential test early** so the largest *new* risk isn't deferred to Phase 3.

**Trust-badge scope (don't oversell):** it audits the *display arithmetic from the 4 scalars*, NOT the β median (DB-resident `percentile_cont`, non-re-derivable client-side).

---

## 7. Build Sequence

- **Phase −1 — Land the beachhead crate.** Commit `crates/calibration-native` (mulberry32 + AUC/bootstrap, napi) + its differential test into the tree. *The sketch's whole "depends on the proven crate" rests on this; the spike was a throwaway, deleted.* This is the real first artifact.
- **Phase 0 — WASM spike + the σ/exp decision.** Compile mulberry32 + `profile_derive` to WASM; measure Rust `f64::exp` vs V8 `Math.exp` divergence; decide §4 invariant (ULP-tolerance vs shared-poly). Ships nothing; de-risks the determinism story.
- **Phase 1 — #41 Tier-1 recompute badge.** `profile_derive` WASM + evidence-bundle serializer + badge on the calibration-maturity card, with the chosen σ tolerance. Read-only, live-safe. **First demo.** + the non-UI one-KC EM differential test.
- **Phase 2 — #123 deterministic prior-propagation (n=0).** `propagate_priors` behind `PREREQ_PROPAGATION_ENABLED` (the inc-E flag), byte-identical-off regression anchor. *Ships: "open app → auditable n=0 profile."*
- **Phase 3 — #125 coupled MAP/EM θ̂ (napi).** `solve_theta_map_em` behind `COLD_START_SOLVER_ENABLED`, JS/grid oracle fallback, frozen sweep-order + differential bit/ULP test before flip. *Ships: "answer a few → profile tightens, identifiable at n=1."*
- **Phase 4 — #124 batch plan + #30 Twin.** `plan_select` offline `{cards,planSeed}` endpoint + `forward_twin` (replay flipped, with the spec'd Normal transform + ULP parity). *Ships: "reproducible first plan" + "the fan that narrows."*
- **Phase 5 — Tier-2 trajectory parity (gated).** Full-log replay recompute; lands the `real`→`double precision` schema decision (or accepts ~1e-6 as the live θ̂'s actual carried precision).

---

## 8. Honest Edges

- **⚠️ Maturity is a FEATURE.** Day-one bands are wide because cold start = `precision=1` → `SE=1` (`candidate-signals.ts:98`); that wideness IS the honest signal (`low_confidence` fires at SE≥1.0, `pfa.ts:122`). Bands narrow mechanically as Fisher info accrues (`theta.ts` updateThetaPrecision) → precision↑ → SE↓. Surface the bands; never hide them.
- **✅ All five are n=1-legal.** #125 estimates θ̂ only over fixed `b` anchors → identifiable from the first observation. No piece estimates item parameters (locked-`b` red line is structural). `propagate_priors`'s `shrink_coeff` is an owner const, not population-fit.
- **Reused vs new ledger.** *Reused (LIVE/written):* grid posterior primitives, full `@/core/theta` credit loop, pure replay engine, KLP/MFI scoring (LIVE), seeded sampler + mulberry32, both read models, placement loop, fixed-`b` anchors. *New:* `propagate_priors`, `solve_theta_map_em`, `plan_select`, `forward_twin`, `profile_derive` + badge, the WASM target, **and committing the beachhead crate**.
- **Explicitly NOT here:** item calibration #66 (❌-at-n=1; `b` is read-only everywhere); no `a`/`c`/slip/guess (1PL only); grid-as-SoT stays dark (`THETA_GRID_ENABLED=false`).
- **Real risks (red-team):** (1) σ/`exp` fidelity — Phase-0 decision, load-bearing for the first slice. (2) Tier-2 bit-exact only in float64 — prod persists θ̂ as Postgres `real`/float32 through TEXT (~7 digits); assert ~1e-6 or widen schema. (3) cross-domain prereq edges couple two `θ_global` translations — propagation needs an explicit offset-grid rule; **focus review here**. (4) FSRS is a JS lib (ts-fsrs) — keep FSRS JS-side for the Twin (thin JS wrapper around the Rust θ̂/PFA MC loop), port later. (5) empty goal-subgraph → `sourcingNeeded` (`placement-start.ts:101-109`), a content gate not an algorithm gate; plan degrades to "source then re-plan", never fabricates.

---

## 9. Linear follow-up (capture-gate, not yet filed)

Umbrella issue: *"coldstart-core Rust crate (napi+WASM) + #41 recompute badge — the day-one auditable diagnostic coach"*, with four explicit sub-decisions:
1. **Commit the beachhead crate first** (Phase −1).
2. σ/`exp` fidelity: ULP-tolerance vs shared-polynomial `exp`.
3. `real`→`double precision` schema widening for Tier-2 bit-exactness.
4. FSRS port boundary: JS-side wrapper vs Rust port.

Not filed (owner is steering an ideation thread + paused the beachhead). File when full implementation starts.
