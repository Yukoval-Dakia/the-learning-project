# axis-2 Wave-0 校准验证 harness 实现计划 (YUK-461)

**Goal:** Build a READ-ONLY, REPORT-ONLY retro-validation harness — pure calibration math (ECE / forward-AUC / ICC-deff-effectiveN / Cohen's κ) + an in-memory θ̂ replay engine that faithfully re-derives production trajectories under a SRT flag-variant + one DB-reading audit script that runs the keystone gate **V-A1-fwd** — to retro-validate the already-LIVE P1 mastery engine (A1 SRT / A2 hierarchical Elo / A3 KLP, all flipped live 2026-06-19) **without flipping any flag or writing any live state**.

**Global constraints (every task obeys all four):**
- **REPORT-ONLY** — never auto-flip a flag (`SRT_ENABLED`/`HIERARCHICAL_ELO_ENABLED`/`EARLY_KLP_ENABLED` stay untouched); the audit prints a verdict, nothing more.
- **READ-ONLY** over the event log — zero writes to live state; the script only `SELECT`s.
- **FORWARD-NO-LEAKAGE** — the forward predictor uses ONLY the PRE-attempt θ̂ (`θ̂_{t−1}`) to predict `outcome_t`; `outcome_t` never forms `θ̂_{t−1}`; no in-sample fitting; the SRT design constant `d` is never re-fit on scored outcomes.
- **REUSE-NOT-DUPLICATE** — `replay.ts` imports the exact production primitives from `@/core/theta` + `@/server/mastery/*`; re-implementing any of them is a bug. The only honest faithfulness proof drives the real `updateThetaForAttempt` and compares.

**Branch:** `yuk-461-axis2-wave0-calibration-harness` off fresh `main` (HEAD `33d880b1`). **Test config:** all new tests under `vitest.unit.config.ts` (NO DB) except ONE `*.db.test.ts` fixture that proves replay-faithfulness against production. Math core stays pure so the partition holds.

---

## 0. Verified ground facts (re-checked against source 2026-06-20, line numbers current)

- **Live flags:** `SRT_ENABLED = true` (`src/core/theta.ts:234`), `HIERARCHICAL_ELO_ENABLED = true` (`:184`), `ELO_K_GLOBAL = 0.048` (`:194`), `SRT_MIN_SIGNAL = 0.15` (`:254`), `DIFFICULTY_PROXY_WEIGHT = 0.3` (`:137`), `EARLY_KLP_ENABLED = true` (`src/core/selection-signals.ts:127`).
- **Production credit loop** `updateThetaForAttempt` (`src/server/mastery/state.ts:453-736`), verbatim:
  - `knowledgeIds` = **dedup of the WHOLE `input.knowledgeIds` set** (`:457`) — both callers pass the question's full KC set. Empty → early return.
  - `calB = effectiveB(calRows[0])` (`:492`); `columnarB = calB ?? difficultyToLogitB(difficulty)` (`:495`); `bWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT` (`:500`).
  - **`b` ALWAYS includes the family delta on live attempts:** `let b = columnarB; if (input.kind && input.source) { … b = effectiveFamilyB(columnarB, familyRow); }` (`:515-531`). Both callers always pass `kind`/`source`. `effectiveFamilyB(b, null) === b`, `effectiveFamilyB(b, row) === b + row.b_delta`.
  - `effectiveThetas[i] = states[i].theta + globalOf(id)`; `globalOf` = θ_global(domain) when `HIERARCHICAL_ELO_ENABLED`, else 0 (`:600-604`). Domain via `getEffectiveDomain` (`:587`, throws on orphan → caught → `null` → θ_global 0).
  - `useSrt = SRT_ENABLED && typeof rtMs === 'number' && Number.isFinite(rtMs)` (`:628`). If `useSrt`: `d = resolveSrtTimeLimit(difficulty)`, `srt = srtOutcome(outcome===1, d, rtMs/1000)`, `credits = conjunctiveCreditsContinuous(effectiveThetas, b, srt)`. Else `credits = conjunctiveCredits(effectiveThetas, b, outcome)` (`:630-637`).
  - per KC `i`: `k = eloK(s.evidence)`; `newTheta = s.theta + k * bWeight * credits[i]` (`:649-650`).
  - global drift (flag on): per domain, `aggregateCredit = mean(domainCredits)`; re-read `lockedGlobal`; `lockedNewGlobal = lockedGlobal + ELO_K_GLOBAL * bWeight * aggregateCredit` (`:682-735`). Sequential single-user → `lockedGlobal` == pre-attempt global.
- **Single-KC degeneracy** (`theta.ts:111-130, 342-387`): `conjunctiveCredits([θ], b, o)` → `[o − p]`; `conjunctiveCreditsContinuous([θ], b, srt)` → `[srt − p]` (`ps.length <= 1` branch). Multi-KC uses conjunctive blame, NOT `o − p`.
- **`effectiveB(row)`** (`recalibration.ts:90`) = `row.b_calib ?? row.b_anchor ?? row.b ?? null`; `ItemCalibrationBRow {b,b_anchor,b_calib}` (`:83`).
- **`ABILITY_GLOBAL_KIND = 'ability_global'`** (`state.ts:53`, **module-private**; fixture hardcodes `'ability_global'`).
- **`event` table** (`schema.ts:692-736`): `id`, `action`, `subject_kind`, `subject_id` (notNull), `outcome` (nullable), `payload` (jsonb), `caused_by_event_id` (chain link), `created_at`. A `judge` event: `subject_kind='event'`, `subject_id = attempt event id`, `caused_by_event_id = attempt event id`.
- **SOLO** (`submit.ts`): `action:'review'`, `subject_kind:'question'`, `updateThetaForAttempt({ knowledgeIds: q.knowledge_ids, kind: q.kind, source: q.source, responseTimeMs: body.latency_ms })` (`:611-630`). Payload: `referenced_knowledge_ids`, `duration_ms` (when `latency_ms` is a number), nested `judge.coarse_outcome`. `auto_rate`+unsupported → throws 422 before writing (`:285`). Sibling `judge` event written iff `judgeResult !== null && judgeRoute !== null && JudgeKindZ.safeParse(judgeRoute).success` (`:551`).
- **PAPER** (`paper-submit.ts`): `action:'attempt'`, `subject_kind:'question'`. **θ̂ gate (`:591`):** `!photoOnlyUnsupported && scheduled !== null && coarseOutcome !== 'unsupported'`. `knowledgeIds: referencedKnowledgeIds`, `outcome: attemptOutcome === 'failure' ? 0 : 1`. **M5 trap:** attempt `outcome = attemptOutcome` forces `unsupported → 'failure'` (`:257`), `unsupported_judge:true` ONLY on `photoOnlyUnsupported` (`:518`). NO `duration_ms` → binary. `judge` event written iff `!photoOnlyUnsupported && invoked !== null && judgeResult !== null` (`:528`), `caused_by_event_id = attemptEventId`, payload `coarse_outcome`.
- **Audit pattern** (`audit-profile.ts:108-126`): `runCli(args): number`, `main()` sets `process.exitCode`, direct-run guard via `fileURLToPath(import.meta.url)`, `--json`. `package.json` audit scripts at lines 35-39.
- **`db`/`Db`/`Tx`** from `@/db/client`; throws at module load if `DATABASE_URL` unset. `worker.ts:29` calls `loadEnv()` BEFORE dynamic-import of `@/db/client`.
- **The cited dossier is an 11-reviewer verdict summary** — no ECE formula, no AUC double-sum, no ICC estimator, no bootstrap design, no thresholds. Only V-A1-fwd text: *"forward AUC, RT 才入 θ; ΔAUC>0.02 CI 排 0"*. All "math ground §N" citations are struck (B1).

---

## 1. Adjudication of the adversarial critique

| # | Critique | Verdict | Reason |
|---|---|---|---|
| **B1** | phantom "§1–§6" citations | ACCEPT | dossier has no such sections; thresholds are owner defaults, labeled as such + real textbook source given. |
| **B2** | single-KC loader filter corrupts trajectory | ACCEPT (resolution b) | `state.ts:457` updates the FULL KC set. Replay the FULL multi-KC update for fidelity, but SCORE only single-KC attempts. |
| **B3** | forward `b` omits family delta | ACCEPT | both callers always pass kind/source; loader reconstructs `b` via `effectiveFamilyB`, reports "family delta applied to X/N". |
| **B4** | effectiveN clusters wrong quantity | ACCEPT reframe; REJECT residual-ICC | bootstrap CI is the decision; effectiveN/deff is a reported coarse floor via ICC(1,1) over per-KC labels. Residual-ICC has no textbook known-answer → rejected (#1 math-correctness rule). |
| **M1** | discard-and-redraw biases CI | ACCEPT | count degenerate replicates, do NOT backfill; report fraction; >5% → INSUFFICIENT. |
| **M2** | fixture pins only easy case | ACCEPT | fixture includes a multi-KC attempt + a non-zero family delta. |
| **M3** | pre-attempt global vs re-read lockedGlobal | ACCEPT (assert equality) | sequential single-user → coincide; fixture asserts θ_global equality. |
| **M4** | split N on RT-presence | ACCEPT | RT-less attempt → identical prediction in both variants → 0 ΔAUC contribution; gate keys on N_with_rt. |
| **M5** | exclusion must match both θ̂-skip guards; forced-'failure' trap | ACCEPT + STRENGTHEN | foldable iff a sibling `judge` event (`caused_by_event_id = attempt.id`) has `coarse_outcome !== 'unsupported'` — mirrors production gate, robust to forced-outcome write. |
| **m1** | equal-count edges non-partitioning | ACCEPT (doc) | edges are realized quantiles (cosmetic); ECE is edge-independent. |
| **m2** | κ length-mismatch contradiction | ACCEPT | throw on length mismatch; remove `'length-mismatch'` from reason enum. |
| **m3** | O(n²) AUC × B hangs on large log | ACCEPT (guard) | pooled N>5000 → reduce B with reported warning; no rank-form AUC (YAGNI). |
| **m4** | null ICC → NaN | ACCEPT | effectiveNFromClusters → deff=1, effectiveN=N when ICC null; evaluateVA1Forward handles icc===null. |
| **m5** | B2/B3 dissolve follow-ups | ACCEPT | only residual: multi-KC forward scoring (filed, out of Wave-0). |

---

## 2. File structure

```
src/server/calibration/
  ece.ts / ece.unit.test.ts
  auc.ts / auc.unit.test.ts
  design-effect.ts / design-effect.unit.test.ts
  kappa.ts / kappa.unit.test.ts
  rng.ts / rng.unit.test.ts
  replay.ts / replay.unit.test.ts
  replay.fixture.db.test.ts   # ⚠ ONLY db test
  bootstrap.ts / bootstrap.unit.test.ts
  v-a1-fwd.ts / v-a1-fwd.unit.test.ts
  index.ts                    # barrel — pure surface only (NOT loader)
scripts/audit-calibration.ts  # thin DB loader + V-A1-fwd + report (REPORT-ONLY)
package.json                  # "audit:calibration": "tsx scripts/audit-calibration.ts"
```

**Partition:** any file importing `@/db/client`/`postgres`/`drizzle`/`PgBoss` must be `*.db.test.ts` → `replay.fixture.db.test.ts` is the ONLY DB test.

---

## 3. Task breakdown (TDD: hand-computed test FIRST → red → impl → green)

Tasks 1–5 (pure math + RNG) independent. Task 6 (replay) depends only on `@/core/theta`. Task 7 (fixture) ← 6. Task 8 (bootstrap) ← 2. Task 9 (gate) ← 6+8. Task 10 (script) ← 9. Task 11 = barrel + package.json.

### TASK 1 — `ece.ts` (Naeini 2015; Guo 2017)
`ece(predictions, labels, {binning='equal-count', k=10})` → per bin: conf=mean(p), acc=mean(y), gap=|acc−conf|; ECE=Σ(n_b/N)·gap_b. equal-width binIndex=min(K−1, floor(p·K)). N=0 → {ece:0,n:0,bins:[]}. Length mismatch → throw. Anchor: N=10,K=2,equal-width, preds [0.2,0.3,0.4,0.1,0.3,0.6,0.7,0.8,0.9,0.7], labels [0,0,1,0,0,1,0,1,1,1] → ece≈0.06.

### TASK 2 — `auc.ts` (Hanley & McNeil 1982, Mann–Whitney U)
`forwardAuc(scores, labels)` → AUC = (Σ_{i∈P}Σ_{j∈N} S(p_i,q_j))/(n1·n0), S=1/0.5/0 for >/=/<. n1==0&&n0==0 → null 'empty'; n1==0 → 'no-positives'; n0==0 → 'no-negatives'. Length mismatch → throw. Anchor: [0.9,0.6,0.6,0.7,0.5]/[1,1,1,0,0] → 4/6≈0.6667. Tie: P={0.5,0.8},N={0.5,0.2} → 3.5/4=0.875.

### TASK 3 — `design-effect.ts` (Shrout & Fleiss 1979 ICC(1,1); Kish 1965 deff)
`iccOneWayAnova(clusters)`, `designEffect(m,icc)=1+(m−1)·icc`, `effectiveNFromClusters(clusters)`. MSB=Σn_i(ȳ_i−ȳ)²/(k−1); MSW=ΣΣ(y_ij−ȳ_i)²/(N−k); m0=(N−Σn_i²/N)/(k−1); ICC=(MSB−MSW)/(MSB+(m0−1)MSW) clamp [0,1]. all-singleton/single-cluster/zero-variance/empty → flagged, deff=1, NEVER NaN. Anchor: [[1,1,0],[0,0,0]] → icc=0.5, deff=2, effectiveN=3.

### TASK 4 — `kappa.ts` (Cohen 1960)
`cohenKappa(r1, r2)` → p_o=Σn_ii/N; p_e=Σ(row_i/N)(col_i/N); κ=(p_o−p_e)/(1−p_e). p_e==1 → null 'no-variance'; N==0 → null 'empty'; length mismatch → throw. Anchor: confusion [[8,2],[1,9]] (N=20) → po=0.85, pe=0.50, κ=0.70.

### TASK 5 — `rng.ts`
`mulberry32(seed)` standard; same seed → identical sequence, output [0,1).

### TASK 6 — `replay.ts` (PURE; imports real `@/core/theta` primitives)
`replayTheta(orderedAttempts, {srtEnabled})` mirrors `state.ts:453-736`: full multi-KC update, emit forward step BEFORE any write (no-leakage), score only `scoredKnowledgeId !== null`. `HIERARCHICAL_ELO_ENABLED` read as live const (fixed for both variants). Anchors: single binary correct cold no-domain → predictedP=σ(0)=0.5, θ_KC→0.2; second attempt pre θ=0.2 → σ(0.2); SRT slow-correct < binary; A2 global inheritance 0.024; bWeight=0.3 → 0.06; multi-KC step not forward-scorable but advances θ_KC.

### TASK 7 — `replay.fixture.db.test.ts` (ONLY DB test)
Byte-identity vs real `updateThetaForAttempt` under live flags. Seed kc1/kc2 with domain dom1; q1 single-KC + item_calibration b + non-zero family b_delta (M2/B3); q2 multi-KC [kc1,kc2] (M2 conjunctive). Sequence mixes single/multi-KC, with/without RT. Production: call updateThetaForAttempt per attempt, read mastery_state θ for kc1/kc2/dom1 ('ability_global'). Replay: matching ReplayAttempt[], assert byte-identity (1e-10) per step + θ_global equality (M3). Binary-variant guard via vi.mock SRT_ENABLED=false.

### TASK 8 — `bootstrap.ts` (Field & Welsh 2007; Cameron et al. 2008 — paired whole-KC)
`deltaAucClusterBootstrap(clusters, {b=2000, rng})`. Point: pool all → forwardAuc per variant → pointDelta. Bootstrap: resample K clusters WITH REPLACEMENT (injected rng), pool, compute aucSrt*/aucBinary* on the SAME resampled multiset (pairing mandatory), Δ*=diff. Degenerate replicate (one-class pool) → count + skip, NO redraw (M1). CI percentile [2.5,97.5]; excludesZero=ciLo>0. m3 guard: pooled N>5000 → reduce b.

### TASK 9 — `v-a1-fwd.ts` (gate + assembly + report — PURE)
`assembleForwardClusters(attemptsByKc)`: per KC replay both variants, take steps where `scoredKnowledgeId !== null && hasRt` (M4). `evaluateVA1Forward(clusters, cfg, rng)`: pool → nWithRt/n1/n0/kClusters; class floor (n1==0||n0==0 → INSUFFICIENT); effectiveNFromClusters → deff/effectiveN (coarse floor, B4); power floor (effectiveN<100 || kClusters<10 → INSUFFICIENT); bootstrap; degenerate guard (>5% → INSUFFICIENT); PASS iff pointDelta>0.02 && ci.lo>0 else FAIL. `formatReport` prints verdict/ΔAUC/AUCs/CI/B/degenerateFraction/nTotal/nWithRt/n1/n0/kClusters/deff/effectiveN + caveats. Synthetic anchors: PASS (≥15 KC × ≥10 RT signal), INSUFFICIENT (thin / one-class / RT-less-ample), FAIL (null signal ample RT), determinism.

### TASK 10 — `scripts/audit-calibration.ts` (REPORT-ONLY thin seam)
`loadEnv()` before `@/db/client` import. `loadAttempts(db)`: query event `action IN ('review','attempt') AND subject_kind='question'` ORDER BY created_at ASC, id ASC. **Foldability gate (M5):** include iff a sibling `judge` event (`action='judge'`, `caused_by_event_id = attempt.id`) has `coarse_outcome !== 'unsupported'`. outcome success→1/failure→0/drop partial (report dropped count). responseTimeMs = payload.duration_ms (solo). knowledgeIds = payload.referenced_knowledge_ids ?? question.knowledge_ids (full set). scoredKnowledgeId = single KC iff question.knowledge_ids.length===1. b reconstructed via effectiveB→columnarB→effectiveFamilyB (B3), count familyDeltaApplied. domainByKc via getEffectiveDomain try/catch null. Group into Map<scoredKnowledgeId, ReplayAttempt[]> = time-ordered list of all attempts whose knowledgeIds include that KC. Exit: PASS→0, INSUFFICIENT→0 (provisional), FAIL→non-zero. Never writes.

### TASK 11 — `index.ts` + `package.json`
Barrel re-exports the PURE surface (NOT the loader). package.json after audit:relations: `"audit:calibration": "tsx scripts/audit-calibration.ts"`. NOT in `pnpm test` chain (manual report-only, mirrors audit:relations). One-line CLAUDE.md Commands entry.

---

## 4. Local gate per task
Per pure task: `pnpm typecheck`; `biome check --write <file>`; `pnpm vitest run --config vitest.unit.config.ts <test>`. Task 7: `pnpm vitest run --config vitest.db.config.ts replay.fixture.db.test.ts`. Pre-hand-off: typecheck, lint, audit:partition, test:unit, test:db, build.

---

## 5. Divergence flags (surface in PR description)
1. Bootstrap = paired whole-KC cluster bootstrap (Field & Welsh 2007; Cameron 2008), NOT i.i.d. row.
2. Decision = cluster bootstrap CI; effectiveN=N/deff (ICC(1,1) over per-KC labels) is a reported coarse floor only; floor 100 + minKcClusters 10 owner-chosen.
3. Forward b = production's full effectiveFamilyB(columnarB, familyRow) (B3); report "family delta applied to X/N".
4. SRT d fixed (resolveSrtTimeLimit), never re-fit on scored outcomes.
5. A2 (HIERARCHICAL_ELO_ENABLED) held LIVE as fixed background for both variants.
6. Scope = single-KC forward scoring; multi-KC replayed for fidelity but not forward-scored; N keys on RT-bearing single-KC attempts (M4).
7. 'partial' outcomes dropped from forward scoring; count reported.
8. All "math dossier §N" provenance struck (B1).

---

## 6. Linear capture
Single residual follow-up: **Multi-KC forward scoring for V-A1-fwd** — extend the gate to forward-predict multi-KC (conjunctive) attempt outcomes. Currently multi-KC attempts are replayed for fidelity but excluded from the scored forward pool. (Out of read-only Wave-0 scope.)

(No Linear issue for the harness itself — it is YUK-461.)
