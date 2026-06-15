# Urnings-Lite Calibration Amendment

**Date:** 2026-06-15
**Status:** Accepted as implementation sequencing guidance
**Part of:** YUK-361 personalized calibration roadmap (`docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md` Phase 0 / Task 1)
**Amends:** ADR-0042（选题引擎，编排档2）· ADR-0043（难度数据驱动校准）

## Decision

Use Urnings as an uncertainty-model inspiration, not as the current production
paired-comparison engine.

Current production path:

1. Keep `item_calibration.b` anchored and read-only in online theta updates.
2. Maintain `mastery_state.theta_hat` with the existing MLE/Elo update (ADR-0043 §1 合取 MLE credit).
3. Add theta uncertainty (`theta_precision` / `theta_se`) before changing MFI.
4. Persist inclusion probability `pi_i` for selected diagnostic items — sourced from
   ADR-0042 编排档2 的 tempered-softmax sampler（LLM 出权重 → 抽样），满足 ADR-0043 §7
   要求的真随机抽样 positivity。
5. Defer full Urnings to an offline replay spike after family-level observation
   density exists (roadmap Phase 7).

## Rationale

One learner can accumulate enough data to improve personalized theta and
family-level effective difficulty, but this is not the same as a cohort. Full
item-half online updates remain unsafe for sparse per-item observations because
theta changes and item difficulty are confounded (ADR-0043 识别性墙：logit 平移
不变 + JMLE incidental-parameters 不一致). Urnings-lite captures the *uncertainty*
benefit (theta_precision down-weights cold/uncertain theta in MFI) without taking
on the unsafe online item-half co-estimation.

## Exit gate

Future agents can answer "why not full Urnings now?" without re-litigating n=1
identifiability: because (a) per-item online co-estimation of theta and b is
unsafe at n=1, and (b) we have not yet proven (via Phase 7 offline replay) that
full Urnings beats Elo+uncertainty on log loss / Brier / MFI stability with a
dense-enough item/family observation graph.
