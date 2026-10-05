# Owner questions — 2026-09-25 triage

Consolidated decision requests from `needs-info` tickets. Each is the minimal question needed to unblock the ticket.

---

## Q-452 — YUK-452 (冷启 day-one epic): closeout vs split

The epic is ~4/6 landed (inc-A anchor, inc-B placement+flag, inc-C onboarding, inc-E propagation landed-dark).

**Question:** Is the remaining value in this epic just the owner decisions — i.e. (a) flip `DAY_ONE_PRIOR_ENABLED` when ready, (b) is inc-D (AutoElicit θ prior) still worth building given the design doc itself says θ=0 seed is likely sufficient, and (c) is inc-F (LLM student simulation) still wanted after the YUK-376 LLaSA negative conclusion? Or should the epic be closed as substantially delivered and inc-D/F captured as standalone backlog tickets (inc-D brief already drafted in sub-tickets.md §3)?

---

## Q-1028/1029 — Astra P2/P3 restart & scope

YUK-1027 (P1) merged; P2 was paused back to Backlog on 09-23; P3 needs-info is still waiting on the **LIGHT (recommended) vs FULL** scope call + actual-output budget.

**Question:** Given P2 is owner-paused — should it (a) restart standalone now (brief already written at `briefs/YUK-1028.md`), (b) restart folded into the P3 LIGHT/FULL decision, or (c) stay paused until P3 decides whether Astra is going live at all? And for P3 itself: LIGHT scope (Copilot/SupplyPlanTask/SolutionGenerationTask) vs FULL (51 TaskSpecs by family) + actual-output budget?

---

## Q-416 — YUK-416 ([DEFERRED] de-bias panel): did Astra unblock it?

Original defer reason: de-bias only makes sense with **two comparable frontier lanes**; at the time only Opus qualified. `openai/gpt-6-astra` is now wired (YUK-1027), but parity is unverified.

**Question:** Does Astra's existence un-defer the de-bias panel now, or keep it deferred until Astra's quality is proven comparable (e.g. after the P3 eval)?

---

## Q-572 — YUK-572 (背景 agent 运行时): shadow-lane flip + P3

P1+P2 are landed but dark (`RESEARCH_MEETING_AGENT_ENABLED` OFF); P3 sub-ticket is drafted (sub-tickets.md §2).

**Question:** Do you want to enable the shadow lane now (flip the kill switch + run the ≥2-week comparison vs the deterministic meeting), and is the P3 dreaming/maintenance charterization sub-ticket approved to schedule?

---

## Q-588 — YUK-588 (夜间 AI 链聚合预算): standalone lane vs digest extension

~24 nightly crons + `induceConjecture` on the anthropic-sub OAuth lane mean the subscription-quota erosion is real, but per-job caps already exist.

**Question:** Is an aggregated per-night subscription-quota/cost ledger worth its own lane, or should it fold into the (now-Done) YUK-580 overnight-digest surface? Ticket itself asks "owner 拍是否值得单独做".

---

## Q-766 — YUK-766 (订阅灾备语义): backup-exclusion decision

The three subscription tables are wipe-not-backup; restore marks pre-backup pending deliveries `bootstrap_skipped`. Only live subscriber is a deliberate no-op. 1055 (in-flight) handles cutover-time translation but not this product decision.

**Question:** Before the effect-slice lane lands real handlers — (a) put checkpoint/delivery into backups (recommended in the ticket), (b) back up only an activation horizon, or (c) explicitly accept post-restore delivery loss and document it?

---

## Q-922 — YUK-922 (组卷面 self_confidence): contract slot + UI shape

`AttemptOnQuestion` has no `self_confidence` slot; `ReviewOnQuestion` already has it. The 1038 migration is redefining the submission contract (YUK-1052 `saveSubmission`/ResponseSet) — deciding the slot alongside it avoids a second schema change.

**Questions:** (1) Should `self_confidence` live on `AttemptOnQuestion.payload` (mirroring ReviewOnQuestion, optional 1-5, observe-only), on the new ResponseSet/submission contract (1052), or as a separate capture event? (2) UI shape: per-question inside PfPaper vs once per submission — needs UI design preflight. (3) Sequence: fold the schema decision into 1052, or keep 922 independent?

---

## Q-1033 — YUK-1033 (学段纠正面): confirm deferral to YUK-1007

Backend correction path exists (`updateGoalScope` accepts `declared_stage`); no UI entry. Owner previously deferred to the YUK-1007 config panel.

**Question:** Confirm the deferral — should 1033 become a formal child of YUK-1007, and does that wait acceptable until 1007 is scheduled (still Backlog)?

---

## Q-1040 — YUK-1040 (seed:*:root 处置): θ-axis semantics + ops choices

Split into code ticket (1040-A) + owner-ops ticket (1040-B) in sub-tickets.md.

**Questions:**
- **Q-1040-1 (θ semantics):** for `updateThetaForAttempt`, mirror the FSRS parity rule — mixed `knowledge_ids` write only real KCs, roots-only binding writes **no** mastery_state rows? Or a different口径?
- **Q-1040-2 (存量 FSRS 行):** disposition of the existing `material_fsrs_state('knowledge','seed:math:root')` row — lazy + guard / knowledge-merge proposal / reviewed one-off ops script?
- **Q-1040-3 (4 道绑题):** re-bind the 4 `seed:math:root`-bound questions to real KCs via attribution propose→accept, or keep the coarse binding?
- **Q-1040-4 (optional):** should plan-executor coarse fallback keep writing `seed:<subj>:root` as the `attribution_state='coarse'` signal, or change to empty-bind + auto-attribution proposal?
