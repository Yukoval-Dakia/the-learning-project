# Triage Report — 2026-09-25

Census: `docs/triage/2026-09-25/issues.json` (34 open). This report covers the 24 non-excluded tickets. Live state was re-verified via Linear `get_issue` (the census snapshot has drifted — several tickets are now Done/Canceled).

## Census vs live state drift (verified, not triaged)

| Ticket | Census | Live state | Evidence |
|---|---|---|---|
| YUK-538 | Backlog | **Done** | Linear status=Done; desc said worklist 14/14 merged → correctly closed |
| YUK-585 | Backlog | **Done** | Linear status=Done |
| YUK-845 | Backlog | **Done** | Linear status=Done; desc said PR #1189 in main → correctly closed |
| YUK-571 | Backlog | **Done** | Linear status=Done; PLAN.md records e2e 验收 09-17 全通 |
| YUK-350 | Backlog | **Canceled** | Linear status=Canceled. Orphan child YUK-369 is still Backlog (handled below) |
| YUK-1020 | Backlog | **Done** | Code confirms landed: `src/kernel/read-models/misc-cause-labels.ts` (`resolveMiscCauseLabels`/`miscCauseLabelMap`), `secondary_labels` wire field through `src/server/questions/detail.ts`, `src/server/records/mistakes.ts`, `question-activity.ts`, copilot tools (`attribute-mistake.ts`, `query-mistakes.ts`, `get-attempt-context.ts`), and `CauseBadge.tsx` renders `secondary_labels?.[s] ?? s`. DB+unit tests pinned. `docs/audit/2026-09-20-yuk-1018-misc-cause-followups.md` 观察项 4 closed |
| YUK-1037 | (ref'd by 1040) | **Done** | Filters confirmed live: `SYNTHETIC_SUBJECT_ROOT_RE` applied in verify-and-promote.ts, quiz_verify.ts, source_verify.ts, proposal-appliers.ts, due-list.ts, review-settlement.ts (FSRS pick only) |

**Action for the above: none** (states already correct in Linear). They are excluded from mutation.

## Live triage set (18 tickets)

| Ticket | Category | Recommendation | Labels | Confidence |
|---|---|---|---|---|
| YUK-369 | enhancement | Backlog (keep) + comment | `+area:practice` | High |
| YUK-405 | enhancement | `ready-for-human` | `+ready-for-human` | High |
| YUK-406 | enhancement | `ready-for-human` | `+ready-for-human` | High |
| YUK-416 | enhancement | `needs-info` (precondition met) | `+needs-info` | Medium-High |
| YUK-438 | enhancement | Backlog + comment (blocked) | `+area:practice` | High |
| YUK-452 | epic | `needs-info` (closeout decision) | `+needs-info` | High |
| YUK-492 | enhancement | Backlog (dormant) + comment | `+area:practice` | High |
| YUK-550 | enhancement | Backlog (dormant trigger) + comment | `+area:kg` | High |
| YUK-572 | epic | `needs-info` (flip + P3 split) | `+needs-info` | High |
| YUK-588 | enhancement | `needs-info` | `+needs-info`, `+area:ops` | High |
| YUK-766 | bug/design | `needs-info` (backup-exclusion decision) | `+needs-info`, `+area:ops` | High |
| YUK-856 | ops | `ready-for-human` (keep) + comment | keep existing | High |
| YUK-922 | enhancement | `needs-info` (contract + UI decisions) | `+needs-info`, `+area:practice` | High |
| YUK-999 | enhancement | Backlog (dormant trigger) + comment | `+area:matcher` | High |
| YUK-1028 | enhancement | `needs-info` (owner-paused; brief written) | `-ready-for-agent`, `+needs-info`, keep `area:copilot` | Medium-High |
| YUK-1029 | enhancement | `needs-info` (keep) + refreshed question | keep existing | High |
| YUK-1033 | enhancement | `needs-info` (blocked-on-1007) | `+needs-info`, `+area:ui` | High |
| YUK-1040 | mixed | `needs-info` + split (code ticket proposed) | `+needs-info`, `+area:practice` | High |

---

## Per-ticket grounding

### YUK-369 — A3 步骤级证据切分（限数学/推导型，future）
- **Category:** enhancement.
- **Grounding:** `StepsJudgeTask` exists and is live for math/derivation (`src/capabilities/practice/tasks/index.ts`, `judges.ts`, `server/judge/steps-judge.ts`; prompt hashes pinned). Desc says scope = extend StepsJudgeTask step-level evidence, **explicitly ratified "future"** by owner 2026-06-16, **not generalized to all question types**.
- **Drift found:** parent YUK-350 is now **Canceled** — this child is orphaned. The ratified decision doc (`docs/superpowers/plans/2026-06-16-A1-A5-ratified-decisions.md`) is standalone, so the ticket remains valid on its own merits; recommend de-parenting or leaving as-is.
- **Disposition:** keep Backlog (deliberate future, not ready-for-agent — owner explicitly deferred). Add `area:practice`. Comment notes parent cancellation.

### YUK-405 — 私人教研团 epic（关系脑 · conjecture 引擎）
- **Category:** enhancement (epic).
- **Grounding:** desc's own 2026-07-23 erratum (owner 拍板) states **Phase 0 确定性闭环已 CODE-LIVE** — verified: `src/capabilities/agency/server/conjecture/induce.ts` (`induceConjecture`, Opus anthropic-sub lane), `conjecture-accept.ts`, `PrepDeskConjectures.tsx`, `AdminConjectureScoresSurface` (`src/capabilities/observability/ui/conjecture-scores.tsx`), `research_meeting_nightly` job. Remaining acceptance is explicitly **behavioral**: a two-week real-usage window — owner uploads first cold-storage content + runs first real placement, then metrics (conjecture confirm-rate non-degenerate, anchor accumulation, subjective delight).
- **Disposition:** `ready-for-human` — next step is an owner action (start/complete the usage window), not code and not a decision. Same for closeout of the epic itself.

### YUK-406 — Phase 0 关系脑 thin slice
- **Category:** enhancement.
- **Grounding:** full desc fetched. The three components (例会 job, conjecture engine, 备课台) all exist in code (see 405 evidence). The ticket's own acceptance criteria are **the same two-week KILL/ALIVE behavioral window**, gated by parent 405's explicit "窗口结束后裁 YUK-406 与本伞收口".
- **Disposition:** `ready-for-human` — identical dependency as 405. Comment explains code-complete, awaiting the owner usage window shared with parent.

### YUK-416 — [DEFERRED] 异质双强 de-bias panel
- **Category:** enhancement.
- **Grounding:** deferral reason (2026-06-18): only meaningful with **two comparable frontier models**; then mimo << Opus, GLM only coding, GPT-5.5-class didn't exist. **Precondition may now be satisfied**: `openai/gpt-6-astra` lane is live (YUK-1027 merged; `src/server/ai/providers.ts` openai-responses wire; contract tests in `astra-responses-contract.test.ts`). Real quality parity is unverified (P3 actual-output eval pending), but the *gate* (a second frontier lane exists) has changed.
- **Disposition:** `needs-info` — respect the original defer but flag the changed precondition to the owner: does Astra's presence warrant un-deferring the de-bias panel, or stay deferred until Astra proves parity?

### YUK-438 — A9 LLM step-grading（PFA 证据倍增器）
- **Category:** enhancement.
- **Grounding:** full desc fetched. Gated on **judge calibration** and **the PFA input contract being rebuilt by the running 1038 migration**. Cross-check: grounding doc (`docs/planning/2026-09-24-question-assessment-implementation-grounding.md` §对应) explicitly says "得分点→学习证据政策复用 YUK-438" — i.e., this ticket's *policy* feeds YUK-1047/1049; the step-grading *producer* itself (LLM rubric-step scoring → binary KC observations feeding PFA) is not in the 1038 ticket set's scope. Jev typed executor (YUK-1049) is a candidate instrument for the multi-sample scoring, blocked on 1047.
- **Disposition:** keep Backlog + `area:practice`; comment records the dependency (wait until 1047 evaluateSubmission lands and judge calibration is addressed). Not ready-for-agent — still owner-gated and instrument-pending.

### YUK-452 — 冷启 day-one MVP epic
- **Category:** epic.
- **Grounding (inc ledger):**
  - inc-A fixed-anchor: **landed** — `src/server/mastery/fixed-anchor.ts` (`setFixedAnchor`, `source='fixed_anchor'`), `/api/calibration/anchors` write path, tests.
  - inc-B placement probe: **landed + flag live** — `PLACEMENT_PROBE_ENABLED=true` in `.env.local` + `docker-compose.mac.yml`; YUK-571 Done; `placement-starter`, `ScreenPlacement.tsx`, `/api/placement/profile` all exist.
  - inc-C onboarding+短自述+goal elicitation: **landed** — `WelcomePage.tsx` writes `declared_stage` via `createGoal`; `goal.declared_stage` column + fold parity + jyeoo consumption (YUK-1009 merged).
  - inc-E prereq 向后传播: **landed but DARK** — `src/server/coldstart/propagate-priors.ts`, `DAY_ONE_PRIOR_ENABLED=false` (`src/core/theta-grid.ts:84`); `day_one_prior` field on placement-profile only when flag on.
  - inc-D AutoElicit θ 先验: **NOT implemented** — design doc says θ=0 seed already sufficient; owner question §6 noted marginal value.
  - inc-F LLM 学生模拟: partially exercised via YUK-376 LLaSA eval → **negative conclusion** (noise 2.2×, no promotion); the design's original inc-F remains unbuilt.
- **Disposition:** `needs-info` — the epic is materially ~4/6 landed; the remainder is owner decisions (flip `DAY_ONE_PRIOR_ENABLED`? is inc-D still worth it? is inc-F still wanted after LLaSA negative?). Recommend closeout-or-split question; contingent sub-ticket for inc-D drafted in sub-tickets.md.

### YUK-492 — 整页 holistic 判分 + 同页密集归属（终态）
- **Category:** enhancement (deferred end-state capture).
- **Grounding:** full desc fetched. Narrow version verified live: `pageScopedQuestionImageRefs` in `auto-enroll.ts` (YUK-488 PR #573) does page-scope per-question judging. The real residual (same-page dense attribution, extraction decoupling, per-sub fold-in) is untouched — by design.
- **Disposition:** keep Backlog + `area:practice`; dormant capture ticket. Desc itself says "不阻塞 — 等真实密集页上传量起来证明是真问题". Comment notes: when the 1038 migration lands `evaluateSubmission` (YUK-1047), a holistic entry should plug into it, not build a parallel path — the ticket is otherwise a valid long-parked enhancement.

### YUK-550 — kg-borrowing × frontier evidence-floor tracked trigger
- **Category:** enhancement (activation-prerequisite capture).
- **Grounding:** all code claims verified — `FRONTIER_MASTERY_MIN_EVIDENCE=4` (`learnable-frontier.ts:121`), borrow branch `applyKgSoftLayer` synthesizes `evidence_count:0` entries (`src/server/mastery/state.ts:519+`, `701+`), both flags hard `false` (`src/core/graph-laplacian.ts:56`, `src/core/prereq-propagation.ts:57`), docblock at `learnable-frontier.ts:112-119` already updated ("conservative by intent / deliberate coupling"). The remaining gap (real `applyKgSoftLayer`-driven DB test, item ②) is real — `learnable-frontier.db.test.ts:201` self-describes as synthetic.
- **Disposition:** keep Backlog + `area:kg`; dormant activation prerequisite (trigger = either flag flips). Owner already ruled P4/不排期 (09-14). Comment records verified-still-dark status.

### YUK-572 — 背景 agent 运行时（议程权分层 + charter 化）
- **Category:** epic.
- **Grounding:** P1 landed — shared scout primitives in `src/capabilities/agency/server/scout/` (`scout-agent.ts`, `evidence-mcp.ts`, `report-findings.ts`, `tool-names.ts`); spawn contract shared in `src/server/ai/spawn-contract.ts`. P2 landed-but-dark — `research_meeting_agent_nightly` job + `ResearchMeetingDirectorTask` registered (`src/capabilities/agency/jobs/research_meeting_agent_nightly.ts`, `director.ts`, `director-tools.ts`), kill switch `RESEARCH_MEETING_AGENT_ENABLED` default OFF (not set in .env.local/compose). P3 **not landed** — `dreaming_nightly.ts`/`knowledge_maintenance` have no `agents` scout hookup or charter objective; architecture.md still lists them as deterministic tool-loops.
- **Disposition:** `needs-info` — remaining work is (a) owner flips the shadow-lane kill switch + runs the ≥2-week comparison (owner ops + evidence judgment), and (b) P3 charterization of dreaming/maintenance. A P3 sub-ticket is proposed in sub-tickets.md (owner-approved direction, spec exists in `docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md`).

### YUK-588 — 夜间自主 AI 链聚合成本预算/订阅额度机制
- **Category:** enhancement (report-only governance).
- **Grounding:** claims verified — `induceConjecture` runs Opus on the anthropic-sub OAuth lane (`src/capabilities/agency/server/conjecture/induce.ts:456`); ~24 cron registrations across capability manifests (`grep cron:` → 24 matches, incl. notes/knowledge/agency/practice/observability night chains); per-job caps exist but no aggregate ledger. YUK-377 (cron audit) and YUK-580 (overnight digest) both Done — the "fold into digest vs standalone lane" question desc raises is unresolved.
- **Disposition:** `needs-info` + `area:ops` — next step is owner deciding whether an aggregated subscription-quota/budget surface is worth a lane (or a YUK-580-style digest extension). Not code yet.

### YUK-766 — 订阅系统灾备恢复语义（backup excludes checkpoint/delivery）
- **Category:** bug (latent) / design decision.
- **Grounding:** subscription system is live — `src/server/event-subscriptions/runtime.ts` implements `bootstrapSubscription` + `bootstrap_skipped` marking (verified in `runtime.db.test.ts:120`); `src/server/export/archive.ts` confirms `RESTORE_WIPE_ONLY_TABLES = effect → delivery → checkpoint` (the three subscription tables are wipe-not-backup). Current production subscriber `notes.mastery-progress-note-refine` is a deliberate no-op.
- **Cross-check vs YUK-1055 (in-flight):** 1055's scope is *cutover-time* pending-delivery translation ("outstanding delivery 显式翻译，不盲目 replay 历史也不跳过 pending") — same machinery, **but 1055 does not cover the backup-exclusion product decision** (whether checkpoint/delivery should enter backups, or which restore-time semantics apply). 766 remains the correct home for that decision.
- **Disposition:** `needs-info` + `area:ops` — the ticket itself says the decision should be made *before the effect-slice lane lands real handlers*. Question for owner: adopt recommendation (a) — checkpoint/delivery enter backups — now, or defer and document (c)?

### YUK-856 — [FULL/F0.O1] Observe and enforce provider attempts in production
- **Category:** ops.
- **Grounding:** `scripts/audit-provider-attempt-truth.ts` exists; ticket explicitly excludes product-code changes, requires owner deployment authorization + production observation of real lanes (DashScope/GLM/OCR/Tencent/Mem0). Parent YUK-845 is now **Done** — meaning the code-side F0 work landed; 856 remains correctly open as the *operational* counterpart (observe→enforce rollout + owner authorization pending).
- **Disposition:** `ready-for-human` (label correct, keep) + `area:ops` already set. Comment notes parent Done, prerequisite (F0.5 + owner deploy auth) still gates.

### YUK-922 — 组卷面 self_confidence 落地（AttemptOnQuestion 缺槽位）
- **Category:** enhancement.
- **Grounding:** verified — `AttemptOnQuestion` (`src/core/schema/event/known.ts`) has `reasoning_trace`/`hints_used`/`duration_ms` but **no `self_confidence`**; `ReviewOnQuestion` does (`known.ts:324`, optional int 1-5, observe-only). PfSolo wires it (`buildCaptureFields`); PfPaper cannot (`PfPaper.capture.unit.test.ts:6` documents the missing slot). Two unresolved decisions per desc: (1) schema slot design (add to AttemptOnQuestion? separate capture event? fold into ResponseSet?), (2) UI interaction shape (per-question vs per-submission collection) — UI design preflight required.
- **Cross-check vs YUK-1052:** 1052 owns `saveSubmission`/`issueAssessment` + ResponseSet schema for the 1038 migration — it is redefining the submission contract. The `self_confidence` slot is a contract-level question best decided *with* 1052 (avoids a second schema migration). 922 is **not absorbed** but its decision should be sequenced before/with 1052.
- **Disposition:** `needs-info` + `area:practice` — two concrete owner/design questions; questions.md carries them.

### YUK-999 — matcher live caller 后 axis C 重标定
- **Category:** enhancement (conditional trigger).
- **Grounding:** `MATCHER_COSINE_MAX_DISTANCE=0.35` exported (`matcher.ts:72`); `pnpm audit:calibration` + `audit-threshold-calibration.ts` exist (report-only, reads the same constant). Matcher's only caller is `question-supply/refill.ts` (`Demand` consumed there), gated by `QUESTION_SUPPLY_REFILL_ENABLED` — **not set in `.env.local` or compose → refill/matcher dormant** (YUK-677 desc itself says "路径 dormant"). Precondition unmet.
- **Disposition:** keep Backlog + `area:matcher`; dormant conditional trigger. Comment records verified-still-dormant status.

### YUK-1028 — GPT-6 Astra P2：费用归因、缓存与逐次调用预算闭合
- **Category:** enhancement.
- **Grounding:** partial premise stale — desc says "attempt-cost.ts 通用分支把非 xiaomi 正 reportedCostUsd 归为 reported"; **already fixed**: `resolveAttemptCostTruth` now explicitly classifies `opencode-go`/`openai` lanes as `basis:'estimated'` with `pi-catalog:` ref (`attempt-cost.ts:51-61`). pi 0.85.1 cache-token reading confirmed via `pi-models.ts` comments + Astra contract tests. Remaining real scope: OpenAI local pricebook (tiers 272K boundary), root/child non-double-count, per-wire budget closure.
- **Critical context:** PLAN.md 09-23 records **owner 叫停 P2 回 Backlog**（"重启基线=main"）— the `ready-for-agent` label contradicts the owner's explicit pause. Restart needs owner authorization (likely bundled with the 1029 LIGHT/FULL decision).
- **Disposition:** `needs-info` (remove `ready-for-agent`) — draft brief written at `briefs/YUK-1028.md` so a restart is executable the moment owner approves. Question = restart P2 standalone or fold into the P3 scope decision?

### YUK-1029 — GPT-6 Astra P3：迁移任务清单 + 真实输出对照 + 灰度验收
- **Category:** enhancement.
- **Grounding:** `needs-info` label correct. Stale check: Astra P1 (YUK-1027) merged (openai lane live); P2 owner-paused (1028). The pending decision is unchanged: **LIGHT (recommended: Copilot/SupplyPlanTask/SolutionGenerationTask etc.) vs FULL (51 TaskSpec by family)** + actual-output budget. That decision now likely also gates whether P2 restarts standalone.
- **Disposition:** `needs-info` (keep) — comment refreshes the question to fold in the P2 restart.

### YUK-1033 — 学段纠正面：goal.declared_stage 用户可达编辑入口
- **Category:** enhancement.
- **Grounding:** verified — `declared_stage` persisted at onboarding (WelcomePage → `createGoal`), correctable via `updateGoalScope` command (`goals/commands.ts:43` accepts `declared_stage`, writes `experimental:goal_scope_update` event) — **but no user-facing UI entry** exists (grep `declared_stage` in `web/` and `onboarding/ui/` returns only WelcomePage set-path; no settings/edit surface). PLAN.md 09-24 records owner deferral to YUK-1007 config panel.
- **Disposition:** `needs-info` + `area:ui` — blocked-on-1007 per owner ruling; question = confirm the deferral and whether 1033 should be a formal child of 1007.

### YUK-1040 — seed:*:root 残留处置（θ̂ 过滤 + owner ops）
- **Category:** mixed (part code, part owner-ops).
- **Grounding:** part A (θ axis) **verified real gap** — `review-settlement.ts` builds `fsrsKnowledgeIds` with `SYNTHETIC_SUBJECT_ROOT_RE` filter (YUK-1037), but `theta.knowledgeIds` at both call sites (`:519`, `:955`) passes unfiltered ids to `updateThetaForAttempt`. Production currently has no seed-root mastery_state rows, but the write path is live (latent pollution). Part B (存量 FSRS 行 + 4 道 seed-root 绑题处置) is owner-ops, options enumerated in the ticket + `docs/audit/2026-09-24-question-binding-audit.md`.
- **Disposition:** `needs-info` + `area:practice`; **split proposed** in sub-tickets.md — (a) code ticket for θ-axis filter (ready-for-agent once owner confirms semantics parity), (b) owner-ops ticket for存量处置, (c) optional plan-executor coarse-fallback semantics question. Original ticket stays open as needs-info parent until owner picks the θ-axis口径.

## Needs-full-text check

None required — all TRUNCATED tickets were fetched in full via Linear `get_issue` during triage.
