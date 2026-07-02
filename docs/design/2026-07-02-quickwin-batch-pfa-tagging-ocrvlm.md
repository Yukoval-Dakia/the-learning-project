# 快赢批设计 spec — pfa / tagging / ocr-vlm（打磨 worklist #2 #3 #11）

> **来源**：`docs/design/2026-07-02-project-logic-master-register.md` 的 14-item grounded worklist，owner 拍「先扫快赢批（止血）」。
> **方法论**：3 个 Sonnet 设计 agent（code-ground @ `685b2c27`，diff 级修案）+ 1 个 Opus 对抗审（workflow `wu2shsiz8`）。对抗裁定：**tagging SOUND · ocr-vlm SOUND · pfa NEEDS-AMENDMENT（修法对，注释文本 + retune 推荐两处修正）**——修正已折入下方「最终修正案」，实现以修正案为准。
> **实施形态**：3 个独立 PR（pfa=core 数学 · tagging=ingestion 事件 · ocr-vlm=UI+ingestion），各走 gate + 独立 review，不 auto-merge。

---

## 最终修正案（对抗审折入后，实现以此为准）

### pfa（spec 正文见 §A，以下条目覆盖 spec 原文）

1. **注释重写不得写 "permanent / nor is planned"**——现注释 `pfa.ts:40-42` 是一张 forward-looking owner IOU（「refit 接通后这些常量应被替换为 per-KC / 全局标定值」），核实为假的只有「job 已存在」半句（`recalibration_nightly.ts` 只 refit b，零 γ/ρ 提及）。无条件可修的诚实版本 =「job 不存在、YUK-361 已建部分只 refit b、在 owner 另行裁决前按 owner-fixed const 对待」。是否**正式撤销 IOU** = owner 决策点 DP-α。
2. **删除两处伪引用**：(i) "ADR-0042 explicit-weights"——该 ADR 全文无此 doctrine（其「权重」指 LLM 编排层 per-candidate weights）；类比 `ELO_K_GLOBAL`/`DIFFICULTY_PROXY_WEIGHT`（`theta.ts:162,219`）成立但不得挂 ADR-0042 名。(ii) "Per ADR-0035's own verdict"——ADR-0035 的 n=1 不可辨识裁定针对软轨 a/c/slip/guess，从未判过 γ/ρ；可作 doctrine 外推但须写明是外推。
3. **retune 默认推荐降为 Candidate A（gate-only）**：β≈3 在今日锚表（`fixed-anchor.ts` 上限 +2）之外，量表内最坏 K(2)=8→6，改善缩水；A 已关掉唯一被证实的 live defect（b）。B（γ=0.5/ρ=−0.25）作为 owner 可选 = DP-β；**选 B 必须**同步调整 `stream-store.db.test.ts:150`/`stream.db.test.ts:138`/`stream-softmax.db.test.ts:148` 共享 fixture（s=3/f=2 的 σ(0.8)=0.690 → σ(1.0)=0.731 跨 0.7，语义翻转，今天不红纯属运气）。
4. **新常量 docblock 须记录 borrow-branch 交互**：borrow 合成 entry `evidence_count:0`（`state.ts:519`），今天 dark（两 flag off）；flag 翻转后 easy 锚 borrowed prereq 今天能过 prereq 闸、加 floor 后永远过不了——大概率是想要的保守行为，但须显式记录（与 `kg-borrowing` unit 的交互）。
5. **穷尽列举补漏**：`poly-sigmoid-swap.unit.test.ts:10` 也 import 生产 `PFA_GAMMA/PFA_RHO`（自洽,不受影响）。

### tagging（spec 正文见 §B）

- SOUND 按写。**test plan 加一条 fold-parity 测试**（对抗审建议）：MATCH 写事件后对 matched KC 跑 `projectKnowledgeNode`/parity，断言行 byte-identical——把「reducer 忽略未知 action」这条新承重不变量钉死（YUK-471 W1 PR-B projection-SoT flip 在飞，最贵回归是 fold 腐蚀）。
- D1-D5 按 spec 推荐执行（每 MATCH 都发 / best-effort catch / 穿 sourceRef / 不动 PROPOSE / emit-only）。

### ocr-vlm（spec 正文见 §C）

- SOUND 按写。实现者两注（对抗审）：(1) `tencent_ocr_extract.ts:396` 已有 `warnings.push(...structure.warnings)` merge 点——等价更小 diff 是在 fallback structure 字面量写 `warnings: glmFallbackWarnings`；两方案任选一，**勿双重折入**。(2) 新 render arm 是 event-type 无关的（有意通用），在 arm 注释点明。
- 决策点按 spec 推荐：Option A 内联 `.sse-warn` · landing 视图后补（**落 Linear follow-up**）· `；` join。

---

# §A — pfa-plearn-formula spec（原文）

# DESIGN SPEC — `pfa-plearn-formula` (polish order #2)

Working tree verified at `685b2c27` (origin/main). All line numbers re-verified live, not trusted from the register.

## 1. CURRENT BEHAVIOR

**Formula** (`src/core/pfa.ts:80-89`):
```ts
export function pfaLogit(beta, gamma, rho, success, fail): number {
  return gamma * success + rho * fail - beta;
}
```
with module consts `PFA_GAMMA = 0.4` (`pfa.ts:49`), `PFA_RHO = -0.2` (`pfa.ts:50`). Consumed live (no copies) by:
- `src/server/mastery/state.ts:349` — `getMasteryProjection` (the single display/AI-facing mastery read).
- `src/server/simulator/forward-sampler.ts:382-383` — DGP defaults for the calibration simulator.
- `src/capabilities/practice/server/learnable-frontier.ts:62` — `MASTERED_PL_THRESHOLD = 0.7`, consumed at `learnable-frontier.ts:221-222` (`pL(kc) >= MASTERED_PL_THRESHOLD`) and, separately, `src/capabilities/knowledge/server/frontier-read.ts:104-105` (`isMastered`, an independent re-implementation of the same check).

**Defect (a) — false comment.** Four places in `pfa.ts`/`state.ts` assert a "pending PFA nightly refit (YUK-361)" job that would eventually replace these hardcoded consts:
- `pfa.ts:24-26` (file header)
- `pfa.ts:37-47` (γ/ρ docblock)
- `pfa.ts:119-125` (`LOW_CONFIDENCE_SE_THRESHOLD` docblock)
- `state.ts:285-288` (`getMasteryProjection` docblock)

Verified by exhaustive grep: `recalibration_nightly.ts` (`src/capabilities/practice/jobs/recalibration_nightly.ts`) is the only YUK-361 nightly-refit job that exists, and it refits **item difficulty** (`b`/`b_calib` via active-PPI/AIPW), never `PFA_GAMMA`/`PFA_RHO`. No job, script, or call site anywhere touches these two consts. The comment is simply false.

**Defect (b) — premature cold-start mastery-flip.** At `beta=0` (no `item_calibration` anchor — the common cold-start case), verified numerically:

| corrects (fail=0) | logit | p(L) | crosses 0.7? |
|---|---|---|---|
| 1 | 0.40 | 0.599 | no |
| 2 | 0.80 | 0.690 | no |
| **3** | **1.20** | **0.7685** | **yes** |

3 consecutive correct answers flips a KC to "mastered" per `MASTERED_PL_THRESHOLD=0.7`. `learnable-frontier.ts:221` (`if (pL(frontierKc) >= MASTERED_PL_THRESHOLD) continue`) then drops it from the frontier pool as self-mastered, and `learnable-frontier.ts:222` treats it as satisfying any dependent's prereq — on 3 lucky answers, with **zero regard for how little evidence that is** (`evidence_count=3`).

**Defect (c) — beta≈3 starvation.** Symmetrically, at a hard anchored prereq (`beta≈3`), the same γ=0.4 requires:

| corrects (fail=0) | logit | p(L) | crosses 0.7? |
|---|---|---|---|
| 9 | 0.60 | 0.646 | no |
| **10** | **1.00** | **0.7311** | **yes** |

10 clean corrects (zero fails tolerated) before the KC unlocks its downstream subtree via `learnable-frontier.ts:222`'s `allPrereqsMastered` check — confirmed exactly matching the register's claim.

**Load-bearing verification — this is not a display-only defect.** `learnable-frontier.ts:221-222` is the actual gate that removes/keeps KCs in `composeDailyStream`'s candidate pool (via `stream-store.ts:205`'s `learnableFrontier(db)` call) and in `frontier_fill_nightly.ts` / `frontier-read.ts`'s FrontierRail banner. This is a real scheduling/pool-membership decision, not merely a number shown on screen.

**A decisive, previously-unverified finding: the existing `low_confidence`/SE flag cannot serve as a substitute gate as-is.** `theta_precision` starts at 1 (SE=1.0, `state.ts:829`) and accumulates Fisher information `p·(1-p)` per answer (`theta.ts:579-606`). Simulating the exact cold-start trajectory (θ starts 0, `kCold=0.4`, `b=0`):

| after answer | precision | SE | `low_confidence` (SE≥1.0) |
|---|---|---|---|
| 1 | 1.25 | 0.894 | **false** |
| 2 | 1.50 | 0.817 | false |
| 3 | 1.74 | 0.758 | false |

`low_confidence` is already `false` after the **first** answer — it is tuned for CI-band presentation, not for "is this frontier-pool decision evidence-backed." (Separately confirmed: `learnable-frontier.ts` never reads `low_confidence`/`theta_se` at all today — this matches the master register's own note on the *adjacent* `kg-borrowing` unit that B3's gate reads only `.mastery`.)

**No blast radius from beta itself:** the current `bucketToLogit` fixed-anchor scale (`src/server/mastery/fixed-anchor.ts:49-55`) only spans `[-2, +2]`; `beta≈3` in the register's illustrative example would require a data-driven `b_calib` outside that range — out of this unit's scope (owned by `difficulty-anchor-cluster`), noted only for completeness.

## 2. PROPOSED FIX

### Part 1 — FREE: comment correction (unconditional, do regardless of Part 2's decision)

`src/core/pfa.ts:24-26` (file header) — replace the false "pending refit" claim:
```ts
// OWNER-FIXED PRIORS (ADR-0042 explicit-weights) — gamma/rho are permanent, code-reviewed
// module consts, NOT a placeholder pending a refit job. No PFA nightly-refit job exists
// anywhere in this codebase or is planned: recalibration_nightly.ts (YUK-361 Phase 6)
// refits item difficulty (b/b_calib) via active-PPI/AIPW — it never touches gamma/rho.
// Per ADR-0035's own verdict, classic PFA's cross-student logistic-regression refit of
// γ/ρ (Pavlik/Cen/Koedinger 2009) is structurally inapplicable at n=1 (no cohort to
// regress over) — the n=1 red line vetoes any runtime-persisted online fit of these
// coefficients. They are structural, cross-learner-scoped coefficients (like the PFA
// equation SHAPE itself), not a per-user latent like θ̂ — same footing as
// ELO_K_GLOBAL / DIFFICULTY_PROXY_WEIGHT / RECALIBRATION_MIN_LABELS. A retune only
// happens via a reviewed PR with a stated reason (see the magnitude note below), never
// an automated nightly job.
```

`pfa.ts:37-47` (γ/ρ docblock) — replace "PHASE-DEFERRED... 待 PFA nightly refit" framing with an explanation of what these values are and what would trigger a future change (see exact text under Part 2 below, since the numbers depend on the owner's decision).

`pfa.ts:119-125` (`LOW_CONFIDENCE_SE_THRESHOLD`) — same false claim, independent of γ/ρ:
```ts
/**
 * Low-confidence 阈值（ADR-0035 confidence-interval / low-confidence 呈现）:
 * θ̂ 的标准误 ≥ 此值时，点估计不可信，呈现应展示 CI 带而非裸点。
 *
 * Owner-fixed presentation const (not pending any refit job — see pfa.ts file header).
 * 1.0 = SE at default cold-start precision (precision=1, "几乎没证据"). Retune this only
 * if the CI-band presentation itself needs recalibrating; it is unrelated to γ/ρ and
 * unrelated to frontier-pool gating (see FRONTIER_MASTERY_MIN_EVIDENCE in
 * learnable-frontier.ts for that separate concern — this SE threshold crosses to
 * "confident" after just ~1 answer at β=0, so it is NOT a substitute evidence gate).
 */
```

`src/server/mastery/state.ts:285-288` — replace:
```
 *   the underlying ability state. The PFA γ/ρ coefficients are PHASE-DEFERRED
 *   hardcoded defaults pending nightly-refit statistical verification (YUK-361,
 *   see src/core/pfa.ts).
```
with:
```
 *   the underlying ability state. The PFA γ/ρ coefficients are owner-fixed, permanent
 *   module consts (ADR-0042 explicit-weights) — see src/core/pfa.ts for why no refit
 *   job exists or is planned for them.
```

### Part 2 — BOUNDED: fixing defects (b) and (c)

**Key scientific finding (drives the recommendation): γ alone cannot fix both defects, because both failure points move in lockstep with γ.** Let `K(β)` = corrects needed to cross `MASTERED_PL_THRESHOLD` at difficulty β. `K(β) = ceil((0.8473+β)/γ)`. Raising γ to shrink `K(3)` (fix defect c) *proportionally shrinks* `K(0)` too (worsens defect b):

| γ (ρ = −γ/2) | K(β=0) — corrects to falsely flip | K(β=3) — corrects to unlock hard prereq |
|---|---|---|
| 0.4 (current) | 3 | 10 |
| 0.45 | 2 | 9 |
| 0.5 | 2 | 8 |
| 0.6 | 2 | 7 |
| 0.7 | 2 | 6 |

Pure magnitude retuning is therefore **not sufficient** to fix defect (b) without an independent structural gate — this is exactly the case for the prompt's alternative: **gate the frontier-pool "mastered enough" decision on evidence sufficiency, not on p(L) magnitude alone.** Evidence-count is already computed and exposed on `MasteryProjection.evidence_count` (`state.ts:304`) — no new query, no schema change.

**Recommended combined fix:**

**(i) Evidence-count floor in `src/capabilities/practice/server/learnable-frontier.ts`** — add, next to `MASTERED_PL_THRESHOLD` (after line 62):
```ts
/**
 * Minimum evidence_count required, ALONGSIDE p(L) ≥ MASTERED_PL_THRESHOLD, before a KC
 * counts as "mastered enough" to leave the frontier pool / satisfy a downstream prereq.
 *
 * p(L) alone crosses 0.7 after 3 consecutive corrects at β=0 (σ(0.4·3)=0.7685) — a real
 * bug: a KC could be declared mastered on THREE lucky answers. Gating on evidence_count
 * (not the existing low_confidence/theta_se flag, which is already false after just ONE
 * answer at β=0 — see docs/design/<this-spec>) directly closes the gap without touching
 * γ/ρ. 4 matches the codebase's existing cold-start-window convention (theta.ts
 * coldStartN).
 */
export const FRONTIER_MASTERY_MIN_EVIDENCE = 4;

/** A KC counts as "mastered enough" for frontier purposes iff BOTH the p(L) point
 *  estimate clears the threshold AND enough evidence has accumulated to trust it. */
export function isMasteredForFrontier(mastery: number, evidenceCount: number): boolean {
  return mastery >= MASTERED_PL_THRESHOLD && evidenceCount >= FRONTIER_MASTERY_MIN_EVIDENCE;
}
```
Then at `learnable-frontier.ts:214-223`, replace:
```ts
  const projection = await getMasteryProjection(db as Db, [...allKcs]);
  const pL = (kc: string): number => projection.get(kc)?.mastery ?? COLD_START_PL;
  ...
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    if (pL(frontierKc) >= MASTERED_PL_THRESHOLD) continue; // self already mastered → skip.
    const allPrereqsMastered = prereqKcs.every((p) => pL(p) >= MASTERED_PL_THRESHOLD);
```
with:
```ts
  const projection = await getMasteryProjection(db as Db, [...allKcs]);
  const pL = (kc: string): number => projection.get(kc)?.mastery ?? COLD_START_PL;
  const evidenceOf = (kc: string): number => projection.get(kc)?.evidence_count ?? 0;
  const masteredEnough = (kc: string): boolean => isMasteredForFrontier(pL(kc), evidenceOf(kc));
  ...
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    if (masteredEnough(frontierKc)) continue; // self already mastered → skip.
    const allPrereqsMastered = prereqKcs.every((p) => masteredEnough(p));
```

**(ii) Same predicate in `src/capabilities/knowledge/server/frontier-read.ts`** (the only *other* direct consumer of `MASTERED_PL_THRESHOLD` — confirmed by exhaustive grep; `stream-store.ts` and `frontier_fill_nightly.ts` only call the `learnableFrontier(Resolved)` wrapper and inherit the fix automatically). At `frontier-read.ts:23-25` import `isMasteredForFrontier` alongside `MASTERED_PL_THRESHOLD`; replace `frontier-read.ts:104-105`:
```ts
function isMastered(mastery: number | null | undefined): boolean {
  return typeof mastery === 'number' && mastery >= MASTERED_PL_THRESHOLD;
}
```
with:
```ts
function isMastered(entry: { mastery: number | null; evidence_count: number } | undefined): boolean {
  return typeof entry?.mastery === 'number' && isMasteredForFrontier(entry.mastery, entry.evidence_count);
}
```
and its call site `frontier-read.ts:247`:
```ts
const proposeFinal = proposeIds.filter((id) => !isMastered(projection.get(id)));
```

**(iii) γ/ρ magnitude retune** — now *safe* to raise γ (the floor gate independently protects defect b regardless of γ), giving three bounded candidates for defect (c):

| Candidate | γ | ρ | K(β=0) raw / gated | L(β=3) | Trade-off |
|---|---|---|---|---|---|
| A — gate-only, no retune | 0.4 (unchanged) | −0.2 (unchanged) | 3 / **4 (gated)** | 10 (unchanged) | Zero new numbers to defend; defect (c) fully deferred/accepted as-is. |
| **B — recommended** | **0.5** | **−0.25** | 2 / 4 (gated) | **8** (−20%) | Modest, keeps 2:1 γ:ρ ratio; meaningfully eases hard-prereq starvation without a big unjustified jump. |
| C — assertive | 0.6 | −0.3 | 2 / 4 (gated) | 7 (−30%) | Bigger cut to (c); further from the "canonical explicit-weights exemplar" ADR-0042 already cites by value. |

Literature note (checked directly, not from memory): Pavlik/Cen/Koedinger (2009) fit γ/ρ per-skill via cross-student logistic regression — the paper reports no portable universal magnitude (values are corpus/skill-grain dependent by construction), so literature cannot hand us a "correct" absolute number for a fixed n=1 default. What the literature *does* support, and what all three candidates preserve, is the qualitative structure already coded here: γ>0>ρ, and `|ρ| < γ` (failure carries less diagnostic weight than success) — a convention also used in the one worked pedagogical example found (γ=0.2/ρ=0.1, same 2:1 ratio). This is why the recommendation is a same-ratio bounded nudge, not a reach for a "literature-derived" absolute number that doesn't exist.

Edit at `pfa.ts:49-50`:
```ts
export const PFA_GAMMA = 0.5;  // was 0.4
export const PFA_RHO = -0.25;  // was -0.2
```
plus rewritten docblock at `pfa.ts:37-47` explaining the retune reason, the new values, and — critically — what would trigger a *future* change (real attempt-data showing the β distribution/threshold-crossing behaves systematically unlike this analysis assumed, or `difficulty-anchor-cluster` changing how β itself is derived) — explicitly **not** "a single user wants to feel more/less mastered," which is `MASTERED_PL_THRESHOLD`'s or the evidence floor's knob, not γ/ρ's.

## 3. DECISION POINTS

1. **Is the evidence-count floor gate in scope for this unit, or should it be deferred to `learnable-frontier-gate` (#4)?**
   Both units touch `learnable-frontier.ts`'s threshold logic, but this unit's own anchor list explicitly includes "the 0.7 threshold shared with learnable-frontier-gate," and the confirmed defect (b) — premature pool-drop — cannot be closed without this change. Unit #4's own target-shape (composer-path overflow logging, documenting the 3 thresholds together, resolving 0.67/0.7 cross-surface) does not claim this fix.
   **Recommend: in scope here** — it's a 2-file, ~15-line, additive change directly required to close (b); flag it for the #4 spec author to be aware of when they touch the same file next.

2. **Floor value for `FRONTIER_MASTERY_MIN_EVIDENCE`.**
   Options: 3 (weakest, still blocks the literal defect since 3 is now `<` the check... actually 3 would NOT block it — reject), 4, 5, 6.
   **Recommend: 4** — reuses the codebase's existing cold-start-window convention (`theta.ts` `coldStartN=4`), and non-disruptively matches the existing `learnable-frontier.db.test.ts` `setMastered` helper's `success_count=4` (zero regression in that anchor).

3. **γ/ρ candidate (A / B / C above).**
   **Recommend: B (γ=0.5, ρ=−0.25)** — meaningful, bounded improvement to defect (c) (10→8 clean corrects), same γ:ρ ratio as today, smallest jump that's not purely cosmetic. Candidate A (no retune) is defensible if the owner wants zero new numbers this cycle and is fine deferring (c) fully; Candidate C is defensible if the owner weights (c) more heavily than "smallest sufficient change."

4. **Should `FRONTIER_MASTERY_MIN_EVIDENCE` also apply on the *prereq* side vs. just the *self* side of the frontier gate?**
   The proposed diff applies it uniformly (both `frontierKc` self-check and every `prereqKcs` check use the same `masteredEnough` predicate) — this is the only internally-consistent option once evidence-gating is adopted at all (a prereq "mastered" on 3 lucky answers is exactly as unreliable a gate-satisfier as a self-KC dropped from the pool on 3 lucky answers). Flagging only because it slightly *increases* defect (c)'s current 10-correct requirement in principle (evidence_count keeps pace with success_count in the all-success scenario, so it's non-binding here — floor=4 ≤ 8/10 in every candidate — but would bind if a real learner's fail-heavy path let success_count lag evidence_count... it can't, since `evidence_count = success_count + fail_count ≥ success_count` always). **Recommend: yes, uniform** — no real downside found.

## 4. TEST PLAN

**Unit partition** (`pnpm vitest run --config vitest.unit.config.ts ...`):
- `src/core/pfa.test.ts` — no changes needed to existing assertions (all are relational/monotonicity checks or the one literal-argument formula test at line ~27, none pin `PFA_GAMMA`/`PFA_RHO`'s current numeric value). Add one new case:
  - `it('β≈3 hard prereq needs L clean corrects to cross MASTERED_PL_THRESHOLD (defect-c regression)')`: assert `pLearned(3, PFA_GAMMA, PFA_RHO, L-1, 0) < 0.7` and `pLearned(3, PFA_GAMMA, PFA_RHO, L, 0) >= 0.7` for whichever `L` the chosen candidate implies (L=8 for Candidate B).
- No changes required in `src/core/poly-exp-parity.unit.test.ts` / `src/server/calibration/wasm-parity.unit.test.ts` — verified these hardcode their own **local, unimported** `PFA_GAMMA=0.4`/`PFA_RHO=-0.2` literals purely to synthesize a realistic logit-input stress grid for bit-parity fuzzing of `polyExp`/`polySigmoid`; they don't assert anything about the production constants and are unaffected by this change.

**DB partition** (`pnpm vitest run --config vitest.db.config.ts ...`):
- `src/capabilities/practice/server/learnable-frontier.db.test.ts`: add
  - `it('(l) evidence-count floor: 3 clean corrects at β=0 cross p(L)≥0.7 but are NOT mastered-enough — prereq role')`: seed prereq `p1`(success=3, fail=0, evidence=3) → `F`; assert `F` is gated OUT (not surfaced) despite `p1`'s raw p(L)=0.7685≥0.7.
  - `it('(m) evidence-count floor — self role: F itself with success=3 still surfaces as its own frontier candidate')`: F has success=3/fail=0/evidence=3 and a fully-mastered prereq; assert F IS surfaced (not skipped as "self already mastered").
  - `it('(n) at evidence_count=4 the same success streak now counts as mastered-enough')`: companion case pinning the floor boundary (continuity with the existing `setMastered` helper, unchanged).
  - Update the file's header comment (lines 1-4) and `setMastered`'s inline math comment to reflect the new γ/ρ values if Candidate B/C is chosen.
- `src/capabilities/knowledge/server/frontier-read.db.test.ts`: extend the existing `it('PROPOSE: a self-mastered candidate is never suggested', ...)` block (~line 159) with a sibling case at `evidence_count=3` confirming the candidate is **still suggested** (floor not yet met), to pin the `isMastered`/`isMasteredForFrontier` change in `frontier-read.ts`.

**Regression anchors to explicitly re-run (not just trust CI):**
- `src/server/mastery/state.db.test.ts` — all assertions compute expected values via live `pLearned(..., PFA_GAMMA, PFA_RHO, ...)` imports, not hardcoded literals; confirm they still pass post-retune (should, by construction) as a sanity check, not because they're expected to need edits.
- `src/server/simulator/forward-sampler.unit.test.ts` — same self-consistent-import pattern; re-run to confirm.
- `pnpm typecheck`, `pnpm lint`, `pnpm audit:draft-status` (unaffected but part of standard pre-PR gate), full `pnpm test`.
- Optional, non-blocking: re-run `pnpm audit:calibration` (report-only, never flips a flag) post-merge to see if the γ/ρ change visibly shifts the forward-AUC retro-validation report; not a gate.

## 5. RED-LINE CHECK

- **Misconception/theta-hat never write mastery**: untouched. This fix stays entirely within the existing p(L)/PFA axis (γ/ρ magnitude + a read-side evidence-count gate on the same `MasteryProjection.evidence_count` field the write path already produces). No new write path, no touch to `updateThetaForAttempt`, `misconception`, or `cause_category` tables. `learnable-frontier.ts` and `frontier-read.ts` remain pure-read modules (unchanged from today).
- **Evidence-first, reversible**: strengthened, not weakened — defect (a)'s fix removes a false claim; defect (b)/(c)'s fix is a single-file, non-persisted constant change (mastery is a live projection, never stored, so there is nothing to migrate or roll back beyond reverting the const/gate).
- **Anti-guilt, qualitative-only**: unaffected — `isMasteredForFrontier`/`masteredEnough` are internal booleans feeding pool-membership decisions; `frontier-read.ts`'s `denseReason`/`proposeReason` (already qualitative: counts/names, never a raw probability) are untouched.
- **Cold-start-first**: this fix **is** a cold-start-first fix, not a bystander. Defect (b) (β=0, the "common cold-start case" per the register's own F6 finding) is exactly the zero-evidence window this project prioritizes serving correctly; today's behavior over-trusts 3 lucky answers and prematurely narrows the frontier. The evidence floor makes cold-start behavior *more* conservative (delays premature "mastered" declarations), which serves this invariant rather than crossing it.
- **n=1 doctrine (ADR-0035/ADR-0042)**: respected — γ/ρ remain hardcoded, code-reviewed, cross-learner-scoped structural consts (same category as `ELO_K_GLOBAL`/`DIFFICULTY_PROXY_WEIGHT`); no runtime-persisted fitting is introduced or implied; this is a same-shape magnitude change, not a new estimation mechanism.

## 6. BLAST RADIUS

**Direct callers affected by the γ/ρ magnitude change** (all recompute live from the imported const — no stale-value risk):
- `src/server/mastery/state.ts:349,509` (`getMasteryProjection`) → every display/AI-facing mastery consumer re-renders different numbers for *existing* rows on next read: `tree.ts`, `node-page.ts`, `review-plan-tools.ts` (an AI copilot tool), `knowledge-readers.ts`, `src/server/questions/detail.ts`, `src/capabilities/practice/api/placement-profile.ts`. This is the intended effect (no migration — mastery is never persisted, always projected on read).
- `src/server/simulator/forward-sampler.ts:382-383` — simulator DGP defaults shift; self-consistent tests (`forward-sampler.unit.test.ts`) are unaffected; `pnpm audit:calibration`'s forward-AUC retro-validation report may shift its numbers slightly (report-only, non-gating).
- The `state.ts:509-510` "borrow branch" (unobserved-KC synthesis, a *different* registered unit's P1 concern) is **unaffected**: it calls `pfaLogit(beta, PFA_GAMMA, PFA_RHO, 0, 0)`, and with `success=fail=0` the γ/ρ terms multiply by zero — the borrow branch's output depends only on `beta`, never on γ/ρ.

**Direct callers affected by the evidence-floor gate:**
- `src/capabilities/practice/server/learnable-frontier.ts` (internal logic edit only — exported symbols `MASTERED_PL_THRESHOLD`, `learnableFrontier`, `learnableFrontierResolved` keep their existing shapes/signatures).
- `src/capabilities/knowledge/server/frontier-read.ts` (`isMastered` internal helper signature changes from `number|null|undefined` to a projection-entry shape — private function, one call site at line 247, no external API change).
- Transitively, with **zero code changes required**: `src/capabilities/practice/server/stream-store.ts:205` (`composeDailyStream`'s frontier candidate source), `src/capabilities/knowledge/jobs/frontier_fill_nightly.ts` (propose-edge job's sparse/dense check) — both call the `learnableFrontier(Resolved)` wrapper and inherit the corrected gate automatically.

**No schema change, no migration.** `MasteryProjection`'s shape is unchanged (adds no new field — `evidence_count` already existed at `state.ts:304`); `p(L)` semantics (the logit formula shape, the 0.5 cold-start midpoint, the CI-band mechanics) are fully preserved — only the γ/ρ magnitudes and one additional AND-condition on the frontier gate change.

**Files touched (summary):**
- `src/core/pfa.ts` — comment fix (4 locations) + const values (if Part 2 magnitude retune is approved).
- `src/server/mastery/state.ts` — comment fix only (1 location), no logic change.
- `src/capabilities/practice/server/learnable-frontier.ts` — new const + helper + 2-line internal logic edit.
- `src/capabilities/knowledge/server/frontier-read.ts` — 1 helper signature edit + 1 call-site edit.
- Tests: `src/core/pfa.test.ts`, `src/capabilities/practice/server/learnable-frontier.db.test.ts`, `src/capabilities/knowledge/server/frontier-read.db.test.ts`.


---

# §B — tagging-match-or-propose spec（原文）

# Design Spec: `tagging-match-or-propose` — instrument the silent MATCH branch

Anchor unit from `docs/design/2026-07-02-project-logic-master-register.md` (§3 register entry, line 437; polish-order entry #3, line 219). Verified live at `main`/`685b2c27`.

## 1. CURRENT BEHAVIOR

`tagKnowledge()` in `src/capabilities/knowledge/server/tag-knowledge.ts` is the shared content→KC-attribution step, live-wired (contrary to its own now-stale header comment at `tag-knowledge.ts:19` "ADDITIVE-ONLY: no entry point calls this yet") from two entry points:
- `src/capabilities/ingestion/server/auto-enroll.ts:511-531` (ENROLL mode, per `question_block`)
- `src/capabilities/ingestion/server/image-candidate-accept.ts:651-663` (thin-seed accept path)

The decision point is `tag-knowledge.ts:186-195`:

```ts
const nearest = subjectScoped[0];
if (nearest && nearest.cosine_distance <= threshold) {
  const matchingIds = subjectScoped
    .filter((c: KnowledgeSimilarityCandidate) => c.cosine_distance <= threshold)
    .map((c) => c.knowledge_id);
  return { kind: 'match', knowledge_ids: matchingIds };
}
```

`threshold` defaults to `MATCH_THRESHOLD = 0.55` (cosine distance ceiling, `tagging-flags.ts:42`, an untuned n=6 probe value per its own docstring). When the nearest in-subject candidate is within threshold, the function returns immediately — **zero DB write, zero event**. The docstring at `tag-knowledge.ts:118` even states this explicitly: "`match`: ... NO new KC created, NO event written."

Contrast with the PROPOSE branch three lines later (`tag-knowledge.ts:226-303`): it opens a `db.transaction`, calls `applyProposeNew`, and writes a fully-instrumented `experimental:auto_tag_kc_created` audit event (`tag-knowledge.ts:259-282`) carrying `auto_created_kc_id`, `subject_root_id`, `name`, `knowledge_hint`, and a `reasoning` string.

Consequence: `knowledge_ids` returned by a silent MATCH flow straight into `question.knowledge_ids` (via `auto-enroll.ts:768` `enrollKnowledgeIds` / `image-candidate-accept.ts:666` `knowledgeIds`), which is the attribution axis mastery/FSRS reads one hop downstream. A wrong match (loose 0.55 threshold, n=6-calibrated) is **less observable** than the already-well-instrumented PROPOSE-garbage case, with no way to retroactively audit which KC a given question got silently attributed to, at what cosine distance, or why.

Existing test coverage in `src/capabilities/knowledge/server/tag-knowledge.db.test.ts:84-109` explicitly pins this gap — its "MATCH" test asserts `events.toHaveLength(0)` as the expected/desired behavior today.

## 2. PROPOSED FIX

Emit a lightweight, audit-only event on MATCH, mirroring the PROPOSE branch's existing shape exactly (same `writeEvent` helper, same `actor_ref`, same `experimental:` namespace convention) — **not** a new event shape.

**Critical naming constraint** (verified, not assumed): the action string **must not** be `experimental:auto_tag_kc_created`. That exact string is a load-bearing SQL/reducer literal in two other live consumers:
- `core/projections/knowledge.ts:179-197` — the node-projection fold reducer treats that action as a **CREATE** event keyed by `subject_id`. Reusing it for a MATCH event (where `subject_id` = an already-existing KC) would corrupt the projection fold for that node.
- `src/capabilities/knowledge/jobs/kc_dedup_nightly.ts:117-125` — the `recent_auto` CTE does `WHERE action = 'experimental:auto_tag_kc_created'` to scope its nightly dedup scan to recently-*minted* KCs. Reusing the action would make every matched (old, established) KC look freshly-created to that job.

New action: **`experimental:auto_tag_kc_matched`** — same prefix family as the sibling (`experimental:auto_tag_kc_*`), immediately greppable alongside it, does not collide with either consumer above, is not in `RESERVED_EXPERIMENTAL_ACTIONS` (core/schema/event/experimental.ts:116-189, matching the un-reserved status of its sibling `_created` action), and does not start with `experimental:knowledge_` so `server/proposals/inbox.ts:176-179`'s `like(event.action, 'experimental:knowledge_%')` proposal-fold predicate does not pick it up — it stays audit-only, never a pending inbox item, exactly like `_created`.

### 2a. `src/capabilities/knowledge/server/tag-knowledge.ts`

Add an optional provenance field to `TagKnowledgeInput` (purely observational — never read by the match/propose decision itself):

```ts
export interface TagKnowledgeInput {
  questionText: string;
  knowledgeHint?: string | null;
  subjectRootId: string;
  knownSubjectIds?: readonly string[];
  /**
   * Optional caller-supplied provenance anchor for audit traceability (YUK-NNN) — e.g. the
   * ingestion `question_block.id` (auto-enroll) or the accepted `image_candidate` proposal id
   * (image-candidate-accept). PURELY OBSERVATIONAL: never read by the match/propose decision
   * itself, only threaded into the MATCH audit event's payload. Omit when no natural anchor
   * exists at call time (e.g. the question row doesn't exist yet).
   */
  sourceRef?: { kind: string; id: string } | null;
}
```

Replace the MATCH branch (`tag-knowledge.ts:189-195`):

```ts
  const nearest = subjectScoped[0];
  if (nearest && nearest.cosine_distance <= threshold) {
    const matchingCandidates = subjectScoped.filter(
      (c: KnowledgeSimilarityCandidate) => c.cosine_distance <= threshold,
    );
    const matchingIds = matchingCandidates.map((c) => c.knowledge_id);

    // Audit-only MATCH event (YUK-NNN) — this branch previously wrote ZERO event ("NO new KC
    // created, NO event written" per the docstring above), making a wrong silent match
    // completely untraceable even though knowledge_ids feed mastery/FSRS one hop downstream via
    // question.knowledge_ids. Mirrors the PROPOSE branch's audit shape (same actor_ref,
    // subject_kind:'knowledge', outcome:'success') with a DISTINCT action name — reusing
    // `experimental:auto_tag_kc_created` would corrupt the fold reducer
    // (core/projections/knowledge.ts:180, which treats that exact action as a node CREATE) and
    // kc_dedup_nightly's `recent_auto` CTE (which would then treat an old, established KC as
    // "recently auto-created"). Best-effort (never throws): unlike PROPOSE's event (paired with
    // a real mutation inside one tx), this event has NOTHING to roll back, so a transient write
    // failure must not turn a successful MATCH decision into a routed-to-review failure —
    // mirrors kc_dedup_nightly's own audit-event catch (kc_dedup_nightly.ts:244-275).
    try {
      await writeEvent(db, {
        id: newId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'tag_knowledge',
        action: 'experimental:auto_tag_kc_matched',
        subject_kind: 'knowledge',
        subject_id: nearest.knowledge_id,
        outcome: 'success',
        payload: {
          source: 'tag_knowledge',
          subject_root_id: input.subjectRootId,
          source_ref: input.sourceRef ?? null,
          threshold,
          primary_knowledge_id: nearest.knowledge_id,
          matches: matchingCandidates.map((c) => ({
            knowledge_id: c.knowledge_id,
            name: c.name,
            cosine_distance: c.cosine_distance,
          })),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
      });
    } catch (err) {
      console.error('[tag_knowledge] MATCH audit event write failed (match unaffected)', err);
    }

    return { kind: 'match', knowledge_ids: matchingIds };
  }
```

Update the module header (`tag-knowledge.ts:11-17`) and the `TagKnowledgeResult` docstring (`tag-knowledge.ts:117-118` "NO new KC created, NO event written") to state MATCH now writes an audit-only event too — closes the stale-comment risk the register flagged for this exact area.

No import changes needed — `writeEvent` and `newId` are already imported (lines 31, 36).

### 2b. Caller wiring (thread the provenance anchor)

`src/capabilities/ingestion/server/auto-enroll.ts:526-530` — `block.id` (a real `question_block` row id) is in scope at the call site:
```ts
          {
            questionText: questionMd,
            knowledgeHint: block.knowledge_hint,
            subjectRootId,
            sourceRef: { kind: 'question_block', id: block.id },
          },
```

`src/capabilities/ingestion/server/image-candidate-accept.ts:658-662` — note `block` here is `vision.blocks[0]` (an in-memory VLM extraction result, **not** a persisted row — it has no `.id`). The only stable identifier at this call site is `proposalId` (the accepted `image_candidate` proposal, already in scope):
```ts
          {
            questionText: promptMd,
            knowledgeHint: block.knowledge_hint,
            subjectRootId,
            sourceRef: { kind: 'image_candidate_proposal', id: proposalId },
          },
```

Both are optional-field additions to an existing call — zero behavior change to either caller's control flow.

### 2c. `tagging-flags.ts`

No change. The threshold and its computation (`MATCH_THRESHOLD`, `deps.threshold ?? MATCH_THRESHOLD`) are read-only inputs to the new event's `threshold` payload field — nothing here needs to change for pure instrumentation.

## 3. DECISION POINTS

**D1 — Emit for every MATCH, or only near-threshold ones (e.g. 0.50–0.55)?**
Options: (a) emit for every MATCH decision; (b) emit only when `cosine_distance` is within some margin of `threshold`.
**Recommendation: (a).** No `NEAR_THRESHOLD_MARGIN` constant exists anywhere in the codebase today, and inventing one now would be a second untuned constant riding on top of an already-acknowledged untuned n=6 threshold — exactly the kind of premature-precision the register warns against. The raw `cosine_distance` + `threshold` are both logged verbatim in the payload, so any margin-based "was this risky" filter can be applied post-hoc via a SQL `WHERE` on stored data, without baking a guess into the write path.

**D2 — Should a failed audit-event write ever propagate (throw) instead of being swallowed?**
Options: (a) best-effort catch + `console.error`, match decision unaffected; (b) let it throw, which (per the existing `auto-enroll.ts:533-554` catch-all) routes the block to review.
**Recommendation: (a).** The PROPOSE branch's event write is inside the *same* transaction as the KC creation deliberately — "a writeEvent failure rolls back the KC rather than orphaning it" (`tag-knowledge.ts:228`). The MATCH event has no paired mutation to protect; treating a transient audit-write hiccup as a hard failure would turn a correct, cheap MATCH into a spurious review-routing, which actively hurts the cold-start-first goal. `kc_dedup_nightly.ts:244-275` already establishes the best-effort-catch precedent for a standalone audit-only write in this exact codebase.

**D3 — Thread `sourceRef` (question_block id / proposal id) through the two live call sites, or keep the change scoped to `tag-knowledge.ts` alone?**
Options: (a) thread it (as in §2b); (b) skip it — emit the event with no caller-provided anchor.
**Recommendation: (a).** The task brief explicitly asks for "question/block id" in the payload, both identifiers are already in scope at their call sites with zero new plumbing, and without it a suspicious MATCH is traceable to a KC but not to the upload/session that produced it — the exact traceability gap this fix exists to close. It does touch two extra files, so flagging as a real choice rather than folding it silently into §2a.

**D4 — Backfill the same `sourceRef` field onto the existing PROPOSE event's payload too, for symmetry?**
Options: (a) yes, one extra line (`source_ref: input.sourceRef ?? null`) in the already-existing PROPOSE payload; (b) leave PROPOSE untouched (out of the assigned scope).
**Recommendation: (b) for this change.** The assigned fix is scoped to the MATCH branch; PROPOSE is already well-instrumented and touching its payload (even additively) invites re-reviewing an already-tested, already-shipped shape for no correctness gain. Worth doing later as a trivial one-line follow-up once `sourceRef` exists on the shared input type — note it, don't bundle it.

**D5 — Is there a consumer that should read this event today (an observability page), or is emit-only correct scope now?**
Verified: no admin/observability route (`src/capabilities/observability/manifest.ts:12-84`) and no `web/` component reads any `event` row by action today (grepped — zero hits for `auto_tag_kc_created` anywhere in `web/`). The register's own target shape explicitly defers "the full provisional-status + veto-queue build."
**Recommendation: emit-only.** Building a consumer now would be scope creep past "instrumentation only." A future audit script (or manual SQL against `event WHERE action = 'experimental:auto_tag_kc_matched'`) is sufficient until there's a real incident or cohort to justify UI investment — consistent with F5 in the register (initial diagnoses tend to overstate urgency once the live caller graph is traced).

## 4. TEST PLAN

Partition: `pnpm vitest run --config vitest.db.config.ts src/capabilities/knowledge/server/tag-knowledge.db.test.ts` (this file imports `tests/helpers/db` → DB partition, not unit).

**Updates to existing tests (regression anchors, must still pass):**
- `tag-knowledge.db.test.ts:84-109` ("MATCH: a candidate within threshold...") — the existing assertion `events (action='experimental:auto_tag_kc_created') toHaveLength(0)` **stays true and stays as-is** (we never reuse that action — this is the collision-safety regression anchor). Add a new assertion block: query `event WHERE action = 'experimental:auto_tag_kc_matched'`, expect exactly 1 row, `subject_id === 'kc-near'`, and assert `payload.matches` contains `{ knowledge_id: 'kc-near', cosine_distance: 0 }` and `payload.threshold === MATCH_THRESHOLD`.
- `tag-knowledge.db.test.ts:111-140` ("MATCH multi: every candidate within threshold...") — add an assertion that the new match event's `payload.matches` array has exactly the 2 in-threshold ids (nearest-first) and excludes the 3rd out-of-threshold one — this is the load-bearing multi-match fidelity check.
- `tag-knowledge.db.test.ts:187-224` ("threshold boundary: just-inside...") — optional: assert the inside branch also wrote exactly 1 match event with `cosine_distance` ≈ `threshold - eps`.

**New tests:**
- `sourceRef` threading: call `tagKnowledge` with `sourceRef: { kind: 'question_block', id: 'block-123' }` on a guaranteed-MATCH fixture; assert `payload.source_ref` on the written event equals that object exactly. Add a companion case with `sourceRef` omitted, asserting `payload.source_ref === null` (backward-compat default).
- Best-effort swallow (optional, nice-to-have — kc_dedup_nightly's own sibling pattern does not unit-test this path either, so not a hard gate): if a cheap injection seam is added, assert a `writeEvent` failure does not throw out of `tagKnowledge` and the `match` result is still returned. Skip if it would require a new DI seam beyond what's already justified by production need.

**Integration blast-radius check (no changes expected, verify only):** `src/capabilities/ingestion/server/auto-enroll.db.test.ts:709-732` ("tagKnowledge MATCH: attributes the existing KC, mints nothing") uses an injected `tagKnowledgeFn: matchK1` stub, not the real implementation — confirmed unaffected by this change; re-run as a regression anchor, no edit needed. Same for the `proposal-appliers.db.test.ts` image-candidate-accept coverage (also stubs `tagKnowledgeFn`).

**Gate before PR:** `pnpm typecheck`, `pnpm lint`, targeted `pnpm test:db:watch tag-knowledge.db.test.ts` during development, full `pnpm test` before PR (this touches a live ingestion hot path, so the full DB partition + migration smoke should run, not just the targeted file).

## 5. RED-LINE CHECK

- **misconception/θ̂ never write mastery**: not touched — no `mastery_state`, `theta`, or FSRS write anywhere in this change; it is a pure audit-event insert alongside an already-existing read-only decision.
- **evidence-first / reversible**: this fix is *closing* a violation of this exact invariant (a silent, untraceable MATCH), not introducing one. The match decision itself, its output (`knowledge_ids`), and its downstream consumers are byte-identical before/after.
- **anti-guilt / qualitative-only**: not applicable — no user-facing coaching text or numeric score is surfaced by this change.
- **cold-start-first**: the 0.55 threshold, its computation, and the match/propose split are **completely unchanged** — this was an explicit constraint from the task brief and is honored: no retuning, no new gating logic, purely additive logging. The n=6/untuned status of `MATCH_THRESHOLD` (tagging-flags.ts:31) is unaffected either direction.

No red line is crossed by this change in either direction.

## 6. BLAST RADIUS

**Callers affected:** `auto-enroll.ts` (ENROLL mode only — OBSERVE mode never calls `tagKnowledge`, confirmed at `auto-enroll.ts:475-477`) and `image-candidate-accept.ts` (thin-seed/no-candidate-ids path only). Any future entry point calling `tagKnowledge` inherits the instrumentation for free with zero extra work.

**DB write volume:** +1 `event` row per MATCH decision where previously there were 0 — same table, same shape of insert already used by the PROPOSE branch and by `kc_dedup_nightly`'s own audit event; no new infrastructure, no new table, no schema migration.

**Verified non-collision with existing consumers** (the primary risk this spec is designed around):
- `core/projections/knowledge.ts:179-197` fold reducer — exact-string match on `experimental:auto_tag_kc_created`, unaffected by a differently-named action.
- `kc_dedup_nightly.ts:117-125` `recent_auto` CTE — same exact-string guard, unaffected.
- `server/proposals/inbox.ts:176-179` `proposalWhere()` — `LIKE 'experimental:knowledge_%'`; `experimental:auto_tag_kc_matched` does not match this prefix, so it is (correctly) never folded into the pending-proposal inbox.
- `server/projections/parity.ts:139-199` — exact-string match on `_created`, unaffected.

**Migration:** none. `event.payload` is already a generic JSONB column; the new action validates through the existing generic `ExperimentalEvent` Zod schema (`core/schema/event/experimental.ts:203-214`), same as its `_created` sibling — no new reserved-action schema needed for this scope.

**Consumers of the new event today:** none (verified — no admin/observability route or `web/` component reads by action name). This is intentional emit-only scope per Decision D5; adding a consumer is explicitly out of scope for this fix and would need its own follow-up if/when an incident or audit need materializes.

**Linear:** this closes the P1 item `tagging-match-or-propose` from the 2026-07-02 master register (polish-order #3). The register separately calls out two stale "reconciled/benign" comments about an orphan-KC-on-rollback gap (`auto-enroll.ts:761-766`, `image-candidate-accept.ts:763-765`) — the register explicitly says to file that as its **own** Linear issue, not bundle it here; this spec does not touch those comments or that gap.


---

# §C — ocr-vlm-fallback-ladder spec（原文）

Confirmed: `src/ui/**/*.test.tsx` is in the `fastTestInclude` unit-partition allowlist, so `VisionTab.test.tsx` runs under `pnpm test:unit` / `vitest.unit.config.ts`, no DB. Everything is grounded. Here is the spec.

---

# DESIGN SPEC — `ocr-vlm-fallback-ladder` (#11 polish order, P2 render gap)

## 0. PRE-FLIGHT (UI compliance)

**(a) Design-doc verbatim quotes.**

Two loom-refresh sections touch this exact `/record` ingestion surface. Neither directly specifies "how to render an array of warning strings inside the live SSE progress timeline," so per the task instructions I am also proposing the in-component convention as the primary source of truth — but both quotes below are load-bearing for the DECISION POINT in §3.

1. `docs/design/loom-refresh/project/screen-record-a8.jsx:16-25` — the reference honesty-banner component for edge-degrade states on this exact surface:
```jsx
// 边缘退化态 banner(诚实标记)
function DegradeBanner({ icon = "alert", children, action }) {
  return (
    <div className="ing-degrade warn">
      <Icon name={icon} size={15} />
      <div className="ing-degrade-txt">{children}</div>
      {action && <span className="ing-degrade-act">{action}</span>}
    </div>
  );
}
```
Used at `screen-record-a8.jsx:101`: `{degrade === "docx" && <DegradeBanner icon="alert">结构没解析出来，已<b>按纯文本处理</b> —— 没有静默降级，标号 / 表格层级可能丢失，可手动补。</DegradeBanner>}` — this is rendered in `IngestExit` (the **post-import landing** state), not in the live SSE timeline.

2. `web/src/globals.css:1636-1640` — the live-code decision record for exactly this class family, already in the codebase:
```css
/* ── A8 (YUK-354): 录入成功着陆视图（IngestExit）。PORT 自
   docs/design/loom-refresh/project/record-a8.css 的 .ing-exit* / .ing-proposal*
   类（视觉参考，按本仓库 loom tokens 落地，不整文件拷）。只成功态；失败 / 退化态
   (.ing-rescue / .ing-degrade / .ing-progress / .ing-figure / .ing-emptyblock /
   .ing-original) OUT-OF-SCOPE，不在此 port。 ── */
```
So `.ing-degrade` (the `DegradeBanner` treatment) was **deliberately deferred** during the A8 port and does not exist in the live app CSS today. Porting it now would be new scope beyond a "3-line render arm."

**Conclusion:** no design doc specifically governs the in-flight `SSETimeline` (this component didn't exist yet when `screen-record-a8.jsx` was authored — it's YUK-277's later addition, `VisionTab.tsx:1226`). Per the task's own fallback instruction, I am following **existing in-component convention** instead: `SSETimeline` already has a live, shipped pattern for surfacing a free-text warning inline in a timeline row — the `error_message` render arm at `VisionTab.tsx:1265-1267` (`{typeof e.payload.error_message === 'string' && (<span className="record-error"> · {e.payload.error_message}</span>)}`), styled by the single-property rule `web/src/globals.css:1632-1634` (`.record-error { color: var(--again-ink); }`). I'm proposing the same shape, colored to the existing `hard` (amber, "degraded but not fatal") semantic already used in this same file for `LayoutQualityBadge`'s `partial`/`text_only` states (`VisionTab.tsx:1177-1181`, `Badge tone="hard"` → `--hard-ink`/`--hard-soft`, `src/ui/primitives/Badge.tsx:19`) — that's the correct tone distinction from `record-error`'s red, because a fallback warning is "succeeded, but degraded," not "failed."

**(b) Component type.** Not a new drawer/modal/route/page. This is an **inline render-arm addition inside an existing component** — `SSETimeline`, a private sub-component of the existing `VisionTab` tab body (`src/ui/components/VisionTab.tsx:1226-1282`), which is already mounted in the `/record` vision_single / vision_paper tabs during the `extracting`/`reviewing` phases. Zero new components, zero new routes.

**(c) Files to touch.**
| File | Create/Modify | What |
|---|---|---|
| `src/ui/components/VisionTab.tsx` | Modify | `SSETimeline` render arm (+ `export` keyword so it's testable like its siblings); no new imports (`Icon` already imported at line 35) |
| `web/src/globals.css` | Modify | One new 1-line CSS rule `.sse-warn` next to `.record-error` |
| `src/capabilities/ingestion/jobs/tencent_ocr_extract.ts` | Modify | Fold `buildGlmFallbackQuestions().warnings` into the persisted `warnings` array (the actual data-completeness half of this fix) |
| `src/ui/components/VisionTab.test.tsx` | Modify | New `describe` block asserting the render arm |
| `src/capabilities/ingestion/jobs/tencent_ocr_extract.db.test.ts` | Modify | Extend the existing GLM-fallback test with a new assertion |

No new files.

---

## 1. CURRENT BEHAVIOR

**Backend (data layer — already correct, per register's grounding note):**

- `src/capabilities/ingestion/jobs/tencent_ocr_extract.ts:338-345`, inside the GLM engine branch that pre-computes the OCR fallback (used only if the VLM `StructureTask` later throws):
```ts
if (engine === 'glm') {
  ocrHintMd = renderGlmHint(glmPages);
  const fb = buildGlmFallbackQuestions({
    pages: glmPages,
    layout_quality: ocrLayout,
    warnings: [],
  });
  ocrFallbackQuestions = fb.questions;
```
`fb.warnings` is never read. `buildGlmFallbackQuestions` (`src/capabilities/ingestion/server/glm_ocr_parser.ts:214-231`) unconditionally returns `warnings: ['GLM fallback: page-level standalone, no sub-question split']` — a real, always-non-empty, informative message that is silently dropped at the call site.

- `tencent_ocr_extract.ts:382-394`, the `StructureTaskError` catch block (the actual VLM-outage path) pushes only its own message and discards `fb.warnings`:
```ts
const engineLabel = engine === 'glm' ? 'GLM' : 'Tencent';
warnings.push(
  `StructureTask unavailable (${err.message}); fell back to ${engineLabel} structure`,
);
structure = {
  questions: ocrFallbackQuestions,
  layout_quality: ocrLayout,
  warnings: [],
};
```
So on a GLM VLM outage, the user only ever sees the generic "fell back to GLM structure" line — never the more specific "no sub-question split" caveat that explains *why* the resulting blocks are undifferentiated page blobs.

- The `warnings` array (now missing that one string) is faithfully persisted three places via `Ingestion.applyExtractionResult` (`src/server/session/ingestion.ts:196-306`):
  1. `learning_session.warnings` (line 273-277, `updatedWarnings = [...current.warnings, ...params.warnings]`)
  2. `job_events.payload.warnings` via `writeJobEvent(..., event_type: 'ingestion.extraction_completed', payload: { block_count, layout_quality, warnings: params.warnings })` (line 279-288)
  3. domain `event.payload.warnings` via `writeSessionEvent(..., action:'extract', payload: { structured_block_ids, layout_quality, warnings: params.warnings })` (line 290-306)

  Test-proven at `src/capabilities/ingestion/jobs/tencent_ocr_extract.db.test.ts:371-389`: on a simulated VLM outage, `session[0].status` is `'extracted'` (i.e., looks like a **full success**, no error phase) yet `session[0].warnings.some((w) => w.includes('fell back to GLM'))` is `true` — proving the exact "silent-looking success with a hidden caveat" shape.

**Frontend (the actual gap):**

- `src/capabilities/ingestion/api/events.ts:46-52,60-66` forwards the persisted `job_events.payload` verbatim over SSE as `{ event_id, event_type, payload }`.
- `src/ui/lib/sse.ts:15-19,100-128` (`useIngestionSSE`) types `payload: Record<string, unknown>` and passes it through unmodified into `events`.
- `src/ui/components/VisionTab.tsx:1226-1282` (`SSETimeline`, not exported) renders each event row and reads exactly three payload fields — `block_count` (line 1259), `layout_quality` (line 1262), `error_message` (line 1265) — and **never reads `payload.warnings`**:
```tsx
<span className="msg">
  <code>{e.event_type}</code>
  {e.payload.block_count !== undefined && (
    <span className="meta"> · {String(e.payload.block_count)} blocks</span>
  )}
  {typeof e.payload.layout_quality === 'string' && (
    <span className="meta"> · {e.payload.layout_quality}</span>
  )}
  {typeof e.payload.error_message === 'string' && (
    <span className="record-error"> · {e.payload.error_message}</span>
  )}
</span>
```
Net effect: a user who hits a GLM VLM outage sees the `ingestion.extraction_completed` row render as `block_count · layout_quality` only — the same visual shape as a fully clean extraction — and then proceeds to review a page full of one giant undifferentiated "question" per page with zero on-screen explanation of why.

---

## 2. PROPOSED FIX

### 2a. Backend — fold the discarded warning in (`tencent_ocr_extract.ts`)

Capture `fb.warnings` at the point they're computed, and push them into the persisted `warnings` array **only when the fallback path actually fires** (inside the `StructureTaskError` catch), so a successful VLM run never gets a spurious "fell back" caveat attached.

```ts
// tencent_ocr_extract.ts:336 area — before the if/else that computes ocrHintMd/ocrFallbackQuestions
let ocrHintMd: string;
let ocrFallbackQuestions: ReturnType<typeof parseMarkAgentResponse>['questions'];
// YUK-nnn (ocr-vlm-fallback-ladder): buildGlmFallbackQuestions() always returns an
// informative warning ('GLM fallback: page-level standalone, no sub-question
// split') that was previously discarded here. Capture it and fold it into
// `warnings` only if the fallback actually fires (StructureTaskError catch below)
// — never on the VLM-success happy path.
let glmFallbackWarnings: string[] = [];
if (engine === 'glm') {
  ocrHintMd = renderGlmHint(glmPages);
  const fb = buildGlmFallbackQuestions({
    pages: glmPages,
    layout_quality: ocrLayout,
    warnings: [],
  });
  ocrFallbackQuestions = fb.questions;
  glmFallbackWarnings = fb.warnings;
} else {
  ocrHintMd = renderTencentHint(tencentPages);
  ocrFallbackQuestions = tencentPages.flatMap((p) => p.questions);
}
```

```ts
// tencent_ocr_extract.ts:382-394 — inside the StructureTaskError catch
const engineLabel = engine === 'glm' ? 'GLM' : 'Tencent';
warnings.push(
  `StructureTask unavailable (${err.message}); fell back to ${engineLabel} structure`,
);
warnings.push(...glmFallbackWarnings); // no-op for the Tencent engine (stays [])
structure = {
  questions: ocrFallbackQuestions,
  layout_quality: ocrLayout,
  warnings: [],
};
usedVlmPath = false;
```

No change to `applyExtractionResult`, `writeJobEvent`, or `writeSessionEvent` — the existing 3-way persistence already forwards whatever is in `warnings`.

### 2b. Frontend — render the warnings (`VisionTab.tsx`)

Export `SSETimeline` (matches the file's existing "Exported for X.test.tsx" convention used by `ExtractionProgressBar`, `TextLineCompletePanel`, `BlockEditor`, `buildBlockForm`) and add one render arm after the existing `error_message` arm:

```tsx
// VisionTab.tsx:1226 — add `export`
export function SSETimeline({
  events,
  status,
}: {
  events: { event_id: number; event_type: string; payload: Record<string, unknown> }[];
  status: string;
}) {
  ...
            <span className="msg">
              <code>{e.event_type}</code>
              {e.payload.block_count !== undefined && (
                <span className="meta"> · {String(e.payload.block_count)} blocks</span>
              )}
              {typeof e.payload.layout_quality === 'string' && (
                <span className="meta"> · {e.payload.layout_quality}</span>
              )}
              {typeof e.payload.error_message === 'string' && (
                <span className="record-error"> · {e.payload.error_message}</span>
              )}
              {/* ocr-vlm-fallback-ladder: the fallback ladder persists a non-fatal
                  degrade warning (e.g. "fell back to GLM structure") on
                  ingestion.extraction_completed even when the session still
                  lands as 'extracted' — this is the only surface that renders it. */}
              {Array.isArray(e.payload.warnings) && e.payload.warnings.length > 0 && (
                <span className="sse-warn">
                  {' · '}
                  <Icon name="alert" size={12} />{' '}
                  {(e.payload.warnings as unknown[])
                    .filter((w): w is string => typeof w === 'string')
                    .join('；')}
                </span>
              )}
            </span>
  ...
}
```

CSS addition, `web/src/globals.css` next to the existing `.record-error` rule (~line 1632-1634):
```css
.record-error {
  color: var(--again-ink);
}

/* ocr-vlm-fallback-ladder: non-fatal degrade warning inside an otherwise-
   successful SSE row (e.g. VLM-outage fallback). Amber ("hard"/degraded), not
   red ("again"/failed) — the session still lands as extracted/partial. */
.sse-warn {
  color: var(--hard-ink);
}
```

This is the entire fix: one capture + one push server-side, one render arm + one CSS rule client-side. No new component, no new query, no schema change.

---

## 3. DECISION POINTS

1. **Visual weight: inline timeline line (proposed) vs. porting the deferred `DegradeBanner`.**
   - Option A (recommended): the inline `.sse-warn` line above — zero new CSS surface beyond one property, matches the register's own "~3-line render arm" framing, ships today.
   - Option B: finally port `.ing-degrade`/`DegradeBanner` (deferred at `globals.css:1636-1640`) and render it as a standalone banner above/below the timeline. Higher visual salience, matches the exact reference mock's edge-degrade language — but reopens a previously-closed, deliberately-scoped-out porting decision, and is explicitly against this task's "keep it minimal — not a redesign" instruction.
   - **Recommendation: Option A.** If the owner later wants the stronger `DegradeBanner` treatment across *all* ingestion degrade states (docx-fallback, empty-block, figure-crop — the other three cases already mocked in `screen-record-a8.jsx` but also unported), that's a bigger, separate follow-up, not this fix.

2. **Should the warning also surface in the A8 `IngestExit` landing view** (`RecordLanding`/`landing` state in `VisionTab.tsx:562-577`), not just the in-flight timeline?
   - The register's grounded scope is specifically "the ingestion progress UI never renders it" (i.e., the SSE timeline). `RecordLanding` is a separate component (`src/ui/components/RecordLanding.tsx`) not touched here; it does not currently receive `warnings` as a prop at all — wiring that through would be a second, larger touch surface (prop threading through `VisionTab`'s `landing` state, which currently only carries `{ count }`).
   - **Recommendation: out of scope for this fix.** File as a fast-follow if the owner wants the caveat to survive past the review phase into the landing summary (a real gap — right now the warning is only visible while `phase === 'extracting' | 'reviewing'`, and disappears once the user reaches the A8 landing card). I'll capture this as a Linear follow-up per the capture gate.

3. **Join separator for multiple warnings** (`；` full-width semicolon vs. line breaks vs. a bullet list). Cosmetic, zero risk either way.
   - **Recommendation:** `；` inline join, matching this codebase's existing convention of terse inline meta strings in this exact row (` · N blocks`, ` · structured`) rather than introducing multi-line row height variance into a `max-height: 280px; overflow-y: auto` scrolling list (`globals.css:1581-1585`).

None of these block implementation; (1) and (3) are pre-decided by the recommendation above, (2) is a scope boundary, not a blocker.

---

## 4. TEST PLAN

**Partition: unit (`vitest.unit.config.ts`) for the UI render arm; DB (`vitest.db.config.ts`) for the backend fold-in.**

**A. `src/ui/components/VisionTab.test.tsx`** (already in `fastTestInclude` via `src/ui/**/*.test.tsx`, `vitest.shared.ts:365-366` — no-DB, `renderToString`, matches this file's existing pattern exactly):
- New `describe('VisionTab SSETimeline — fallback warning render', ...)`:
  - `it('renders payload.warnings on an extraction_completed row')`: `renderToString(<SSETimeline events={[{ event_id: 1, event_type: 'ingestion.extraction_completed', payload: { block_count: 2, layout_quality: 'structured', warnings: ['StructureTask unavailable (timeout); fell back to GLM structure', 'GLM fallback: page-level standalone, no sub-question split'] } }]} status="closed" />)`; assert `.toContain('fell back to GLM structure')` and `.toContain('no sub-question split')`.
  - `it('omits the warning line when payload.warnings is absent/empty')`: same shape with `warnings: []` and with the key omitted entirely; assert `.not.toContain('sse-warn')` (or assert absence of the joined text) to pin the no-regression case (a clean extraction must not show a phantom warning line).
  - Follows this file's existing multi-value assertion idiom (`renderToString` + `.toContain`), same as `TextLineCompletePanel`'s tests at lines 185-211.

**B. `src/capabilities/ingestion/jobs/tencent_ocr_extract.db.test.ts`** (existing DB partition test, `resetDb()` per file):
- Extend the existing `it('GLM VLM-fail → page-level GLM fallback questions + cost_ledger still written', ...)` (line 371) with one new assertion right after the existing `line 389` check:
```ts
expect(session[0].warnings.some((w) => w.includes('fell back to GLM'))).toBe(true);
expect(
  session[0].warnings.some((w) => w.includes('no sub-question split')),
).toBe(true); // new — buildGlmFallbackQuestions().warnings is no longer discarded
```
- This is the regression anchor for the backend half: it fails today (pre-fix) because `glmFallbackWarnings` doesn't exist yet, and passes after 2a lands.
- No new test file needed; this is additive to an existing, already-green test.

**Regression anchors to re-run (not new, but must stay green):**
- `tencent_ocr_extract.db.test.ts` full file (GLM-warnings-aggregation test at line ~300, Tencent-fallback test at line ~556-651) — confirms the fold-in doesn't leak into the Tencent engine path (`glmFallbackWarnings` stays `[]` there).
- `VisionTab.test.tsx` full file (AI-prefill badge, `buildBlockForm` resilience, `TextLineCompletePanel`) — confirms `export`-ing `SSETimeline` and the new render arm don't disturb sibling exports.
- `ExtractionProgressBar.test.tsx` — same file family, unaffected but co-located; cheap to include in the targeted run.

**Commands:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/components/VisionTab.test.tsx
pnpm vitest run --config vitest.db.config.ts src/capabilities/ingestion/jobs/tencent_ocr_extract.db.test.ts
pnpm typecheck && pnpm lint   # touched-file Biome + full typecheck per CLAUDE.md pre-flight discipline
```

---

## 5. RED-LINE CHECK

- **Misconception/θ̂ never write mastery:** not touched. This fix is pure display (client) + array fold-in (server-side warnings string array, no mastery/theta/FSRS/misconception table involved).
- **Evidence-first, reversible:** strengthens this invariant — the data was already reversible/evidence-complete (3-way persistence, test-proven); this fix closes the *last-mile render* gap so the evidence is actually visible to the human, which is the point of "evidence-first" in the first place.
- **Anti-guilt, qualitative-only:** not applicable to mastery/practice feedback (this is an ingestion pipeline diagnostic, not learner-facing performance feedback), but worth confirming tone: the rendered strings (`"StructureTask unavailable (...); fell back to GLM structure"`, `"GLM fallback: page-level standalone, no sub-question split"`) are neutral, technical, system-directed — no blame-the-user language. No change needed to match the existing anti-guilt tone convention already used elsewhere in this surface (`RescueFail`'s "不是装作好了，是真没成" phrasing).
- **Cold-start-first:** not touched — this is the day-one ingestion path (as the register itself notes, "closes an evidence-first violation on the day-one ingestion path"), and the fix makes cold-start ingestion *more* honest about degraded output, which is directly aligned with cold-start-first (new users are exactly the ones most likely to hit a fresh VLM-outage-and-not-know-it scenario on their very first upload).

No red-line invariant is put at risk by this change; if anything it hardens the evidence-first one.

---

## 6. BLAST RADIUS

**Callers/consumers of touched code:**
- `buildGlmFallbackQuestions()` (`glm_ocr_parser.ts:214`) — only caller is `tencent_ocr_extract.ts:340`; the function itself is unchanged (still returns the same shape), only the caller now uses `fb.warnings` instead of dropping it. Its own unit test (`glm_ocr_parser.unit.test.ts`) is unaffected (tests the function in isolation, not the caller).
- `warnings` array in `applyExtractionResult` — already had a "warnings can be arbitrary strings" contract (no schema/shape constraint beyond `string[]`); adding one more string to the array on the fallback path is additive, not a shape change. All 3 persistence sinks (`learning_session.warnings` jsonb-ish text[], `job_events.payload`, `event.payload`) already accept arbitrary-length string arrays — no migration needed.
- `SSETimeline` — private to `VisionTab.tsx`, only consumer is `VisionTab` itself (2 call sites: `phase === 'extracting'|'creating'|...` render block at line 701, and `phase === 'reviewing'` at line 712). Exporting it adds no new external consumer; it's purely additive for the test file.
- SSE wire contract (`SSEEvent.payload: Record<string, unknown>` in `src/ui/lib/sse.ts:18`) — already untyped/passthrough; no change needed there, `payload.warnings` was already flowing over the wire, just unread.
- No other component reads `SSETimeline`'s internals or the `warnings` field from these payloads today (confirmed via `grep -rn "e.payload.warnings\|payload\.warnings"` returning zero client-side hits before this fix).

**Migration:** none. No schema change, no new DB column, no new API field — this is a pure "read a field that was always there" + "don't drop a value that was always computed" fix.

**Risk of regression:** low. The backend change is additive-only and gated behind the existing `StructureTaskError` catch (only fires on the already-tested fallback path); the frontend change is a new conditional render arm that no-ops (renders nothing) when `payload.warnings` is absent/empty, so every existing non-fallback SSE row (the overwhelming majority) is visually unchanged.

**Linear:** per CLAUDE.md's issue-capture gate, DECISION POINT #2 above (surface warnings persisting into the A8 `IngestExit` landing view, not just the in-flight timeline) is a real, scoped-out follow-up gap worth filing once this fix lands — I did not file it during this spec-writing pass since no code was changed yet; it should be filed at implementation time referencing this spec.

**Key file:line references for implementation:**
- `src/capabilities/ingestion/jobs/tencent_ocr_extract.ts:338-345` (capture), `:382-394` (push)
- `src/capabilities/ingestion/server/glm_ocr_parser.ts:214-231` (unchanged, read-only reference)
- `src/ui/components/VisionTab.tsx:1226-1282` (`SSETimeline`)
- `web/src/globals.css:1632-1634` (new `.sse-warn` rule beside `.record-error`)
- `src/server/session/ingestion.ts:273-306` (unchanged, confirms 3-way persistence)
- `src/capabilities/ingestion/api/events.ts:46-52,60-66` (unchanged, confirms SSE forwards `payload` verbatim)
- `src/capabilities/ingestion/jobs/tencent_ocr_extract.db.test.ts:371-407` (test to extend)
- `src/ui/components/VisionTab.test.tsx` (test to extend)


---

# §D — Opus 对抗审裁定（原文）

三份 spec 已逐条对照 685b2c27 工作树核验（关键行号、常量、消费者 grep、数值仿真、ADR 原文）。以下是裁定。

---

## SPEC 1 — `pfa-plearn-formula`：**VERDICT: NEEDS-AMENDMENT**（核心修法对，两处必须修正）

**先说站住的部分（全部实证核过，不复述 spec 已有的）：**
- 数学全对：K(β)=ceil((0.8473+β)/γ) 表、σ(1.2)=0.7685、γ 与两缺陷 lockstep（纯 retune 修不了 defect b）——复算无误。
- SE-gate 不可替代的判定**成立且是本 spec 最有价值的新发现**：`theta.ts:579-606` Fisher 累积 `precision' = precision + w²·p(1-p)`，冷启 1 答后 precision=1.25 → SE=0.894 < `LOW_CONFIDENCE_SE_THRESHOLD=1.0`（`pfa.ts:126`）——`low_confidence` 确实第一题就熄灭，不能当证据闸。evidence-count floor 是对的结构修法。
- `MASTERED_PL_THRESHOLD` 消费者穷尽性核过：全仓只有 `learnable-frontier.ts:221-222` + `frontier-read.ts:105` 两处，spec 无遗漏。
- `setMastered` helper（`learnable-frontier.db.test.ts:69-70`）确实是 `evidence_count: 4, success_count: 4`——floor=4 零回归的说法为真。`state.db.test.ts` 全部经 live `pLearned(..., PFA_GAMMA, PFA_RHO, ...)` import 计算期望值（:292,:369-370,:403,:435 核过），retune 后自洽。`poly-exp-parity.unit.test.ts:57-58` 是本地字面量，不受影响——claim 属实。
- borrow branch γ/ρ-免疫（`state.ts:509` success=fail=0）属实。

**必须修正的两处：**

1. **Part 1 的注释文本把「修正假注释」偷换成「替 owner 做永久性裁决」，且引用有两处站不住。**
   - 现注释 `pfa.ts:40-42` 记录的是 owner 裁定原文：「owner 裁定：现在就建、hardcode + flag。**refit 接通后这些常量应被替换为 per-KC / 全局标定值**」。这是一张 forward-looking 的 owner IOU，不是「声称 job 存在」。核实为假的只有窄的那半句——`recalibration_nightly.ts` 全文零 PFA/γ/ρ 提及（grep 核过），YUK-361 已建部分只 refit b。但 spec 提议的新注释写成「gamma/rho are **permanent** ... NOT a placeholder ... nor is planned」——这是**推翻一条已存盘 owner 裁定**，必须列为 DECISION POINT 交 owner 拍板，不能标 "FREE: unconditional"。诚实的无条件版本是：「job 不存在、YUK-361 只 refit b、在 owner 另行裁决前按 owner-fixed const 对待」。
   - **引用 (i)**：「ADR-0042 explicit-weights」——`docs/adr/0042-mfi-selection-signal-three-layer-engine.md` 全文 grep：无 "explicit-weights"/显式权重 doctrine、无 γ=0.4 by-value 引用、无 ELO_K_GLOBAL。该 ADR 的 "权重" 全部指 LLM 编排层 per-candidate weights（line 50-64），与 owner-fixed 模块常量无关。候选表 C 行的「further from the canonical explicit-weights exemplar ADR-0042 already cites by value」是无依据的。（`ELO_K_GLOBAL`/`DIFFICULTY_PROXY_WEIGHT` 本身存在于 `theta.ts:162,219`——类比成立，出处标错。）
   - **引用 (ii)**：「Per ADR-0035's own verdict, classic PFA's ... refit is structurally inapplicable at n=1」——ADR-0035 的 n=1 不可辨识裁定（Stocking 1990）针对的是**软轨 a/c/slip/guess**（该文 line 32-33），从未对 γ/ρ 下过判词。作为 doctrine 外推是合理的，写成 "ADR-0035's own verdict" 是伪造归属。两处引用都要改成诚实措辞，否则这个 unit 在「修一条假注释」的同时往代码里种两条新的假引用。

2. **Part 2(iii) retune 的动机场景在今日量表外，且 spec 漏报了一个 fixture 语义翻转。**
   - `ANCHOR_BUCKET_LOGITS` 上限 +2（`fixed-anchor.ts:49-55` 核过）；β≈3 只能来自 b_calib 漂出锚表——spec 自己承认 out of scope，却仍用 β=3 的 10-correct 表当 headline。量表内最坏情形是 K(2)=8→6（candidate B），改善幅度进一步缩水。Candidate A（gate-only）关掉了唯一被证实的 live defect；B 是偏好而非必需——建议把默认推荐降为 A，B 作为 owner 可选。
   - 若选 B：**σ(0.8)=0.690 → σ(1.0)=0.731 跨过 0.7**。`stream-store.db.test.ts:150` / `stream.db.test.ts:138` / `stream-softmax.db.test.ts:148` 三处共享的 s=3/f=2/e=5 fixture 会从「未掌握」翻成「已掌握」。已核实这三个测试只用该行喂 θ̂/MFI（`stream-store.ts` 无任何 mastery 阈值读取），**今天不会红**——但这是纯运气：任何未来 frontier 相关测试复用该 fixture 都继承翻转后的语义。选 B 就必须在 test plan 里写明并调整该 fixture（如 f=3）。

**一处漏报的潜伏耦合（非阻塞，建议写进新常量 docblock）：** borrow branch 合成的 entry 是 `evidence_count: 0`（`state.ts:519`）。今天 `GRAPH_LAPLACIAN_ENABLED=false` / `PREREQ_THETA_PROPAGATION_ENABLED=false`（核过）所以 dark；但 flag 翻转后，easy/very_easy 锚（β≤−1，量表内）的 borrowed prereq σ(−β)≥0.73 今天能过 prereq 闸、加 floor 后永远过不了。大概率正是想要的保守行为，但这是与另一 registered unit 的交互，应显式记录而非静默。

**小遗漏：** `poly-sigmoid-swap.unit.test.ts:10` 也 import 生产 `PFA_GAMMA/PFA_RHO`（自洽 parity 测试，不受影响），spec 的「穷尽列举」漏了它。

---

## SPEC 2 — `tagging-match-or-propose`：**VERDICT: SOUND**

碰撞分析是本 spec 的承重部分，逐条核实为真：
- fold reducer（`src/core/projections/knowledge.ts`）:180 精确匹配 `experimental:auto_tag_kc_created`，:247 前缀匹配 `experimental:knowledge_`，未知 action **直接落穿、无 default throw**（`warnMalformed` 只在已匹配 action 的 payload 坏时触发）——`auto_tag_kc_matched` 两个都不命中。
- `kc_dedup_nightly.ts:121` CTE、`parity.ts:157,199` 均为 exact-string eq，不受影响。inbox `LIKE 'experimental:knowledge_%'` 前缀不吞新 action。`RESERVED_EXPERIMENTAL_ACTIONS`（experimental.ts:116-189）不含它，generic `ExperimentalEvent`（:203-214，`experimental:` 前缀 + 非 reserved）放行——全部属实。
- **best-effort catch 的安全前提核过**：两个 caller 都传 root `db` 且在 terminal tx 之前调用（auto-enroll enroll-tx 在 :728、tagKnowledge 调用在 :511；image-candidate-accept 的 tagKnowledge 在 :652、terminal tx 在 :730，:664 注释自证「in its own tx」）——swallow 一个失败 INSERT 不会毒化任何外层 Postgres tx。D2 选 (a) 正确，且 auto-enroll :533-554 的 catch-all 确实会把 throw 变成 route-to-review（spec 对 (b) 危害的描述准确）。
- 既有 MATCH 测试（`tag-knowledge.db.test.ts:104-108`）的零事件断言是 **action-filtered**（`eq(event.action, 'experimental:auto_tag_kc_created')`）——加新事件后保持绿，spec 说法准确。
- `sourceRef` 两个锚点（`block.id` / `proposalId`）都在作用域内，D3/D4/D5 的取舍无可挑剔。

**一条非阻塞建议（本 spec 最强的残余风险）：** 这个区域正处于 YUK-471 W1 PR-B 的 projection-SoT flip 工程中（`tag-knowledge.ts` PROPOSE 分支内的 `projectionIsWriter()` 分叉）。flip ON 时 knowledge 行由事件 fold 重建——matched 事件挂在**既存 KC** 的 subject_id 上，该 KC 下次任何 fold 触发（archive/reparent/dedup）都会把这条事件喂进 reducer。「reducer 忽略未知 action」现在成了承重不变量但无测试钉住。建议 test plan 加一条：MATCH 写事件后对 matched KC 跑 `projectKnowledgeNode`/parity，断言行 byte-identical。一行测试，把最贵的那类回归（fold 腐蚀）钉死。

事件量（每 MATCH +1 行，N-block 上传 +N）与 PROPOSE 既有 per-block 事件同量级，非问题。

---

## SPEC 3 — `ocr-vlm-fallback-ladder`：**VERDICT: SOUND**

**Pre-flight (f) 成立：** `screen-record-a8.jsx:16-25` 的 `DegradeBanner` 引用逐字核实；`globals.css:1636-1640` 的「.ing-degrade OUT-OF-SCOPE 不在此 port」决策注释逐字核实；「无 design doc 管辖 in-flight SSETimeline」是诚实缺席——且 grep 证实全仓 UI 今天零处读 `payload.warnings` / `session.warnings`（spec 代码注释里 "the only surface that renders it" 为真）。选 `--hard-ink`（degraded）而非 `--again-ink`（failed）的 tone 论证有 `LayoutQualityBadge`（VisionTab.tsx:1177-1181 `Badge tone="hard"`）实锚。组件类型声明、touch 文件清单、export-for-test 惯例（`ExtractionProgressBar`:143 / `BlockEditor`:804 / `TextLineCompletePanel`:1193 / `buildBlockForm`:1368 均已 export）全部核实。

**其余承重 claim 全部核过：** `buildGlmFallbackQuestions` 无条件返回该 warning（glm_ocr_parser.ts:229）且调用点丢弃（tencent_ocr_extract.ts:340-345）；catch 块（:381-394）形状、`usedVlmPath = false` 均与 spec 引文一致；3-way 持久化（ingestion.ts:273-306）、`fastTestInclude` 含 `src/ui/**/*.test.tsx`（vitest.shared.ts:365-366）、DB 测试 :371 及其 `fell back to GLM` 断言、`Icon` import（VisionTab.tsx:35）+ `alert`→AlertTriangle 存在——全对。红线检查无异议。

**两条小注（都不阻塞）：**
1. spec 漏引了 `tencent_ocr_extract.ts:396` 的 `warnings.push(...structure.warnings)`——catch 之后紧跟一个既有的 merge 点。更小的等价 diff 是在 fallback 的 `structure` 字面量里写 `warnings: glmFallbackWarnings`（语义上更真：这本来就是该 fallback structure 的 warning），省掉新增的 push 行。行为完全等价，纯风格；但 spec 声称精读了该区域却未提这个 merge 点，实现者应知道它存在（选 spec 原方案时勿再让 :396 二次折入，当前 catch 置 `structure.warnings: []` 恰好防住了——如换等价方案则应删除 catch 内的直接 push）。
2. 新 render arm 是 event-type 无关的（任何带 `payload.warnings` 的事件都渲染）。今天只有 `extraction_completed` 携带（核过 ingestion.ts 三个 sink），未来别的 ingestion 事件若带 warnings 会自动获得渲染——语义上是 feature 不是 bug，但值得在 arm 注释里点明是「有意通用」。

Scope 划界（Option A、landing view 后补、`；` join）判断全部合理；DECISION POINT 2 的 Linear follow-up 承诺满足 capture gate。

---

**总结：** Spec 2、Spec 3 可按写实现（各带一条非阻塞建议）。Spec 1 的 evidence-gate 半边照写；但 Part 1 注释必须 (a) 把「permanent」降级为 owner 决策点或改为诚实的「未裁决前 owner-fixed」措辞、(b) 删掉/改正 ADR-0042 "explicit-weights" 与 "ADR-0035's own verdict" 两处伪引用；Part 2(iii) retune 建议默认降为 Candidate A，若 owner 选 B 须补 s=3/f=2 fixture 跨阈说明。
