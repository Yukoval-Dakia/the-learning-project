# The Rust-Unlocked Cool-Ideas Catalog
### For a single-user self-hosted AI learning tool — what introducing Rust actually unlocks as *product features*

- **Status**: Ideation / generative (NOT a commitment). Generated 2026-06-25 by a 9-lens × ≥15-idea workflow (19 opus agents, ~230 raw ideas) honestly filtered for genuine Rust-necessity and deduped.
- **Companion**: the calibration beachhead design + spike → `docs/design/2026-06-24-rust-napi-calibration-beachhead.md` (the toolchain proof that makes any of this buildable).

Every idea earns its Rust value from exactly one of three mechanisms — **[WASM-client]** (in-browser, offline, private), **[native-compute]** (napi-rs heavy numerics the JS thread can't carry), or **[determinism]** (bit-exact isomorphic core, server≡client, reproducible) — and never from an I/O/LLM feature in disguise.

**TOTAL DISTINCT IDEAS: 126** (numbered 1–126 across 9 clusters).

---

## user=1 ENABLABILITY FILTER (2026-06-25)

> Classification of every idea by whether it works at **user=1** (one learner, self-hosted, realistic personal data, cold-start). Done via an 11-agent workflow (9 cluster classifiers + identifiability verify + synth). **Corrected count** (the synth miscounted #111/#112 as phantom slots — they are real single-user ✅): **✅ 91 · ⚠️ 31 · 🔻 1 · ❌ 3 = 126.**

**The n=1 wall is exactly ONE thing: item-parameter psychometrics.** From a single learner you can only identify the *difference* `θ − b`, never item difficulty `b`, discrimination/guessing `a`/`c`, or MIRT loadings separately — those need between-person variance. Everything that *consumes* fixed (LLM-seeded / KG-anchored) item params while estimating only this person's `θ̂`/posterior is fully identifiable at n=1. The recurring caveat elsewhere is never identifiability but *maturity* — works day-one on priors with honest wide bands, sharpens as your attempts accrue (a feature for a cold-start tool).

### ❌ NEEDS SCALE — not enablable at user=1 (exactly 3)
- **#66 Joint IRT Item Calibration (EM/JMLE fit of `b`)** — needs many persons per item; at n=1 the response matrix is one row → `b` and `θ` jointly under-identified. (This is the wall the locked-`b` red line exists to avoid.)
- **#68 2PL/3PL Discrimination & Guessing (`a`/`c`)** — per-item ICC slope/asymptote needs many learners of differing ability; one ability point can't trace a curve.
- **#76 Multidimensional IRT (MIRT) Compensation Map** — compensatory loadings need a multi-person × multi-item matrix; rotationally unidentified at n=1.

### 🔻 SELF-ONLY — works at user=1, the cool part needs another party (1)
- **#108 Verifiable Proof-of-Learning** — third-party recompute of "θ ≥ X" needs a verifier. Single-user-degraded form = a self-issued, self-re-derivable credential / future-you receipt (✅ minus the external-verifier wow).

### ⚠️ DATA-GATED — enablable at user=1, statistically empty/weak until your attempts accrue (31)
#12 dedup-on-upload (~tens of KCs) · #18 Digital Twin (~tens of attempts) · #25 Forgetting-Cliff Radar (~weeks/KC) · #26 Overload Rebalancer (populated queue) · #27 Mastery-ROI Map (~tens spread) · #29 Marginal-Gain Ranker (~tens) · #32 Mastery Weather (~weeks/KC) · #33 Misconception Contagion (~tens) · #35 Exam Simulator (~tens/KC; ICC stays anchored) · #48 Twin-vs-Reality Backtest (weeks–months of resolved forecasts) · #55 Honesty Dial (calibration accrual) · #58 Gap/Frontier weak-coloring (frontier ring is ✅ now) · #60 Bottleneck Highlighter (~few/KC) · #63 Decay Heat Field (~weeks) · #70 Personalized BKT/PFA fit (~tens/KC) · #71 Item-Fit soft-anomaly (~few/item) · #74 Temporal DIF within-person (multi-attempt × 2 windows; identifiable at n=1) · #77 Empirical-Bayes Prior (relative `b−θ` over neighbor cluster) · #85 Difficulty Dial (~tens/KC) · #90 Brier "vs last week" (~dozens tagged) · #91 Live Mastery Meter band-narrowing (~tens/KC; needle moves now) · #93 Desirable-Difficulty Governor (~tens/KC) · #96 Practice Metronome (~dozens timed) · #102 Branch-and-Merge plans (~weeks) · #103 MC Study ROI decision-grade (~tens/KC) · #104 Efficient Frontier (~weeks decay data) · #115 Confusion Cluster Map (~50–100+ errors) · #118 Nearest-Confusions (~tens) · #120 Confusable-Concept Finder (~tens co-occurring) · #121 Personal Forgetting-Curve fit (~weeks spaced; within-person identifiable) · #122 Highlight Reel (~month of θ̂ movement).

### ✅ ENABLABLE NOW — buildable at user=1 today (91)
- **C1 Instant & Offline (WASM):** #1 #2 #3 #4 #5 #6 #7 #8 #9 #10 #11 #13 #14 #15 #16 #17 (16)
- **C2 Simulation & Forecasting:** #19 #20 #21 #22 #23 #24 #28 #30 #31 #34 #36 #37 (12)
- **C3 Deterministic Replay & Trust:** #38 #39 #40 #41 #42 #43 #44 #45 #46 #47 #49 #50 #51 #52 #53 #54 (16)
- **C4 Graph Intelligence:** #56 #57 #59 #61 #62 #64 #65 (7)
- **C5 Adaptive Testing & Psychometrics (param-consuming, θ̂-only):** #67 #69 #72 #73 #75 #78 #79 #80 #81 #82 #83 #84 (12) — incl. #79 common-PERSON equating (one person spans both forms = the anchor).
- **C6 Real-time UX & Procedural Gen:** #86 #87 #88 #89 #92 #94 #95 (7)
- **C7 Gameplay & Replayable Practice:** #97 #98 #99 #100 #101 (5) — incl. #99 ghost = your own bit-exact replay.
- **C8 Data, Sync & Portability:** #105 #106 #107 #109 #110 #111 #112 #113 #114 (9) — #106 multi-device = one user/many devices; #111/#112 = query/analyze your own history locally.
- **C9 On-Device Intelligence & Cold-Start:** #116 #117 #119 #123 #124 #125 #126 (7)

### Best ✅ picks for single-user + cold-start (vision-aligned)
#123 Cold-Start Profile from Priors · #124 Cold-Start Plan from Priors · #125 Cold-Start Prior Solver (MAP/EM) · #30 Cold-Start Twin · #15 Offline CAT diagnostic · #41 Reproducible Diagnostic Profile · #119 Re-rank "Prepared For You" · #88 Breathing Confidence Cloud · #5 Offline "What Next" Picker · #56 Keystone Concept Detector.

---

## 1. Instant & Offline (WASM) — "it just works on a plane"

1. **Pocket Practice (full offline loop)** — A complete graded session with no signal, syncing when you surface. — [WASM-client] — WOW: airplane mode, 30 items, each grades instantly, the next card is already chosen on-device, a "queued to sync" pill ticks up — the app never spins. — medium
2. **Zero-Latency Objective Grading** — The verdict lands before your finger leaves the key. — [WASM-client] — WOW: no blip between submit and "correct"; `1/2 m` ≡ `50 cm` accepted with zero round-trip — grading feels like a calculator. — easy
3. **Offline Step-Checker Scratchpad** — Type a multi-step derivation; each line ticks green/red as you go. — [WASM-client] — WOW: a spell-checker for reasoning, no server in the loop. — medium
4. **Unit/Dimension Sanity Light** — Live dimensional-consistency check as you type an answer. — [WASM-client] — WOW: `kg·m/s²` lights green, `kg·m/s` flags — bundled into the WASM judge core. — easy
5. **Offline "What Should I Do Next" Picker** — The next item, chosen by live mastery + due-dates, fully client-side. — [WASM-client + determinism] — WOW: finish a card, the next is *already* on screen, matching what the server would serve. — medium
6. **Private Mode (data never leaves the device)** — A toggle keeping every answer, mistake, and estimate on this machine only. — [WASM-client] — WOW: practice a full topic, open the Network tab — *zero* requests, yet grading and scheduling still work. — medium
7. **Live Knowledge-Graph Layout in WASM** — Pan/zoom a thousand-node concept map at 60fps offline. — [WASM-client] — WOW: a graph that stutters today settles smoothly; deterministic seed means it looks the *same* every load, so spatial memory works. — medium
8. **Spatially-Stable Progressive Disclosure** — Expand a cluster; new nodes glide in around it while the rest stays put. — [WASM-client] — WOW: the map feels like a place, not a slideshow — anchored incremental relaxation on just the touched subgraph. — medium
9. **Instant Corpus Search Palette** — Press `/`, fuzzy-search every KC, note, question, and upload, ranked as you type, offline. — [WASM-client] — WOW: Spotlight over your whole learning life, full speed on a plane. — medium
10. **Local Semantic Recall (in-browser HNSW)** — Type a half-remembered idea in fuzzy words; the right node lights up by *meaning*. — [WASM-client] — WOW: embeddings precomputed server-side, but the ANN search runs in WASM over a downloaded vector blob. — medium
11. **Live Search-As-You-Drag in the Graph** — Matching nodes glow and neighbors fade as you type while panning. — [WASM-client] — WOW: the filter index lives in WASM next to the renderer; no debounced API calls, 60fps. — easy
12. **Did I Already Learn This? (dedup-on-upload)** — Drop a document; badges show concept overlap before any server job. — [WASM-client] — WOW: "3 KCs you already have, 2 are new" appears before LLM tagging even starts. — medium
13. **Instant Study-Set Builder (offline faceted search)** — Compose a practice set by live-querying the whole bank with structured + fuzzy filters. — [WASM-client] — WOW: "KCs in this cluster, difficulty > X, last-wrong, not-seen-in-30-days" filters thousands instantly. — medium
14. **Local Adaptive Difficulty (live IRT targeting)** — Next item's difficulty tuned to live θ̂ for the ~75%-success sweet spot, offline. — [WASM-client + determinism] — WOW: the session "breathes" — harder after a streak, easier after a stumble — no network. — medium
15. **Offline CAT (full adaptive diagnostic)** — Take a complete adaptive placement test on a plane; each item perfectly chosen. — [WASM-client] — WOW: the Fisher-maximizing selector in WASM runs the whole adaptive loop, then syncs on reconnect. — medium
16. **WASM Mastery Pre-Compute on Page Load** — Open offline and your entire mastery profile is already drawn. — [WASM-client + determinism] — WOW: rings render from the cached event tail before any network call returns, then reconcile flicker-free. — medium
17. **Local Spaced-Repetition Notifications** — Your device reminds you at the mathematically optimal moment, computed on-device. — [WASM-client] — WOW: correct reminders offline and private — no server needs to know your schedule. — easy

## 2. Simulation & Forecasting (native-compute) — "run my brain forward 10,000 times"

18. **Digital Twin of the Learner** — Forward-simulate your knowledge and show where you'll actually be in 30 days. — [native-compute] — WOW: a per-KC *fan chart* — median projected mastery + 10–90% band from MC-sampling FSRS×PFA forward from θ̂/SE. — medium
19. **What-If Time Slider** — Drag from 10→90 min/day and watch the projected curve *breathe* in real time. — [native-compute] — WOW: thousands of futures re-simulated *per frame* during the drag. — medium
20. **Optimal-Schedule Search (Monte-Carlo Planner)** — "I simulated 5,000 schedules in 0.4s — this one hits your goal 47 min faster." — [native-compute] — WOW: enumerate spacings, full forward MC each, return the Pareto-best with the visible simulation count. — moonshot
21. **Goal-Date Reverse Solver** — "Exam-ready by the 18th? Here's the daily dose — or the honest 'earliest is the 23rd.'" — [native-compute] — WOW: search over daily effort, each probe a full graph MC. — medium
22. **Prerequisite Cascade Simulator** — Let a foundation rot and watch the damage ripple up the graph. — [native-compute] — WOW: drop one KC in sim, propagate through prereq edges over thousands of trajectories; downstream nodes dim by probability-weighted severity. — medium
23. **Strategy Tournament (A/B/C plans)** — Cram vs steady vs interleaved — three futures side by side. — [native-compute] — WOW: the twin under named policies, fan charts side-by-side with peak/day-60/total-minutes/burnout-proxy. — medium
24. **Regret Meter (skip-cost forecast)** — "Skip today, −4%; skip three days, −14%." — [WASM-client] — WOW: counterfactual did-plan-vs-did-nothing MC, recomputed in-browser at close-time, even offline. — easy
25. **Forgetting-Cliff Radar (banded)** — "These 7 concepts crack before you next see them." — [native-compute] — WOW: MC the retrievability-crossing per KC for a *distribution* of failure dates, ranked by load-bearing weight. — easy
26. **Overload Rebalancer** — "Next Tuesday spikes to 40 reviews — here's a smoother plan that hits the same target." — [native-compute] — WOW: detect FSRS pileups, then MC-search a load-balanced schedule with statistically-indistinguishable projected mastery. — medium
27. **Graph-Wide Mastery-ROI Map** — Every node shows sessions-to-solid; sort your whole graph by effort-to-payoff. — [native-compute] — WOW: forward-sim PFA+FSRS for *all* KCs at once, ETA band on every node, live-sortable by ROI. — easy
28. **New-Concept Readiness Gate** — "You could start this, but you'll thrash — shore up these 2 prereqs for a 3× smoother ramp." — [native-compute] — WOW: MC start-now vs firm-prereqs-first over the prereq subgraph. — medium
29. **Overnight Marginal-Gain Ranker (Learning Autopilot)** — "While you slept I ran ~10,000 versions of tomorrow and pre-baked the best." — [native-compute] — WOW: breakfast shows one ranked session + "I considered 9,847 plans; this lifts your weakest 3 prerequisites without overloading review debt." — medium
30. **Cold-Start Twin from Priors** — Day one, before a single answer, the twin projects your likely path from item/KC priors. — [native-compute] — WOW: wide honest bands that visibly narrow as attempts land. — medium
31. **Spaced-Repetition Wind Tunnel (Parameter Studio)** — Drag the FSRS knobs and watch projected forgetting curves bend across your whole deck. — [native-compute] — WOW: slide retention target and thousands of cards re-simulate instantly, plotting review-load vs retention. — medium
32. **Mastery Weather Forecast** — "3 concepts going cloudy by Thursday, a storm next week if you skip today." — [native-compute] — WOW: a weather-style map with forecast icons + confidence bands per region. — medium
33. **Misconception Contagion Map** — Watch one shaky concept "infect" downstream KCs — an SIR epidemic over your prereq graph. — [native-compute] — WOW: spread seeded at weak nodes animates which concepts are at risk of collapse. — medium
34. **Optimal-Stopping Session Coach** — A live "quit while you're ahead" signal when extra drilling stops paying. — [native-compute] — WOW: thousands of micro-projections estimate marginal retention-per-minute; a "peak reached" nudge. — medium
35. **Stress-Test Exam Simulator** — Drop into a simulated mixed exam 1,000 times — here's your score *distribution* and the 3 topics that sink it. — [native-compute] — WOW: sample item responses from per-KC ICCs across thousands of mock papers. — medium
36. **Sensitivity Tornado / Heatmap** — "Of everything you could change, daily-minutes matters 4× more than review-order." — [native-compute] — WOW: perturb each input in the twin, rank outcome leverage as a tornado chart / graph heatmap. — medium
37. **Confidence-Earned Unlock Forecast** — "Finish these 4 reviews and the sim is 90% sure this advanced node opens." — [native-compute] — WOW: MC the minimal action set driving a target KC's prereqs past readiness. — medium

## 3. Deterministic Replay & Trust — "your progress is auditable, not a black box"

38. **Replay Scrubber / Time Machine** — Drag a timeline and watch your whole knowledge graph bloom from blank to today, frame by frame. — [determinism] — WOW: scrub to any past date; the browser re-projects the full event log to that instant, zero server calls — you watch the exact day a misconception died. — moonshot
39. **Git-Diff of Your Mind** — Pick two dates; get a literal changelog: KCs added, mastery gained, edges rewired, misconceptions struck through. — [determinism] — WOW: reads like reviewing a pull request against yourself. — medium
40. **Counterfactual "What-If" Replay** — Flip any past answer (or strip a misconception) and watch the entire alternate future compute instantly. — [determinism] — WOW: a private, reversible thought experiment over your *real* history, side-by-side with reality. — medium
41. **Reproducible Diagnostic Profile** — A "recompute" button on the headline profile re-derives every per-KC θ̂/SE, matching the server bit-for-bit. — [determinism] — WOW: the product's core trust claim becomes verifiable — your profile is a number you can re-derive, not an opinion. — medium
42. **Bit-Exact Verifier Badge / Replay Receipt** — Tap any score and get a receipt: same inputs → same number, re-derived client-side. — [determinism] — WOW: every score carries a "verify ✓". — medium
43. **Drift Sentinel** — A silent watchdog proving client≡server to the bit — and screaming the instant they diverge, pinned to the offending event. — [determinism] — WOW: a green "in sync, bit-for-bit" dot; a bad migration triggers "inconsistency in your records — here's which event caused it." — medium
44. **Bit-Identical Server/Client θ̂** — The ability number on screen is the *exact* number the server stored. — [determinism] — WOW: the ring moves the instant you answer and never silently corrects itself on refresh. — medium
45. **Reproducible Calibration Card** — Calibration (AUC/ECE/κ) with one-click "recompute, byte-for-byte" proof. — [determinism] — WOW: press the button, WASM re-runs the exact AUC + cluster-bootstrap, matches to the last bit. — easy
46. **Theta Trajectory Audit** — Scrub one concept's ability curve; click any bend to see the exact evidence that moved it. — [WASM-client] — WOW: every inflection is clickable and replays the precise BKT/Urnings updates locally. — medium
47. **"Explain This Number" Provenance Drill-Down** — Tap any score and watch it unfold into the exact events and computation that produced it. — [determinism] — WOW: the trace IS the computation, recomputed live in WASM — not an LLM narrating a rationale. — medium
48. **Twin-vs-Reality Backtest** — "Last month the twin said 72%; you hit 70%. Here's its track record." — [determinism] — WOW: replay past forecasts against what happened, scoring the forecaster's own calibration. — medium
49. **Replay-Diff for Algorithm Changes** — Tune FSRS/θ̂ params and see the *exact* per-event delta the new core produces over your real history. — [determinism] — WOW: "this change would have moved 412 reviews and changed 3 diagnoses." — medium
50. **Reproducible Audit / Bug-Report Time-Capsule** — One click exports a tiny seed+event slice that reproduces the exact state anywhere, byte-for-byte. — [determinism] — WOW: "it computed wrong" becomes reproducible instead of a ghost story. — easy
51. **Reproducible Streak / Achievement Ledger** — Streaks computed as a deterministic fold over the event log — provable, tamper-evident. — [determinism] — WOW: no more "the app forgot my 40-day streak." — easy
52. **Replay-Backed "Why Now?" / "Why This Card?"** — Tap any due review and get a locally-recomputed reason it surfaced. — [WASM-client] — WOW: "last seen 9d ago, retrievability 0.86, 82% overdue, 18% weakest prereq" — every number live-recomputed. — easy
53. **Reproducible Adaptive Replay** — A seeded selector replayed over the event spine reproduces the exact item sequence + every snapshot. — [determinism] — WOW: "here's the posterior at item 7, here's why item 8 was chosen." — easy
54. **Deterministic Bit-Exact Selection Receipt** — Every served question carries a reproducible "why this" the client can re-derive offline. — [determinism] — WOW: "frontier-safe, FSRS-due 1.3d, unlocks 2 goals — verified ✓". — medium
55. **Calibration-Aware Honesty Dial** — The forecast widens its own error bars where the model has historically been wrong. — [determinism] — WOW: feed audited AUC/ECE back into the twin so bands inflate in miscalibrated regimes. — moonshot

## 4. Graph Intelligence (native-compute) — "the load-bearing concepts in your map"

56. **Keystone Concept Detector** — Surfaces the handful of concepts that unlock the most of everything else. — [native-compute] — WOW: "master this and 23 downstream things get easier"; centrality turns the hairball into a ranked plan. — medium
57. **Community / Cluster Detection** — The graph self-organizes into natural topic neighborhoods you never labeled. — [native-compute] — WOW: the hairball blooms into named colored islands (Louvain/Leiden). — medium
58. **Gap Detector / Frontier Map ("where I'm wrong / where I'm long")** — Live-maps shaky concepts upstream of what you're reaching for, and lights up what you're ready to learn *now*. — [WASM-client] — WOW: the graph dims to grey except a glowing frontier ring + red load-bearing weak nodes, recolored live on every answer. — medium
59. **Optimal Study Sequencer** — Tangled goals → a prerequisite-safe, ordered queue (never B before its A). — [native-compute] — WOW: "this week, in order" as a justified ladder, recomputing the instant you finish a rung. — medium
60. **Critical-Path Bottleneck Highlighter** — Finds the single weak concept bottlenecking the most paths to your goals. — [native-compute] — WOW: "one thing is holding back 5 of your goals," culprit throbbing. — medium
61. **Prerequisite Path / "Unlock Route" Finder** — Pick a target; instantly see the shortest *effort* path through your weak prerequisites. — [WASM-client] — WOW: a glowing route through only the prereqs you haven't mastered, re-routing live — GPS for your curriculum. — easy
62. **Cross-Domain Bridge Finder** — Surfaces surprising links between distant clusters. — [native-compute] — WOW: "these two clusters connect through 1 concept" — and gives the dead `applied_in` edge its first real consumer. — medium
63. **Mastery Half-Life / Heat Decay Field** — Color every concept by how fast it rots; watch the graph "cool" as memories decay. — [native-compute / WASM-client] — WOW: reopen after two weeks and a region has visibly cooled to blue. — easy
64. **Live Integrity Guard** — Impossible prereq loops and require-vs-contrast contradictions caught *as you edit*. — [WASM-client] — WOW: draw an edge that would create a loop and it snaps back red instantly — no save, no server. — medium
65. **Drag-to-Splice KG Editing** — Reshape your graph by hand and watch prerequisite consequences ripple instantly. — [native-compute] — WOW: drag an edge and the graph instantly recolors every downstream KC whose "ready-to-learn" status flipped. — medium

## 5. Adaptive Testing & Psychometrics (native-compute) — "difficulty stops being a guess"

66. **Joint IRT Item Calibration + On-Demand Re-Fit** — Your bank calibrates itself; difficulty becomes measured truth. — [native-compute] — WOW: an EM/JMLE pass fits `b` from the full response matrix — the computation the locked-`b` red line was built to avoid — with a live convergence animation. — moonshot
67. **Live Full-Information CAT Engine** — Each next question is the single most informative one, chosen the instant you submit. — [native-compute] — WOW: expected-Fisher maximization over the *entire* bank × *full* posterior in <5ms; the session locks onto your edge in 3–4 items. — medium
68. **2PL/3PL Discrimination & Guessing** — Finds which questions actually separate "gets it" from "doesn't" — and retires the ones that don't. — [native-compute] — WOW: real `a`/`c` estimation (impossible in JS, so everything is `a=1` today) gives a per-item quality score. — moonshot
69. **Exact Grid-Bayes Posterior, Flipped On** — A real probability cloud over your ability per concept, not a single guessed number. — [native-compute] — WOW: the deferred multi-KC conjunctive factorization becomes a cheap Rust grid convolution, so the dark grid goes live with a *calibrated* SE. — medium
70. **Personalized Knowledge-Tracing Fit (BKT/PFA learned)** — The model of how *you* learn is tuned to you, not a textbook average. — [native-compute] — WOW: per-KC EM-fitted learn/slip/guess + PFA weights from your own history. — moonshot
71. **Item-Fit Diagnostics (infit/outfit)** — Spots questions that behave weirdly — misprints, trick wording, broken keys. — [native-compute] — WOW: Rasch infit/outfit over the full residual matrix flags items where strong learners miss and weak learners pass. — medium
72. **Live Test-Information Curve (TIF X-ray)** — See the exact ability band your question set measures best — and where it's blind. — [WASM-client] — WOW: WASM recomputes Σ-Fisher across selected items over θ at 60fps as you hover KCs. — medium
73. **Bank Blueprint Optimizer** — Tells you the smallest set of questions to write next to measure you sharply everywhere. — [native-compute] — WOW: a TIF optimization over (difficulty × KC) returns "3 hard on A, 2 easy on B." — medium
74. **Differential Item Functioning Over Time** — Catches when a question has quietly gotten easier for you — i.e. you actually learned it. — [native-compute] — WOW: temporal DIF over the longitudinal residual matrix separates genuine learning from item drift. — moonshot
75. **Cross-KC Information Routing via the Graph** — The engine tests one concept to learn about five, reasoning over your prereq map. — [native-compute] — WOW: information maximization over the *joint* ability vector with the prereq graph as a covariance prior. — moonshot
76. **Multidimensional IRT (MIRT) Compensation Map** — Sees when getting a question right leaned on a neighboring skill — and corrects the credit. — [native-compute] — WOW: a compensatory MIRT model disentangles "did they know A, or did B carry them?" — moonshot
77. **Empirical-Bayes Difficulty Prior (warm-start the LLM `b`)** — Cold-start `b` isn't a wild guess — it's shrunk toward what similar concepts actually measured. — [native-compute + determinism] — WOW: hierarchical shrinkage toward fitted KG-neighbor difficulty. — medium
78. **Reliability / Conditional-SEM Report Card** — A trustworthiness score for your whole measurement — and exactly where it's shaky. — [native-compute] — WOW: marginal reliability + CSEM across θ: "reliable in the middle, noisy at the high end." — easy
79. **Local Linking / Equating Across Uploads** — Two separately-uploaded question sets land on one common ability ruler, automatically. — [native-compute + determinism] — WOW: common-person equating (Haebara/Stocking-Lord) across a textbook and a past paper; deterministic so linking constants are reproducible. — moonshot
80. **Posterior-Weighted Spacing (FSRS × ability uncertainty)** — Review timing accounts not just for forgetting, but for how *sure* we are you knew it. — [native-compute] — WOW: high posterior-SE → test sooner; reviews target your *blurriest* knowledge. — medium
81. **Power Analysis / "Is It Worth Asking?"** — "Answer this and uncertainty on 5 downstream concepts drops *this much*; that one barely moves." — [native-compute] — WOW: value-of-information — MC the expected posterior-SE reduction each candidate buys. — moonshot
82. **Calibration Sweep (nightly, native)** — Recompute calibration/AUC/cluster-bootstrap CIs across your *entire* history nightly without janking the worker. — [native-compute] — WOW: every morning a fresh "your model's reliability went up 4%" card. — medium
83. **Deterministic Calibration Diff** — See exactly what changed (and why) between two recalibrations. — [determinism] — WOW: "item 42's `b` dropped 0.4 because 12 attempts passed it this week." — easy
84. **Item-Difficulty Stress Probe (ingestion gate)** — Before a freshly-ingested question enters your queue, the sim predicts it's too hard *right now* — parked until you're ready. — [native-compute] — WOW: MC each new item against current θ̂/prior; auto-defer demoralizing/trivial items. — medium

## 6. Real-time UX & Procedural Generation — "the problem becomes an explorable object"

85. **Difficulty Dial You Can Scrub** — Drag a slider and the whole problem set re-tunes to your target challenge under your finger. — [native-compute / WASM-client] — WOW: IRT info-max re-ranks hundreds of candidates every frame, zero fetch. — medium
86. **Parametric Sketchpad (drag the givens)** — Manipulate a problem's inputs live and watch the canonically-correct answer track your changes. — [WASM-client + determinism] — WOW: drag lengths/rates/coefficients and the correct answer recomputes from the deterministic generator. — medium
87. **Deterministic Variant Generator** — "Give me 50 more like this" — instantly, offline, same seed → same variant server≡client. — [determinism] — WOW: an endless instant stream that grades reproducibly bit-for-bit. — medium
88. **Confidence Ribbon / Uncertainty Cloud That Breathes** — Your ability isn't a point — it's a fog that tightens with every answer. — [WASM-client + native-compute] — WOW: each KC shows a posterior cloud that re-samples and visibly contracts on-device. — medium
89. **Confidence-Weighted Wager Mode** — Stake how sure you are before answering; a proper-scoring engine grades your *calibration*. — [WASM-client + determinism] — WOW: bet chips; Brier/log-score + running calibration recompute the instant you submit, offline. — easy
90. **Confidence → Instant Brier Feedback** — Rate confidence; get an immediate local calibration nudge. — [WASM-client] — WOW: "+0.03 better calibrated than last week" the moment the verdict lands. — medium
91. **Live Mastery Meter** — Watch θ̂ and its uncertainty band tighten in real time as you answer. — [WASM-client] — WOW: a per-KC needle nudges and its error bar visibly narrows the instant a verdict lands. — medium
92. **Per-Frame Item-Exposure Balancer** — Adaptive selection that never over-drills the same KC, retuned live. — [native-compute] — WOW: an invisible solver keeps the deck humane and varied in real time. — medium
93. **Desirable-Difficulty Live Governor** — The session keeps you in the sweet spot in real time. — [WASM-client + native-compute] — WOW: next item re-selected client-side in <50ms by running the success-probability model locally. — medium
94. **Spaced-Schedule Optimizer Slider** — Drag your available daily minutes; the optimal review set re-packs across all due KCs. — [native-compute] — WOW: "I have 20 minutes" → a live knapsack re-selects which reviews maximize retained mastery. — medium
95. **Hint Ladder with Zero-Latency Gating** — Progressive hints gated by a deterministic check that matches the server. — [WASM-client + determinism] — WOW: the local gate releases the next hint instantly, provably the same gate the server would apply. — easy
96. **Practice-Loop Metronome** — An adaptive tempo engine paces your drilling and catches you rushing into errors. — [native-compute + WASM-client] — WOW: watches answer-cadence and accuracy, adjusting drill tempo with zero latency. — medium

## 7. Gameplay & Replayable Practice — "study becomes a seeded roguelike"

97. **Deterministic Roguelike Review Run** — Today's review is a seeded run — same seed, same dungeon; re-runnable and shareable. — [determinism] — WOW: re-rush a brutal run on the same terrain, compare runs fairly. — easy
98. **Seeded Daily Challenge (portable)** — A date-seeded challenge with identical terrain you can re-run tomorrow. — [determinism] — WOW: even single-user, today's gauntlet is reproducible and exportable. — easy
99. **Race the Ghost of Past-You** — Re-attempt a set with a replay "ghost" of your earlier self answering alongside you. — [determinism] — WOW: a racing-game ghost car for studying — bit-exact not approximated. — medium
100. **Personal Skill Tree** — Your KG re-skinned as an unlockable talent web. — [native-compute + WASM-client] — WOW: a Diablo-style talent screen for your own brain, unlock-frontier computed client-side. — medium
101. **Replay Theater with Decision Forks** — Replay any past session step-by-step, then branch off at the moment you went wrong. — [determinism] — WOW: like a chess engine's analysis board — fork the state, play the road not taken. — moonshot
102. **Branch-and-Merge Your Study Plan** — Fork your state, simulate two study orderings for a month, keep the branch that wins. — [native-compute + determinism] — WOW: plan-A and plan-B race as projected mastery curves; the winner's projection is reproducible. — moonshot
103. **Monte-Carlo Study ROI** — "Spend 30 min here → 78% chance you clear this cluster by Friday," from 10,000 simulated futures. — [native-compute] — WOW: a finance-style fan chart the moment you hover a cluster. — medium
104. **Efficient Frontier of Today** — Given 45 free minutes, the basket of KCs that buys the most long-term retention per minute. — [native-compute] — WOW: a Markowitz-style optimizer treats each review as an asset, re-solving live. — medium

## 8. Data, Sync & Portability (determinism) — "your data outlives the app"

105. **One Isomorphic Learning Core (the keystone)** — A single Rust crate — judges + FSRS + θ̂ + calibration + replay — compiled once to napi and once to WASM, the one source of truth for every number. — [determinism] — WOW: not a feature but the foundation that makes the entire determinism cluster *correct-by-construction*. — medium
106. **Conflict-Free Multi-Device Sync** — Practice offline on phone *and* laptop; reconnect and state merges with no conflicts. — [determinism] — WOW: merged θ̂/FSRS is *identical regardless of merge order* — replaying the union of events through the deterministic core is order-independent. — moonshot
107. **Replay-Verified Export** — Export your record as a self-contained artifact that re-derives every number from raw events. — [determinism] — WOW: not a dead PDF — the event log + deterministic core, so future-you re-runs it to bit-identical mastery. — medium
108. **Verifiable Proof-of-Learning** — A compact, third-party-checkable certificate that you reached a mastery threshold. — [determinism] — WOW: hand someone a small artifact and the shared core lets *them* recompute "yes, this genuinely produces θ ≥ X" — a self-hosted credential. — moonshot
109. **Two-Device Forecast Parity Badge** — Your phone and laptop show the identical forecast to the last digit. — [determinism] — WOW: a "bit-exact ✓" badge proving the number you see is the audited one. — easy
110. **Deterministic Diagnostic Snapshot (shareable, reproducible)** — Freeze your profile at a moment; reopen months later and it rebuilds bit-identically. — [determinism] — WOW: "Profile as of June 24" reopens *exactly* as it was — recomputed, not stored stale. — medium
111. **Queryable Compressed Time-Capsule** — Your multi-year event log as a tiny local blob you can back up — and query without decompressing. — [native-compute] — WOW: "everything between March and June" answers instantly from the compressed columnar form. — medium
112. **Offline Full-History Analytics Dashboard** — Rich stats computed locally, opening instantly offline. — [native-compute] — WOW: a rich analytics page that loads in one frame from a single Rust pass over the event log. — medium
113. **Deterministic Stable-Layout Export** — Export your knowledge map as a crisp image that looks identical every time. — [determinism] — WOW: server-side napi runs the *same* seeded layout solver as the client, pixel-for-pixel; no headless-browser flakiness. — medium
114. **Knowledge Graph Time-Lapse Export** — Render your year of learning as a shareable time-lapse video, entirely in the browser. — [WASM-client + determinism] — WOW: deterministic replay drives a WASM frame renderer into a faithful, reproducible "year in review." — moonshot

## 9. On-Device Intelligence & Moonshots — "compute that respects single-user, self-hosted"

115. **Local Cluster Map of My Confusions** — One button auto-groups your entire error history into named misconception clusters. — [native-compute] — WOW: mistakes resolve into themes ("these 40 are the same misunderstanding"); napi clustering over thousands of attempts returns instantly. — medium
116. **Local Vector Map of Your Corpus (the "galaxy")** — A 2D constellation where every concept/note/question is a star positioned by meaning. — [native-compute] — WOW: zoom a living galaxy — dense clusters = strengths, sparse voids = blind spots; UMAP/t-SNE via napi in seconds, not a multi-minute Python job. — moonshot
117. **Local Embedding/Similarity Dedup** — A near-duplicate concept on upload is caught on-device and offered to merge. — [WASM-client / native-compute] — WOW: "this looks 91% like a concept you already have — merge?" computed on your machine. *(Generating embeddings is the LLM step; only the offline similarity search is the Rust win.)* — medium
118. **Nearest-Confusions Recommender** — For any concept you're stuck on, surfaces the most similar things you also struggle with. — [native-compute] — WOW: "you're shaky here, and these 5 related things are shaky too — fix them together." — medium
119. **Local Re-rank for "Prepared For You"** — The teaching-team's retrieved context reordered by live mastery + recency on-device. — [native-compute] — WOW: the "prepared for you" panel feels personally curated — only the ranking is Rust; the LLM stays server-side. — medium
120. **Confusable-Concept Finder** — "You systematically mix up these two — your error pattern proves it." — [native-compute] — WOW: cluster error co-occurrence across KCs, then propose contrasts edges. *(Explanation is LLM/out-of-scope; the clustering is the Rust win.)* — medium
121. **Personal-Best Curve Fitter (your forgetting curve, measured)** — Your *actual* forgetting curve, fitted from your data, per concept. — [native-compute] — WOW: a nonlinear curve-fit: "you forget X-type material 1.4× faster than average." — medium
122. **Trajectory Compression / Highlight Reel** — A native pass extracts the handful of moments that most moved your ability into a deterministic recap. — [native-compute] — WOW: end-of-month, "your 5 breakthrough moments," reproducible from the same log. — medium
123. **Deterministic Cold-Start Profile from Priors** — Day one, your initial mastery prior over the seeded graph is computed by a deterministic, bit-exact prior-propagation pass. — [determinism] — WOW: brand-new user, no data — the map already shows a coherent "best-guess," and the first diagnosis is auditable and re-derivable. — medium
124. **Deterministic Cold-Start Plan from Priors** — Day-one, offline, a usable seeded plan from prior distributions, reproducible for later comparison. — [WASM-client + determinism] — WOW: zero history, offline — "Here's a starting 15-card session," reconstructable later to measure progress. — medium
125. **Cold-Start Prior Solver (MAP/EM)** — First use runs a fast MAP/EM over priors + graph structure + first answers → confident initial θ̂ per KC with honest bands. — [native-compute] — WOW: day-one feels like a real diagnostic, not an empty shell. — medium
126. **Deterministic Replay as a Regression-Test Oracle** — Your real event log becomes a golden-master test: any code change that alters one historical projection fails CI. — [determinism] — WOW (dev-facing): the bit-exact core makes the test a true equality assertion — the determinism investment pays itself back as unbreakable coverage. — easy

---

## Top 12 — coolest AND most vision-aligned (diagnostic profile / private teaching team / strong cold-start)

1. **Reproducible Diagnostic Profile (#41)** — the headline "where I'm wrong / where I'm long" stops being faith-based: a "recompute" button re-derives every per-KC θ̂/SE in-browser to the server's exact bits. The north-star feature becomes *falsifiable*.
2. **Digital Twin of the Learner (#18)** — your teaching team runs your brain forward 10,000× and shows a fan chart of where you'll be in a month. Turns "study more" into "here's exactly what happens if you do."
3. **What-If Time Slider (#19)** — drag 10→90 min/day and watch the curve *breathe*, thousands of futures per frame. The most physically-impossible-in-JS demo here.
4. **Joint IRT Item Calibration (#66)** — the bank calibrates itself; difficulty stops being an LLM guess and becomes measured truth via the EM pass the architecture currently forbids. Strongest "only Rust could do this."
5. **Live Full-Information CAT Engine (#67)** — every next question provably the most informative over the whole bank+posterior in <5ms; locks onto your edge in 3–4 items.
6. **Offline Pocket Tutor (#1)** — full graded loop on a plane, zero spinner, clean sync on land. The flagship for a self-hosted single-user tool.
7. **Replay Scrubber / Time Machine (#38)** — drag a timeline, watch your graph bloom from blank to today, every frame re-projected locally. See the day a misconception died.
8. **Drift Sentinel (#43)** — a watchdog proving your numbers match the server to the bit, and naming the offending event the instant they don't.
9. **Counterfactual What-If Replay (#40)** — click a stubborn past mistake, ask "what if I'd never made this?", watch the alternate trajectory recompute in ms. Embodies the evidence-first/reversible principle.
10. **Cold-Start Twin / Deterministic Cold-Start Profile (#30 / #123)** — day one, before a single answer, you're placed on the map from priors with honest bands that narrow as you practice. Serves the strong-cold-start north star.
11. **Live Calibration Conscience (#45 / #90)** — built on the calibration core *already proven bit-exact this session*: "when you felt 80% sure, you were right 62% of the time," recomputed in-browser the instant each verdict lands.
12. **Keystone Concept Detector + Frontier Map (#56 + #58)** — points at the few load-bearing concepts that unlock the most, and lights up what you're ready to learn now. The diagnostic profile made spatial and directive.

---

## Build-first pick (right after the calibration beachhead) → **Reproducible Calibration Card (#45)**

The calibration core (AUC + paired cluster-bootstrap + mulberry32) is *already proven bit-exact this session*, so the hardest technical risk is retired before you start. Compile it to WASM, put a one-click "recompute, byte-for-byte" proof on the existing calibration card: the user presses a button and watches their honesty metrics re-derive in the browser and match the server to the last bit. It **proves the WASM determinism path end-to-end** — the exact substrate the whole Trust cluster (#41/#42/#43/#44) and the offline clusters depend on — and de-risks the keystone **One Isomorphic Learning Core (#105)**. Runner-up: **Replay-Backed "Why Now?" (#52)** if you'd rather lead with FSRS than calibration.

---

## The Constellation View — how ideas combine into flagships

- **A. The Offline What-If Coach** = determinism + simulation + WASM — Isomorphic Core (#105) + What-If Slider (#19) + Counterfactual Replay (#40) + Pocket Practice (#1). On a plane, no signal, scrub a "minutes/day" slider and watch a *trustworthy* forecast breathe — the projection you see offline is provably the one the server confirms. **The thesis statement of the whole Rust bet.**
- **B. The Auditable Diagnostic** = Reproducible Profile (#41) + Verifier Badge (#42) + Drift Sentinel (#43) + "Explain This Number" (#47) + Replay-Diff (#49). Every claim carries a "recompute ✓"; every score unfolds into the events that made it; the system screams if it drifts; even algorithm upgrades show a reviewable per-event diff. The most honest object in any learning tool.
- **C. The Self-Calibrating Teaching Team** = Joint IRT (#66) + Empirical-Bayes Prior (#77) + Cold-Start Twin (#30) + Overnight Marginal-Gain Ranker (#29) + Power Analysis/VOI (#81). Day one it places you from priors; as you answer, both your item bank and ability model sharpen from real data; each night it simulates tomorrow; it always asks the question that buys the most certainty per minute.
- **D. Time Machine for Your Mind** = Replay Scrubber (#38) + Git-Diff of Your Mind (#39) + Decay Heat Field (#63) + Time-Lapse Export (#114). One timeline scrubber drives your whole graph blooming, cooling, and rewiring across your history, exportable as a year-in-review video. The most *emotionally* compelling surface.

---

## Honest Edges — what Rust does NOT unlock

Rust buys exactly three things: **CPU-bound numerics** (IRT/EM/MCMC/MIRT/Fisher/Monte-Carlo/clustering/equating), **WASM on-device + offline** execution, and **bit-exact determinism** (server≡client, reproducible). It buys **nothing** on the I/O- and model-bound half: the AI tutor's prose/hints/explanations; vision/OCR ingestion and handwriting grading; open-ended/subjective judging; LLM concept-tagging and edge proposals; copilot chat; *generating* embeddings; ordinary DB CRUD — all latency-dominated by the model endpoint or Postgres, where Rust adds ~0. Several ideas (local dedup #117, confusable-concept #120, re-rank #119) claim Rust value *only* for similarity/clustering math over vectors that **already exist** — the embedding step that creates them is an LLM call, out of scope. Rule of thumb: if the wow is "the AI said something smart," it's not a Rust feature; if the wow is "the number is instant, offline, or provably correct," it is.
