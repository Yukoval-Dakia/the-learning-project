# Station 3 (YUK-188) — Layer-8 flywheel end-to-end validation PLAN

Status: PLAN (do not commit until approved)
Date: 2026-06-01
Owner: data-activation drive (capstone of Stations 1 / 2A / 2B)

---

## Goal

Stations 1 / 2A / 2B each wired ONE seam of the Layer-8 flywheel and tested it
in isolation against an empty / single-fixture DB. Station 3 is the **first time
the whole flywheel runs together on one shared synthetic dataset**: brief regen
→ goal cron → accept → dreaming → coach → edge-propose, all reading each other's
writes through the production read seams.

The deliverable is a **focused e2e validation test**, NOT a new framework. The
e2e test IS the discovery mechanism: build it, and every red assertion is a real
cross-layer integration bug to fix in a focused commit. If all assertions are
green on first run, Station 3 collapses to pure validation + closeout.

Anti-over-engineering guardrails:
- ONE new DB test file. No new harness, no scenario DSL, no fixtures framework.
- Reuse the existing seed harness verbatim (`runSeed` / `runStubbedNightly` /
  `printReport` from `scripts/seed-synthetic.ts`) and the existing per-layer stub
  helpers (`coachWithGoalStrand`, `makeStub`, `cannedDraft`, the goal `fakeRunTask`).
- All LLM calls stubbed — zero tokens. `testDb()` + `resetDb()` in `beforeEach`.
- The `--observe` report extension is OPTIONAL and minimal (see §The e2e test).

---

## The e2e test

### Placement decision

**New file: `tests/integration/layer8_e2e.db.test.ts`.** Do NOT extend
`tests/integration/seed-synthetic.db.test.ts`.

Rationale: the seed test (`seed-synthetic.db.test.ts:97-224`) is a tight
single-purpose proof that the *seed + reset* harness behaves (5 slices + the
`--reset` hard gate + idempotency). Station 3 adds the **author layers** on top
(brief, goal, accept, dreaming, coach) which the seed harness deliberately does
NOT touch. Mixing them would (a) blow up the seed test's runtime and surface
area, and (b) couple two different concerns. The new file `import`s the same
harness functions, so there is no duplication of seed logic.

The new file lives in the **`.db` partition** (it touches `testDb()`,
`memory_brief_note`, `goal`, `event`, `material_fsrs_state`, `proposal_signals`).
It uses `tests/helpers/db` (`testDb` :10, `resetDb` :49), `beforeEach(resetDb)`.

### Stub strategy (the Station-3 seam set)

One canned-LLM stub per author layer, each returning the exact schema its parser
expects. All are `TaskTextRunFn` / `runAgentTaskFn` shapes — `provenance.ts:1-7`
(`{ text, task_run_id?, cost_usd? }`). Reuse the proven helpers:

| Layer | Stub seam | Reuse |
|---|---|---|
| Brief regen | `buildBriefGenerator({ db, runTaskFn })` 3rd-arg `runTaskFn` | `makeStub` + `cannedDraft` from `brief-writer.db.test.ts:45-66` |
| Goal cron | `runGoalScopeProposeNightly(db, { runTaskFn })` | `fakeRunTask` shape from `scope.test.ts:75-81` — **must cite seeded `synthetic:wenyan:*` ids** (see Risk 1) |
| Accept | `acceptAiProposal(db, proposal_id)` — no stub, no opts | `scope.test.ts:124` |
| Dreaming | `runDreamingNightly(db, { listActiveGoalsFn, runAgentTaskFn, buildMcpServerFn, listProposalInboxRowsFn, loadProposalAcceptanceRatesFn, writeEventFn, now })` | `dreaming_nightly.test.ts:29-49` |
| Coach | `runCoach(db, 'daily', { listActiveGoalsFn, runAgentTaskFn, buildMcpServerFn, listProposalInboxRowsFn, writeEventFn, now })` | `coachWithGoalStrand` from `coach_daily.northstar.test.ts:130-154` |
| Edge-propose | `runStubbedNightly(db)` (wraps `runKnowledgeEdgeProposeNightly(db, { runTaskFn })`) | `seed-synthetic.ts:848-870` |

Decision on **goal seam for the consumers**: drive the *full live chain* —
real `acceptAiProposal` → real `listActiveGoals` feeds Coach/Dreaming/Review via
the **default** seam (do NOT inject `listActiveGoalsFn` for the read; inject it
only where a unit needs the goal echoed deterministically — see per-slice notes).
This is the whole point of Station 3: prove the real `listActiveGoals` join, not
a re-stubbed fixture. Where a consumer's `db` is a real `testDb()` (it is), its
default `listActiveGoalsFn` already reads the materialized goal.

### Execution order (dependency order)

```
beforeEach: resetDb()

1. seedSentinel(db, now)            // optional — only if also asserting reset survives; can drop for e2e
2. runSeed(db, now)                 // synthetic:wenyan:* nodes + questions + attempts/reviews/signals/rubric-rejected
3. brief regen — GLOBAL scope:
     regenerateMemoryBrief({ db, scopeKey:'global', searchFacts:async()=>[],
       generate: buildBriefGenerator({ db, runTaskFn: briefStub([e1,e2]) }), now:()=>NOW })
4. brief regen — SUBJECT scope 'subject:wenyan' (same drive, scopeKey:'subject:wenyan')
5. goal cron:
     const goalRes = await runGoalScopeProposeNightly(db, { runTaskFn: goalStub })
6. accept:
     const accepted = await acceptAiProposal(db, goalRes.proposal_id!)
7. dreaming:  runDreamingNightly(db, dreamingDeps)
8. coach:     runCoach(db, 'daily', coachDeps)
9. edge-propose nightly:  runStubbedNightly(db)
10. assert all slices (below)
```

`now` is a single shared `const NOW = new Date()` (or a fixed ISO like
`brief.db.test.ts:19`) threaded into every `now: () => NOW` so freshness /
due-windows / 24h cluster windows all agree.

### Slices + exact assertions

**Slice A — Brief write→read round-trip + P5.3 freshness (global)**
Drive step 3 with `briefStub` citing two seeded events that exist in the loaded
window (so the D3 filter keeps them and the freshness scorer resolves them).
```ts
const out = await executeMemoryBrief(toolCtx(), { scopeKey:'global', includeEvidence:true });
expect(out.note).not.toBeNull();                                  // context-readers.ts:1095
expect(out.note?.recent_week_md).toContain('Recent week');        // recent_week_md non-empty
expect(out.note?.long_term_md).toContain('recurring weak spot');
expect(out.note?.long_term_freshness_score).not.toBeNull();       // P5.3 non-null (knownCount>0), brief-freshness.ts:53
expect(out.evidence?.long_term_ids.length).toBeGreaterThan(0);
```
`toolCtx()` = `{ db: testDb(), taskRunId:'e2e', callerActor:{kind:'system',ref:'test'} }`
(`brief-writer.db.test.ts:68-70`).

**Slice A' — Subject-scope brief is independently readable**
After step 4, `executeMemoryBrief(toolCtx(), { scopeKey:'subject:wenyan' })` →
`out.note` not null AND distinct row from `global` (different `scope_key`). This
proves the scope-key write target (`brief.ts:300` onConflict `scope_key`) and the
read filter (`context-readers.ts:1090-1094`) agree — see Risk 4.

**Slice B — Goal materialized → listActiveGoals join**
```ts
expect(goalRes.proposed).toBe(1);                  // goal_scope_propose_nightly.ts result
expect(goalRes.proposal_id).toBeTruthy();
expect(accepted.kind).toBe('goal_scope');          // actions.ts:576
const active = await listActiveGoals(db);          // queries.ts:114
const g = active.find(a => a.id === accepted.goal_id);
expect(g).toBeTruthy();
expect(g!.subject_id).toBe('wenyan');              // picked domain == subject_id (cron :125)
expect(g!.scope_knowledge_ids.length).toBeGreaterThan(0); // real synthetic ids survived scope.ts:92
```

**Slice C — Coach receives + biases on the goal**
Run step 8 with `runAgentTaskFn: coachWithGoalStrand(active)` and a capturing
`writeEventFn` (capture `experimental:coach_scan` payload, `coach_daily.ts:290`).
```ts
// (1) the goal REACHED the model (buildCoachInput → coach_daily.ts:143-149):
expect(coachStub.mock.calls[0][1].active_goals.map(x=>x.id)).toContain(accepted.goal_id);
// (2) bias is ACTIVE in the persisted plan:
expect(scanPayload.today_plan.goal_strand.length).toBeGreaterThan(0);
expect(scanPayload.today_plan.goal_strand[0].serves_goal_id).toBe(accepted.goal_id);
expect(scanPayload.today_plan.goal_ids).toContain(accepted.goal_id);
```

**Slice D — Dreaming receives the goal scope**
Run step 7 with `runAgentTaskFn` that asserts the echo and returns `{text:'{}', task_run_id:'d1'}`.
```ts
const callInput = dreamingStub.mock.calls[0][1];
expect(callInput.active_goals.map(x=>x.id)).toContain(accepted.goal_id);
expect(callInput.active_goals[0].scope_knowledge_ids).toEqual(g!.scope_knowledge_ids);
```
(The "tagged proposal" half is OUT OF SCOPE for the deterministic e2e — proving a
real MCP-tool-written proposal requires a live `buildMcpServerFn`; the load-bearing
proof is the input echo. Note in test.)

**Slice E — Review due-list goal-bias reorder**
Pure deterministic rerank, NO LLM (`due-list.ts:400-433`). The seed already plants
overdue questions (`SEED_PROFILE.overdueReviewedQuestions:4`, due_at backdated
`seed-synthetic.ts:513`). Requires ≥1 overdue question whose `knowledge_ids`
intersects `g.scope_knowledge_ids` AND ≥1 that does not (else early-return :431).
The cron's `scope_knowledge_ids` come from the LLM stub — **set the goal stub's
scope to a node that some seeded overdue question references** (Risk 6).
```ts
const res = await handleReviewDue(new Request('http://localhost/api/review/due?limit=50'), {});
const ids = (await res.json()).rows.map(r => r.id);
// goal-relevant overdue floats ahead of non-relevant overdue:
expect(ids.indexOf(qInScope)).toBeLessThan(ids.indexOf(qOutOfScope));
```
`handleReviewDue` reads goals via its DEFAULT `listActiveGoalsFn` (bound to
`testDb()`), so the real materialized goal drives the reorder — the full join.

**Slice F — proposal_signals digest + L2 gate bump** (seed-provided)
```ts
const rates = await getProposalAcceptanceRates(db);
expect(rates.length).toBeGreaterThan(0);
expect(rates.every(r => r.total > 0)).toBe(true);
const bump = await resolveEdgeGateBump(db, 'related_to', PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG);
expect(bump.tightenMediumToStrong).toBe(true);    // L2_DISMISS_RELATION='related_to' (seed-synthetic.ts:174)
```

**Slice G — FSRS due > 0** (seed-provided)
```ts
const dueRows = await db.select({id: material_fsrs_state.subject_id})
  .from(material_fsrs_state)
  .where(and(eq(material_fsrs_state.subject_kind,'question'),
             sql`${material_fsrs_state.due_at} <= ${NOW.toISOString()}::timestamptz`,
             sql`${material_fsrs_state.subject_id} LIKE 'synthetic:q:%'`));
expect(dueRows.length).toBeGreaterThan(0);
// OR via the real route: (await handleReviewDue(req,{})).json().rows.length > 0
```

**Slice H — active-subject detection** (seed-provided, but interacts with Slice A')
```ts
const activeSubs = await listActiveSubjectsSinceRefresh(db, { now: NOW });
expect(activeSubs.some(a => a.subjectId === 'wenyan')).toBe(true);
```
**Interaction caveat (Risk 5):** if step 4 wrote a `subject:wenyan` brief BEFORE
this assertion, the subject's floor becomes its own `refreshed_at` (=NOW), and
active detection compares the newest qualifying event against that floor. The
seeded attempts are <= NOW, so newest-event-strictly-after-floor may flip false.
Assert Slice H **BEFORE** step 4's subject-scope brief regen, OR seed an attempt
after the brief's `refreshed_at`. The e2e ordering must place Slice H assertion
relative to step 4 deliberately — documented inline.

### Optional `--observe` report extension (minimal)

OPTIONAL: extend `ObserveReport` (`seed-synthetic.ts:872-880`) + `printReport`
with `brief_global_present: boolean`, `goal_materialized: boolean`,
`coach_goal_strand: boolean`. Keep it to 3 booleans, no new query helpers beyond
the read seams already imported. Skip if it adds churn — the e2e test assertions
are the source of truth; the report is only for the human `pnpm seed --observe`
walk-through. **Default: skip unless the closeout walk-through needs it.**

---

## Integration-risk list (ranked by likelihood)

This is the high-value part. Each layer was tested against an empty/isolated DB;
these are the concrete cross-layer mismatches most likely to surface when they
run together. For each: the file:line to check + how the e2e catches it.

**Risk 1 (HIGH) — Goal stub cites ids the scope filter drops → empty goal.**
`runGoalScopeAndWrite` drops hallucinated ids (`scope.ts:92`); if the goal stub's
`scope_knowledge_ids` cite ids NOT present as real `knowledge` rows, `scope_count`
collapses to 0 and the materialized goal has empty `scope_knowledge_ids`, which
silently no-ops every downstream consumer (Coach strand empty, Review rerank
early-returns `:431`). **Fix in stub:** the goal stub MUST cite seeded
`synthetic:wenyan:*` node ids (e.g. `NODES.xuci`, `NODES.jushi`). **Catch:**
Slice B `expect(g!.scope_knowledge_ids.length).toBeGreaterThan(0)` + Slice E
reorder assertion go red if the scope is empty.

**Risk 2 (HIGH) — Each stubbed LLM output must match its parser's schema.**
Five distinct parsers, five distinct schemas; a dropped/renamed field throws at
parse and the whole layer fails (or silently swallows). Check points:
- Brief: `BriefDraftOutputSchema` — all 6 keys required (`brief-writer.ts:55-69`).
  Reuse `cannedDraft` verbatim (`brief-writer.db.test.ts:45-54`).
- Goal: `parseGoalScopeOutput` — `scope_knowledge_ids` + non-empty `reasoning`
  required; empty reasoning throws (`scope.test.ts:43-44`). Reuse `fakeRunTask`.
- Coach: TodayPlan schema with `goal_strand`/`goal_ids` (`coachWithGoalStrand`,
  `northstar.test.ts:134-149`). Reuse verbatim.
- Dreaming: agent-task; `{text, task_run_id}` minimal is enough for the input-echo
  proof (`dreaming_nightly.test.ts:29-35`).
- Edge: `EdgeProposeOutput` `{proposals:[{from_knowledge_id,to_knowledge_id,relation_type,weight,reasoning}]}` (`seed-synthetic.ts:851-861`).
**Catch:** any schema drift throws synchronously inside the corresponding step →
the test errors at that `await`, pinpointing the layer. **Mitigation:** reuse the
exact canned helpers rather than hand-writing JSON.

**Risk 3 (HIGH) — Goal cron skip-gates fire on the seeded DB → `proposed:0`.**
Two dedup gates: live-goal (`goal_scope_propose_nightly.ts:130`) and pending
`goal_scope` proposal (`:140`). The seed does NOT plant a goal or a pending
goal_scope proposal, so this should pass — BUT if the e2e runs the goal cron
TWICE (or re-runs in a loop), gate 2/3 fire and `proposed:0`. Also: the cron
picks the domain with the **most weak nodes** among `KNOWN_SUBJECT_IDS`
(`'wenyan'|'math'|'physics'`, `:111-117`); the seed only plants `wenyan` nodes
with no mastery (read as 0.5 < 0.55 = weak, `:69`), so `wenyan` wins. If a future
seed change adds mastery rows >= 0.55 to all wenyan nodes, `domain===null` →
`skipped_no_weak`. **Catch:** Slice B `expect(goalRes.proposed).toBe(1)` red.

**Risk 4 (MEDIUM) — Brief scope_key write target vs read filter mismatch.**
`regenerateMemoryBrief` upserts on `scope_key` (`brief.ts:300` onConflict target),
`executeMemoryBrief` reads `where(eq(scope_key, scopeKey))` with
`scopeKey = input.scopeKey ?? 'global'` (`context-readers.ts:1089-1094`). For the
subject scope the caller must pass the SAME literal string on both sides
(`'subject:wenyan'`). A mismatch (e.g. `subject:wenyan` write vs `wenyan` read)
yields `note:null`. **Catch:** Slice A' `expect(out.note).not.toBeNull()` red.

**Risk 5 (MEDIUM) — Subject-brief regen poisons active-subject detection.**
`listActiveSubjectsSinceRefresh` uses each subject's `refreshed_at` as its floor
(`active-subjects.ts:177-179`); a never-built subject floors at `now-30d`. Step 4
writes a `subject:wenyan` brief with `refreshed_at=NOW`, raising the floor so the
seeded attempts (<= NOW) may no longer be strictly-after → `wenyan` drops out of
active. **Catch:** Slice H flips red if asserted after step 4. **Resolution:**
assert Slice H before step 4, documented inline (ordering is load-bearing).

**Risk 6 (MEDIUM) — Review rerank needs split overdue + scope intersection.**
`rerankOverdueByGoals` early-returns unchanged unless BOTH a goal-relevant and a
non-relevant overdue item exist (`due-list.ts:431`). The seed's overdue questions
carry `referenced_knowledge_ids` pointing at synthetic nodes; the goal's
`scope_knowledge_ids` come from the goal stub. These two sets must INTERSECT for
≥1 overdue question and EXCLUDE ≥1 other. **Fix:** point the goal stub's scope at
a node referenced by exactly some (not all) seeded overdue questions; confirm the
seed plants overdue questions spanning ≥2 distinct nodes. **Catch:** Slice E
reorder assertion red (or no observable reorder).

**Risk 7 (LOW) — Dreaming/Coach default acceptance-rate reader hits real digest.**
With a real `testDb()`, Coach/Dreaming default `loadProposalAcceptanceRatesFn` /
`loadAcceptanceRates` to `getProposalFeedbackDigest(db, …)` (`coach_daily.ts:35,121`,
`dreaming_nightly.ts:249-251`). On the seeded DB this returns a non-empty digest
(the L2 cluster), which is GOOD (proves Slice F feeds the prompt) but means the
prompt input is larger than the unit tests' empty digest. No correctness risk;
the stubs ignore the digest. **Catch:** N/A (informational) — but verify the
Coach/Dreaming runs don't throw on a populated digest (`rollUpToPerKindRate`
`dreaming_nightly.ts:144-169`). The e2e exercising it IS the check.

**Risk 8 (LOW) — `now` divergence between freshness clock and writer anchor.**
`regenerateMemoryBrief`'s `now: () => Date` drives the freshness clock; the
writer's bucket-anchor ISO `now` is stamped separately inside `buildBriefGenerator`
(`brief-writer.ts:190-207`) and is NOT threaded from the host. Documented
divergence. **Catch:** the brief stub asserts `typeof input.now === 'string'`
(`makeStub` `brief-writer.db.test.ts:63`); freshness assertions use the host `NOW`.
No fix needed — just don't assume they're the same clock.

**Risk 9 (LOW) — pg-boss handler factory is bypassed.**
The e2e drives the pure functions directly (the proven seed pattern), NOT through
`registerMemoryHandlers` / pg-boss (`handlers.ts:56`). This is intentional and
matches every existing DB test. The seam injection (`buildBriefGenerator` bolted
on at `handlers.ts:56`) is covered by the brief-writer test; the e2e covers the
function-level composition. **Not a defect** — call out in scope so reviewers
don't expect a full worker boot.

---

## Scope decision

Station 3 is **(b) validation + bug-fixes, gated on what the e2e surfaces.**

The plan's stance: **build the e2e first; treat each red assertion as a real
integration bug to fix in a focused commit.** The risk list says the most likely
failures (Risks 1, 3, 6) are *test-fixture wiring* (goal stub must cite real
seeded ids; ordering of Slice H), not necessarily product bugs — but Risks 4 and
5 are genuine cross-layer mismatches that, if red, are product/contract bugs
warranting a fix commit. We do NOT pre-judge: the e2e is the discovery mechanism.

- If all slices green after correct stub wiring → Station 3 = **pure validation +
  closeout** (the layers compose cleanly; ship the test + closeout doc).
- If any slice red after correct wiring → fix the underlying layer in a focused,
  separately-reviewed commit; re-run the e2e green; THEN closeout.

Either way the deliverable is small: one test file (+ optional 3-bool report) and
the closeout doc.

---

## Closeout doc outline

Part of Station 3's deliverable. Write `docs/superpowers/status.md` update (or a
data-activation closeout section) covering:

1. **Stations recap** — 1 (synthetic seed harness + 5-slice proof), 2A (brief
   writer bolted onto regen seam, `handlers.ts:56`), 2B (goal cron → accept →
   3 consumers), 3 (this e2e: full flywheel on shared synthetic data).
2. **What is now observable** — `pnpm seed --observe` lights the 5 seed slices;
   the e2e proves brief read-back + P5.3 freshness, goal materialization →
   `listActiveGoals` join → Coach goal_strand + Dreaming goal echo + Review
   goal-bias reorder.
3. **Integration bugs found + fixed** (fill from the e2e red list, if any).
4. **Deferred backlog** (explicitly carried, NOT silently dropped):
   - **YUK-187** — (carry forward per existing backlog).
   - **Strategy-D real-ingestion** — synthetic seed is a stand-in; real ingestion
     pipeline activation deferred.
   - **Goal chip-UI** — the goal materializes server-side; the UI surface
     (goal chips) is deferred (no UI in Station 3 — backend/test only).
   - **Mem0 `OPENAI_API_KEY`** — fact-store live path blocked on key; brief regen
     `searchFacts` is stubbed to `[]` in the e2e.
   - **Dreaming "tagged proposal" deep assertion** — deferred (needs live MCP
     bridge; e2e proves only the input echo).
5. **Linear capture gate** — file/refresh issues for any e2e-discovered bug and
   for the deferred items above that lack a tracking issue.

---

## Gate (before claiming Station 3 done)

- `pnpm vitest run --config vitest.db.config.ts tests/integration/layer8_e2e.db.test.ts` green (Docker up).
- `pnpm typecheck`, `pnpm lint`, `pnpm audit:partition` (new file is in the db
  partition — it imports `testDb`), `pnpm audit:schema` (no new write paths added).
- Full `pnpm test` + `pnpm build` before PR.
- Independent reviewer pass on the e2e test (separate lane; do not self-approve).
- Linear capture gate (issue per discovered bug + deferred-backlog tracking).

---

## Out of scope

- No new harness / DSL / fixtures framework — reuse `scripts/seed-synthetic.ts`.
- No pg-boss worker boot / `registerMemoryHandlers` integration (function-level only).
- No live LLM, no live Mem0, no real ingestion (Strategy-D deferred).
- No UI (goal chip-UI deferred).
- No Dreaming live-MCP "tagged proposal" assertion (input echo only).
- No multi-subject (math/physics) seeding — `wenyan` only, matching the seed.
- No changes to the seed harness behavior beyond the optional 3-bool report.
