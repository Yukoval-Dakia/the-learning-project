# Rust-Catalog Triage — All 126 Ideas, Per-Idea Adversarial Disposition

- **Status**: Triage outcome (decision artifact). Companion to the catalog → `docs/design/2026-06-25-rust-product-ideas-catalog.md`, the beachhead → `docs/design/2026-06-24-rust-napi-calibration-beachhead.md`, and the cold-start sketch → `docs/design/2026-06-25-coldstart-diagnostic-coach-sketch.md`.
- **Provenance**: 2026-06-25, owner-commissioned ("126 点子放 workflow 去 triage"). Produced by a 55-agent workflow (9 cluster-chunk triagers → 45-verdict adversarial refute pass, grounded against the real repo → synthesis). 7/45 load-bearing verdicts refuted-and-corrected. The disposition below is *earned per-idea and refutation-tested*, NOT inherited from the catalog's own self-grade.
- **Linear**: project "Rust 同构核心 — 确定性 cold-start 引擎" (under initiative 私人教研团 — 个性化学习地基); Phase-0+ umbrella = YUK-495; Phase -1 record = YUK-493.

## Owner sub-decisions (2026-06-25 — all chose the more ambitious option)

1. **Build order** = #41 badge first + #125 one-KC EM differential-test rider (pulls the largest NEW determinism risk, EM sweep-order, forward from Phase 3). NOT #123-visible-WOW first.
2. **σ/exp fidelity = shared-polynomial exp (b)** — JS oracle + Rust route through ONE fixed-polynomial exp/σ, so σ-derived display fields are also `Object.is` bit-exact. **The ULP carve-out is removed; the whole core is literally bit-for-bit.** Phase 0's headline deliverable = build + verify that shared-polynomial exp/σ.
3. **FSRS ported to Rust too** — keystone #105 literally includes FSRS; Twin #30 uses Rust FSRS, not a JS shell. Adds an FSRS-port sub-phase.
4. **Schema widened now** — `mastery_state.theta_hat`/`theta_precision` `real → double precision` early (Phase 1, not deferred to Phase 5), so Tier-2 trajectory parity is bit-exact from the start. Goes through the 5-surface registration ritual (schema / migration / `audit:schema` / `export-constants.ts` FK_ORDER+SCHEMA_VERSION / `db.ts` ALL_TABLES).

---

## 1. Headline counts

### By disposition

| Disposition | Count | IDs |
|---|---|---|
| **COMMIT-phase0plus** (the spine) | **6** | 30, 41, 105, 123, 124, 125 |
| **COMMIT-fastfollow** | **22** | 1, 2, 4, 5, 14, 16, 42, 44, 45, 47, 52, 56, 58, 61, 67, 69, 82, 87, 88, 91, 110, 123-family |
| **DEFER-backlog** | **92** | tiered by maturity (§4) |
| **DROP-redline** | **7** | 66, 68, 70, 71, 74, 76, 77 |
| **DEV-TOOL** | **1** | 126 |

> COMMIT total = 28 (6 spine + 22 fast-follow). Non-build = 100 (92 defer + 7 drop + 1 dev-tool).

### By n=1 bucket

| Bucket | Count | Note |
|---|---|---|
| **enablable-now** | ~60 | n=0/n=1 legal day-one |
| **data-gated** | ~59 | works at n=1 but statistically empty until own-history accrues |
| **needs-scale** | 6–7 | requires between-person variance — unreachable at user=1 (66, 68, 70, 71, 74, 76; + 77 as a b-estimator) |
| **self-only** | 1 | works solo, wow needs a 2nd party (108) |

> **Every needs-scale idea is also DROP-redline — they coincide exactly.** That is the n=1 wall made visible: the *only* ideas that genuinely cannot run single-user are the ones that try to fit item parameters across people.

### Divergence from the catalog's self-grade (✅91 / ⚠️31 / 🔻1 / ❌3)

Independent triage disagreed in **both** directions:

- **Catalog ❌=3, triage DROP=7.** The catalog flagged only #66/#68/#76. The triage additionally dropped:
  - **#70 (BKT/PFA slip-guess learned)** — catalog graded buildable-with-caveat; slip/guess are a/c-family item params needing between-person variance. → needs-scale.
  - **#71 (item-fit infit/outfit)** — catalog ✅; infit/outfit is an item-quality statistic over a multi-person residual matrix; one row → not identifiable.
  - **#74 (temporal DIF)** — catalog ✅ ("within-person"); separating "item drifted easier" from "you learned" is an item-parameter-over-time inference; at n=1 it collapses to ordinary θ̂-rise. **Sharpest divergence — the catalog's own ✅ rationale was the trap.**
  - **#77 (empirical-Bayes b prior)** — real EB shrinkage needs *fitted* neighbor difficulties (between-person). The n=1-legal version is just #123's owner-fixed `shrink_coeff`, not an estimated prior. → DROP as a b-estimator.
- **4 catalog-favorite "build-first" picks demoted to DEFER** (mechanism mirage / phase order): #15, #54, #59, #119 (see §6/§7).
- **2 ideas flagged mechanism_real=FALSE** that the catalog presented as native-compute: #96 (JS timer), #12 (LLM embedding step).

> **Net:** independent triage is *more conservative on the red line* (7 drops vs 3) and *more skeptical of "build-first" labels* (4 demotions for mechanism), while confirming the spine. The value is concentrated in **#70/#71/#74** (caught fitting params despite ✅) and **#15/#54/#59/#119** (caught as LLM/JS mirages despite COMMIT framing).

---

## 2. COMMIT set — the actionable scope

### 2a. The Phase 0+ spine

| id | title | mechanism | phase | why |
|---|---|---|---|---|
| **105** | One Isomorphic Learning Core (keystone) | determinism | Phase 1 | The single napi+WASM crate the spine compiles into; no data needed — build first. Now literally includes FSRS (decision 3). |
| **41** | Reproducible Diagnostic Profile | determinism | Phase 1 | Headline north-star made falsifiable; re-derives whatever profile exists (incl. day-one prior), now bit-exact through shared-poly σ (decision 2). |
| **45** | Reproducible Calibration Card | determinism | Phase 1 | Rides the already-shipped bit-exact calibration crate; proves the WASM determinism path end-to-end. |
| **125** | Cold-Start Prior Solver (MAP/EM) | native-compute | Phase 3 (diff-test rides Phase 1) | Estimates θ̂ only over fixed b → identifiable at n=1; largest NEW determinism risk (EM sweep-order) — its one-KC diff-test is a Phase-1 rider (decision 1). |
| **123** | Deterministic Cold-Start Profile from Priors | determinism | Phase 2 | Day-one coherent profile from priors, reads b never writes; IS the design's inc-E (heaviest, dark-ship `PREREQ_PROPAGATION_ENABLED`, byte-identical-off regression anchor) — fast-follow BEHIND the MVP, do NOT lead with it. |
| **30** | Cold-Start Twin from Priors | native-compute | Phase 4 | Projects a path day-one with honest wide bands; uses Rust FSRS (decision 3); Box-Muller `Normal(θ̂,SE)` init is the parity watch, not a b-fit. |
| **124** | Deterministic Cold-Start Plan from Priors | mixed | Phase 4 | Reproducible offline day-one plan from the seeded profile; reload-identical via mulberry32 planSeed. |

### 2b. The fast-follow set (22)

Ships off the spine substrate once the core lands.

- **Trust cluster (on the #41 substrate):** #44 Bit-Identical Server/Client θ̂ · #42 Bit-Exact Verifier Badge · #47 "Explain This Number" Provenance · #110 Deterministic Diagnostic Snapshot · #52 Replay-Backed "Why Now?".
- **Selector / posterior:** #67 Live Full-Information CAT Engine (θ̂-only over fixed anchors) · #69 Exact Grid-Bayes Posterior (consumes fixed b) · #14 Local Adaptive Difficulty · #16 WASM Mastery Pre-Compute.
- **WASM judge / offline loop:** #2 Zero-Latency Objective Grading · #1 Pocket Practice · #4 Unit/Dimension Sanity Light · #5 Offline What-Next Picker.
- **Graph diagnostic:** #56 Keystone Concept Detector (centrality over prereq edges — first diagnostic consumer of the graph) · #58 Gap Detector / **Frontier Map (build the ring NOW)** · #61 Prerequisite Path / Unlock Route.
- **Live meter:** #88 Confidence Ribbon / Uncertainty Cloud · #91 **Live Mastery Meter (build the needle NOW)**.
- **Calibration / content:** #82 Calibration Sweep (nightly napi over the shipped crate) · #87 Deterministic Variant Generator.

> **Build-first within fast-follow:** #45 + the calibration crate behind #82 are *retired risk* (already shipped, YUK-493). #44/#42/#47 are the cheapest Trust wins on the #41 substrate. **#58-ring + #91-needle** are the visible day-one slices (their accrual halves — weak-coloring / band-narrowing — stay deferred).

---

## 3. DROP / red-line register — the wall (do-not-build, record WHY)

Every idea that **fits item parameters** (b/a/c/MIRT/slip-guess) or **needs between-person scale**.

| id | title | why it's the wall |
|---|---|---|
| **66** | Joint IRT Item Calibration (EM/JMLE of b) | THE n=1 wall. EM/JMLE over the response matrix outputs item difficulty b — the exact forbidden write. (Catalog ❌ — confirmed.) |
| **68** | 2PL/3PL Discrimination & Guessing (a/c) | Per-item ICC slope/asymptote is between-person; one ability point cannot trace a curve. (Catalog ❌ — confirmed.) |
| **76** | Multidimensional IRT (MIRT) Compensation Map | Fits compensatory loadings; rotationally unidentified at n=1. (Catalog ❌ — confirmed.) |
| **70** | Personalized KT Fit (BKT/PFA learned) | **Catalog buildable-with-caveat → DROPPED.** EM-fitting slip/guess IS the a/c-family red line; needs between-person variance, not just more attempts. |
| **71** | Item-Fit Diagnostics (infit/outfit) | **Catalog ✅ → DROPPED.** Item-quality statistic over a multi-person residual matrix; one row → not identifiable. |
| **74** | Differential Item Functioning Over Time | **Catalog ✅ ("within-person") → DROPPED.** "This item got easier" is an item-parameter-over-time inference; at n=1 you only see θ̂ move. **Do not echo the catalog's ✅.** |
| **77** | Empirical-Bayes b Prior | **b-estimator → DROPPED.** Real EB shrinkage needs fitted neighbor b (between-person); the n=1-legal version is just #123's owner-fixed `shrink_coeff`. Keep b read-only/seeded. |

> **Through-line:** the red line is "*seed, don't close*" — consume b as fixed input, never fit it from this user's responses. **#74 is the one to internalize**: a plausible "within-person" framing was an item-param-fit in disguise.

---

## 4. DEFER backlog — grouped by maturity tier (92)

Tag each with its `unlock_condition` so it auto-surfaces as data accrues.

- **Tier 0 — enablable-now but off-spine (no data gate, ship as a later wave):** #3 #6 #7 #8 #9 #11 #13 #50 #51 #54† #57 #59† #62 #64 #65 #72 #73 #86 #89 #95 #97 #98 #100 #106 #107 #109 #112 #113 #116 #119† #84†. († = mechanism-mirage, build as plain-TS not Rust — see §6.)
- **Tier 1 — ~tens of attempts/KC:** #12 #18 #22 #27 #28 #29 #33 #35 #36 #37 #40 #46 #60 #80 #85 #90 #93 #96† #103 #115 #117 #118 #120.
- **Tier 2 — ~weeks of spaced/decay history:** #20 #21 #23 #24 #25 #26 #31 #32 #63 #92 #94 #102 #104 #121.
- **Tier 3 — sessions/forecasts/multi-snapshot:** #34 #38 #39 #48 #49 #53 #55 #75 #78 #79‡ #81 #83‡ #99 #101 #108 (self-only) #111 #114 #122. (‡ = b-adjacent watch, §5.)

> **⭐ Early buildable slices (already lifted to fast-follow):** #58 frontier ring (✅ now; only the red weak-node coloring is gated) · #91 θ̂ needle (moves day-one; only band-narrowing is the accrual part).

---

## 5. b-red-line watch — CONSUMES vs WRITES

| id | verdict | guard |
|---|---|---|
| **30** Twin | CONSUMES b read-only; estimates only θ̂ | Box-Muller init draw = parity watch, not a b-fit |
| **35** Exam Simulator | CONSUMES anchored ICC (b read-only, a=1) | watch no a/c creeps into sampling |
| **84** Stress Probe | CONSUMES `effectiveB`; estimates only θ̂ | name says "difficulty" but it READS difficulty (also mechanism-refuted §6) |
| **123** Cold-Start Profile | CONSUMES fixed priors; `shrink_coeff` owner-const, never estimated | watch only because it touches multiple live engines (inc-E); writes no b |
| **77** EB b Prior | **WRITES** (as a b-estimator) → DROPPED (§3) | n=1-legal version is just #123's fixed shrink_coeff |
| **79** Equating | CONSUMES — estimates a per-form linear translation of θ, not per-item b | watch it translates θ, never re-fits b |
| **83** Calibration Diff | diff is read-only/deterministic (legal) | renders the disjoint nightly `b_calib` path — copy must never imply cold-start fits b |

---

## 6. mechanism_real = FALSE — Rust value is partly/wholly an LLM/IO/JS mirage

| id | title | real Rust slice | the mirage (out of scope / JS-carryable) |
|---|---|---|---|
| **96** Practice-Loop Metronome | *None* | Cadence/tempo nudge is a lightweight JS UX timer. No heavy numerics, no determinism wow. |
| **12** Did-I-Already-Learn-This (dedup) | Rust math over *pre-existing* vectors | The wow needs the NEW upload embedded — an LLM step. Also empty until the KC bank fills. |
| **84** Item-Difficulty Stress Probe | *None as Rust* | `p=σ(θ̂−b)` per item is inline pure-TS (`mfiScore`/`fisherInformation`/`expectedScore`); no MC engine exists. Keep as plain-TS ingestion gate. |
| **59** Optimal Study Sequencer | *None* | Prereq-DAG topo-sort is O(V+E) — `topology-gate.ts` already does it in TS. The "smart" ordering is the LLM `GoalScopeTask`. |
| **119** Local Re-rank for "Prepared For You" | *None as Rust* | Re-ranking tens of candidates by a closed-form mastery+recency score is microsecond JS. The wow is the LLM-retrieved context. Plain-TS re-rank seam. |
| **54** Deterministic Selection Receipt | FSRS-due/MFI slice is deterministic — *but that is already #52* | Distinguishing claim rests on LLM `SelectionOrchestratorTask` weights + an un-seeded `Math.random()` Poisson draw — a bit-exact receipt can't re-derive either. |
| **15** Offline CAT (full adaptive diagnostic) | Fisher-max selector is WASM-portable — *but that is #14/#67's selector* | The "complete offline adaptive diagnostic" wow needs a per-item LLM judge grade + LLM sourcing. The full loop is an LLM feature in disguise. |

> **Pattern:** the recurring mirage is (a) a "native-compute" hat on JS-carryable arithmetic (#84/#59/#119/#96), or (b) claiming offline/deterministic for a loop whose *wow-producing step* is an LLM call (#15/#54/#12). The genuine Rust wins are the **selector** (#67), the **posterior** (#69), the **forward-MC twin** (#30), and the **isomorphic determinism core** (#105/#41).

---

## 7. What the adversarial pass changed (7 refuted of 45 verified)

| id | change | from → to | why it matters |
|---|---|---|---|
| **15** | demoted (mechanism over-claimed) | COMMIT-fastfollow → DEFER | "Offline CAT on a plane" was a flagship best-pick, but the full loop needs an LLM judge per item. Prevents shipping an "offline" feature that silently needs the network. |
| **54** | demoted (mechanism false for the distinguishing claim) | COMMIT-fastfollow → DEFER | A "bit-exact receipt" cannot re-derive an LLM weight or an un-seeded random draw. Avoids a false "provably reproducible" claim. |
| **59** | demoted (mechanism false) | COMMIT-fastfollow → DEFER | Topo-sort is JS-trivial; the smart ordering is LLM. Don't spend the napi/WASM budget here. |
| **119** | demoted (mechanism false) | COMMIT-fastfollow → DEFER | The wow is LLM-retrieved context, not the sort. Plain-TS seam, not a Rust feature. |
| **123** | phase corrected (verdict held) | COMMIT-phase0plus → fast-follow-behind-MVP | #123's prior-propagation IS inc-E (heaviest, last, dark-ship). Reordering it out of the phase-1 lead keeps the riskiest increment from blocking the MVP spine. |
| **70** | confirmed DROP, bucket fixed | data-gated → needs-scale | Slip/guess need between-person variance (not just more attempts) → never reachable at user=1, not merely "wait for data." |
| **84** | verdict held, mechanism corrected | native-compute=true → false | `p=σ(θ̂−b)` over a few items is inline pure-TS, not napi-heavy. Stops a JS-trivial ingestion gate being scoped as a Rust crate. |

### Why this is the value of the exercise

1. **Separated "real Rust win" from "Rust hat on a mirage"** — 4 COMMIT-track ideas were LLM-in-disguise or JS-carryable; building them as Rust/WASM would have spent the scarce determinism budget on nothing *and* shipped false "offline/provable" claims.
2. **Caught the n=1 wall the catalog's ✅ hid** — #70/#71/#74 all fit item params despite a ✅ grade; **#74** especially ("within-person" concealing item-param-over-time).
3. **Got the build order right** — #123 carries a COMMIT verdict but is the heaviest, last, most-audited increment; leading with it would have inverted the risk profile.
4. **The red line held under attack** — identifiability/b-write verdicts survived every adversarial challenge; what moved was *mechanism* (is the Rust real?) and *bucket* (data-gated vs needs-scale). The psychometric legality of the spine is firm; the engineering justification of individual features is where skepticism paid off.
