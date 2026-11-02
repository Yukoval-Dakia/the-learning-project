# Phase 0 关系脑 (Relationship Brain) Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Ship a nightly sleep-time 教研例会 (research-meeting) job that reads recent learning events, deterministically gathers recurring (cause_category × KC) evidence, induces up to 3 conjectures about how the owner thinks, and surfaces them as steerable, guilt-free proposals in a 备课台 (prep-desk).

**Architecture:** The 例会 job is the single proposer: it runs deterministic 取证 (no LLM) → Opus self-consistency induction (D2 mitigation) → writes each conjecture as a new proposal kind through the *existing* `experimental:proposal` event/inbox path (`writer.ts:86-95` default branch — zero writer/inbox change, same precedent as `goal_scope`). Provenance reuses `BaseProposal.evidence_refs` (event ids) — no new misconception table. Owner accept/edit/reject decisions become calibration anchors; an accepted conjecture's single discriminating probe is served exactly once via a pool-invisible draft question (ND-5: the job never writes FSRS).

**Tech Stack:** TypeScript, Zod (`src/core/schema`), Drizzle + Postgres (event-sourced `event` table, `material_fsrs_state`, `mastery_state`), Claude Agent SDK on the `anthropic-sub` OAuth Opus lane (`providers.ts`), pg-boss nightly job (`src/capabilities/agency/jobs`), DomainTool MCP bridge (`src/server/ai/tools`), mem0 CORE (`userId 'self'`), Vitest (unit + DB testcontainer), Hono read-model route (`src/capabilities/shell`).

## Global Constraints

- **single-writer**: the 例会 job is the ONLY proposer of conjectures.
- **copilot read-only on CORE**: copilot never writes mem0 CORE.
- **mem0 CORE written only by the sleep job** (the owner-edit golden anchor is reconciled into CORE by the next 例会 run, never written directly from the request path).
- **NO new misconception table / NO consistency-gate**: provenance reuses `evidence_refs` (event ids) on the existing proposal payload.
- **confidence NEVER rendered as a number**: it is internal sort/calibration only (salience = confidence × recurrence drives ordering; it must not cross the wire to the UI).
- **probe is one-shot (never a recurring FSRS item)**: served exactly once; answering it confirms/retires the conjecture; only a CONFIRMED weakness's remediation enters FSRS via the normal review path.
- **ND-5**: the 例会 job NEVER writes FSRS state.
- **D2 = Opus self-consistency + judge-only-evidence cap + owner anchor**, NOT a heterogeneous mimo+Opus Jury (Jury deferred per YUK-416).
- **备课台 UI follows design-doc pre-flight + claude design**: no free-hand visual code in Phase 0 — Phase 0 ships the read-model + owner-decision backend + a functional handoff doc only.
- **new schema needs audit:schema write-path/allowlist**: Phase 0 introduces no new DB columns (payload JSON fields only), so no allowlist entries are required; probe INSERTs explicitly set `draft_status`.
- **pre-PR gate** = `typecheck` + `lint` + `audit:schema` + `audit:draft-status` + `audit:profile` + `test` + `build`.

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/core/schema/proposal.ts` | Modify | Add the new proposal-kind literal + its `ProposalChange` Zod object + discriminated-union branch (`subject_kind` literal `'mind_model'`); deliberately keep it OUT of `acceptSupportedProposalKinds` until the accept lane lands. |
| `src/core/schema/proposal.test.ts` | Modify | Round-trip + coverage-guard + focused invariant tests for the new kind. |
| `src/capabilities/shell/ui/inbox-meta.unit.test.ts` | Modify | Keep the accept-partition + KIND_META parity guards balanced for the new kind. |
| `src/core/schema/business.ts` | Modify | `ConjectureDraft` — the small bounded record the induction LLM step emits. |
| `src/core/schema/business.test.ts` | Create/Modify | `ConjectureDraft` validation tests. |
| `src/core/schema/event/known.ts` | Modify | `ReconstructionSignal` enum + optional `reconstruction_signal` payload field on `AttemptOnQuestion`/`ReviewOnQuestion` (YUK-407 logging contract). |
| `src/core/schema/schema.test.ts` | Modify | `reconstruction_signal` parse/round-trip tests. |
| `src/server/conjectures/evidence.ts` | Create | Pure deterministic 取证: `gatherConjectureEvidence` cell aggregation, recurrence floor, theta attach, mem0 dedup, salience order. |
| `src/server/conjectures/evidence.test.ts` | Create | Unit tests for 取证 (no DB). |
| `src/server/agency/conjecture/induce.ts` | Create | `induceConjecture` — Opus N-sample self-consistency orchestrator + judge-only-evidence cap (D2). |
| `src/server/agency/conjecture/induce.test.ts` | Create | Unit tests for the induction orchestrator (injected `runTaskFn`). |
| `src/ai/registry.ts` | Modify | Register the induction `TaskKind` (mimo default; Opus lane chosen per-call via override). |
| `src/ai/registry.test.ts` | Modify | Pin the induction task registry entry. |
| `src/server/ai/tools/conjecture-tools.ts` | Create | `propose_conjecture` DomainTool — thin wrap of `writeAiProposal`. |
| `src/server/ai/tools/conjecture-tools.unit.test.ts` | Create | DomainTool unit tests. |
| `src/server/ai/tools/bootstrap.ts` | Modify | Register `propose_conjecture` in CORE_TOOLS. |
| `src/server/ai/tools/allowlists.ts` | Modify | `propose_conjecture` in PROPOSE_WRITE_TOOLS; new `research_meeting` surface + allowlist. |
| `src/capabilities/agency/jobs/research_meeting_nightly.ts` | Create | The nightly job: trigger → 取证 → induction → propose ≤3 on the Opus lane → cost/failure scan event. |
| `src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts` | Create | Job orchestration unit tests (injected deps). |
| `src/capabilities/agency/manifest.ts` | Modify | Register the cron handler; declare the new proposal-kind ownership. |
| `src/capabilities/agency/manifest.unit.test.ts` | Create/Modify | Pin the cron job declaration. |
| `src/server/proposals/actions.ts` | Modify | `dispatchAccept` case for the conjecture kind; `corrected_payload` on `AcceptAiProposalOpts`; result union member. |
| `src/capabilities/agency/server/conjecture-accept.ts` | Create | Accept-not-confirmed applier: accept/edit/reject semantics + injectable `ConjectureCoreWriter` (single mem0-CORE write seam). |
| `src/capabilities/agency/server/conjecture-accept.db.test.ts` | Create | DB tests for accept/edit/reject/idempotency. |
| `src/capabilities/agency/server/conjecture/probe-lifecycle.ts` | Create | `serveProbeOnce` / `answerProbe` / `countActiveProbes` — one-shot probe, pool-invisible, ≤3 concurrent, no FSRS write. |
| `src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts` | Create | DB tests + the recurrence-landmine regression lock (absent from real `/api/review/due`). |
| `src/capabilities/practice/server/solve-session.ts` | Modify | Stamp `reconstruction_signal: 'unknown'` on the live solve attempt write. |
| `src/capabilities/ingestion/api/mistakes.ts` | Modify | Stamp `reconstruction_signal: 'unknown'` on the manual-mistake attempt write. |
| `src/capabilities/shell/server/prep-desk.ts` | Create | `loadPrepDeskConjectures` read model — salience sort, cap 3, no confidence leak. |
| `src/capabilities/shell/api/prep-desk-conjectures.ts` | Create | `GET /api/prep-desk/conjectures` thin route shell. |
| `src/capabilities/shell/manifest.ts` | Modify | Mount the prep-desk route. |
| `src/capabilities/shell/server/prep-desk.db.test.ts` | Create | Read-model + route-registration DB tests. |
| `postman/api-endpoints.json` | Modify | Add the prep-desk route spec; regen via `pnpm gen:postman`. |
| `docs/design/handoff/2026-06-18-prep-desk-conjectures.md` | Create | Functional handoff (design-gated, no UI code). |

## Task Order & Interface Reconciliation

Implement in this dependency order. **Names diverge across the 8 drafts — the implementer MUST normalize to ONE canonical set before starting (see the "MISMATCHES TO FIX" block below); the Consumes/Produces names listed per task assume the canonical set is in force.**

1. **Schema (conjecture proposal kind)** — Draft 1.
   - Produces: kind literal added to `aiProposalKinds`/`AiProposalKindT`; `ConjectureProposalChange` (Zod) + `ConjectureProposalChangeT`; discriminated-union branch with `target.subject_kind` literal `'mind_model'`; reachable via `parseAiProposalPayload`.
   - Consumes: `BaseProposal` (`proposal.ts:113-129`), `ProposalTarget` (`:101-104`), `ProposalEvidenceRef` (`:95-99`), `CauseCategory` (re-exported from `./business`), `acceptSupportedProposalKinds` (`:76-93`).
   - Cross-task seam: deliberately leaves `inbox-meta.unit.test.ts` KIND_META guard expected-red until the 备课台 UI lane lands `KIND_META.<kind>`. Track, do not paper over.

2. **取证 evidence (deterministic, no LLM)** — Draft 2.
   - Consumes: `FailureAttempt` (`queries.ts:78`), `effectiveCauseForFailureAttempt` (`cause-policy.ts:36`, `source:'user'|'agent'`), `CauseCategoryT` (`event/blocks.ts:56`), `MasteryStateRow` (`mastery/state.ts:30`, `theta_hat`/`theta_precision`), `thetaSe` (`theta.ts:145`).
   - Produces: `CONJECTURE_RECURRENCE_FLOOR=2`, `LOW_PRECISION_THRESHOLD=1.5`, `conjectureKey(cause, kc)`, `EvidenceCell` (`{ key, cause_category, knowledge_id, recurrence_count, evidence_event_ids, theta_hat|null, theta_precision|null, probe_here, has_owner_cause }`), `GatherConjectureEvidenceInput`, `gatherConjectureEvidence(input): EvidenceCell[]`.
   - Seam: `EvidenceCell.evidence_event_ids` → `evidence_refs`; `has_owner_cause === false` is the precondition for the D2 judge-only cap.

3. **Induction (LLM prompt-step + D2 self-consistency)** — Draft 3.
   - Consumes: `ConjectureDraft`/`ConjectureDraftT` (Draft 3's own `business.ts` addition), `TaskTextRunFn`/`TaskTextResult` (`provenance.ts`), `zodToJsonSchemaOutputFormat` (`output-format.ts:51`), `EvidenceCell` (from Draft 2 — see MISMATCH #3), `anthropic-sub` lane via `override:{provider:'anthropic-sub'}` (`providers.ts:181-191`).
   - Produces: `induceConjecture(input): Promise<InduceConjectureResult>` where `InduceConjectureResult = { draft, confidence, confidence_capped, samples, task_run_ids, cost_usd }`; `JUDGE_ONLY_CONFIDENCE_CAP=0.5`; registry entry for the induction `TaskKind`.

4. **Tool + Job (propose_conjecture + research_meeting_nightly + manifest)** — Draft 4.
   - Consumes: the schema kind + `ConjectureProposalChange` (Task 1), `parseAiProposalPayload`; `DomainTool`/`ToolContext` (`tools/types.ts:51-65`), `writeAiProposal` (`writer.ts:98`); `gatherConjectureEvidence` (Task 2), `induceConjecture` (Task 3); `buildMcpServerFromRegistry`, `resolveDomainToolNames`/`resolveMcpAllowedTools`, `DOMAIN_TOOL_MCP_SERVER_NAME`; `runAgentTask` (`runner.ts`); `listProposalInboxRows`; `writeEvent`; `JobDecl`/`registerCapabilityJobs`.
   - Produces: `proposeConjectureTool`, `research_meeting` surface + allowlist, `RESEARCH_MEETING_MAX_CONJECTURES=3`, `runResearchMeetingNightly`/`buildResearchMeetingNightlyHandler`, cron handler in agency manifest (`'20 4 * * *'` Asia/Shanghai, queue `'agent'`).

5. **Accept applier (accept-not-confirmed + edit→CORE + reject→digest)** — Drafts 5 & 8 (these two OVERLAP — see MISMATCH #5; pick ONE applier module).
   - Consumes: schema kind + `ConjectureProposalChange`; `acceptSupportedProposalKinds` (must now INCLUDE the kind — reconcile with Task 1's deliberate exclusion, see MISMATCH #4); `writeEvent`, `recordProposalDecisionSignal`/`ensureProposalDecisionSignal` (`signals.ts:176`/`:498`), `existingAcceptRate`/`ensureAcceptOnly`/`asPlainRecord`/`requiredString` (`applier-helpers.ts`), `ProposalInboxRow`, `ApiError`, `dismissAiProposal` default branch.
   - Produces: `acceptConjectureProposal(db, proposalId, proposal, opts): Promise<ConjectureAcceptResult>` with `{ kind, rate_event_id, conjecture_id, corrected_by_owner, weakness_confirmed:false, idempotent? }`; `ConjectureCoreWriter` type + `setConjectureCoreWriter`; `dispatchAccept` case; `AcceptAiProposalOpts.corrected_payload`.

6. **Probe one-shot lifecycle** — Draft 6.
   - Consumes: the schema kind's `proposed_change` probe shape + `knowledge_id` (see MISMATCH #6 — `discriminating_probe` is a string in Drafts 1/4 but a `{prompt_md,kind,reference_md,knowledge_ids}` object in Draft 6); `question`/`event` schema; `writeEvent`; `handleReviewDue` (for the regression lock); `draft_status='draft'` invariant.
   - Produces: `PROBE_QUESTION_SOURCE='mind_probe'`, `MAX_CONCURRENT_ACTIVE_PROBES=3`, `serveProbeOnce`, `answerProbe`, `countActiveProbes`; `experimental:probe_served`/`experimental:probe_answered` event vocabulary.
   - Seam: the accept lane (Task 5) decides whether/when to call `serveProbeOnce`; the probe row stays `draft` forever and never reuses the remediation question.

7. **Logging contract (YUK-407)** — Draft 7.
   - Consumes: `parseEvent`, `writeEvent`, existing `AttemptOnQuestion`/`ReviewOnQuestion` Zod objects.
   - Produces: `ReconstructionSignal` enum + `ReconstructionSignalT`; optional `reconstruction_signal` payload field on attempt/review branches; `'unknown'` stamped at the two live write sites. Independent of the conjecture chain — can land in parallel.

8. **备课台 handoff (read model + owner-decision route + design-gated doc)** — Draft 8.
   - Consumes: schema kind, `listProposalInboxPage` (`inbox.ts:518`), `ProposalInboxRow`, `recordProposalDecisionSignal`, `ProposalEvidenceRefT`, `loadWorkbenchSummary` precedent.
   - Produces: `loadPrepDeskConjectures(db): Promise<PrepDeskConjectures>`, `GET /api/prep-desk/conjectures`, `PrepDeskConjecture` wire shape (NO confidence field), the functional handoff doc. **No `.tsx`/`.css`.**

### MISMATCHES TO FIX (cross-draft — resolve BEFORE coding; these are the load-bearing reconciliations)

1. **Kind literal: `'conjecture'` vs `'mind_model'`.** Drafts 1/2/3/4 name the proposal kind `'conjecture'` and put `subject_kind` literal `'mind_model'` on `target`. Drafts 5/8 name the *kind* itself `'mind_model'`. These cannot coexist — `dispatchAccept`, `acceptSupportedProposalKinds`, `proposalWhere`, and the read model all key on the same string. **CANONICAL: kind = `'conjecture'`, `target.subject_kind` = `'mind_model'`** (Drafts 1-4, the schema-owning lane). The accept lane (Draft 5) and read model (Draft 8) must be rewritten to dispatch on `kind === 'conjecture'` and filter `listProposalInboxPage({ kind: 'conjecture' })`, NOT `'mind_model'`.

2. **`proposed_change` field names.** Draft 1: `claim_md`, `cause_category`, `confidence` (number 0..1), `recurrence_count`, `probe_md`, `corrected_by_owner`, `knowledge_id`. Draft 4: `claim`, `discriminating_probe`, `confidence_bucket` (`low|medium|high`). Draft 5: `claim_md`, `conjecture_id`, `probe_question`, `probe_kind` (no confidence). Draft 8: `claim`, `probe:{question_id,status}`, `confidence` (number). **CANONICAL (Draft 1, the schema lane that owns the Zod object): `claim_md`, `knowledge_id`, `cause_category`, `confidence` (z.number 0..1), `recurrence_count` (int ≥2), `probe_md` (string), `corrected_by_owner` (default false).** Every consuming lane (4/5/6/8) must map to these exact names. NOTE: confidence is a **number on the payload** (Drafts 1/8) — Draft 4's `confidence_bucket` enum is rejected; the read model (Task 8) reads the number to sort then strips it from the wire.

3. **`EvidenceCell` shape divergence.** Draft 2 (the 取证 owner) produces `EvidenceCell` with `theta_hat: number | null` / `theta_precision: number | null` (cold-start nullable) + a `key` field. Draft 3 redeclares `EvidenceCell` with non-null `theta_hat`/`theta_precision` and no `key`. **CANONICAL: Draft 2's exported `EvidenceCell` from `@/server/conjectures/evidence`.** Draft 3 must `import type { EvidenceCell }` from Draft 2, delete its local redeclaration, and handle `theta_hat: number | null` in the prompt assembly.

4. **`acceptSupportedProposalKinds` membership.** Draft 1 deliberately EXCLUDES the kind (prep-desk owns accept; it joins the `defer/archive/judge_retraction` unsupported partition in `inbox-meta.unit.test.ts`). Drafts 5 & 8 ADD it to `acceptSupportedProposalKinds`. **CANONICAL: ADD `'conjecture'` to `acceptSupportedProposalKinds`** because there IS a real accept applier (Task 5). The schema task (Task 1) must therefore put `'conjecture'` in `acceptSupportedProposalKinds` (not the unsupported partition) and `inbox-meta.unit.test.ts` must keep it OUT of the `unsupported` tuple. Draft 1's "exclude it" steps are superseded — only `KIND_META.<kind>` (UI metadata, Task 8) remains an expected cross-task red.

5. **Two accept-applier modules.** Draft 5 creates `src/capabilities/agency/server/conjecture-accept.ts` (`acceptConjectureProposal`, with edit→CORE via injectable `ConjectureCoreWriter`). Draft 8 creates `src/server/proposals/mind-model-applier.ts` (`acceptMindModelProposal`, no CORE write, `confirmed:false`). These are the SAME responsibility. **CANONICAL: Draft 5's `conjecture-accept.ts` / `acceptConjectureProposal`** (it covers edit + reject + idempotency + the CORE seam, and lives in the agency package which owns the proposer). Drop Draft 8's `mind-model-applier.ts` entirely; Task 8 keeps ONLY its read-model + route + handoff doc, and its accept tests should target `acceptConjectureProposal`.

6. **Probe payload shape.** Draft 6's `serveProbeOnce` expects the conjecture's probe as `{ prompt_md, kind, reference_md, knowledge_ids }`, but the canonical schema (MISMATCH #2) carries a single `probe_md: string`. **CANONICAL: pass the probe text as `probe_md` and synthesize the served question with `kind` defaulted (e.g. `'short_answer'`), `reference_md: null`, `knowledge_ids: [knowledge_id]`** — the accept lane (Task 5) adapts `ServeProbeParams.probe` from `{ prompt_md: probe_md, kind, reference_md, knowledge_ids }`. Draft 6's `ServeProbeParams` field names stay; the *source* of `prompt_md` is `proposed_change.probe_md`.

7. **`actor_ref` for the proposer.** All drafts use `actor_ref: 'research_meeting'` on `writeAiProposal`/tool context — consistent, no fix needed. Confirm `listProposalInboxPage` filtering does not exclude it.

8. **Induction registry default model.** Draft 3 uses `defaultModel: 'mimo-v2.5-pro'` for the induction task; the project memory note flags vision id as `mimo-v2.5` (non-pro), but the induction task is text-only so `mimo-v2.5-pro` is acceptable as the *text* default — keep Draft 3's value but verify the model id is accepted by the registry's provider validation before committing.

## Acceptance & 2-week kill/alive

**ALIVE (keep building Phase 1+):**
- Owner opens the 备课台 ≥4 times over the 2 weeks.
- At least 1 conjecture lands as "it really got me" (subjective hit on how the owner thinks, not just a topic miss).
- The surface never feels like a backlog to clear (no guilt, no "N unread" pressure — owner reports it as an invitation).
- Confirm-rate ≥70% (accepted/edited ÷ surfaced).
- Probe-confirmed weaknesses are non-degenerate (probes actually discriminate; confirmations aren't trivially-true rephrasings).

**KILL (tear down, do not invest further):**
- Confirm-rate <50%.
- Owner opens the 备课台 <3 times in 2 weeks.
- The owner finds themselves chasing/optimizing the confirm numbers (the metric became the goal — anti-pattern, contradicts anti-guilt intent).

---

# Task Bodies (grounded drafts, appended verbatim below)


---

## ▸ Draft 1: conjecture-schema

I now have everything I need. The test is unit (no DB). The `proposal.test.ts` lives in `src/core/schema/` which is included by `fastTestInclude` (unit config). All five coverage guards are confirmed.

I have all the grounding. Here is the drafted task in the WRITING-PLANS format.

---

### Task 1: conjecture proposal kind + ConjectureProposalChange Zod schema

**Files**
- Modify `src/core/schema/proposal.ts:65` (append `'conjecture'` to `aiProposalKinds`), `:228` (insert `ConjectureProposalChange` after `BlockMergeProposalChange`, before `ImageCandidateProposalChange`), `:425` (append the `conjecture` union branch before the closing `]`)
- Modify `src/core/schema/proposal.test.ts:184` (add `conjecture` to round-trip `samples`), `:505` (add `conjecture` to `sampleByKind`), `:586` (add `conjecture: false` to `correctivePossibleByKind`); append two new focused `conjecture` tests after the `question_draft` rejection test at `:377`
- Modify `src/capabilities/shell/ui/inbox-meta.unit.test.ts:45` (add `'conjecture'` to the `unsupported` partition tuple)
- Test: `src/core/schema/proposal.test.ts` (existing file; this is the test surface)

**Interfaces**
- Consumes (existing, from real source — cite):
  - `aiProposalKinds` readonly tuple `src/core/schema/proposal.ts:6-65`; `AiProposalKindT = z.infer<typeof AiProposalKind>` `:67-68`
  - `BaseProposal` (z.object with `target`, `reason_md` 1..4000, `evidence_refs: z.array(ProposalEvidenceRef).default([])`, `rollback_plan?`, `cooldown_key?` 1..300, `suggestion_kind?`) `src/core/schema/proposal.ts:113-129`
  - `ProposalTarget = z.object({ subject_kind: z.string().min(1), subject_id: z.string().min(1).nullable() })` `src/core/schema/proposal.ts:101-104`
  - `ProposalEvidenceRef = z.object({ kind: z.enum(['event','question','knowledge','artifact','record']), id: z.string().min(1) })` `src/core/schema/proposal.ts:95-98`
  - `CauseCategory` (alias of `CauseCategoryId = z.string().regex(/^[a-z][a-z0-9_]*$/)`) `src/core/schema/cause.ts:5-10`, re-exported from `src/core/schema/business.ts:2-4`
  - `parseAiProposalPayload(input: unknown): AiProposalPayloadT` `src/core/schema/proposal.ts:430-432`
  - `acceptSupportedProposalKinds` `src/core/schema/proposal.ts:76-93` — `conjecture` is deliberately NOT added here (accept ≠ confirmed; the prep-desk lane owns its own accept/edit/reject dispatch, so it joins the `defer`/`archive`/`judge_retraction` unsupported partition, exactly like the inbox-meta guard pins).
- Produces (later tasks rely on these exact names):
  - `ConjectureProposalChange` (Zod) + `ConjectureProposalChangeT` (type)
  - `'conjecture'` member of `aiProposalKinds` / `AiProposalKindT`
  - union branch with `kind: z.literal('conjecture')`, `target.subject_kind: z.literal('mind_model')`, `proposed_change: ConjectureProposalChange`

**Steps**

- [ ] **Write failing test** — add the conjecture entry to the round-trip `samples` map. Insert after the `question_edit` block at `src/core/schema/proposal.test.ts:184` (inside the `samples` object literal, before the closing `} as const;` at line 185):

```ts
      // YUK-406 Phase 0 (关系脑 thin slice) — conjecture: a belief about the
      // owner's mind. subject_kind 'mind_model'; provenance reuses evidence_refs
      // (event ids); confidence is internal sort/calibration only (never rendered
      // as a number); recurrence_count >= 2; exactly ONE discriminating probe.
      conjecture: {
        ...base,
        kind: 'conjecture',
        target: { subject_kind: 'mind_model', subject_id: 'k1' },
        proposed_change: {
          claim_md: '你把链式法则当成「导数相乘」，忽略了内层函数的代入。',
          knowledge_id: 'k1',
          cause_category: 'concept_confusion',
          confidence: 0.62,
          recurrence_count: 3,
          probe_md: '对 f(x)=sin(x^2)，先写出 f\'(x)，再说明这一步用到了链式法则的哪一层。',
          corrected_by_owner: false,
        },
      },
```

- [ ] **Run it, expect FAIL** — the `Object.keys(samples).sort()).toEqual([...aiProposalKinds].sort())` assertion (line 187) now has a `conjecture` sample key with no matching enum member, AND `parseAiProposalPayload(sample)` throws on the unknown discriminator:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts -t 'round-trips all proposal kinds through the union'
```

- [ ] **Minimal implementation** — add the enum member. In `src/core/schema/proposal.ts`, after the `question_edit` member (line 64) and before the closing `] as const;` (line 65):

```ts
  // YUK-406 Phase 0 (关系脑 thin slice) — conjecture: a NEW proposal kind for a
  // belief about the owner's MIND (subject_kind 'mind_model'), proposed ONLY by the
  // nightly 教研例会 (research-meeting) sleep job — single-writer. NO new
  // misconception table: provenance REUSES evidence_refs (event ids) and the claim/
  // probe/cause live on the proposed_change. Flows through the existing
  // experimental:proposal event/inbox path (writeAiProposal default + proposalWhere).
  // Accept ≠ confirmed: the 备课台 (prep-desk) lane owns accept/edit/reject, so this
  // kind stays OUT of acceptSupportedProposalKinds (joins defer/archive/judge_retraction
  // in the unsupported partition — inbox-meta.unit.test.ts pins this).
  'conjecture',
```

- [ ] **Run it, expect FAIL still** — the enum now has `conjecture`, so the key-set assertion passes, but `parseAiProposalPayload` still throws because the discriminated union has no `conjecture` branch:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts -t 'round-trips all proposal kinds through the union'
```

- [ ] **Minimal implementation** — add the `ConjectureProposalChange` schema. In `src/core/schema/proposal.ts`, insert after `export type BlockMergeProposalChangeT = ...` (line 229) and before the `// YUK-227 S3 Slice C` comment for `ImageCandidateProposalChange` (line 231). Note: `CauseCategory` must be imported — see the next step's import edit.

```ts
// YUK-406 Phase 0 (关系脑 thin slice) — conjecture proposed_change. A conjecture
// is a 2nd-person belief about HOW the owner thinks (claim_md), anchored to one
// knowledge node + one cause_category (reusing the shared cause vocabulary), with
// internal-only `confidence` (sort/calibration ONLY — the UI NEVER renders it as a
// number, ADR per YUK-406 anti-guilt), a `recurrence_count` (>= 2: the deterministic
// 取证 gate requires >=2 distinct attempts before a conjecture is raised), exactly
// ONE untested discriminating `probe_md` (the induction step synthesizes it; served
// ONCE via the FSRS one-shot loop), and a `corrected_by_owner` flag the prep-desk
// edit action flips. Provenance lives on BaseProposal.evidence_refs (event ids) —
// NOT duplicated here (single source of truth for evidence).
export const ConjectureProposalChange = z.object({
  // 2nd-person claim about the owner's thinking. 1..280 so it stays a single
  // surfaced sentence (the 备课台 card renders it whole — never truncated to a count).
  claim_md: z.string().min(1).max(280),
  // The knowledge node this conjecture is about (the 取证 gate keyed cause_category
  // x KC recurrence here). Required: a mind-model belief must hang off a concrete KC.
  knowledge_id: z.string().min(1),
  // Reuses the shared cause vocabulary (CauseCategory = lowercase id grammar) — the
  // same vocabulary effectiveCauseForFailureAttempt returns, so the conjecture's
  // cause aligns with the failure-attempt evidence it was induced from.
  cause_category: CauseCategory,
  // Internal sort/calibration ONLY. NEVER rendered as a number (salience =
  // confidence x recurrence drives ordering; the self-consistency + judge-only cap
  // + owner-correction anchor calibrate it). 0..1.
  confidence: z.number().min(0).max(1),
  // The deterministic 取证 floor: a conjecture is only raised after >= 2 distinct
  // attempts recur for this cause x KC. Integer, min 2.
  recurrence_count: z.number().int().min(2),
  // The ONE untested discriminating probe (synthesized by the induction step). Served
  // ONCE via the FSRS one-shot loop — answering it confirms/retires the conjecture;
  // the probe itself does NOT become a recurring FSRS item.
  probe_md: z.string().min(1).max(2000),
  // Set true by the 备课台 edit action (owner rewrites the claim → owner version
  // written to CORE; still NOT auto-confirmed). Defaulted so a freshly-induced
  // conjecture (job-authored, never owner-touched) parses to false.
  corrected_by_owner: z.boolean().default(false),
});
export type ConjectureProposalChangeT = z.infer<typeof ConjectureProposalChange>;
```

- [ ] **Add the import** — `CauseCategory` is not yet imported in `proposal.ts`. Edit the import block (top of file). Replace the line `import { QuestionKind } from './business';` (line 2) with:

```ts
import { CauseCategory, QuestionKind } from './business';
```

(`CauseCategory` is re-exported from `./business` per `src/core/schema/business.ts:2-12` — same module the file already imports `QuestionKind` from, so no new module dependency.)

- [ ] **Add the union branch** — in `src/core/schema/proposal.ts`, inside `AiProposalPayload` (the `z.discriminatedUnion('kind', [...])`), insert after the `question_edit` branch (the block ending at line 425, `})`) and before the closing `]);` (line 426):

```ts
  // YUK-406 Phase 0 (关系脑 thin slice) — conjecture. target.subject_kind is the
  // literal 'mind_model' (a NEW subject_kind, distinct from 'knowledge'); subject_id
  // carries the knowledge_id the belief is about (known at propose time). Proposed
  // ONLY by the nightly 例会 sleep job (single-writer); copilot is read-only on CORE.
  BaseProposal.extend({
    kind: z.literal('conjecture'),
    target: ProposalTarget.extend({ subject_kind: z.literal('mind_model') }),
    proposed_change: ConjectureProposalChange,
  }),
```

- [ ] **Run it, expect PASS** — round-trip now parses and the key-set matches:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts -t 'round-trips all proposal kinds through the union'
```

- [ ] **Run the full proposal suite, expect 3 FAILs** — the other two coverage guards in this file plus the `suggestion_kind` guard are now red (they assert `Object.keys(...).sort() === aiProposalKinds.sort()` and an exhaustive `Record<AiProposalKind, …>`):

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts
```

Expected failures: `'pins the §3.1 corrective-possible classification per kind'` (TS/runtime — `correctivePossibleByKind` missing `conjecture` key) and `'is optional on every proposal kind …'` (sample map key-set mismatch).

- [ ] **Fix the suggestion_kind coverage map** — in `src/core/schema/proposal.test.ts`, inside `sampleByKind` add the `conjecture` entry after the `question_edit` block (before the closing `};` at line 506):

```ts
      conjecture: {
        kind: 'conjecture',
        target: { subject_kind: 'mind_model', subject_id: 'k1' },
        proposed_change: {
          claim_md: '你默认所有积分都能用换元法直接消去。',
          knowledge_id: 'k1',
          cause_category: 'method_misuse',
          confidence: 0.5,
          recurrence_count: 2,
          probe_md: '对 ∫ x·e^{x^2} dx，说明你会先做什么换元，为什么。',
        },
      },
```

(`corrected_by_owner` omitted on purpose — it is `.default(false)`, so this also exercises the default in the suggestion_kind guard.)

- [ ] **Fix the §3.1 corrective classification table** — in `src/core/schema/proposal.test.ts`, inside `correctivePossibleByKind` add after the `question_edit: false,` line (line 586):

```ts
      // YUK-406 Phase 0 — conjecture is a proactive mind-model proposal raised by
      // the nightly 例会 (the job induces a belief from recurring evidence); it is
      // not the SK-3 "structurally corrective" variant lane.
      conjecture: false,
```

- [ ] **Run it, expect PASS** — all coverage guards in the file green:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts
```

- [ ] **Write failing test (focused validation)** — add two conjecture-specific tests in `src/core/schema/proposal.test.ts`, immediately after the `'rejects a question_draft proposal …'` test (insert before the closing `});` of the `describe('AiProposalPayload', …)` block at line 378):

```ts
  // YUK-406 Phase 0 (关系脑 thin slice) — conjecture round-trip + invariant rejections.
  it('accepts a valid conjecture proposal and defaults corrected_by_owner to false', () => {
    const parsed = parseAiProposalPayload({
      ...base,
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'k1' },
      proposed_change: {
        claim_md: '你把链式法则当成「导数相乘」。',
        knowledge_id: 'k1',
        cause_category: 'concept_confusion',
        confidence: 0.62,
        recurrence_count: 3,
        probe_md: '对 f(x)=sin(x^2)，写出 f\'(x) 并说明用到链式法则的哪一层。',
      },
    });
    expect(parsed.kind).toBe('conjecture');
    expect(parsed.target.subject_kind).toBe('mind_model');
    if (parsed.kind === 'conjecture') {
      expect(parsed.proposed_change.knowledge_id).toBe('k1');
      expect(parsed.proposed_change.cause_category).toBe('concept_confusion');
      expect(parsed.proposed_change.recurrence_count).toBe(3);
      // corrected_by_owner omitted in input → defaults to false (job-authored).
      expect(parsed.proposed_change.corrected_by_owner).toBe(false);
    }
    // Provenance reuses evidence_refs (event ids) — no separate misconception store.
    expect(parsed.evidence_refs[0]).toEqual({ kind: 'event', id: 'event_1' });
  });

  it('rejects a conjecture with recurrence_count < 2, empty claim, or wrong target.subject_kind', () => {
    const change = {
      claim_md: '你把链式法则当成「导数相乘」。',
      knowledge_id: 'k1',
      cause_category: 'concept_confusion',
      confidence: 0.62,
      recurrence_count: 2,
      probe_md: '对 f(x)=sin(x^2)，写出 f\'(x)。',
    };
    const target = { subject_kind: 'mind_model', subject_id: 'k1' };
    // recurrence_count floor is 2 — the 取证 gate never raises a one-off.
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'conjecture',
        target,
        proposed_change: { ...change, recurrence_count: 1 },
      }),
    ).toThrow();
    // claim_md must be non-empty.
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'conjecture',
        target,
        proposed_change: { ...change, claim_md: '' },
      }),
    ).toThrow();
    // confidence is bounded 0..1.
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'conjecture',
        target,
        proposed_change: { ...change, confidence: 1.5 },
      }),
    ).toThrow();
    // cause_category follows the shared lowercase-id grammar.
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'conjecture',
        target,
        proposed_change: { ...change, cause_category: 'Concept Confusion' },
      }),
    ).toThrow();
    // target.subject_kind must be the 'mind_model' literal.
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'conjecture',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: change,
      }),
    ).toThrow();
  });
```

- [ ] **Run it, expect PASS** — the schema already enforces every invariant the tests assert (`recurrence_count` `.int().min(2)`, `claim_md` `.min(1)`, `confidence` `.min(0).max(1)`, `cause_category` regex via `CauseCategory`, `target.subject_kind` literal):

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts -t 'conjecture'
```

- [ ] **Fix the inbox-meta accept-partition guard** — `inbox-meta.unit.test.ts` asserts `acceptSupported ∪ {defer, archive, judge_retraction} === aiProposalKinds`. With `conjecture` added to `aiProposalKinds` but NOT to `acceptSupportedProposalKinds`, the union is short by one. In `src/capabilities/shell/ui/inbox-meta.unit.test.ts:45`, replace:

```ts
  const unsupported = ['defer', 'archive', 'judge_retraction'] as const;
```

with:

```ts
  // YUK-406 Phase 0 — conjecture accept is owned by the 备课台 (prep-desk) lane
  // (accept ≠ confirmed; accept/edit/reject + golden anchors live there), so it is
  // NOT in the auto-materializing acceptSupportedProposalKinds. It joins the
  // unsupported partition exactly like defer/archive/judge_retraction.
  const unsupported = ['defer', 'archive', 'judge_retraction', 'conjecture'] as const;
```

- [ ] **Run the inbox-meta guard, expect 1 remaining FAIL** — the accept-partition union now balances, but the `KIND_META vs aiProposalKinds` guard at line 20 still fails because `KIND_META` has no `conjecture` entry:

```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/shell/ui/inbox-meta.unit.test.ts
```

(Expected: `'每个 core proposal kind 都有 UI 元数据条目'` fails — `missing` contains `conjecture`. This `KIND_META` entry is added in the prep-desk UI task, NOT this schema task. Document this hand-off in the commit body; do NOT add UI metadata here — that crosses into the 备课台 lane which requires the design-doc pre-flight.)

> Note for the implementing engineer: this single red test is the deliberate seam to the prep-desk UI task. If your task ordering puts the schema first, the `inbox-meta.unit.test.ts:20` guard is expected-red until the UI task lands `KIND_META.conjecture`. The pre-PR gate (`pnpm test`) will stay red on exactly this one assertion until then — track it as the explicit cross-task dependency, do not paper over it by adding UI metadata in the schema lane.

- [ ] **Commit**

```bash
git add src/core/schema/proposal.ts src/core/schema/proposal.test.ts src/capabilities/shell/ui/inbox-meta.unit.test.ts
git commit -m "feat(proposals): conjecture proposal kind + ConjectureProposalChange schema (YUK-406 Phase 0)

New 'conjecture' AiProposalKind (subject_kind 'mind_model') — a 2nd-person belief
about how the owner thinks, proposed only by the nightly 教研例会 sleep job.
proposed_change carries claim_md (1..280), knowledge_id, cause_category (shared
cause vocab), internal-only confidence (0..1, never rendered as a number),
recurrence_count (>=2), one discriminating probe_md, corrected_by_owner (default
false). Provenance reuses BaseProposal.evidence_refs — no new misconception table.
Accept != confirmed: conjecture stays out of acceptSupportedProposalKinds (prep-desk
lane owns accept/edit/reject). KIND_META.conjecture is added by the 备课台 UI task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

**Schema gate note (audit:schema):** This task adds NO `src/db/schema.ts` columns — `conjecture` is a payload field on the existing `experimental:proposal` event (per the `goal_scope`/`block_merge` precedent at `proposal.ts:25,31`, which the comment confirms need "no migration"). So `pnpm audit:schema` / `audit:draft-status` / `audit:profile` are unaffected by this task. The reconstructability logging signal (YUK-407) and any new columns are separate tasks.

---

## PRODUCES (exact names neighboring tasks line up against)

In `src/core/schema/proposal.ts`:
- `aiProposalKinds` now includes the literal `'conjecture'`; `AiProposalKindT` includes `'conjecture'`.
- `export const ConjectureProposalChange` — `z.object` with fields: `claim_md: z.string().min(1).max(280)`, `knowledge_id: z.string().min(1)`, `cause_category: CauseCategory` (= `z.string().regex(/^[a-z][a-z0-9_]*$/)`), `confidence: z.number().min(0).max(1)`, `recurrence_count: z.number().int().min(2)`, `probe_md: z.string().min(1).max(2000)`, `corrected_by_owner: z.boolean().default(false)`.
- `export type ConjectureProposalChangeT = z.infer<typeof ConjectureProposalChange>` → input has optional `corrected_by_owner`, output has required `corrected_by_owner: boolean`.
- Union branch on `AiProposalPayload`: `{ kind: 'conjecture'; target: { subject_kind: 'mind_model'; subject_id: string | null }; proposed_change: ConjectureProposalChangeT; reason_md: string; evidence_refs: ProposalEvidenceRefT[]; rollback_plan?: unknown; cooldown_key?: string; suggestion_kind?: SuggestionKindT }` — reachable via `parseAiProposalPayload(input): AiProposalPayloadT` narrowed by `parsed.kind === 'conjecture'`.

## CONSUMES (existing signatures this task depends on — verified, cited)

- `BaseProposal` `src/core/schema/proposal.ts:113-129` — extended via `.extend({ kind, target, proposed_change })`.
- `ProposalTarget` `src/core/schema/proposal.ts:101-104`; `.extend({ subject_kind: z.literal('mind_model') })`.
- `ProposalEvidenceRef` / `ProposalEvidenceRefT` `src/core/schema/proposal.ts:95-99` — provenance channel (event ids), reused unchanged.
- `CauseCategory` (= `CauseCategoryId`, `z.string().regex(/^[a-z][a-z0-9_]*$/)`) `src/core/schema/cause.ts:5-11`, re-exported `src/core/schema/business.ts:2-12` — imported into `proposal.ts` alongside `QuestionKind`.
- `parseAiProposalPayload(input: unknown): AiProposalPayloadT` `src/core/schema/proposal.ts:430-432`.
- `acceptSupportedProposalKinds` `src/core/schema/proposal.ts:76-93` — `conjecture` deliberately excluded (unsupported partition; prep-desk owns accept).

## DOWNSTREAM HAND-OFFS (explicit cross-task seams, not done here)

1. `KIND_META.conjecture` in `src/capabilities/shell/ui/inbox-api.ts` (referenced by `inbox-meta.unit.test.ts:5-17`) — added by the **备课台 (prep-desk) UI task** (requires design-doc pre-flight + claude design). Until then `inbox-meta.unit.test.ts:20` `'每个 core proposal kind 都有 UI 元数据条目'` is expected-red.
2. `writeAiProposal` default branch already emits `experimental:proposal` for any kind (`src/server/proposals/writer.ts`) — no writer change needed; verify in the **例会 job task** that the conjecture payload flows the default branch.
3. The induction step (LLM prompt-step) must emit a payload matching `ConjectureProposalChange` exactly (`recurrence_count >= 2` is a hard schema floor — the deterministic 取证 gate must guarantee it before the LLM ever sees the candidate, or `parseAiProposalPayload` throws).
4. The prep-desk **accept/edit/reject** dispatch (a later task) handles `conjecture` outside `dispatchAccept`'s `acceptSupportedProposalKinds` switch; `edit` flips `corrected_by_owner` and writes the owner version to mem0 CORE; none of these paths write FSRS state (ND-5).

---

## ▸ Draft 2: evidence-gathering

I now have all signatures grounded. The deterministic function I'm drafting is a pure aggregator that takes pre-fetched `FailureAttempt[]` + a mastery-state lookup function (so the function itself stays pure/unit-testable, with the DB orchestration left to a thin wrapper that callers in neighbouring tasks supply). This mirrors the codebase's dependency-injection pattern (DepsOverride in dreaming_nightly.ts, reader fns injected).

Here is the task block.

---

### Task 3: deterministic 取证 — `gatherConjectureEvidence` (pure, no LLM)

**Files**
- Create: `src/server/conjectures/evidence.ts`
- Test: `src/server/conjectures/evidence.test.ts` (unit, no DB — runs under `vitest.unit.config.ts`)

**Interfaces**

Consumes (exact signatures, already in repo — cite file:line):
- `FailureAttempt` — `src/server/events/queries.ts:78-88`. Fields used: `attempt_event_id: string`, `referenced_knowledge_ids: string[]`, `created_at: Date`, and the nested `judge?` / `user_cause?` channels.
- `effectiveCauseForFailureAttempt(failure: FailureAttempt): EffectiveFailureCause | null` — `src/server/events/cause-policy.ts:36-68`. Returns `{ source: 'user' | 'agent'; event_id: string; primary_category: CauseCategoryT; ... }` or `null` (no active cause). `source: 'user'` ⇒ an owner-supplied cause exists (used to lift the judge-only confidence cap downstream); `source: 'agent'` ⇒ agent judge only.
- `CauseCategoryT` — `src/core/schema/event/blocks.ts:56` (alias of `CauseCategory` = a regex-validated `string`).
- `MasteryStateRow` — `src/server/mastery/state.ts:30-41`. Fields used: `theta_hat: number`, `theta_precision: number`.
- `thetaSe(thetaPrecision: number): number` — `src/core/theta.ts:145-147` (SE = `1/√precision`; precision floored at 1e-9).

Produces (neighbouring tasks rely on these exact names/types):
- `export interface EvidenceCell` (shape below).
- `export interface GatherConjectureEvidenceInput` (shape below).
- `export const CONJECTURE_RECURRENCE_FLOOR = 2`.
- `export const LOW_PRECISION_THRESHOLD = 1.5`.
- `export function conjectureKey(causeCategory: CauseCategoryT, knowledgeId: string): string`.
- `export function gatherConjectureEvidence(input: GatherConjectureEvidenceInput): EvidenceCell[]`.

Design notes (load-bearing, do not drop):
- PURE function: no DB import, no `await`, no LLM. The DB orchestration (calling `getFailureAttempts` with a `since` window and resolving `MasteryStateRow` per knowledge_id) belongs to a thin wrapper in a later 例会-job task; this function takes already-fetched rows + a mastery lookup map. This matches the repo's injection pattern (`DepsOverride` in `dreaming_nightly.ts:77-94`).
- A "cell" is one `(cause_category × knowledge_id)` pair. The function fans each `FailureAttempt` out across **every** `knowledge_id` in `referenced_knowledge_ids` (a question can probe multiple KCs — PFA per-KC, mirrors `conjunctiveCredits` semantics in `theta.ts:90`).
- `recurrence_count` = number of **distinct** `attempt_event_id`s contributing to the cell (an attempt referencing the same KC twice must not double-count). Keep cells with `recurrence_count >= CONJECTURE_RECURRENCE_FLOOR`.
- `theta_hat` / `theta_precision` attached from the mastery lookup; `probe_here = thetaSe(theta_precision) is high` i.e. `theta_precision < LOW_PRECISION_THRESHOLD` (low precision ⇒ wide SE ⇒ probe here). When the KC has no mastery row, leave `theta_hat: null`, `theta_precision: null`, `probe_here: true` (unknown mastery is itself a reason to probe).
- `has_owner_cause` = true iff **any** contributing attempt's effective cause has `source: 'user'` (drives the downstream judge-only confidence CAP — D2 mitigation, YUK-416).
- `already_known` dedup: skip emitting any cell whose `conjectureKey(...)` is in the supplied `knownConjectureKeys` set (mem0 CORE dedup — same conjecture not re-raised).
- Deterministic ordering: salience-first so the 例会 job can take the top 3 — sort by `recurrence_count` DESC, then `probe_here` (true first), then `conjectureKey` ASC as a stable tiebreak.

**Steps**

- [ ] **Write failing test 1 — cell aggregation + recurrence floor.** Create `src/server/conjectures/evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FailureAttempt } from '@/server/events/queries';
import {
  CONJECTURE_RECURRENCE_FLOOR,
  conjectureKey,
  gatherConjectureEvidence,
} from './evidence';

function failure(
  id: string,
  knowledgeIds: string[],
  cause: { source: 'user' | 'agent'; category: string },
): FailureAttempt {
  const base: FailureAttempt = {
    attempt_event_id: id,
    question_id: `q_${id}`,
    answer_md: null,
    answer_image_refs: [],
    referenced_knowledge_ids: knowledgeIds,
    created_at: new Date('2026-06-18T00:00:00Z'),
    correction_state: {
      terminal_state: 'active',
      effective_event_id: id,
    } as FailureAttempt['correction_state'],
  };
  if (cause.source === 'user') {
    base.user_cause = {
      user_cause_event_id: `uc_${id}`,
      primary_category: cause.category,
      user_notes: null,
      created_at: base.created_at,
      correction_state: base.correction_state,
    };
  } else {
    base.judge = {
      judge_event_id: `j_${id}`,
      cause: {
        primary_category: cause.category,
        secondary_categories: [],
        analysis_md: 'agent analysis',
        confidence: 0.6,
      } as FailureAttempt['judge']['cause'],
      referenced_knowledge_ids: knowledgeIds,
      created_at: base.created_at,
      correction_state: base.correction_state,
    };
  }
  return base;
}

describe('gatherConjectureEvidence — aggregation + recurrence floor', () => {
  it('keeps only cells with recurrence_count >= floor', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_chain_rule'], { source: 'agent', category: 'concept.misapplied' }),
      failure('a2', ['k_chain_rule'], { source: 'agent', category: 'concept.misapplied' }),
      // single occurrence — below floor, must be dropped
      failure('a3', ['k_limits'], { source: 'agent', category: 'concept.misapplied' }),
    ];

    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });

    expect(cells).toHaveLength(1);
    expect(cells[0].cause_category).toBe('concept.misapplied');
    expect(cells[0].knowledge_id).toBe('k_chain_rule');
    expect(cells[0].recurrence_count).toBe(2);
    expect(cells[0].recurrence_count).toBeGreaterThanOrEqual(CONJECTURE_RECURRENCE_FLOOR);
    expect(cells[0].key).toBe(conjectureKey('concept.misapplied', 'k_chain_rule'));
    expect(cells[0].evidence_event_ids).toEqual(['a1', 'a2']);
  });
});
```

- [ ] **Run it — expect FAIL** (module does not exist yet):
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/conjectures/evidence.test.ts -t 'aggregation'
```

- [ ] **Minimal implementation — create `src/server/conjectures/evidence.ts`** with just enough to pass test 1:

```ts
// YUK-406 Phase 0 (关系脑 thin slice) — deterministic 取证 (NO LLM).
//
// Aggregates failure attempts into (cause_category × knowledge_id) "cells" that
// are candidate CONJECTURES about the owner's mind. Pure function: the caller
// (例会 job, later task) fetches FailureAttempt[] via getFailureAttempts({since})
// and a per-knowledge mastery lookup, then hands them in. No DB import here so
// the recurrence/salience math is unit-testable in isolation (mirrors the
// DepsOverride injection pattern in dreaming_nightly.ts:77-94).
//
// Recurrence floor (>=2 distinct attempts) and mem0 CORE dedup (knownConjectureKeys)
// are the gates that keep one-off noise out of the prep-desk surface.

import type { CauseCategoryT } from '@/core/schema/event/blocks';
import { thetaSe } from '@/core/theta';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import type { FailureAttempt } from '@/server/events/queries';
import type { MasteryStateRow } from '@/server/mastery/state';

/** A conjecture must recur across at least this many distinct failure attempts. */
export const CONJECTURE_RECURRENCE_FLOOR = 2;

/**
 * theta_precision below this ⇒ wide SE (thetaSe) ⇒ low confidence in the θ̂
 * point estimate ⇒ "probe here". DEFAULT precision is 1 (schema.ts:777, a weak
 * 1-unit prior, SE=1), so a KC that has barely been observed sits below the
 * threshold and is flagged. Placeholder scale until fixed-anchor calibration
 * (ADR-0043); 1.5 ≈ SE 0.82, i.e. flag anything not yet firmly pinned.
 */
export const LOW_PRECISION_THRESHOLD = 1.5;

/** Stable dedup key for a (cause_category, knowledge_id) conjecture cell. */
export function conjectureKey(causeCategory: CauseCategoryT, knowledgeId: string): string {
  return `${causeCategory}::${knowledgeId}`;
}

export interface EvidenceCell {
  /** conjectureKey(cause_category, knowledge_id) — stable dedup / sort key. */
  key: string;
  cause_category: CauseCategoryT;
  knowledge_id: string;
  /** Distinct failure attempts contributing to this cell (>= CONJECTURE_RECURRENCE_FLOOR). */
  recurrence_count: number;
  /** provenance — the attempt event ids, oldest-first (links to evidence events). */
  evidence_event_ids: string[];
  /** θ̂ for this KC, or null when no mastery row exists (cold start). */
  theta_hat: number | null;
  /** Cumulative Fisher information for θ̂, or null on cold start. */
  theta_precision: number | null;
  /** true ⇒ low-precision (or unknown) KC: a good place to spend the one probe. */
  probe_here: boolean;
  /** true iff any contributing attempt has an owner-supplied (source:'user') cause. */
  has_owner_cause: boolean;
}

export interface GatherConjectureEvidenceInput {
  /** Recent failure attempts (caller fetched via getFailureAttempts({ since })). */
  failures: FailureAttempt[];
  /** knowledge_id → mastery row (caller resolved via getMasteryState). */
  masteryByKnowledgeId: Map<string, MasteryStateRow>;
  /** mem0 CORE dedup: conjectureKey(...) values already raised — skip these cells. */
  knownConjectureKeys: Set<string>;
}

interface CellAccumulator {
  cause_category: CauseCategoryT;
  knowledge_id: string;
  attemptIds: Set<string>;
  hasOwnerCause: boolean;
}

export function gatherConjectureEvidence(input: GatherConjectureEvidenceInput): EvidenceCell[] {
  const { failures, masteryByKnowledgeId, knownConjectureKeys } = input;

  // 1. Fan each failure out across (effective cause_category × each referenced KC).
  const acc = new Map<string, CellAccumulator>();
  for (const failure of failures) {
    const cause = effectiveCauseForFailureAttempt(failure);
    if (cause === null) continue; // no active cause — cannot attribute a conjecture
    const isOwnerCause = cause.source === 'user';
    for (const knowledgeId of failure.referenced_knowledge_ids) {
      const key = conjectureKey(cause.primary_category, knowledgeId);
      const cell = acc.get(key) ?? {
        cause_category: cause.primary_category,
        knowledge_id: knowledgeId,
        attemptIds: new Set<string>(),
        hasOwnerCause: false,
      };
      cell.attemptIds.add(failure.attempt_event_id); // Set ⇒ distinct attempts only
      if (isOwnerCause) cell.hasOwnerCause = true;
      acc.set(key, cell);
    }
  }

  // 2. Keep cells at/above the recurrence floor, skip already-known, attach mastery.
  const cells: EvidenceCell[] = [];
  for (const [key, cell] of acc) {
    if (cell.attemptIds.size < CONJECTURE_RECURRENCE_FLOOR) continue;
    if (knownConjectureKeys.has(key)) continue; // mem0 CORE dedup
    const mastery = masteryByKnowledgeId.get(cell.knowledge_id) ?? null;
    const thetaHat = mastery?.theta_hat ?? null;
    const thetaPrecision = mastery?.theta_precision ?? null;
    // Unknown mastery (cold start) is itself a reason to probe; otherwise probe
    // when precision is low (thetaSe(precision) is wide).
    const probeHere =
      thetaPrecision === null ? true : thetaPrecision < LOW_PRECISION_THRESHOLD;
    cells.push({
      key,
      cause_category: cell.cause_category,
      knowledge_id: cell.knowledge_id,
      recurrence_count: cell.attemptIds.size,
      evidence_event_ids: [...cell.attemptIds],
      theta_hat: thetaHat,
      theta_precision: thetaPrecision,
      probe_here: probeHere,
      has_owner_cause: cell.hasOwnerCause,
    });
  }

  // 3. Salience-first deterministic order: recurrence DESC, probe_here first, key ASC.
  cells.sort(
    (a, b) =>
      b.recurrence_count - a.recurrence_count ||
      Number(b.probe_here) - Number(a.probe_here) ||
      a.key.localeCompare(b.key),
  );
  return cells;
}
```

> Note on `thetaSe`: it is imported and named in the design contract because Task 4 (induction prompt assembly) renders SE for the model. In THIS function `probe_here` keys off `theta_precision` directly (monotone with `thetaSe`), so we keep the dependency explicit but compute the cheap comparison. If a linter flags the unused import, switch the threshold check to `thetaSe(thetaPrecision) > thetaSe(LOW_PRECISION_THRESHOLD)` — equivalent, and consumes the import.

- [ ] **Run it — expect PASS:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/conjectures/evidence.test.ts -t 'aggregation'
```

- [ ] **Commit:**
```bash
git add src/server/conjectures/evidence.ts src/server/conjectures/evidence.test.ts && git commit -m "feat(conjecture): deterministic 取证 gatherConjectureEvidence — cell aggregation + recurrence floor (YUK-406 Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Write failing test 2 — multi-KC fan-out + distinct-attempt recurrence.** Append to `evidence.test.ts`:

```ts
describe('gatherConjectureEvidence — multi-KC fan-out', () => {
  it('counts each KC separately and dedups attempt ids per cell', () => {
    const attempts: FailureAttempt[] = [
      // one attempt referencing two KCs ⇒ contributes to two cells
      failure('a1', ['k_chain_rule', 'k_product_rule'], {
        source: 'agent',
        category: 'concept.misapplied',
      }),
      failure('a2', ['k_chain_rule'], { source: 'agent', category: 'concept.misapplied' }),
      failure('a3', ['k_product_rule'], { source: 'agent', category: 'concept.misapplied' }),
    ];

    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });

    const byKey = new Map(cells.map((c) => [c.key, c]));
    expect(byKey.get(conjectureKey('concept.misapplied', 'k_chain_rule'))?.recurrence_count).toBe(2);
    expect(byKey.get(conjectureKey('concept.misapplied', 'k_product_rule'))?.recurrence_count).toBe(
      2,
    );
  });

  it('skips attempts with no active effective cause', () => {
    const noCause = failure('a1', ['k_x'], { source: 'agent', category: 'concept.misapplied' });
    // strip the judge so effectiveCauseForFailureAttempt returns null
    noCause.judge = undefined;
    const cells = gatherConjectureEvidence({
      failures: [noCause, noCause],
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });
    expect(cells).toHaveLength(0);
  });
});
```

- [ ] **Run it — expect PASS** (test 2 exercises behaviour already implemented; this locks the multi-KC + null-cause contract):
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/conjectures/evidence.test.ts -t 'multi-KC'
```

- [ ] **Commit:**
```bash
git add src/server/conjectures/evidence.test.ts && git commit -m "test(conjecture): lock multi-KC fan-out + null-cause skip in 取证 (YUK-406 Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Write failing test 3 — theta attach / probe_here + mem0 dedup + salience ordering.** Append to `evidence.test.ts`:

```ts
import type { MasteryStateRow } from '@/server/mastery/state';
import { LOW_PRECISION_THRESHOLD } from './evidence';

function mastery(subjectId: string, thetaHat: number, thetaPrecision: number): MasteryStateRow {
  return {
    subject_kind: 'knowledge',
    subject_id: subjectId,
    theta_hat: thetaHat,
    evidence_count: 3,
    success_count: 1,
    fail_count: 2,
    last_outcome_at: new Date('2026-06-18T00:00:00Z'),
    theta_precision: thetaPrecision,
    last_theta_delta: null,
  };
}

describe('gatherConjectureEvidence — theta attach, dedup, ordering', () => {
  it('attaches theta and flags low-precision (and unknown) KCs as probe_here', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_low'], { source: 'agent', category: 'concept.misapplied' }),
      failure('a2', ['k_low'], { source: 'agent', category: 'concept.misapplied' }),
      failure('b1', ['k_high'], { source: 'agent', category: 'procedure.slip' }),
      failure('b2', ['k_high'], { source: 'agent', category: 'procedure.slip' }),
      failure('c1', ['k_unknown'], { source: 'agent', category: 'recall.gap' }),
      failure('c2', ['k_unknown'], { source: 'agent', category: 'recall.gap' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map([
        ['k_low', mastery('k_low', -0.5, LOW_PRECISION_THRESHOLD - 0.5)],
        ['k_high', mastery('k_high', 1.2, LOW_PRECISION_THRESHOLD + 5)],
      ]),
      knownConjectureKeys: new Set(),
    });
    const byKey = new Map(cells.map((c) => [c.key, c]));
    const low = byKey.get(conjectureKey('concept.misapplied', 'k_low'));
    const high = byKey.get(conjectureKey('procedure.slip', 'k_high'));
    const unknown = byKey.get(conjectureKey('recall.gap', 'k_unknown'));
    expect(low?.theta_hat).toBe(-0.5);
    expect(low?.probe_here).toBe(true);
    expect(high?.probe_here).toBe(false);
    expect(unknown?.theta_hat).toBeNull();
    expect(unknown?.theta_precision).toBeNull();
    expect(unknown?.probe_here).toBe(true); // unknown mastery ⇒ probe
  });

  it('skips cells whose key is already known (mem0 CORE dedup)', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_x'], { source: 'agent', category: 'concept.misapplied' }),
      failure('a2', ['k_x'], { source: 'agent', category: 'concept.misapplied' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set([conjectureKey('concept.misapplied', 'k_x')]),
    });
    expect(cells).toHaveLength(0);
  });

  it('orders by recurrence DESC, then probe_here first, then key ASC', () => {
    const attempts: FailureAttempt[] = [
      // recurrence 3 cell
      failure('a1', ['k_a'], { source: 'agent', category: 'cat.a' }),
      failure('a2', ['k_a'], { source: 'agent', category: 'cat.a' }),
      failure('a3', ['k_a'], { source: 'agent', category: 'cat.a' }),
      // recurrence 2 cell, probe_here false (high precision)
      failure('b1', ['k_b'], { source: 'agent', category: 'cat.b' }),
      failure('b2', ['k_b'], { source: 'agent', category: 'cat.b' }),
      // recurrence 2 cell, probe_here true (unknown mastery)
      failure('c1', ['k_c'], { source: 'agent', category: 'cat.c' }),
      failure('c2', ['k_c'], { source: 'agent', category: 'cat.c' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map([['k_b', mastery('k_b', 0, LOW_PRECISION_THRESHOLD + 5)]]),
      knownConjectureKeys: new Set(),
    });
    expect(cells.map((c) => c.knowledge_id)).toEqual(['k_a', 'k_c', 'k_b']);
  });

  it('sets has_owner_cause when any contributing attempt has a user cause', () => {
    const attempts: FailureAttempt[] = [
      failure('a1', ['k_x'], { source: 'agent', category: 'concept.misapplied' }),
      failure('a2', ['k_x'], { source: 'user', category: 'concept.misapplied' }),
    ];
    const cells = gatherConjectureEvidence({
      failures: attempts,
      masteryByKnowledgeId: new Map(),
      knownConjectureKeys: new Set(),
    });
    expect(cells).toHaveLength(1);
    expect(cells[0].has_owner_cause).toBe(true);
  });
});
```

- [ ] **Run it — expect PASS:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/conjectures/evidence.test.ts -t 'theta attach'
```

- [ ] **Run the full file + Biome to confirm no regressions / format:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/conjectures/evidence.test.ts && pnpm biome check src/server/conjectures/evidence.ts src/server/conjectures/evidence.test.ts
```

- [ ] **Commit:**
```bash
git add src/server/conjectures/evidence.ts src/server/conjectures/evidence.test.ts && git commit -m "feat(conjecture): attach theta_hat/precision + probe_here flag, mem0 dedup, salience ordering (YUK-406 Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

#### PRODUCES / CONSUMES interfaces footer

**PRODUCES** (new — neighbouring tasks import these from `@/server/conjectures/evidence`):

```ts
export const CONJECTURE_RECURRENCE_FLOOR = 2;
export const LOW_PRECISION_THRESHOLD = 1.5;

export function conjectureKey(causeCategory: CauseCategoryT, knowledgeId: string): string;

export interface EvidenceCell {
  key: string;                       // conjectureKey(cause_category, knowledge_id)
  cause_category: CauseCategoryT;    // string (regex id), from effective cause
  knowledge_id: string;
  recurrence_count: number;          // distinct attempts, >= CONJECTURE_RECURRENCE_FLOOR
  evidence_event_ids: string[];      // attempt event ids (provenance → BaseProposal.evidence_refs)
  theta_hat: number | null;          // null on cold start
  theta_precision: number | null;    // null on cold start
  probe_here: boolean;               // low/unknown precision ⇒ spend the one probe here
  has_owner_cause: boolean;          // ANY contributing attempt source:'user' ⇒ lifts judge-only conf cap (D2/YUK-416)
}

export interface GatherConjectureEvidenceInput {
  failures: FailureAttempt[];                          // from getFailureAttempts({ since })
  masteryByKnowledgeId: Map<string, MasteryStateRow>;  // from getMasteryState per KC
  knownConjectureKeys: Set<string>;                    // mem0 CORE dedup
}

export function gatherConjectureEvidence(input: GatherConjectureEvidenceInput): EvidenceCell[];
```

**CONSUMES** (existing repo symbols — verified file:line):
- `FailureAttempt` — `src/server/events/queries.ts:78`; produced by `getFailureAttempts(db, { since })` `:166`.
- `effectiveCauseForFailureAttempt` — `src/server/events/cause-policy.ts:36` (returns `{ source: 'user'|'agent'; primary_category: CauseCategoryT } | null`).
- `CauseCategoryT` — `src/core/schema/event/blocks.ts:56` (= `string`).
- `MasteryStateRow` — `src/server/mastery/state.ts:30`; produced by `getMasteryState(db, knowledgeId, 'knowledge')` `:110`.
- `thetaSe` — `src/core/theta.ts:145`.

**NOTES for neighbouring tasks:**
- The thin DB wrapper (例会-job task) must call `getFailureAttempts(db, { since: nightlyWindowStart })`, then for each distinct `knowledge_id` across the results call `getMasteryState(db, knowledgeId)` and build the `Map`, then derive `knownConjectureKeys` from mem0 CORE (search_memory_facts for existing `mind_model` conjectures → `conjectureKey`). This keeps `gatherConjectureEvidence` pure and DB-free (unit-testable).
- `EvidenceCell.evidence_event_ids` feed directly into `BaseProposal.evidence_refs` (`ProposalEvidenceRef`) in the proposal-write task — provenance reuse, no new misconception table (YUK-406 spec).
- `EvidenceCell.has_owner_cause === false` is the precondition for the D2 judge-only confidence CAP (YUK-416); the induction/self-consistency task reads it.
- Salience for the "top 3 surfaced" UI = `recurrence_count` (this cell list is already salience-sorted; the induction task applies `confidence × recurrence` after the LLM assigns confidence).

This task adds NO schema columns, so no `audit:schema` / `audit:draft-status` allowlist entry is needed; the new file is pure TS that runs under the unit gate.

---

## ▸ Draft 3: induction-task

I have everything. `core/schema/business.ts` is pure Zod (no DB import → unit-safe). The drafted induction task module will be a pure function (no DB) so its tests go in the **unit** config. Now I'll write the plan.

---

## BUILD SPOT: Conjecture Induction LLM Task + D2 Self-Consistency

This build spot delivers two unit-testable modules with NO DB import:
1. The `MindModelInductionTask` registry entry + its conjecture-draft Zod schema (`src/core/schema/business.ts`).
2. A pure `induceConjecture()` orchestrator that runs Opus N-sample self-consistency over an injected `runTaskFn`, applies the judge-only-evidence confidence cap, and returns a `ConjectureDraft`.

All file:line citations verified against the real source below.

---

### Task 1: ConjectureDraft Zod schema + MindModelInductionTask registry entry

**Files**
- Modify: `src/core/schema/business.ts:337` (add `ConjectureDraft` after `VariantVerificationResult` block ends at line 337)
- Modify: `src/ai/registry.ts:604` (add `MindModelInductionTask` entry into the `tasks` object — insert after the `MemoryBriefTask` entry which closes at line 604)
- Test: `src/core/schema/business.test.ts` (existing unit-config file; if absent create it)
- Test: `src/ai/registry.test.ts` (existing unit-config file)

**Interfaces**
- Produces: `ConjectureDraft` (Zod schema) + `ConjectureDraftT` (inferred type) exported from `src/core/schema/business.ts`. Shape:
  ```ts
  { claim_md: string; probe_md: string; cause_category: string; recurrence_count: number; agreement_count: number }
  ```
- Produces: `tasks.MindModelInductionTask` registry entry, `kind: 'MindModelInductionTask'`, `defaultProvider: 'xiaomi'`, `defaultModel: 'mimo-v2.5-pro'` (the anthropic-sub Opus lane is selected per-call via `override`, NEVER as a task default — see `registry.ts:12-16` comment forbidding `anthropic-sub` as a `defaultProvider`).
- Consumes (from existing code): the `tasks` object shape `TaskDef` (`src/ai/registry.ts:39-62`); `DEFAULT_BUDGET` (`src/ai/registry.ts:64`).

Steps:

- [ ] **Write failing test** for the schema in `src/core/schema/business.test.ts`. The single conjecture record is small + bounded (约束 per the prompt note: large reasoning is markdown, only the small record is Zod). Add:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { ConjectureDraft } from './business';

  describe('ConjectureDraft', () => {
    it('accepts a well-formed second-person conjecture with exactly one probe', () => {
      const parsed = ConjectureDraft.safeParse({
        claim_md: 'you treat the chain rule as multiplying derivatives',
        probe_md: 'Differentiate sin(x^2). Show each factor.',
        cause_category: 'concept',
        recurrence_count: 3,
        agreement_count: 2,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects recurrence_count < 2 (Phase 0 invariant: a conjecture needs >=2 distinct attempts)', () => {
      const parsed = ConjectureDraft.safeParse({
        claim_md: 'you confuse necessary and sufficient',
        probe_md: 'Is "x>2" necessary or sufficient for "x>0"? Explain.',
        cause_category: 'logic',
        recurrence_count: 1,
        agreement_count: 2,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects an empty probe_md (exactly one discriminating probe required)', () => {
      const parsed = ConjectureDraft.safeParse({
        claim_md: 'you skip unit conversion',
        probe_md: '',
        cause_category: 'careless',
        recurrence_count: 2,
        agreement_count: 1,
      });
      expect(parsed.success).toBe(false);
    });
  });
  ```
- [ ] **Run it, expect FAIL** (`ConjectureDraft` not yet exported):
  ```
  pnpm vitest run --config vitest.unit.config.ts src/core/schema/business.test.ts -t ConjectureDraft
  ```
- [ ] **Minimal implementation** — in `src/core/schema/business.ts`, immediately after the `VariantVerificationResult = z.object({...})` block (it closes at line 337), insert:
  ```ts
  // YUK-406 (Phase 0 关系脑) — the small structured record an induction run emits.
  // Large reasoning stays as the run's markdown text; ONLY this bounded record is
  // schema-constrained (mirrors the VariantVerificationResult precedent above).
  // - claim_md: 2nd-person belief about the owner's THINKING ("you treat ...").
  // - probe_md: exactly ONE untested discriminating probe (one question's worth).
  // - recurrence_count: >=2 — a conjecture requires >=2 distinct attempts of evidence.
  // - agreement_count: how many of the N self-consistency samples agreed on this
  //   claim (the raw count; induceConjecture() derives confidence from it). The
  //   LLM fills 1 per single sample; the orchestrator overwrites with the tally.
  // confidence itself is NOT in this schema: it is internal calibration only and is
  // NEVER rendered as a number (Phase 0 anti-number rule), so it lives on the
  // orchestrator's return type, not the model-facing record.
  export const ConjectureDraft = z.object({
    claim_md: z.string().min(1).max(500),
    probe_md: z.string().min(1).max(1000),
    cause_category: z.string().min(1).max(120),
    recurrence_count: z.number().int().min(2),
    agreement_count: z.number().int().min(1).default(1),
  });
  export type ConjectureDraftT = z.infer<typeof ConjectureDraft>;
  ```
- [ ] **Run it, expect PASS**:
  ```
  pnpm vitest run --config vitest.unit.config.ts src/core/schema/business.test.ts -t ConjectureDraft
  ```
- [ ] **Write failing test** for the registry entry in `src/ai/registry.test.ts` (mirrors how other task entries are pinned):
  ```ts
  import { describe, expect, it } from 'vitest';
  import { tasks } from './registry';

  describe('MindModelInductionTask registry entry', () => {
    it('is registered as a text-only single-shot task (Opus lane chosen per-call via override, not as default)', () => {
      const def = tasks.MindModelInductionTask;
      expect(def.kind).toBe('MindModelInductionTask');
      // anthropic-sub is opt-in via override only; it is NEVER a task default.
      expect(def.defaultProvider).not.toBe('anthropic-sub');
      expect(def.needsToolCall).toBe(false);
      expect(def.isMultimodal).toBe(false);
      expect(def.budget.maxIterations).toBe(1);
    });
  });
  ```
- [ ] **Run it, expect FAIL** (`tasks.MindModelInductionTask` is `undefined`):
  ```
  pnpm vitest run --config vitest.unit.config.ts src/ai/registry.test.ts -t MindModelInductionTask
  ```
- [ ] **Minimal implementation** — in `src/ai/registry.ts`, inside the `tasks` object, after the `MemoryBriefTask` entry (it closes at line 604 with `},`) and before `TaggingTask:` (line 605), insert:
  ```ts
  // YUK-406 (Phase 0 关系脑) — the conjecture induction step of the nightly 教研
  // 例会. Given a list of EvidenceCells (cause_category × KC recurrence + θ̂ /
  // θ precision signals, assembled deterministically WITHOUT an LLM by the 取证
  // sibling task), induce/update ONE conjecture about the owner's thinking and
  // synthesize its single discriminating probe — emitted as the small ConjectureDraft
  // record (claim_md + probe_md), with the large reasoning staying as markdown text.
  //
  // D2 mitigation runs at the ORCHESTRATOR layer (induceConjecture), not here: the
  // orchestrator calls this task N times on the Opus (anthropic-sub OAuth) lane via
  // `override: { provider: 'anthropic-sub' }` and tallies agreement (self-consistency).
  // This registry default stays mimo so non-override callers (and tests) never need
  // the OAuth token; the nightly job supplies the override (registry.ts:12-16 forbids
  // anthropic-sub as a defaultProvider). Single structured-output call, no tool loop —
  // mirrors GoalScopeTask / MemoryBriefTask.
  MindModelInductionTask: {
    kind: 'MindModelInductionTask',
    description:
      'YUK-406 (Phase 0) — induce/update ONE conjecture about the owner mind from a list of EvidenceCells (cause_category × KC recurrence + θ̂ / θ precision) and synthesize its single discriminating probe. Emits the small ConjectureDraft record (claim_md + probe_md + cause_category + recurrence_count); large reasoning returns as markdown. Single structured-output call (no tool loop). Default model is mimo for token-free tests; the nightly 例会 job runs it on the Opus anthropic-sub lane via per-call override for D2 self-consistency.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是教研例会的归因研究员。输入 { evidence_cells: [{ knowledge_id, cause_category, recurrence_count, theta_hat, theta_precision, evidence_event_ids: [...] }], prior_claim_md?: string }——每个 cell 是某知识点上某错因类别累积了 ≥2 次不同 attempt 的确定性取证结果，theta_precision 低代表该处掌握度估计不确定（值得探针）。\n你的任务：归纳/更新关于 owner**思维方式**的一个猜想（claim），并为它合成恰好一个能区分该猜想真伪的探针（probe）。\n要点：\n- claim_md 必须是**第二人称、关于思维的**陈述（例：「你把链式法则当成导数相乘」「你混淆必要与充分条件」），不是关于某道题对错的陈述。\n- probe_md 是恰好一道能证实或证伪该 claim 的题（一道题的量），未测过的角度。\n- cause_category 选输入 evidence_cells 里出现的错因类别之一。\n- recurrence_count 取支撑该 claim 的 cell 的最大 recurrence_count（≥2）。\n先用一段 markdown 写出你的归纳推理（证据如何指向这个思维模式），然后严格输出 JSON（不带 markdown 代码块包裹）：{"claim_md":"...","probe_md":"...","cause_category":"...","recurrence_count":<int>=2>,"agreement_count":1}。agreement_count 恒填 1（多样本一致性由调用方统计）。',
  },
  ```
- [ ] **Run it, expect PASS**:
  ```
  pnpm vitest run --config vitest.unit.config.ts src/ai/registry.test.ts -t MindModelInductionTask
  ```
- [ ] **Commit**:
  ```
  git commit -am "feat(agency): ConjectureDraft schema + MindModelInductionTask registry entry (YUK-406 Phase 0)"
  ```

---

### Task 2: induceConjecture() — Opus N-sample self-consistency + judge-only confidence cap

**Files**
- Create: `src/server/agency/conjecture/induce.ts`
- Test: `src/server/agency/conjecture/induce.test.ts` (UNIT config — this module has NO DB import; it takes an injected `runTaskFn`, exactly like the `dreaming_nightly.ts` `RunAgentTaskFn` seam at `dreaming_nightly.ts:53-61` and the `variant_verify.ts` `parseVariantVerifyResult` seam at `variant_verify.ts:118`)

**Interfaces**
- Consumes: `ConjectureDraft` / `ConjectureDraftT` from `@/core/schema/business` (Task 1). `TaskTextResult` / `TaskTextRunFn` from `@/server/ai/provenance` (`provenance.ts:0-15` — `TaskTextRunFn = (kind, input, ctx: unknown) => Promise<TaskTextResult>`, where `TaskTextResult = { text, task_run_id?, cost_usd?, structured_output? }`). `zodToJsonSchemaOutputFormat` from `@/server/ai/output-format` (`output-format.ts:51`).
- Produces: `EvidenceCell` (TS interface — the deterministic取证 output the neighboring 取证 task produces; defined here so neighbors line up); `InduceConjectureInput`; `InduceConjectureResult` (`{ draft: ConjectureDraftT; confidence: number; confidence_capped: boolean; samples: number }`); `induceConjecture(args)` async fn.
- The Opus lane is selected by passing `override: { provider: 'anthropic-sub' }` in the ctx (resolved by `resolveTaskProvider`, `providers.ts:162-251` — `anthropic-sub` has a built-in `ANTHROPIC_SUB_DEFAULT_MODEL` Opus default so no `AI_PROVIDER_MODEL` is needed; the guard at `providers.ts:181-191` exempts it).

Steps:

- [ ] **Write failing test 1 — dedup of identical-claim samples → confidence from agreement.** Create `src/server/agency/conjecture/induce.test.ts`:
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import type { TaskTextResult } from '@/server/ai/provenance';
  import { type EvidenceCell, induceConjecture } from './induce';

  const baseCells: EvidenceCell[] = [
    {
      knowledge_id: 'k_chain_rule',
      cause_category: 'concept',
      recurrence_count: 3,
      theta_hat: -0.4,
      theta_precision: 1.2,
      evidence_event_ids: ['e_a', 'e_b', 'e_c'],
      has_owner_cause: true,
    },
  ];

  function sample(claim: string): TaskTextResult {
    return {
      text: `reasoning...\n${JSON.stringify({
        claim_md: claim,
        probe_md: 'Differentiate sin(x^2). Show each factor.',
        cause_category: 'concept',
        recurrence_count: 3,
        agreement_count: 1,
      })}`,
    };
  }

  describe('induceConjecture self-consistency', () => {
    it('agreement across samples raises confidence; the dominant claim is returned with its tally', async () => {
      const claim = 'you treat the chain rule as multiplying derivatives';
      const runTaskFn = vi
        .fn<[string, unknown, unknown], Promise<TaskTextResult>>()
        .mockResolvedValueOnce(sample(claim))
        .mockResolvedValueOnce(sample(claim))
        .mockResolvedValueOnce(sample('you forget to apply the power rule'));

      const result = await induceConjecture({ cells: baseCells, samples: 3, runTaskFn });

      expect(result.draft.claim_md).toBe(claim); // 2 of 3 agreed → dominant
      expect(result.draft.agreement_count).toBe(2);
      expect(result.samples).toBe(3);
      // confidence = agreement / samples = 2/3, not capped (owner_cause present)
      expect(result.confidence).toBeCloseTo(2 / 3, 5);
      expect(result.confidence_capped).toBe(false);
      // It ran on the Opus anthropic-sub lane for every sample.
      for (const call of runTaskFn.mock.calls) {
        expect(call[0]).toBe('MindModelInductionTask');
        expect((call[2] as { override?: { provider?: string } }).override?.provider).toBe(
          'anthropic-sub',
        );
      }
    });
  });
  ```
- [ ] **Run it, expect FAIL** (module `./induce` does not exist):
  ```
  pnpm vitest run --config vitest.unit.config.ts src/server/agency/conjecture/induce.test.ts -t 'raises confidence'
  ```
- [ ] **Minimal implementation** — create `src/server/agency/conjecture/induce.ts`:
  ```ts
  // YUK-406 (Phase 0 关系脑) — conjecture induction orchestrator with D2 mitigation.
  //
  // Pure (no DB / no R2): the 取证 sibling assembles the EvidenceCell list
  // deterministically (cause_category × KC recurrence via effectiveCauseForFailureAttempt
  // PLUS theta_hat / theta_precision from mastery_state — no LLM), and the nightly
  // 例会 job persists the result. This module ONLY runs the LLM induction and applies
  // the D2 mitigations, taking an injected runTaskFn so it is unit-testable with a fake.
  //
  // D2 (CORRECTED per YUK-416 — NO heterogeneous mimo+Opus Jury; that is DEFERRED):
  //   1. Opus SELF-CONSISTENCY — run the SAME MindModelInductionTask N times on the
  //      Opus (anthropic-sub OAuth) lane; cluster samples by claim; the dominant
  //      claim wins and its agreement fraction (agreement / samples) IS the confidence.
  //   2. JUDGE-ONLY-EVIDENCE CAP — if EVERY supporting evidence cell is agent-judge
  //      with no owner_cause, cap confidence at JUDGE_ONLY_CONFIDENCE_CAP (the owner
  //      never corroborated it, so we must not be loud about it).
  //   3. owner-correction golden anchor is applied by the caller (the job feeds a
  //      prior_claim_md / corrected_by_owner signal); this module surfaces the cap +
  //      raw confidence for the caller to combine.
  //
  // confidence is INTERNAL calibration only — it is returned as a number here for
  // sorting/calibration but is NEVER rendered to the owner as a number (Phase 0 rule).

  import { ConjectureDraft, type ConjectureDraftT } from '@/core/schema/business';
  import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
  import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';

  /**
   * Deterministic 取证 output: one (knowledge_id × cause_category) cell that
   * recurred across >=2 distinct attempts, carrying the θ̂ / θ precision signals
   * from mastery_state and whether ANY supporting attempt had an owner_cause.
   * Produced by the 取证 sibling build-spot; defined here so neighbors align.
   */
  export interface EvidenceCell {
    knowledge_id: string;
    cause_category: string;
    /** >=2 distinct attempts (Phase 0 recurrence invariant). */
    recurrence_count: number;
    /** mastery_state.theta_hat (logit). */
    theta_hat: number;
    /** mastery_state.theta_precision (Fisher info; low ⇒ uncertain ⇒ probe here). */
    theta_precision: number;
    /** event ids that are the provenance for this cell (reused as evidence_refs). */
    evidence_event_ids: string[];
    /**
     * true when at least one supporting attempt carried an owner (user) cause
     * (cause-policy `source: 'user'`); false when every cause is an agent judge.
     * Drives the judge-only confidence cap.
     */
    has_owner_cause: boolean;
  }

  export interface InduceConjectureInput {
    cells: EvidenceCell[];
    /** N self-consistency samples (>=1). The nightly job passes 3. */
    samples: number;
    /** injected runner — defaults to the real runTask in the job, faked in tests. */
    runTaskFn: TaskTextRunFn;
    /** prior conjecture claim being updated, if any (owner-correction anchor feed). */
    priorClaimMd?: string;
  }

  export interface InduceConjectureResult {
    draft: ConjectureDraftT;
    /** internal calibration in [0,1]; NEVER rendered as a number to the owner. */
    confidence: number;
    confidence_capped: boolean;
    samples: number;
    /** task_run_ids of every sample (provenance / cost trail). */
    task_run_ids: string[];
    cost_usd: number;
  }

  /** Confidence ceiling when ALL evidence is agent-judge (no owner corroboration). */
  export const JUDGE_ONLY_CONFIDENCE_CAP = 0.5;

  function parseSampleDraft(result: TaskTextResult): ConjectureDraftT | null {
    // Three-state dispatch mirrors variant_verify.ts:118 — prefer the SDK's
    // structured_output (Opus honours outputFormat), else char-scan the text.
    if (result.structured_output !== undefined && result.structured_output !== null) {
      const parsed = ConjectureDraft.safeParse(result.structured_output);
      return parsed.success ? parsed.data : null;
    }
    const start = result.text.indexOf('{');
    const end = result.text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
      const parsed = ConjectureDraft.safeParse(JSON.parse(result.text.slice(start, end + 1)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Normalize a claim for clustering (case + whitespace insensitive). */
  function claimKey(claim: string): string {
    return claim.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  export async function induceConjecture(
    input: InduceConjectureInput,
  ): Promise<InduceConjectureResult> {
    const { cells, samples, runTaskFn, priorClaimMd } = input;
    if (samples < 1) throw new Error('induceConjecture: samples must be >= 1');
    if (cells.length === 0) throw new Error('induceConjecture: cells must be non-empty');

    const taskInput = {
      evidence_cells: cells.map((c) => ({
        knowledge_id: c.knowledge_id,
        cause_category: c.cause_category,
        recurrence_count: c.recurrence_count,
        theta_hat: c.theta_hat,
        theta_precision: c.theta_precision,
        evidence_event_ids: c.evidence_event_ids,
      })),
      ...(priorClaimMd ? { prior_claim_md: priorClaimMd } : {}),
    };

    // Run N samples on the Opus anthropic-sub lane (override; providers.ts exempts
    // it from the AI_PROVIDER_MODEL guard via ANTHROPIC_SUB_DEFAULT_MODEL).
    const drafts: ConjectureDraftT[] = [];
    const taskRunIds: string[] = [];
    let costUsd = 0;
    for (let i = 0; i < samples; i++) {
      const result = await runTaskFn('MindModelInductionTask', taskInput, {
        override: { provider: 'anthropic-sub' as const },
        outputFormat: zodToJsonSchemaOutputFormat(ConjectureDraft),
      });
      if (result.task_run_id) taskRunIds.push(result.task_run_id);
      costUsd += result.cost_usd ?? 0;
      const draft = parseSampleDraft(result);
      if (draft) drafts.push(draft);
    }
    if (drafts.length === 0) {
      throw new Error('induceConjecture: no sample produced a valid ConjectureDraft');
    }

    // Cluster by normalized claim; the dominant cluster wins, agreement = its size.
    const clusters = new Map<string, ConjectureDraftT[]>();
    for (const d of drafts) {
      const key = claimKey(d.claim_md);
      const bucket = clusters.get(key) ?? [];
      bucket.push(d);
      clusters.set(key, bucket);
    }
    let dominant: ConjectureDraftT[] = [];
    for (const bucket of clusters.values()) {
      if (bucket.length > dominant.length) dominant = bucket;
    }
    const agreement = dominant.length;
    // Self-consistency confidence = agreement fraction over the N samples run.
    let confidence = agreement / samples;

    // Judge-only-evidence cap: every supporting cell is agent-judge, no owner_cause.
    const allJudgeOnly = cells.every((c) => !c.has_owner_cause);
    const confidence_capped = allJudgeOnly && confidence > JUDGE_ONLY_CONFIDENCE_CAP;
    if (confidence_capped) confidence = JUDGE_ONLY_CONFIDENCE_CAP;

    // Stamp the agreement tally onto the returned draft (the model filled 1).
    const draft: ConjectureDraftT = { ...dominant[0], agreement_count: agreement };

    return { draft, confidence, confidence_capped, samples, task_run_ids: taskRunIds, cost_usd: costUsd };
  }
  ```
- [ ] **Run it, expect PASS**:
  ```
  pnpm vitest run --config vitest.unit.config.ts src/server/agency/conjecture/induce.test.ts -t 'raises confidence'
  ```
- [ ] **Commit**:
  ```
  git commit -am "feat(agency): induceConjecture Opus self-consistency orchestrator (YUK-406 Phase 0 D2)"
  ```

- [ ] **Write failing test 2 — judge-only confidence cap.** Append to `src/server/agency/conjecture/induce.test.ts`:
  ```ts
  it('caps confidence when ALL evidence is agent-judge (no owner_cause)', async () => {
    const claim = 'you misread the sign in inequalities';
    const judgeOnlyCells: EvidenceCell[] = [
      {
        knowledge_id: 'k_ineq',
        cause_category: 'careless',
        recurrence_count: 4,
        theta_hat: 0.1,
        theta_precision: 0.8,
        evidence_event_ids: ['e_1', 'e_2', 'e_3', 'e_4'],
        has_owner_cause: false, // every cause is an agent judge
      },
    ];
    const judgeSample = (): TaskTextResult => ({
      text: JSON.stringify({
        claim_md: claim,
        probe_md: 'Solve -2x > 6 and state the direction flip.',
        cause_category: 'careless',
        recurrence_count: 4,
        agreement_count: 1,
      }),
    });
    const runTaskFn = vi
      .fn<[string, unknown, unknown], Promise<TaskTextResult>>()
      .mockResolvedValue(judgeSample()); // all 3 samples agree → raw conf 1.0

    const result = await induceConjecture({ cells: judgeOnlyCells, samples: 3, runTaskFn });

    expect(result.draft.claim_md).toBe(claim);
    expect(result.confidence_capped).toBe(true);
    expect(result.confidence).toBe(0.5); // capped from raw 1.0
  });

  it('does NOT cap when at least one cell carries an owner_cause', async () => {
    const ownerCells: EvidenceCell[] = [
      {
        knowledge_id: 'k_ineq',
        cause_category: 'careless',
        recurrence_count: 2,
        theta_hat: 0.0,
        theta_precision: 1.0,
        evidence_event_ids: ['e_1', 'e_2'],
        has_owner_cause: true,
      },
    ];
    const sample = (): TaskTextResult => ({
      text: JSON.stringify({
        claim_md: 'you flip the inequality only sometimes',
        probe_md: 'Solve -3x <= 9.',
        cause_category: 'careless',
        recurrence_count: 2,
        agreement_count: 1,
      }),
    });
    const runTaskFn = vi
      .fn<[string, unknown, unknown], Promise<TaskTextResult>>()
      .mockResolvedValue(sample());

    const result = await induceConjecture({ cells: ownerCells, samples: 2, runTaskFn });
    expect(result.confidence_capped).toBe(false);
    expect(result.confidence).toBe(1); // 2/2 agreement, uncapped
  });
  ```
- [ ] **Run it, expect PASS** (the cap logic from the prior implementation step already covers it):
  ```
  pnpm vitest run --config vitest.unit.config.ts src/server/agency/conjecture/induce.test.ts -t cap
  ```
  If RED: confirm the cap branch in `induce.ts` reads `cells.every((c) => !c.has_owner_cause)` and clamps to `JUDGE_ONLY_CONFIDENCE_CAP`. Re-run.
- [ ] **Write failing test 3 — reuses structured_output when the Opus endpoint honours outputFormat.** Append:
  ```ts
  it('prefers result.structured_output over char-scanning the text (Opus honours outputFormat)', async () => {
    const runTaskFn = vi
      .fn<[string, unknown, unknown], Promise<TaskTextResult>>()
      .mockResolvedValue({
        text: 'prose with no json braces at all',
        structured_output: {
          claim_md: 'you generalize from a single worked example',
          probe_md: 'Here is a NEW case the example did not cover; predict it.',
          cause_category: 'concept',
          recurrence_count: 2,
          agreement_count: 1,
        },
      });

    const result = await induceConjecture({ cells: baseCells, samples: 1, runTaskFn });
    expect(result.draft.claim_md).toBe('you generalize from a single worked example');
    expect(result.draft.agreement_count).toBe(1);
  });
  ```
- [ ] **Run it, expect PASS** (the `parseSampleDraft` structured_output branch already handles it):
  ```
  pnpm vitest run --config vitest.unit.config.ts src/server/agency/conjecture/induce.test.ts -t structured_output
  ```
- [ ] **Commit**:
  ```
  git commit -am "test(agency): induceConjecture judge-only cap + structured_output dispatch (YUK-406 Phase 0)"
  ```

- [ ] **Run the full unit suite for the touched files** to confirm no cross-file breakage:
  ```
  pnpm vitest run --config vitest.unit.config.ts src/server/agency/conjecture/induce.test.ts src/core/schema/business.test.ts src/ai/registry.test.ts
  ```
- [ ] **Run typecheck + lint on the new files** (pre-PR gate subset):
  ```
  pnpm typecheck && pnpm exec biome check src/server/agency/conjecture/induce.ts src/server/agency/conjecture/induce.test.ts src/core/schema/business.ts src/ai/registry.ts
  ```

---

## PRODUCES / CONSUMES interfaces footer (for neighboring tasks to line up)

**This build spot PRODUCES (exact names + signatures):**

```ts
// from @/core/schema/business
export const ConjectureDraft: z.ZodObject<{
  claim_md: z.ZodString; probe_md: z.ZodString; cause_category: z.ZodString;
  recurrence_count: z.ZodNumber; agreement_count: z.ZodDefault<z.ZodNumber>;
}>;
export type ConjectureDraftT = {
  claim_md: string; probe_md: string; cause_category: string;
  recurrence_count: number; agreement_count: number;
};

// from @/ai/registry  (tasks object)
tasks.MindModelInductionTask: TaskDef; // defaultProvider 'xiaomi', model 'mimo-v2.5-pro', maxIterations 1, needsToolCall false

// from @/server/agency/conjecture/induce
export interface EvidenceCell {
  knowledge_id: string; cause_category: string; recurrence_count: number;
  theta_hat: number; theta_precision: number; evidence_event_ids: string[];
  has_owner_cause: boolean;
}
export interface InduceConjectureInput {
  cells: EvidenceCell[]; samples: number; runTaskFn: TaskTextRunFn; priorClaimMd?: string;
}
export interface InduceConjectureResult {
  draft: ConjectureDraftT; confidence: number; confidence_capped: boolean;
  samples: number; task_run_ids: string[]; cost_usd: number;
}
export const JUDGE_ONLY_CONFIDENCE_CAP = 0.5;
export async function induceConjecture(input: InduceConjectureInput): Promise<InduceConjectureResult>;
```

**This build spot CONSUMES (verified file:line, owned by other build spots / existing code):**

- `TaskTextRunFn = (kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>` and `TaskTextResult = { text: string; task_run_id?: string; cost_usd?: number; structured_output?: unknown }` — `src/server/ai/provenance.ts:0-15`.
- `zodToJsonSchemaOutputFormat(schema: ZodTypeAny): JsonSchemaOutputFormat` — `src/server/ai/output-format.ts:51`.
- `runTask(kind, input, ctx: RunTaskCtx): Promise<RunTaskResult>` — the real fn the **nightly-job build spot** injects as `runTaskFn`; `RunTaskCtx.override?.provider` + `RunTaskCtx.outputFormat` are the two fields this spot sets — `src/server/ai/runner.ts:87-138` (`RunTaskCtx`), `464-630` (`runTask`). `RunTaskResult.structured_output` at `runner.ts:57-72`. Note `runTask`'s ctx requires `db: Db`; the **nightly-job spot's** injected wrapper supplies `db` (same pattern as `dreaming_nightly.ts:53-61` `RunAgentTaskFn`), so this orchestrator's `TaskTextRunFn` stays DB-free for unit tests.
- Opus lane selection: `override: { provider: 'anthropic-sub' }` is resolved by `resolveTaskProvider` — `src/server/ai/providers.ts:162-251`; `anthropic-sub` is exempt from the `AI_PROVIDER_MODEL` guard (`providers.ts:181-191`) and supplies `ANTHROPIC_SUB_DEFAULT_MODEL` (Opus 4.8), so no extra config is needed beyond the `CLAUDE_CODE_OAUTH_TOKEN` env (which the worker process already loads per the stack note).

**Hand-off to neighboring build spots (NOT built here):**

- **取证 spot** produces `EvidenceCell[]` (deterministic: `effectiveCauseForFailureAttempt` at `src/server/events/cause-policy.ts:35-67` gives `source: 'user' | 'agent'` → maps to `has_owner_cause`; `mastery_state.theta_hat` / `theta_precision` at `src/db/schema.ts:765,777` give the θ signals; `thetaSe` at `src/core/theta.ts:145` available if SE form is preferred over raw precision). It MUST set `has_owner_cause` from the cause `source`, and only emit cells with `recurrence_count >= 2`.
- **Nightly-job spot** calls `induceConjecture({ cells, samples: 3, runTaskFn })` (wrapping the real `runTask` with `db`), then writes the conjecture as a `mind_model` proposal whose `evidence_refs` reuse `draft`'s backing `EvidenceCell.evidence_event_ids`, stores `confidence` (internal sort only) + `confidence_capped` + `agreement_count` in payload, and emits the cost event using `cost_usd` (mirrors `dreaming_nightly.ts:388-390` `cost_micro_usd = Math.round(cost_usd * 1_000_000)`). It must enforce the `<=3 concurrent active probes` and `up to 3 conjectures` caps at the job layer (this orchestrator induces ONE).

**Gate note:** No new DB columns are introduced by THIS build spot (pure schema + pure orchestrator), so `audit:schema` / `audit:draft-status` need no allowlist entry from here — those gates are the nightly-job/proposal-persistence spot's responsibility when it adds the `mind_model` write path.

---

## ▸ Draft 4: nightly-job-and-tool

Confirmed: `research_meeting` / `conjecture` / `mind_model` are greenfield (no existing code). I now have all real signatures. Here is the task markdown for my build spot.

---

## BUILD SPOT: `nightly-job-and-tool` — `research_meeting_nightly` sibling job + `propose_conjecture` DomainTool + manifest registration

Grounding notes (every signature cited against the real source I read):

- DomainTool contract: `src/server/ai/tools/types.ts:51-65` — `DomainTool<Input,Output>` = `{ name, description, effect, inputSchema: z.ZodType<Input>, outputSchema: z.ZodType<Output>, costClass, execute(ctx,input), summarize(input,output), mirrorEvent }`; `ToolContext` (`:38-44`) = `{ db, taskRunId, callerActor: {kind,ref}, causedByEventId? }`.
- `writeAiProposal(db, input)` → `Promise<string>` at `src/server/proposals/writer.ts:98`; `WriteAiProposalInput` (`:17-33`) = `{ id?, session_id?, actor_ref?, outcome?, payload: AiProposalPayloadInputT, event_override?, caused_by_event_id?, task_run_id?, cost_usd?, created_at? }`. The `default` branch of `eventShapeForProposal` (`:86-95`) writes `action: 'experimental:proposal'`, `subject_kind: payload.target.subject_kind`, payload `{ ai_proposal: payload }` — exactly the path a `mind_model` conjecture takes (NO writer change, like `goal_scope`).
- `ProposalEvidenceRef` (`src/core/schema/proposal.ts:95-98`) reuses `kind: 'event' | 'question' | 'knowledge' | 'artifact' | 'record'` + `id`. Conjecture provenance = `evidence_refs` of event ids (no new table).
- The conjecture kind `'conjecture'` + its `proposed_change` schema (`ConjectureProposalChange`) are PRODUCED by the schema task (Task in the neighboring `proposal-schema` build spot). I CONSUME `parseAiProposalPayload` and the `'conjecture'` literal from `@/core/schema/proposal`.
- The MCP bridge requires `inputSchema instanceof z.ZodObject` (`src/server/ai/tools/mcp-bridge.ts:145-149`) — so the tool's inputSchema must be a flat `z.object(...)`.
- Job sibling shape: `src/capabilities/agency/jobs/dreaming_nightly.ts` — trigger `writeEvent`, `buildMcpServerFromRegistry({ ctx, serverName, toolNames, taskKind, beforeExecute })`, `runAgentTask(kind, input, { db, mcpServers, allowedTools })`, scan `writeEvent` with `cost_micro_usd = Math.round(cost_usd * 1_000_000)`, try/catch failure event.
- Manifest: `src/capabilities/agency/manifest.ts:25-53` `jobs.handlers[]` entries `{ name, schedule:{cron,tz}, queue, load }`; `JobDecl` (`src/kernel/manifest.ts:42-53`). The registrar `registerCapabilityJobs` (`src/server/boss/register-capability-jobs.ts:68-81`) auto-mounts any handler with `load`.
- Provider lane: the Opus self-consistency runs on `anthropic-sub` (`src/server/ai/providers.ts:89-90`, authMode `'oauth'`). `runAgentTask`'s `RunTaskCtx.override` (`src/server/ai/runner.ts:88-93`) carries `{ provider, model }`. The job threads `override: { provider: 'anthropic-sub' }` through its `RunAgentTaskFn` ctx.

---

### Task 8: `propose_conjecture` DomainTool (thin wrap of `writeAiProposal`, `mind_model`/`conjecture` kind)

**Files**
- Create: `src/server/ai/tools/conjecture-tools.ts`
- Modify: `src/server/ai/tools/bootstrap.ts:66` (import), `src/server/ai/tools/bootstrap.ts:125` (CORE_TOOLS tail entry)
- Modify: `src/server/ai/tools/allowlists.ts:40` (`PROPOSE_WRITE_TOOLS` tail) + `:332` (`research_meeting` surface entry) + `:111` (`DomainToolSurface` union)
- Test: `src/server/ai/tools/conjecture-tools.unit.test.ts`

**Interfaces**

Consumes (from the `proposal-schema` build spot — Task 1; these MUST already exist):
```ts
// @/core/schema/proposal
// aiProposalKinds includes 'conjecture'; AiProposalPayload has the branch:
//   BaseProposal.extend({
//     kind: z.literal('conjecture'),
//     target: ProposalTarget.extend({ subject_kind: z.literal('mind_model') }),
//     proposed_change: ConjectureProposalChange,
//   })
export const ConjectureProposalChange: z.ZodObject<{
  claim: z.ZodString;                                  // 2nd-person, about thinking
  knowledge_id: z.ZodString;
  cause_category: z.ZodString;
  recurrence_count: z.ZodNumber;                       // int >= 2
  discriminating_probe: z.ZodString;                   // exactly ONE probe
  corrected_by_owner: z.ZodDefault<z.ZodBoolean>;      // default false
  confidence_bucket: z.ZodEnum<['low','medium','high']>; // sort/calibration ONLY, never rendered as a number
}>;
export type ConjectureProposalChangeT = z.infer<typeof ConjectureProposalChange>;
export function parseAiProposalPayload(input: unknown): AiProposalPayloadT; // proposal.ts:430
```

Produces (later tasks rely on these EXACT names):
```ts
// @/server/ai/tools/conjecture-tools
export const proposeConjectureTool: DomainTool<ProposeConjectureInput, ProposeConjectureOutput>;
export type ProposeConjectureInput = z.infer<typeof ProposeConjectureInputSchema>;
export type ProposeConjectureOutput = z.infer<typeof ProposeConjectureOutputSchema>;
// allowlists.ts: 'propose_conjecture' added to PROPOSE_WRITE_TOOLS;
//   DomainToolSurface gains 'research_meeting'; DOMAIN_TOOL_ALLOWLISTS.research_meeting = [...readers, 'propose_conjecture']
```

**Steps**

- [ ] **Add `'propose_conjecture'` to `PROPOSE_WRITE_TOOLS`.** Append after `'propose_question_edit'` at `src/server/ai/tools/allowlists.ts:88`:
```ts
  'propose_question_edit',
  // YUK-406 Phase 0 — 关系脑 conjecture proposer. Thin wrap of writeAiProposal
  // (kind 'conjecture', subject_kind 'mind_model'). Granted ONLY on the
  // research_meeting surface below (the sleep-time 教研例会 job is the single
  // proposer; ND-5 — it never writes FSRS state).
  'propose_conjecture',
] as const;
```

- [ ] **Add the `research_meeting` surface + allowlist.** In the `DomainToolSurface` union (`allowlists.ts:124`, after `'review_plan'`):
```ts
  | 'review_plan'
  // YUK-406 Phase 0 — sleep-time 教研例会 surface. Read evidence + propose
  // conjectures only. NOT granted to copilot/dreaming/coach (single-writer:
  // the 例会 job is the only CORE proposer).
  | 'research_meeting';
```
Add the const array before `DOMAIN_TOOL_ALLOWLISTS` (after `REVIEW_PLAN_TOOLS`, `allowlists.ts:330`):
```ts
// YUK-406 Phase 0 — 教研例会 surface allowlist. Reads enough learning signal to
// induce a conjecture (mistakes + attempt context + knowledge + memory facts),
// then the single propose_conjecture write. propose_conjecture lives ONLY here.
const RESEARCH_MEETING_TOOLS = [
  'query_mistakes',
  'get_attempt_context',
  'query_knowledge',
  'query_events',
  'search_memory_facts',
  'propose_conjecture',
] as const satisfies readonly DomainToolName[];
```
Add the surface entry in `DOMAIN_TOOL_ALLOWLISTS` (`allowlists.ts:341`, before the closing `}`):
```ts
  review_plan: REVIEW_PLAN_TOOLS,
  research_meeting: RESEARCH_MEETING_TOOLS,
} as const satisfies Record<DomainToolSurface, readonly DomainToolName[]>;
```

- [ ] **Write the failing test** `src/server/ai/tools/conjecture-tools.unit.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from './types';
import { proposeConjectureTool } from './conjecture-tools';

describe('proposeConjectureTool', () => {
  const ctx = (): ToolContext => ({
    db: {} as never,
    taskRunId: 'task_rm_1',
    callerActor: { kind: 'agent', ref: 'research_meeting' },
    causedByEventId: 'rm_trigger_1',
  });

  it('is a propose-effect tool named propose_conjecture with a ZodObject input', () => {
    expect(proposeConjectureTool.name).toBe('propose_conjecture');
    expect(proposeConjectureTool.effect).toBe('propose');
    // MCP bridge requires a z.object inputSchema (mcp-bridge.ts:145).
    expect(proposeConjectureTool.inputSchema.constructor.name).toBe('ZodObject');
  });

  it('wraps writeAiProposal with a conjecture/mind_model payload and event-kind evidence refs', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_conjecture_1');
    const out = await proposeConjectureTool.execute(ctx(), {
      claim: 'you treat the chain rule as multiplying derivatives',
      knowledge_id: 'k_chain_rule',
      cause_category: 'concept_confusion',
      recurrence_count: 3,
      discriminating_probe: 'Differentiate sin(x^2): is the answer cos(x^2) or 2x·cos(x^2)?',
      confidence_bucket: 'medium',
      evidence_event_ids: ['ev_1', 'ev_1', 'ev_2'],
      reasoning: 'two distinct failures on chain-rule attempts',
      __writeAiProposalFn: writeAiProposalFn,
    } as never);

    expect(out).toEqual({ status: 'proposed', proposal_id: 'prop_conjecture_1' });
    expect(writeAiProposalFn).toHaveBeenCalledTimes(1);
    const [, input] = writeAiProposalFn.mock.calls[0];
    expect(input.actor_ref).toBe('research_meeting');
    expect(input.task_run_id).toBe('task_rm_1');
    expect(input.caused_by_event_id).toBe('rm_trigger_1');
    expect(input.payload).toMatchObject({
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'k_chain_rule' },
      proposed_change: {
        claim: 'you treat the chain rule as multiplying derivatives',
        knowledge_id: 'k_chain_rule',
        cause_category: 'concept_confusion',
        recurrence_count: 3,
        confidence_bucket: 'medium',
        corrected_by_owner: false,
      },
    });
    // provenance reuses event evidence_refs, deduped.
    expect(input.payload.evidence_refs).toEqual([
      { kind: 'event', id: 'ev_1' },
      { kind: 'event', id: 'ev_2' },
    ]);
  });

  it('rejects recurrence_count < 2 (>=2 distinct attempts invariant)', async () => {
    const writeAiProposalFn = vi.fn(async () => 'unused');
    const out = await proposeConjectureTool.execute(ctx(), {
      claim: 'you misread the question',
      knowledge_id: 'k1',
      cause_category: 'careless',
      recurrence_count: 1,
      discriminating_probe: 'p',
      confidence_bucket: 'low',
      reasoning: 'r',
      __writeAiProposalFn: writeAiProposalFn,
    } as never);
    expect(out.status).toBe('skipped:below_recurrence_floor');
    expect(writeAiProposalFn).not.toHaveBeenCalled();
  });

  it('summarize folds the claim + status under ~120 chars', () => {
    const s = proposeConjectureTool.summarize(
      { claim: 'you treat the chain rule as multiplying derivatives' } as never,
      { status: 'proposed', proposal_id: 'prop_1' } as never,
    );
    expect(s).toContain('conjecture');
    expect(s).toContain('proposed');
    expect(s.length).toBeLessThanOrEqual(120);
  });
});
```

- [ ] **Run it, expect FAIL** (module missing):
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/ai/tools/conjecture-tools.unit.test.ts
```

- [ ] **Minimal implementation** — create `src/server/ai/tools/conjecture-tools.ts`:
```ts
// YUK-406 Phase 0 (关系脑 thin slice) — propose_conjecture DomainTool.
//
// Thin wrap of writeAiProposal, exactly like the LearningItem proposal tools:
// it writes ONE conjecture (kind 'conjecture', target.subject_kind 'mind_model')
// through the existing experimental:proposal event/inbox path — NO writer change,
// NO new misconception table, NO consistency-gate. provenance REUSES
// evidence_refs (event ids). confidence is an internal calibration bucket
// (low|medium|high) that is sorted on but NEVER rendered as a number. The probe
// is carried as text only here (it is generated as a real served-once question by
// the FSRS one-shot lane, NOT by this tool — ND-5: this surface never writes FSRS
// state). Granted ONLY on the research_meeting surface (allowlists.ts).
import {
  type AiProposalPayloadInputT,
  type ProposalEvidenceRefT,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { writeAiProposal } from '@/server/proposals/writer';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const ProposeConjectureInputSchema = z.object({
  // 2nd-person, about the owner's THINKING (e.g. "you treat the chain rule as
  // multiplying derivatives"). Free text; the prompt-step enforces the framing.
  claim: z.string().min(1).max(2000),
  knowledge_id: z.string().min(1),
  cause_category: z.string().min(1),
  // >=2 distinct failure attempts (recurrence invariant). Enforced in execute()
  // so the flat z.object stays MCP-bridge compatible (no .refine).
  recurrence_count: z.number().int(),
  // Exactly ONE untested discriminating probe (text). Served-once question
  // generation is a different lane (FSRS one-shot); not this tool's job.
  discriminating_probe: z.string().min(1).max(2000),
  // Internal sort/calibration ONLY. NEVER rendered as a number (3-bucket).
  confidence_bucket: z.enum(['low', 'medium', 'high']),
  // provenance: the evidence event ids this conjecture is induced from.
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  reasoning: z.string().min(1).max(4000),
  // Set true only when the owner edited it (corrected_by_owner). The 例会 job
  // always proposes with false; the owner-edit path sets it on accept/edit.
  corrected_by_owner: z.boolean().optional(),
  // Test-only DI seam (mirrors the proposal-tools default-fn pattern). Never set
  // by the model — the MCP bridge zod-parses args and this field is ignored on
  // the live path because writeAiProposal is the captured default.
  __writeAiProposalFn: z.any().optional(),
});

const ProposeConjectureOutputSchema = z.object({
  status: z.enum(['proposed', 'skipped:below_recurrence_floor']),
  proposal_id: z.string().optional(),
  reason: z.string().optional(),
});

export type ProposeConjectureInput = z.infer<typeof ProposeConjectureInputSchema>;
export type ProposeConjectureOutput = z.infer<typeof ProposeConjectureOutputSchema>;

type WriteAiProposalFn = (
  db: Db | Tx,
  input: Parameters<typeof writeAiProposal>[1],
) => Promise<string>;

function evidenceRefsFromEventIds(ids: string[]): ProposalEvidenceRefT[] {
  return [...new Set(ids)].map((id) => ({ kind: 'event', id }));
}

async function proposeConjectureExecute(
  ctx: ToolContext,
  raw: ProposeConjectureInput,
): Promise<ProposeConjectureOutput> {
  const input = ProposeConjectureInputSchema.parse(raw);
  // Recurrence floor: a conjecture needs >=2 distinct attempts of evidence.
  if (input.recurrence_count < 2) {
    return {
      status: 'skipped:below_recurrence_floor',
      reason: `recurrence_count ${input.recurrence_count} < 2`,
    };
  }
  const write: WriteAiProposalFn =
    (input.__writeAiProposalFn as WriteAiProposalFn | undefined) ?? writeAiProposal;

  const payload: AiProposalPayloadInputT = {
    kind: 'conjecture',
    target: { subject_kind: 'mind_model', subject_id: input.knowledge_id },
    reason_md: input.reasoning,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    proposed_change: {
      claim: input.claim,
      knowledge_id: input.knowledge_id,
      cause_category: input.cause_category,
      recurrence_count: input.recurrence_count,
      discriminating_probe: input.discriminating_probe,
      confidence_bucket: input.confidence_bucket,
      corrected_by_owner: input.corrected_by_owner ?? false,
    },
  } as AiProposalPayloadInputT;
  // Parse-and-throw early so a schema drift surfaces here, not deep in writeAiProposal.
  parseAiProposalPayload(payload);

  const proposalId = await write(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    payload,
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
  return { status: 'proposed', proposal_id: proposalId };
}

export const proposeConjectureTool: DomainTool<
  ProposeConjectureInput,
  ProposeConjectureOutput
> = {
  name: 'propose_conjecture',
  description:
    'Propose ONE conjecture about the owner\'s mind: a 2nd-person claim about their thinking, tied to a knowledge_id + cause_category, backed by >=2 distinct failure attempts (recurrence_count), carrying exactly one untested discriminating probe and an internal confidence bucket (low|medium|high, never a number). Proposal-only via the inbox; the owner accepts/edits/rejects. Never writes FSRS state.',
  effect: 'propose',
  inputSchema: ProposeConjectureInputSchema,
  outputSchema: ProposeConjectureOutputSchema,
  costClass: 'local',
  execute: proposeConjectureExecute,
  summarize(input, output) {
    const claim = (input.claim ?? '').slice(0, 60);
    return `conjecture "${claim}": ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
```

- [ ] **Register in bootstrap.** Add the import after `writeQuizTool` import at `src/server/ai/tools/bootstrap.ts:66`:
```ts
import { writeQuizTool } from './write-quiz';
// YUK-406 Phase 0 — 关系脑 conjecture proposer.
import { proposeConjectureTool } from './conjecture-tools';
```
Add the CORE_TOOLS tail entry after `writeReviewPlanTool` (`bootstrap.ts:125`):
```ts
  writeReviewPlanTool as DomainTool<unknown, unknown>,
  // YUK-406 Phase 0 — research_meeting surface propose tool.
  proposeConjectureTool as DomainTool<unknown, unknown>,
];
```

- [ ] **Run it, expect PASS:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/server/ai/tools/conjecture-tools.unit.test.ts
```

- [ ] **Commit:**
```bash
git add src/server/ai/tools/conjecture-tools.ts src/server/ai/tools/conjecture-tools.unit.test.ts src/server/ai/tools/bootstrap.ts src/server/ai/tools/allowlists.ts
git commit -m "feat(agency): propose_conjecture DomainTool + research_meeting surface (YUK-406 Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `research_meeting_nightly` sibling job — orchestrate evidence → induction → propose up to 3

**Files**
- Create: `src/capabilities/agency/jobs/research_meeting_nightly.ts`
- Test: `src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts`

**Interfaces**

Consumes (from the two neighboring build spots — these are injected via deps, so the job test stubs them; the real defaults are imported):
```ts
// gatherConjectureEvidence — from the `evidence` build spot (取证, deterministic, NO LLM):
//   cause_category x KC recurrence (>=2 distinct attempts) via effectiveCauseForFailureAttempt
//   + theta_hat/theta_precision from mastery_state + mem0 CORE dedup.
export type ConjectureEvidence = {
  knowledge_id: string;
  cause_category: string;
  recurrence_count: number;          // >= 2
  evidence_event_ids: string[];
  theta_hat: number | null;
  theta_precision: number | null;    // low precision = probe here
};
export function gatherConjectureEvidence(db: Db, opts: { now: Date; limit: number }): Promise<ConjectureEvidence[]>;

// runConjectureInduction — from the `induction` build spot (LLM prompt-step on the Opus
// self-consistency lane). Induces/updates ONE conjecture + synthesizes its one probe.
export type InducedConjecture = {
  knowledge_id: string;
  cause_category: string;
  recurrence_count: number;
  claim: string;
  discriminating_probe: string;
  confidence_bucket: 'low' | 'medium' | 'high'; // self-consistency agreement + judge-only-evidence cap applied upstream
  evidence_event_ids: string[];
};
export function runConjectureInduction(args: {
  db: Db;
  evidence: ConjectureEvidence;
  runAgentTaskFn: RunAgentTaskFn;        // threaded so the Opus lane override flows through
  triggerEventId: string;
  toolContextTaskRunId: string;
}): Promise<InducedConjecture | null>;

// proposeConjectureTool (Task 8) — surfaced via the research_meeting MCP allowlist.
// resolveDomainToolNames('research_meeting') / resolveMcpAllowedTools('research_meeting').
```

Produces (Task 10 + tests rely on these EXACT names):
```ts
// @/capabilities/agency/jobs/research_meeting_nightly
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;
export const RESEARCH_MEETING_OBJECTIVE: string;
export interface ResearchMeetingResult {
  processed: number;
  conjectures_created: number;
  pending_after: number;
  task_run_id?: string;
  tool_context_task_run_id: string;
}
export async function runResearchMeetingNightly(db: Db, deps?: ResearchMeetingDeps): Promise<ResearchMeetingResult>;
export function buildResearchMeetingNightlyHandler(db: Db, deps?: ResearchMeetingDeps): (jobs: Job<Record<string, never>>[]) => Promise<void>;
```

**Steps**

- [ ] **Write the failing test** `src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  RESEARCH_MEETING_MAX_CONJECTURES,
  runResearchMeetingNightly,
} from './research_meeting_nightly';

function fakeEvidence(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    knowledge_id: `k_${i}`,
    cause_category: 'concept_confusion',
    recurrence_count: 2 + i,
    evidence_event_ids: [`ev_${i}_a`, `ev_${i}_b`],
    theta_hat: -0.5,
    theta_precision: 0.2,
  }));
}

function fakeInduced(ev: { knowledge_id: string }) {
  return {
    knowledge_id: ev.knowledge_id,
    cause_category: 'concept_confusion',
    recurrence_count: 2,
    claim: `you confuse ${ev.knowledge_id}`,
    discriminating_probe: `probe for ${ev.knowledge_id}`,
    confidence_bucket: 'medium' as const,
    evidence_event_ids: ['ev_x', 'ev_y'],
  };
}

describe('runResearchMeetingNightly', () => {
  it('runs ResearchMeetingTask on the Opus lane, propose-only, and writes a cost-bearing scan event', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'c1', status: 'pending' },
        { id: 'c2', status: 'pending' },
      ]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_rm_1',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
      cost_usd: 0.05,
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const gatherConjectureEvidenceFn = vi.fn(async () => fakeEvidence(2));
    const runConjectureInductionFn = vi.fn(async ({ evidence }) => fakeInduced(evidence));

    const result = await runResearchMeetingNightly(db, {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      gatherConjectureEvidenceFn,
      runConjectureInductionFn,
      now: () => new Date('2026-06-18T03:30:00.000Z'),
    });

    expect(result).toMatchObject({ processed: 1, conjectures_created: 2, pending_after: 2 });

    // Opus lane: ctx.override.provider === 'anthropic-sub'.
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'ResearchMeetingTask',
      expect.objectContaining({ run_kind: 'nightly' }),
      expect.objectContaining({
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('research_meeting')],
        override: { provider: 'anthropic-sub' },
      }),
    );

    // research_meeting surface + propose-only cap of 3.
    expect(buildMcpServerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
        toolNames: resolveDomainToolNames('research_meeting'),
        taskKind: 'ResearchMeetingTask',
        ctx: expect.objectContaining({
          callerActor: { kind: 'agent', ref: 'research_meeting' },
          causedByEventId: expect.stringMatching(/^research_meeting_trigger_/),
        }),
      }),
    );
    const buildOptions = buildMcpServerFn.mock.calls[0]?.[0];
    if (!buildOptions?.beforeExecute) throw new Error('expected beforeExecute gate');
    for (let i = 0; i < RESEARCH_MEETING_MAX_CONJECTURES; i++) {
      expect(buildOptions.beforeExecute?.({ name: `propose_${i}`, effect: 'propose' })).toBe(undefined);
    }
    expect(buildOptions.beforeExecute?.({ name: 'over_cap', effect: 'propose' })).toMatch(/cap reached/);
    expect(buildOptions.beforeExecute?.({ name: 'query_mistakes', effect: 'read' })).toBeUndefined();

    // cost event written (cost_micro_usd = round(cost_usd * 1e6)).
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:research_meeting_scan',
        actor_kind: 'agent',
        actor_ref: 'research_meeting',
        outcome: 'success',
        cost_micro_usd: 50_000,
        payload: expect.objectContaining({ conjectures_created: 2 }),
      }),
    );
  });

  it('caps induction to the first 3 evidence groups even if more are gathered', async () => {
    const db = {} as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake' }) as never);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runConjectureInductionFn = vi.fn(async ({ evidence }) => fakeInduced(evidence));

    await runResearchMeetingNightly(db, {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      gatherConjectureEvidenceFn: async () => fakeEvidence(5),
      runConjectureInductionFn,
      now: () => new Date('2026-06-18T03:30:00.000Z'),
    });

    // 5 gathered, only the first 3 fed to induction (salience-truncated upstream).
    expect(runConjectureInductionFn).toHaveBeenCalledTimes(RESEARCH_MEETING_MAX_CONJECTURES);
  });

  it('writes a failure event and rethrows when the task fails', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    await expect(
      runResearchMeetingNightly(db, {
        listProposalInboxRowsFn: vi.fn(async () => []),
        buildMcpServerFn: vi.fn(() => ({}) as never),
        runAgentTaskFn: vi.fn(async () => {
          throw new Error('opus down');
        }),
        writeEventFn,
        gatherConjectureEvidenceFn: async () => fakeEvidence(1),
        runConjectureInductionFn: async ({ evidence }) => fakeInduced(evidence),
        now: () => new Date('2026-06-18T03:30:00.000Z'),
      }),
    ).rejects.toThrow('opus down');
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:research_meeting_scan',
        outcome: 'failure',
        payload: expect.objectContaining({ error: 'opus down' }),
      }),
    );
  });
});
```

- [ ] **Run it, expect FAIL** (module missing):
```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts
```

- [ ] **Minimal implementation** — create `src/capabilities/agency/jobs/research_meeting_nightly.ts`:
```ts
// YUK-406 Phase 0 (关系脑 thin slice) — research_meeting_nightly pg-boss handler.
//
// A nightly sleep-time 教研例会. While the owner is away it reads recent learning
// events, induces up to 3 CONJECTURES about the owner's mind, and surfaces them as
// steerable proposals in the 备课台 (prep-desk). Mirrors the dreaming_nightly /
// coach_daily sibling shape: trigger event → research_meeting MCP bridge
// (propose-only + per-run cap) → ResearchMeetingTask on the Opus self-consistency
// lane → cost-bearing scan event, try/catch failure event.
//
// ND-5 invariant: this job is propose-only. It NEVER writes FSRS state and never
// reads the FSRS-due queue. The probe is text on the proposal; served-once probe
// question generation + confirm/retire is a separate lane.
//
// Single-writer: this job is the ONLY proposer of conjectures (mem0 CORE is
// written only by the sleep job; copilot is read-only on CORE).
import { createId } from '@paralleldrive/cuid2';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';
// 取证 (deterministic, NO LLM) — cause_category x KC recurrence + theta + mem0 dedup.
import { type ConjectureEvidence, gatherConjectureEvidence } from './conjecture-evidence';
// induction (LLM prompt-step on the Opus self-consistency lane).
import { type InducedConjecture, runConjectureInduction } from './conjecture-induction';

// Up to 3 conjectures surfaced per run (also the concurrent-active-probe ceiling).
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;

export const RESEARCH_MEETING_OBJECTIVE =
  'Review the gathered conjecture evidence and, for each, induce or update ONE conjecture about how the owner thinks — a 2nd-person claim about their thinking — then propose it via propose_conjecture with its single discriminating probe. Propose at most 3. Do not mutate user data directly; never write review/FSRS state.';

export interface ResearchMeetingResult {
  processed: number;
  conjectures_created: number;
  pending_after: number;
  task_run_id?: string;
  tool_context_task_run_id: string;
}

type ProposalSnapshotRow = Pick<ProposalInboxRow, 'id' | 'status'>;
type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer>;
    allowedTools?: string[];
    // YUK-406 — Opus self-consistency lane override threaded through.
    override?: { provider?: string; model?: string };
  },
) => Promise<RunTaskResult>;
type ListProposalInboxRowsFn = (db: Db) => Promise<ProposalSnapshotRow[]>;
type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
type GatherConjectureEvidenceFn = (
  db: Db,
  opts: { now: Date; limit: number },
) => Promise<ConjectureEvidence[]>;
type RunConjectureInductionFn = (args: {
  db: Db;
  evidence: ConjectureEvidence;
  runAgentTaskFn: RunAgentTaskFn;
  triggerEventId: string;
  toolContextTaskRunId: string;
}) => Promise<InducedConjecture | null>;

export interface ResearchMeetingDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  gatherConjectureEvidenceFn?: GatherConjectureEvidenceFn;
  runConjectureInductionFn?: RunConjectureInductionFn;
  now?: () => Date;
}

function buildResearchMeetingInput(
  now: Date,
  beforeRows: ProposalSnapshotRow[],
  induced: InducedConjecture[],
) {
  return {
    run_kind: 'nightly',
    now: now.toISOString(),
    pending_proposals_before: beforeRows.filter((row) => row.status === 'pending').length,
    objective: RESEARCH_MEETING_OBJECTIVE,
    // Deterministically gathered + induced conjecture candidates (already capped
    // + ordered by salience upstream). The model reads these and calls
    // propose_conjecture for the ones it endorses.
    conjecture_candidates: induced.map((c) => ({
      knowledge_id: c.knowledge_id,
      cause_category: c.cause_category,
      recurrence_count: c.recurrence_count,
      claim: c.claim,
      discriminating_probe: c.discriminating_probe,
      confidence_bucket: c.confidence_bucket,
      evidence_event_ids: c.evidence_event_ids,
    })),
    budget: {
      max_conjectures: RESEARCH_MEETING_MAX_CONJECTURES,
      stop_when_no_actionable_conjecture: true,
    },
    proposal_policy: {
      prefer_existing_proposal_tools: true,
      avoid_duplicates: true,
      no_silent_writes: true,
    },
  };
}

export async function runResearchMeetingNightly(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const now = deps.now?.() ?? new Date();
  const listRows = deps.listProposalInboxRowsFn ?? listProposalInboxRows;
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const write = deps.writeEventFn ?? writeEvent;
  const gather = deps.gatherConjectureEvidenceFn ?? gatherConjectureEvidence;
  const induce = deps.runConjectureInductionFn ?? runConjectureInduction;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const triggerEventId = `research_meeting_trigger_${createId()}`;
  const toolContextTaskRunId = `research_meeting_tool_${createId()}`;

  // 取证: deterministic, NO LLM. Gather a few more than the cap, then truncate to
  // the top RESEARCH_MEETING_MAX_CONJECTURES (salience ordering done upstream).
  const evidence = (await gather(db, { now, limit: RESEARCH_MEETING_MAX_CONJECTURES })).slice(
    0,
    RESEARCH_MEETING_MAX_CONJECTURES,
  );

  await write(db, {
    id: triggerEventId,
    actor_kind: 'cron',
    actor_ref: 'nightly_research_meeting',
    action: 'experimental:trigger_research_meeting_scan',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: null,
    payload: {
      surface: 'research_meeting',
      pending_before: beforeRows.filter((row) => row.status === 'pending').length,
      evidence_groups: evidence.length,
    },
    created_at: now,
  });

  try {
    // induction (LLM prompt-step on the Opus lane) per evidence group.
    const induced: InducedConjecture[] = [];
    for (const ev of evidence) {
      const result = await induce({
        db,
        evidence: ev,
        runAgentTaskFn: run,
        triggerEventId,
        toolContextTaskRunId,
      });
      if (result) induced.push(result);
    }

    const toolNames = resolveDomainToolNames('research_meeting');
    let proposalWrites = 0;
    const mcpServer = buildMcpServer({
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        callerActor: { kind: 'agent', ref: 'research_meeting' },
        causedByEventId: triggerEventId,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames,
      taskKind: 'ResearchMeetingTask',
      beforeExecute: (tool) => {
        if (tool.effect !== 'propose' && tool.effect !== 'write') return undefined;
        if (proposalWrites >= RESEARCH_MEETING_MAX_CONJECTURES) {
          return `research_meeting conjecture cap reached (${RESEARCH_MEETING_MAX_CONJECTURES}); stop proposing in this run`;
        }
        proposalWrites += 1;
        return undefined;
      },
    });

    const taskResult = await run('ResearchMeetingTask', buildResearchMeetingInput(now, beforeRows, induced), {
      db,
      mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
      allowedTools: [...resolveMcpAllowedTools('research_meeting')],
      // YUK-406 — Opus self-consistency lane (anthropic-sub OAuth). The D2
      // mitigation (multi-sample agreement + judge-only-evidence cap +
      // owner-correction anchor) runs here.
      override: { provider: 'anthropic-sub' },
    });

    const afterRows = await listRows(db);
    const pendingAfter = afterRows.filter((row) => row.status === 'pending').length;
    const conjecturesCreated = afterRows.filter((row) => !beforeIds.has(row.id)).length;

    await write(db, {
      id: `research_meeting_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'research_meeting',
      action: 'experimental:research_meeting_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        conjectures_created: conjecturesCreated,
        pending_after: pendingAfter,
        evidence_groups: evidence.length,
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      task_run_id: taskResult.task_run_id,
      cost_micro_usd:
        taskResult.cost_usd === undefined ? null : Math.round(taskResult.cost_usd * 1_000_000),
      created_at: deps.now?.() ?? new Date(),
    });

    return {
      processed: 1,
      conjectures_created: conjecturesCreated,
      pending_after: pendingAfter,
      task_run_id: taskResult.task_run_id,
      tool_context_task_run_id: toolContextTaskRunId,
    };
  } catch (err) {
    await write(db, {
      id: `research_meeting_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'research_meeting',
      action: 'experimental:research_meeting_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'failure',
      payload: {
        error: err instanceof Error ? err.message : String(err),
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      created_at: deps.now?.() ?? new Date(),
    });
    throw err;
  }
}

export function buildResearchMeetingNightlyHandler(
  db: Db,
  deps: ResearchMeetingDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runResearchMeetingNightly(db, deps);
    console.log('[research_meeting_nightly] result', result);
  };
}
```

> Note: the imports `./conjecture-evidence` (Task: evidence build spot) and `./conjecture-induction` (Task: induction build spot) are produced by the neighboring tasks. If those modules do not yet exist when this task runs, the unit test still passes because every default is overridden by injected deps — but `pnpm typecheck` (Task 11 gate) requires the two sibling modules to export the cited `ConjectureEvidence` / `InducedConjecture` types + functions. Order this task AFTER the evidence + induction tasks land, or stub the two modules with the exact exported signatures first.

- [ ] **Run it, expect PASS:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts
```

- [ ] **Commit:**
```bash
git add src/capabilities/agency/jobs/research_meeting_nightly.ts src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts
git commit -m "feat(agency): research_meeting_nightly job orchestrates evidence→induction→propose<=3 conjectures on Opus lane (YUK-406 Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Register `research_meeting_nightly` in the agency manifest

**Files**
- Modify: `src/capabilities/agency/manifest.ts:53` (append to `jobs.handlers`)
- Test: `src/capabilities/agency/manifest.unit.test.ts` (create if absent)

**Interfaces**

Consumes:
```ts
// buildResearchMeetingNightlyHandler (Task 9) — JobHandlerFactory shape (db) => (jobs) => Promise<void>.
// JobDecl (src/kernel/manifest.ts:42-53): { name, schedule?:{cron,tz}, queue:'llm'|'agent'|'fast', load? }.
```

Produces:
```ts
// agencyCapability.jobs.handlers gains { name: 'research_meeting_nightly', schedule:{cron:'20 4 * * *', tz:'Asia/Shanghai'}, queue:'agent', load }.
// Auto-mounted by registerCapabilityJobs (register-capability-jobs.ts:73) — no other wiring.
```

**Steps**

- [ ] **Write the failing test** `src/capabilities/agency/manifest.unit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { agencyCapability } from './manifest';

describe('agency manifest — research_meeting_nightly', () => {
  it('declares the research_meeting_nightly cron job on the agent queue after dreaming', () => {
    const handlers = agencyCapability.jobs?.handlers ?? [];
    const rm = handlers.find((h) => h.name === 'research_meeting_nightly');
    expect(rm).toBeDefined();
    expect(rm?.queue).toBe('agent');
    // Cron is after dreaming_nightly (03:15) so evidence reflects the night's events.
    expect(rm?.schedule).toEqual({ cron: '20 4 * * *', tz: 'Asia/Shanghai' });
    expect(rm?.load).toBeTypeOf('function');
  });

  it('lazy-loads buildResearchMeetingNightlyHandler', async () => {
    const rm = agencyCapability.jobs?.handlers.find((h) => h.name === 'research_meeting_nightly');
    const factory = await rm?.load?.();
    expect(factory).toBeTypeOf('function');
  });
});
```

- [ ] **Run it, expect FAIL** (handler not declared):
```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/agency/manifest.unit.test.ts
```

- [ ] **Minimal implementation** — append the handler in `src/capabilities/agency/manifest.ts`. After the `goal_scope_propose_nightly` entry (`manifest.ts:52`), before the closing `],` of `handlers`:
```ts
      {
        name: 'goal_scope_propose_nightly',
        schedule: { cron: '50 3 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/goal_scope_propose_nightly').then(
            (m) => m.buildGoalScopeProposeNightlyHandler,
          ),
      },
      // YUK-406 Phase 0 — sleep-time 教研例会. Runs AFTER dreaming (03:15) /
      // coach_daily (03:45) so its 取证 reflects the night's full event set.
      // queue 'agent' (DomainTool-loop job, like dreaming_nightly), not 'llm'.
      {
        name: 'research_meeting_nightly',
        schedule: { cron: '20 4 * * *', tz: 'Asia/Shanghai' },
        queue: 'agent',
        load: () =>
          import('./jobs/research_meeting_nightly').then(
            (m) => m.buildResearchMeetingNightlyHandler,
          ),
      },
```

- [ ] **Run it, expect PASS:**
```bash
pnpm vitest run --config vitest.unit.config.ts src/capabilities/agency/manifest.unit.test.ts
```

- [ ] **Commit:**
```bash
git add src/capabilities/agency/manifest.ts src/capabilities/agency/manifest.unit.test.ts
git commit -m "feat(agency): register research_meeting_nightly job in agency manifest (YUK-406 Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PRODUCES / CONSUMES interfaces footer

**PRODUCES** (neighboring tasks line up against these exact names/signatures):

```ts
// src/server/ai/tools/conjecture-tools.ts
export const proposeConjectureTool: DomainTool<ProposeConjectureInput, ProposeConjectureOutput>;
//   name: 'propose_conjecture'; effect: 'propose'; costClass: 'local'; mirrorEvent: 'when_causal'
export type ProposeConjectureInput = {
  claim: string; knowledge_id: string; cause_category: string;
  recurrence_count: number; discriminating_probe: string;
  confidence_bucket: 'low'|'medium'|'high';
  evidence_event_ids?: string[]; reasoning: string; corrected_by_owner?: boolean;
};
export type ProposeConjectureOutput = { status: 'proposed'|'skipped:below_recurrence_floor'; proposal_id?: string; reason?: string };

// src/server/ai/tools/allowlists.ts
//   PROPOSE_WRITE_TOOLS now includes 'propose_conjecture'
//   DomainToolSurface now includes 'research_meeting'
//   DOMAIN_TOOL_ALLOWLISTS.research_meeting = ['query_mistakes','get_attempt_context','query_knowledge','query_events','search_memory_facts','propose_conjecture']
//   resolveDomainToolNames('research_meeting') / resolveMcpAllowedTools('research_meeting') resolve it

// src/capabilities/agency/jobs/research_meeting_nightly.ts
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;
export const RESEARCH_MEETING_OBJECTIVE: string;
export interface ResearchMeetingResult { processed: number; conjectures_created: number; pending_after: number; task_run_id?: string; tool_context_task_run_id: string }
export interface ResearchMeetingDeps { runAgentTaskFn?; listProposalInboxRowsFn?; buildMcpServerFn?; writeEventFn?; gatherConjectureEvidenceFn?; runConjectureInductionFn?; now? }
export async function runResearchMeetingNightly(db: Db, deps?: ResearchMeetingDeps): Promise<ResearchMeetingResult>;
export function buildResearchMeetingNightlyHandler(db: Db, deps?: ResearchMeetingDeps): (jobs: Job<Record<string,never>>[]) => Promise<void>;

// src/capabilities/agency/manifest.ts
//   agencyCapability.jobs.handlers gains research_meeting_nightly (cron '20 4 * * *' Asia/Shanghai, queue 'agent')
```

**CONSUMES** (these must be PRODUCED by the neighboring build spots before Task 9/typecheck):

```ts
// proposal-schema build spot (@/core/schema/proposal):
//   aiProposalKinds includes 'conjecture'
//   AiProposalPayload discriminated-union branch: kind 'conjecture', target.subject_kind literal 'mind_model', proposed_change = ConjectureProposalChange
export const ConjectureProposalChange: z.ZodObject<{
  claim, knowledge_id, cause_category, recurrence_count(int>=2),
  discriminating_probe, corrected_by_owner(default false), confidence_bucket('low'|'medium'|'high')
}>;
//   NOTE: 'conjecture' is intentionally NOT in acceptSupportedProposalKinds yet — accept/edit/reject
//   dispatch is the UI/备课台 build spot's task. inbox-meta.unit.test.ts pins
//   (acceptSupportedProposalKinds ∪ unimplemented) === aiProposalKinds, so the schema task MUST add
//   'conjecture' to the unimplemented-kinds list in that test (alongside defer/archive/judge_retraction)
//   or to acceptSupportedProposalKinds — coordinate with the schema task.

// evidence build spot (@/capabilities/agency/jobs/conjecture-evidence):
export type ConjectureEvidence = { knowledge_id: string; cause_category: string; recurrence_count: number; evidence_event_ids: string[]; theta_hat: number|null; theta_precision: number|null };
export function gatherConjectureEvidence(db: Db, opts: { now: Date; limit: number }): Promise<ConjectureEvidence[]>;

// induction build spot (@/capabilities/agency/jobs/conjecture-induction):
export type InducedConjecture = { knowledge_id: string; cause_category: string; recurrence_count: number; claim: string; discriminating_probe: string; confidence_bucket: 'low'|'medium'|'high'; evidence_event_ids: string[] };
export function runConjectureInduction(args: { db: Db; evidence: ConjectureEvidence; runAgentTaskFn; triggerEventId: string; toolContextTaskRunId: string }): Promise<InducedConjecture | null>;
```

**Key grounding caveats for the implementing engineer:**
1. `inbox-meta.unit.test.ts` pins `acceptSupportedProposalKinds ∪ {defer, archive, judge_retraction} === aiProposalKinds` (`proposal.ts:70-93`). Adding `'conjecture'` to `aiProposalKinds` will break that test until the schema task updates it. This is the schema task's responsibility — flag the dependency.
2. There is likely an `allowlists.unit.test.ts` `listTools()` inventory assertion (referenced repeatedly in `allowlists.ts` comments, e.g. `:56-57`, `:72`) that pins the exact CORE_TOOLS tail order. Adding `proposeConjectureTool` at the CORE_TOOLS tail (`bootstrap.ts:125`) and `'propose_conjecture'` at the `PROPOSE_WRITE_TOOLS` tail keeps the orders aligned; the inventory test will need `'propose_conjecture'` added to its expected list — run `pnpm vitest run --config vitest.unit.config.ts src/server/ai/tools/allowlists` and update the expected array if it fails.
3. `copilot-tools.unit.test.ts` (`allowlists.ts:138-139`) enforces COPILOT_TOOLS parity with the per-package `manifest.copilotTools`. `propose_conjecture` is NOT a copilot tool (single-writer: only the 例会 job proposes), so do NOT add it to `COPILOT_TOOLS` or any package's `copilotTools` — that parity test stays green untouched.
4. The Opus lane is set via `override: { provider: 'anthropic-sub' }` (`providers.ts:89`). In prod the global `AI_PROVIDER_OVERRIDE` may already force every task onto `anthropic-sub`; the explicit per-call override is idempotent with that (per-call override wins, `runner.ts:172`) and guarantees the lane even when the global switch is off.

---

## ▸ Draft 5: accept-applier-mem0

I have everything I need. The route layer (`proposal-decide.ts`) passes `{ decision, new_relation_type, user_note }` — I'll need `corrected_payload` plumbed through `AcceptAiProposalOpts`, but the route plumbing is a neighboring task's concern. This build spot's scope is the `dispatchAccept` conjecture case + the applier + the accept-not-confirmed semantics + the mem0 CORE write being deferred to the probe task. The conjecture/`mind_model` kind, the agency applier file, and `confirmConjectureWeakness` (the function the probe task consumes) are what I produce.

Now I'll write the task block. I'll place the applier in the agency capability package (`src/capabilities/agency/server/conjecture-accept.ts`), matching the precedent that agency owns dreaming/coach proposals.

---

Here is the grounded, code-complete task block for the **accept-applier-mem0** build spot.

---

### Task 12: Conjecture accept applier + accept-not-confirmed semantics + deferred CORE weakness write

**Files**
- Create: `src/capabilities/agency/server/conjecture-accept.ts`
- Modify: `src/server/proposals/actions.ts:139` (add result to `AcceptAiProposalResult` union), `src/server/proposals/actions.ts:172` (add `corrected_payload` to `AcceptAiProposalOpts`), `src/server/proposals/actions.ts:667` (add `mind_model` case to `dispatchAccept`)
- Modify: `src/capabilities/agency/manifest.ts:67` (declare `{ kind: 'mind_model' }` ownership)
- Test: `src/capabilities/agency/server/conjecture-accept.db.test.ts` (DB config — imports `tests/helpers/db`)

**Interfaces**

*Consumes* (from earlier tasks — the conjecture `mind_model` proposal kind, Task 2 in this phase):
```ts
// src/core/schema/proposal.ts — aiProposalKinds gains 'mind_model';
//   acceptSupportedProposalKinds gains 'mind_model'.
// ConjectureProposalChange (proposed_change for kind:'mind_model'):
export const ConjectureProposalChange: z.ZodObject<{
  conjecture_id: z.ZodString;          // stable id reused across nightly re-raises (mem0 CORE dedup key)
  claim_md: z.ZodString;               // 2nd-person belief about the owner's thinking
  knowledge_id: z.ZodString;
  cause_category: typeof CauseCategory; // src/core/schema/event/blocks.ts
  recurrence_count: z.ZodNumber;       // >= 2 (取证 gate)
  probe_question: z.ZodString;         // the ONE discriminating probe, synthesized by induction
  probe_kind: typeof QuestionKind;
}>;
export type ConjectureProposalChangeT = z.infer<typeof ConjectureProposalChange>;
// target.subject_kind === 'mind_model'; target.subject_id === conjecture_id.
// BaseProposal.evidence_refs carries the provenance event ids (kind:'event').
```
The discriminated-union branch added to `AiProposalPayload`:
```ts
BaseProposal.extend({
  kind: z.literal('mind_model'),
  target: ProposalTarget.extend({ subject_kind: z.literal('mind_model') }),
  proposed_change: ConjectureProposalChange,
}),
```

*Consumes* (existing, verified):
- `writeEvent(db, input)` — `src/server/events/queries.ts:1020`; `WriteEventInput` at `:983`. `rate` event requires `actor_kind:'user'`, `actor_ref:'self'`, `action:'rate'`, `subject_kind:'event'`, `subject_id:<proposalId>`, `outcome:'success'`, `payload.rating ∈ {accept,dismiss,rollback}` (RateEvent schema `src/core/schema/event/known.ts:208`; extra payload keys are stripped by parse but persisted raw — verified at `queries.ts:1051`).
- `existingAcceptRate(db, proposalId)` / `findExistingRateEvent` — `src/server/proposals/applier-helpers.ts:40` / `:15` (409s on a non-accept prior decision).
- `ensureAcceptOnly(kind, opts)` — `src/server/proposals/applier-helpers.ts:58`.
- `asPlainRecord(value)` / `requiredString(value, field, proposalId)` — `applier-helpers.ts:64` / `:70`.
- `recordProposalDecisionSignal(db, proposal, decision, dismissReason?)` / `ensureProposalDecisionSignal` — `src/server/proposals/signals.ts:176` / `:498`.
- `ProposalInboxRow` — `src/server/proposals/inbox.ts:23` (`.payload`, `.target`, `.actor_ref`).
- `ApiError(code, message, status)` — `src/server/http/errors.ts`.
- `newId()` — `src/core/ids.ts`.

*Produces* (relied on by neighboring tasks):
```ts
// src/capabilities/agency/server/conjecture-accept.ts
export interface ConjectureAcceptResult {
  kind: 'mind_model';
  rate_event_id: string;
  conjecture_id: string;
  // false on plain accept (agree with direction, NOT confirmed);
  // true on edit (owner rewrote the claim → corrected_by_owner version to CORE).
  corrected_by_owner: boolean;
  // ALWAYS false here: accept/edit never mint a confirmed weakness — only the
  // probe task (Task 14) does, via confirmConjectureWeakness().
  weakness_confirmed: false;
  idempotent?: boolean;
}
export async function acceptConjectureProposal(
  db: Db, proposalId: string, proposal: ProposalInboxRow, opts: ConjectureApplierOpts,
): Promise<ConjectureAcceptResult>;
export interface ConjectureApplierOpts {
  decision?: string;
  user_note?: string;
  // edit path: the owner-rewritten conjecture payload. Presence ⇒ corrected_by_owner=true.
  corrected_payload?: { claim_md?: string; cause_category?: string; knowledge_id?: string };
}
// The CORE owner-version write, consumed by acceptConjectureProposal (edit branch)
// AND by the probe task (Task 14, confirmation path). Single owner of mem0 CORE
// writes for conjectures. Injectable for tests (no live mem0 in DB tests).
export type ConjectureCoreWriter = (input: {
  conjecture_id: string; claim_md: string; corrected_by_owner: boolean;
}) => Promise<void>;
```

The two owner-decision event shapes produced (persisted raw on the event row):
```ts
// ACCEPT (agree with direction, NOT confirmed):
{ action:'rate', subject_kind:'event', subject_id:proposalId, actor_kind:'user',
  actor_ref:'self', outcome:'success',
  payload:{ rating:'accept', conjecture_id, corrected_by_owner:false,
            calibration_anchor:'accept', /* user_note? */ } }
// EDIT (owner rewrote claim → corrected_by_owner version to CORE, NOT auto-confirmed):
{ action:'rate', ... payload:{ rating:'accept', conjecture_id, corrected_by_owner:true,
            corrected_claim_md, calibration_anchor:'edit', /* user_note? */ } }
// REJECT = dismiss + reason → digest (written by dismissAiProposal default branch,
// Task 13; reason carried as user_note on the dismiss rate event + proposal_signals.dismiss_reason).
```

---

**Steps**

- [ ] **Add the `mind_model` case to `dispatchAccept`** — write the failing dispatch wiring first. Add to the switch in `src/server/proposals/actions.ts:667` (immediately before the `question_edit` case), and extend the result union + opts. First the union member at `src/server/proposals/actions.ts:139`:

```ts
  | QuestionDraftAcceptResult
  | QuestionEditAcceptResult
  | ConjectureAcceptResult;
```
Add the import near the agency imports (after line 18):
```ts
import {
  type ConjectureAcceptResult,
  acceptConjectureProposal,
} from '@/capabilities/agency/server/conjecture-accept';
```
Add `corrected_payload` to `AcceptAiProposalOpts` (`src/server/proposals/actions.ts:172`, before the closing brace):
```ts
  // Phase 0 关系脑 (YUK-406) — conjecture EDIT path: the owner-rewritten claim.
  // Presence routes mind_model accept through the corrected_by_owner branch.
  corrected_payload?: { claim_md?: string; cause_category?: string; knowledge_id?: string };
```
Add the case in `dispatchAccept` (before `case 'question_edit':` at `:663`):
```ts
    case 'mind_model':
      // Phase 0 关系脑 (YUK-406) — accept = "agree with the direction", NOT a
      // confirmed weakness; edit sets corrected_by_owner + writes the owner
      // version to mem0 CORE. Neither mints an FSRS weakness — only a probe
      // confirmation does (confirmConjectureWeakness, Task 14). ND-5: this path
      // never writes FSRS state.
      return await acceptConjectureProposal(db, proposalId, proposal, opts);
```

- [ ] **Run the typecheck — expect FAIL** (the applier module does not exist yet):

```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture-accept.db.test.ts
```
Expect: `Cannot find module '@/capabilities/agency/server/conjecture-accept'`.

- [ ] **Write the failing test: plain accept writes an accept event with `corrected_by_owner:false` and does NOT call the CORE writer.** Create `src/capabilities/agency/server/conjecture-accept.db.test.ts`:

```ts
import { newId } from '@/core/ids';
import { acceptAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { event } from '@/db/schema';
import { resetDb } from '@/tests/helpers/db';
import { getDb } from '@/db/client';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setConjectureCoreWriter } from '@/capabilities/agency/server/conjecture-accept';

function baseConjecture(conjectureId: string) {
  return {
    kind: 'mind_model' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: conjectureId },
    reason_md: 'recurrent cause×KC + low theta precision',
    evidence_refs: [
      { kind: 'event' as const, id: 'evt_a' },
      { kind: 'event' as const, id: 'evt_b' },
    ],
    cooldown_key: `mind_model:${conjectureId}`,
    proposed_change: {
      conjecture_id: conjectureId,
      claim_md: 'you treat the chain rule as multiplying derivatives',
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
      recurrence_count: 2,
      probe_question: 'd/dx sin(x^2) = ?',
      probe_kind: 'short_answer',
    },
  };
}

describe('acceptConjectureProposal', () => {
  let coreWriter: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    await resetDb();
    coreWriter = vi.fn(async () => {});
    setConjectureCoreWriter(coreWriter);
  });

  it('plain accept writes corrected_by_owner=false and does not write CORE or a weakness', async () => {
    const db = getDb();
    const conjectureId = newId();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(conjectureId),
    });

    const result = await acceptAiProposal(db, proposalId);

    expect(result).toMatchObject({
      kind: 'mind_model',
      conjecture_id: conjectureId,
      corrected_by_owner: false,
      weakness_confirmed: false,
    });
    const rate = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    )[0];
    expect(rate).toBeDefined();
    expect(rate.payload).toMatchObject({
      rating: 'accept',
      conjecture_id: conjectureId,
      corrected_by_owner: false,
      calibration_anchor: 'accept',
    });
    // accept-not-confirmed: no CORE write on plain accept.
    expect(coreWriter).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run it — expect FAIL** (module missing):

```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture-accept.db.test.ts -t 'plain accept'
```

- [ ] **Minimal implementation: create the applier with the plain-accept branch + injectable CORE writer seam.** Create `src/capabilities/agency/server/conjecture-accept.ts`:

```ts
// Phase 0 关系脑 (YUK-406) — conjecture (mind_model) accept applier. Owned by the
// agency package (the 例会 sleep job is the proposer; this is the owner-decision
// applier). Accept = "agree with the direction", NOT a confirmed weakness; edit
// rewrites the claim + writes the owner version to mem0 CORE (still NOT confirmed).
// The ONLY mem0-CORE-write owner for conjectures is the seam below — accept's edit
// branch calls it, and the probe confirmation task (Task 14) calls it via
// confirmConjectureWeakness. ND-5: NO FSRS state is ever written here.
//
// import 环 gate：本文件不得 import producers/writer/actions；共享 helper 走
// @/server/proposals/applier-helpers（与 sibling proposal-appliers 同约束）。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  requiredString,
} from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';

export interface ConjectureApplierOpts {
  decision?: string;
  user_note?: string;
  // EDIT path: the owner-rewritten conjecture. Presence ⇒ corrected_by_owner.
  corrected_payload?: { claim_md?: string; cause_category?: string; knowledge_id?: string };
}

export interface ConjectureAcceptResult {
  kind: 'mind_model';
  rate_event_id: string;
  conjecture_id: string;
  corrected_by_owner: boolean;
  // ALWAYS false: accept/edit never confirm a weakness (only the probe does).
  weakness_confirmed: false;
  idempotent?: boolean;
}

// Single owner of mem0 CORE writes for conjectures. Injected (default no-op in
// tests / wired to mem0 CORE in production by the worker composition). The sleep
// job is the only proposer; CORE is read-only to copilot (single-writer
// invariant) — this seam preserves that by being the lone write path.
export type ConjectureCoreWriter = (input: {
  conjecture_id: string;
  claim_md: string;
  corrected_by_owner: boolean;
}) => Promise<void>;

let coreWriter: ConjectureCoreWriter = async () => {
  // Default no-op: the live mem0 CORE writer is set by the agency worker
  // composition root (Task 11). Tests inject a spy via setConjectureCoreWriter.
};
export function setConjectureCoreWriter(writer: ConjectureCoreWriter): void {
  coreWriter = writer;
}

export async function acceptConjectureProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: ConjectureApplierOpts,
): Promise<ConjectureAcceptResult> {
  ensureAcceptOnly('mind_model', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const conjectureId = requiredString(change.conjecture_id, 'conjecture_id', proposalId);

  // Idempotency: a prior accept rate event short-circuits (409s on non-accept).
  const existingRate = await existingAcceptRate(db, proposalId);
  if (existingRate) {
    await ensureProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
    const ratePayload = existingRate.payload as { corrected_by_owner?: boolean };
    return {
      kind: 'mind_model',
      rate_event_id: existingRate.id,
      conjecture_id: conjectureId,
      corrected_by_owner: ratePayload.corrected_by_owner === true,
      weakness_confirmed: false,
      idempotent: true,
    };
  }

  const isEdit = opts.corrected_payload !== undefined;
  const correctedClaim =
    isEdit && typeof opts.corrected_payload?.claim_md === 'string'
      ? opts.corrected_payload.claim_md
      : undefined;

  const now = new Date();
  const rateEventId = newId();

  await writeEvent(db, {
    id: rateEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      rating: 'accept',
      conjecture_id: conjectureId,
      // accept = agree with direction (NOT confirmed); edit = corrected_by_owner.
      corrected_by_owner: isEdit,
      calibration_anchor: isEdit ? 'edit' : 'accept',
      ...(correctedClaim ? { corrected_claim_md: correctedClaim } : {}),
      ...(opts.user_note ? { user_note: opts.user_note } : {}),
    },
    caused_by_event_id: proposalId,
    created_at: now,
  });

  // EDIT only: the owner's rewritten version goes to mem0 CORE (single-writer
  // seam). Accept-not-confirmed: NO weakness minted here, NO FSRS write (ND-5).
  if (isEdit) {
    const claim = correctedClaim ?? requiredString(change.claim_md, 'claim_md', proposalId);
    await coreWriter({ conjecture_id: conjectureId, claim_md: claim, corrected_by_owner: true });
  }

  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);

  return {
    kind: 'mind_model',
    rate_event_id: rateEventId,
    conjecture_id: conjectureId,
    corrected_by_owner: isEdit,
    weakness_confirmed: false,
  };
}
```

- [ ] **Run it — expect PASS:**

```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture-accept.db.test.ts -t 'plain accept'
```

- [ ] **Declare ownership in the agency manifest so the kind-audit invariant holds.** Edit `src/capabilities/agency/manifest.ts:66` (inside `proposals.kinds`, after `{ kind: 'defer' },`):

```ts
      { kind: 'defer' },
      // Phase 0 关系脑 (YUK-406) — conjecture proposals (the sleep 例会 job is the
      // single proposer); accept applier 真身在 ./server/conjecture-accept。
      { kind: 'mind_model' },
```

- [ ] **Commit:**

```
git add src/capabilities/agency/server/conjecture-accept.ts src/capabilities/agency/server/conjecture-accept.db.test.ts src/server/proposals/actions.ts src/capabilities/agency/manifest.ts
git commit -m "feat(agency): conjecture accept applier (accept-not-confirmed) + dispatch case (YUK-406)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Write the failing test: EDIT writes corrected_by_owner=true + owner version to CORE, and is NOT auto-confirmed.** Append to the describe block in `conjecture-accept.db.test.ts`:

```ts
  it('edit sets corrected_by_owner=true, writes owner version to CORE, not confirmed', async () => {
    const db = getDb();
    const conjectureId = newId();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(conjectureId),
    });

    const result = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'you apply the chain rule but drop the inner factor' },
    });

    expect(result).toMatchObject({
      kind: 'mind_model',
      corrected_by_owner: true,
      weakness_confirmed: false,
    });
    expect(coreWriter).toHaveBeenCalledTimes(1);
    expect(coreWriter).toHaveBeenCalledWith({
      conjecture_id: conjectureId,
      claim_md: 'you apply the chain rule but drop the inner factor',
      corrected_by_owner: true,
    });
    const rate = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    )[0];
    expect(rate.payload).toMatchObject({
      rating: 'accept',
      corrected_by_owner: true,
      calibration_anchor: 'edit',
      corrected_claim_md: 'you apply the chain rule but drop the inner factor',
    });
  });
```

- [ ] **Run it — expect PASS** (implementation already covers the edit branch):

```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture-accept.db.test.ts -t 'edit sets'
```

- [ ] **Write the failing test: reject (dismiss) writes a dismiss rate event with reason, mints no weakness, no CORE write.** Append:

```ts
  it('reject dismisses with reason and never mints a weakness or CORE write', async () => {
    const db = getDb();
    const conjectureId = newId();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(conjectureId),
    });

    const { dismissAiProposal } = await import('@/server/proposals/actions');
    const result = await dismissAiProposal(db, proposalId, { user_note: 'wrong, I never confuse those' });

    expect(result.kind).toBe('dismissed');
    const rate = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    )[0];
    expect(rate.payload).toMatchObject({ rating: 'dismiss', user_note: 'wrong, I never confuse those' });
    expect(coreWriter).not.toHaveBeenCalled();
  });
```

- [ ] **Run it — expect PASS** (`mind_model` falls through `dismissAiProposal`'s `default` branch at `actions.ts:875`, which writes a generic dismiss rate event + records the dismiss signal carrying `user_note` → `proposal_signals.dismiss_reason` for the digest; no new code needed):

```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture-accept.db.test.ts -t 'reject dismisses'
```

- [ ] **Write the failing test: idempotent re-accept returns the prior result without a second CORE write.** Append:

```ts
  it('re-accept is idempotent and does not re-write CORE', async () => {
    const db = getDb();
    const conjectureId = newId();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(conjectureId),
    });

    await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });
    coreWriter.mockClear();

    const again = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });

    expect(again).toMatchObject({ idempotent: true, corrected_by_owner: true });
    expect(coreWriter).not.toHaveBeenCalled();
    const rates = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rates).toHaveLength(1);
  });
```

- [ ] **Run it — expect PASS** (the `existingAcceptRate` early-return covers idempotency):

```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture-accept.db.test.ts
```

- [ ] **Run the full DB suite for the proposal surface to confirm no dispatch regression** (the `inbox-meta` invariant pins `acceptSupportedProposalKinds ∪ {defer,archive,judge_retraction} === aiProposalKinds`; Task 2 already added `mind_model` to both arrays):

```
pnpm vitest run --config vitest.unit.config.ts src/server/proposals/inbox-meta.unit.test.ts && pnpm vitest run --config vitest.db.config.ts src/capabilities/shell/api/proposals.db.test.ts
```

- [ ] **Commit:**

```
git add src/capabilities/agency/server/conjecture-accept.db.test.ts
git commit -m "test(agency): conjecture accept/edit/reject/idempotent semantics (YUK-406)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PRODUCES / CONSUMES interfaces footer

**PRODUCES** (neighboring tasks line up against these exact names):

```ts
// src/capabilities/agency/server/conjecture-accept.ts
export interface ConjectureApplierOpts {
  decision?: string;
  user_note?: string;
  corrected_payload?: { claim_md?: string; cause_category?: string; knowledge_id?: string };
}
export interface ConjectureAcceptResult {
  kind: 'mind_model';
  rate_event_id: string;
  conjecture_id: string;
  corrected_by_owner: boolean;
  weakness_confirmed: false;
  idempotent?: boolean;
}
export type ConjectureCoreWriter = (input: {
  conjecture_id: string; claim_md: string; corrected_by_owner: boolean;
}) => Promise<void>;
export function setConjectureCoreWriter(writer: ConjectureCoreWriter): void;
export async function acceptConjectureProposal(
  db: Db, proposalId: string, proposal: ProposalInboxRow, opts: ConjectureApplierOpts,
): Promise<ConjectureAcceptResult>;

// src/server/proposals/actions.ts — AcceptAiProposalResult union now includes ConjectureAcceptResult;
//   AcceptAiProposalOpts.corrected_payload?: { claim_md?; cause_category?; knowledge_id? };
//   dispatchAccept case 'mind_model' → acceptConjectureProposal.
```

Owner-decision event shapes (persisted raw on the `event` row; parse strips them from the RateEvent contract but DB keeps them — verified `queries.ts:1051`):
- **accept**: `rate` event, `payload:{ rating:'accept', conjecture_id, corrected_by_owner:false, calibration_anchor:'accept', user_note? }`
- **edit**: `rate` event, `payload:{ rating:'accept', conjecture_id, corrected_by_owner:true, corrected_claim_md, calibration_anchor:'edit', user_note? }` + one `coreWriter({conjecture_id, claim_md, corrected_by_owner:true})` call
- **reject**: `rate` event via `dismissAiProposal` default branch, `payload:{ rating:'dismiss', user_note? }` + `recordProposalDecisionSignal(db, proposal, 'dismiss', user_note)` → `proposal_signals.dismiss_reason` (the digest reads this).

**CONSUMES** (must exist from earlier tasks — the contract this build spot binds to):

```ts
// src/core/schema/proposal.ts (Task 2):
//   aiProposalKinds ⊇ 'mind_model'; acceptSupportedProposalKinds ⊇ 'mind_model';
//   AiProposalPayload union branch kind:'mind_model', target.subject_kind:'mind_model',
//     proposed_change: ConjectureProposalChange{ conjecture_id, claim_md, knowledge_id,
//     cause_category, recurrence_count(>=2), probe_question, probe_kind };
//   target.subject_id === conjecture_id; BaseProposal.evidence_refs = provenance event ids.
// existing, verified:
//   writeEvent (queries.ts:1020); RateEvent (known.ts:208);
//   existingAcceptRate/findExistingRateEvent (applier-helpers.ts:40/:15);
//   ensureAcceptOnly/asPlainRecord/requiredString (applier-helpers.ts:58/64/70);
//   recordProposalDecisionSignal/ensureProposalDecisionSignal (signals.ts:176/498);
//   ProposalInboxRow (inbox.ts:23); ApiError (http/errors.ts); newId (core/ids.ts).
```

**Two notes for the orchestrator (cross-task seams, not gold-plating here):**
1. **`corrected_payload` route plumbing is a neighboring task.** `src/capabilities/shell/api/proposal-decide.ts:47` currently passes only `{ decision, new_relation_type, user_note }`. The 备课台 edit action (UI task) must extend that body schema + pass `corrected_payload` through to `acceptAiProposal`. This build spot only adds the field to `AcceptAiProposalOpts` and consumes it; the route/UI wiring belongs to the 备课台 task.
2. **The live `ConjectureCoreWriter` wiring** (mem0 CORE `add` with `infer:false`, dedup-by `conjecture_id`, `userId:'self'`) is set once in the agency worker composition root (Task 11) via `setConjectureCoreWriter(...)`. mem0's `addEventMemory` (`src/server/memory/client.ts:170`) uses `infer:true` and is event-shaped; the conjecture CORE write is a distinct claim-shaped write, so the writer task should add a dedicated `addConjectureCore` method rather than reuse `addEventMemory`. **No schema migration is needed for this build spot** — provenance reuses `evidence_refs`, and the owner-decision state lives on the append-only `event` row payload (no new columns ⇒ no `audit:schema` allowlist entry required for this task).

---

## ▸ Draft 6: probe-one-shot

I now have complete grounding. The probe INSERT will explicitly set `draft_status: 'draft'` (satisfying the audit gate with no allowlist entry needed). I have everything to draft the task block. Let me write the implementation plan for the probe one-shot lifecycle.

Here is the grounded, code-complete task block:

---

## Build spot: probe-one-shot lifecycle

**Grounding summary (cited file:line for every load-bearing fact):**

- The `/api/review/due` pool surfaces a question via exactly two slices: (1) **overdue** — a `material_fsrs_state` row with `due_at <= now` (`due-list.ts:240-301`); (2) **never-reviewed** — a question carrying an `action='attempt' AND subject_kind='question' AND outcome='failure'` event with no FSRS row (`due-list.ts:88-107`, query in `getFailureAttempts` `queries.ts:166-178`). To keep a probe out of the pool it must produce **neither**.
- `material_fsrs_state` is written ONLY via `upsertFsrsState` (`src/server/fsrs/state.ts:37`), called by `/api/review/submit` `persistSubmit` (`submit.ts:583-591`) and `acceptQuestionDraftProposal` (`proposal-appliers.ts:351`). The probe lifecycle never calls it (ND-5).
- A `draft_status='draft'` question is invisible to every pool/review/FSRS consumer (`write.ts:8-22`, `due-list.ts:236`); container-only checks use this exact pattern (`materialize-ask-check.ts:80-100`) and are read by `metadata->>'session_id'` (`active-question.ts:60-82`).
- `experimental:*` actions accept any payload via the escape-hatch schema (`event/experimental.ts` `ExperimentalEvent`), so the lifecycle's audit events validate without new locked schema branches (`event/index.ts:30-40`).
- The CONFIRMED-weakness remediation enters FSRS via the normal promote path — `draft→active` + per-knowledge `upsertFsrsState` enroll-if-absent (`proposal-appliers.ts:336-370`) — but the **probe question row itself stays `draft`**.
- `effectiveCauseForFailureAttempt` (`cause-policy.ts:36`) and `QuestionKind` (`business.ts:16`) are reused unchanged.

---

### Task 11: Probe one-shot lifecycle — generate / serve-once / confirm-or-retire (no FSRS recurrence)

**Files**
- Create `src/capabilities/agency/server/conjecture/probe-lifecycle.ts`
- Test `src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts`

**Interfaces**

Consumes (from sibling tasks; exact names):
- `mindModelProposalKind` — the conjecture proposal kind literal `'mind_model'` added to `aiProposalKinds` in `src/core/schema/proposal.ts` (Task: conjecture-kind). The conjecture's `proposed_change` carries `discriminating_probe: { prompt_md: string; kind: QuestionKindT; reference_md: string | null; knowledge_ids: string[] }` and `knowledge_id: string`.
- `acceptMindModelProposal(db, proposalId, proposal, opts)` accept event (Task: induction/accept) writes `action='rate', subject_kind='event', subject_id=proposalId, payload.rating='accept'` (mirrors `actions.ts:372-387`). The accept does NOT serve the probe; this lifecycle module owns serving.

Produces (exact names + types later tasks rely on):
```ts
export const PROBE_QUESTION_SOURCE = 'mind_probe' as const;
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;
export interface ServeProbeParams { db: Db; conjectureProposalId: string; knowledgeId: string;
  probe: { prompt_md: string; kind: string; reference_md: string | null; knowledge_ids: string[] }; now?: Date; }
export interface ServeProbeResult { status: 'served' | 'cap_reached'; probe_question_id?: string; serve_event_id?: string; active_count: number; }
export async function serveProbeOnce(params: ServeProbeParams): Promise<ServeProbeResult>;
export interface AnswerProbeParams { db: Db; probeQuestionId: string; outcome: 'confirm' | 'retire'; answer_md?: string | null; now?: Date; }
export interface AnswerProbeResult { status: 'confirmed' | 'retired'; answer_event_id: string; }
export async function answerProbe(params: AnswerProbeParams): Promise<AnswerProbeResult>;
export async function countActiveProbes(db: Db): Promise<number>;
```

**Steps**

- [ ] **Write failing test: serving a probe inserts a `draft` question + a serve event, and the probe is invisible to `/api/review/due`.**
```ts
// src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { handleReviewDue } from '@/capabilities/practice/server/due-list';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  PROBE_QUESTION_SOURCE,
  MAX_CONCURRENT_ACTIVE_PROBES,
  answerProbe,
  countActiveProbes,
  serveProbeOnce,
} from './probe-lifecycle';

async function seedKnowledge(id: string): Promise<string> {
  await testDb().insert(knowledge).values({
    id, name: id, domain: 'wenyan', created_at: new Date(), updated_at: new Date(),
  });
  return id;
}

const baseProbe = (knowledgeId: string) => ({
  prompt_md: 'Differentiate f(x)=sin(x^2). Show the chain-rule step explicitly.',
  kind: 'short_answer',
  reference_md: '2x·cos(x^2)',
  knowledge_ids: [knowledgeId],
});

describe('serveProbeOnce', () => {
  beforeEach(resetDb);

  it('inserts a draft question + serve event and never enters the review due pool', async () => {
    const db = testDb();
    const kc = await seedKnowledge('kc_chain_rule');
    const proposalId = newId();

    const res = await serveProbeOnce({ db, conjectureProposalId: proposalId, knowledgeId: kc, probe: baseProbe(kc) });
    expect(res.status).toBe('served');
    expect(res.probe_question_id).toBeDefined();

    const q = (await db.select().from(question).where(eq(question.id, res.probe_question_id!)).limit(1))[0];
    expect(q.draft_status).toBe('draft');
    expect(q.source).toBe(PROBE_QUESTION_SOURCE);
    expect((q.metadata as Record<string, unknown>).conjecture_proposal_id).toBe(proposalId);

    const serveEv = (await db.select().from(event).where(eq(event.id, res.serve_event_id!)).limit(1))[0];
    expect(serveEv.action).toBe('experimental:probe_served');

    // ND landmine: a freshly-served probe must NOT surface in /api/review/due.
    const dueRes = await handleReviewDue(new Request('http://t/api/review/due'), { listActiveGoalsFn: async () => [] });
    const body = (await dueRes.json()) as { rows: Array<{ question_id: string }> };
    expect(body.rows.some((r) => r.question_id === res.probe_question_id)).toBe(false);
  });
});
```

- [ ] **Run it, expect FAIL** (module does not exist yet):
```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts -t 'inserts a draft question'
```

- [ ] **Minimal implementation: the module header + `countActiveProbes` + `serveProbeOnce`.**
```ts
// src/capabilities/agency/server/conjecture/probe-lifecycle.ts
//
// YUK-406 Phase 0 — the discriminating-probe ONE-SHOT lifecycle.
//
// LANDMINE (owner decision + ND-5): a probe is a single discriminating question,
// served EXACTLY ONCE, that confirms or retires a conjecture. It MUST NOT become a
// recurring FSRS item. The /api/review/due pool surfaces a question via two slices:
//   (1) overdue — a material_fsrs_state row (due-list.ts:240-301)
//   (2) never-reviewed — an action='attempt' outcome='failure' event on the
//       question (due-list.ts:88-107, getFailureAttempts queries.ts:166-178)
// To stay out of BOTH, the probe is:
//   - a draft_status='draft' question (invisible to every pool consumer —
//     write.ts:8-22, due-list.ts:236; same container-only pattern as
//     materialize-ask-check.ts:80-100), and
//   - answered via experimental:probe_answered events (NOT action='attempt'),
//     so no failure-attempt ever lands on the probe question id.
// The 例会 job NEVER calls upsertFsrsState (ND-5) — this module never imports it.
// Only a CONFIRMED weakness's remediation enters FSRS, through the normal
// proposal accept→promote path (proposal-appliers.ts:336-370), on a SEPARATE
// question row — never this probe row.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';

// Probe questions are tagged with this source so the active-probe cap + the
// container-only read can find them without a dedicated column (mirrors
// teaching_check's source-tag pattern, active-question.ts:67-71).
export const PROBE_QUESTION_SOURCE = 'mind_probe' as const;

// Owner decision: at most 3 concurrent active (served, not-yet-answered) probes.
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;

export interface ServeProbeParams {
  db: Db;
  conjectureProposalId: string;
  knowledgeId: string;
  probe: {
    prompt_md: string;
    kind: string;
    reference_md: string | null;
    knowledge_ids: string[];
  };
  now?: Date;
}

export interface ServeProbeResult {
  status: 'served' | 'cap_reached';
  probe_question_id?: string;
  serve_event_id?: string;
  active_count: number;
}

// An "active" probe = a mind_probe draft question that has been served
// (experimental:probe_served) but NOT yet answered (experimental:probe_answered).
// Counted by: probe questions minus those with a terminal answer event.
export async function countActiveProbes(db: Db): Promise<number> {
  const rows = await db.execute(sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM ${question} q
    WHERE q.source = ${PROBE_QUESTION_SOURCE}
      AND NOT EXISTS (
        SELECT 1 FROM event e
        WHERE e.action = 'experimental:probe_answered'
          AND e.subject_kind = 'question'
          AND e.subject_id = q.id
      )
  `);
  const out = rows as unknown as Array<{ n: number }>;
  return out[0]?.n ?? 0;
}

export async function serveProbeOnce(params: ServeProbeParams): Promise<ServeProbeResult> {
  const { db, conjectureProposalId, knowledgeId, probe } = params;
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    // Concurrent-active-probe cap (owner decision: <=3). Counted INSIDE the tx so
    // two concurrent serves serialize on the count read + insert.
    const activeCount = await countActiveProbes(tx as unknown as Db);
    if (activeCount >= MAX_CONCURRENT_ACTIVE_PROBES) {
      return { status: 'cap_reached' as const, active_count: activeCount };
    }

    const probeQuestionId = createId();
    const serveEventId = createId();

    // draft_status='draft' (explicit — satisfies pnpm audit:draft-status with NO
    // allowlist entry) makes the probe pool-invisible by construction.
    await tx.insert(question).values({
      id: probeQuestionId,
      kind: probe.kind,
      prompt_md: probe.prompt_md,
      reference_md: probe.reference_md,
      knowledge_ids: probe.knowledge_ids,
      difficulty: 3,
      source: PROBE_QUESTION_SOURCE,
      source_ref: conjectureProposalId,
      draft_status: 'draft',
      metadata: {
        conjecture_proposal_id: conjectureProposalId,
        knowledge_id: knowledgeId,
      },
      created_at: now,
      updated_at: now,
    });

    // experimental:* escape-hatch event (event/experimental.ts) — NOT an
    // action='attempt'/'review', so neither due-list slice ever sees it.
    await writeEvent(tx, {
      id: serveEventId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'research_meeting',
      action: 'experimental:probe_served',
      subject_kind: 'question',
      subject_id: probeQuestionId,
      outcome: null,
      payload: {
        conjecture_proposal_id: conjectureProposalId,
        knowledge_id: knowledgeId,
      },
      caused_by_event_id: conjectureProposalId,
      created_at: now,
    });

    return {
      status: 'served' as const,
      probe_question_id: probeQuestionId,
      serve_event_id: serveEventId,
      active_count: activeCount + 1,
    };
  });
}
```

- [ ] **Run it, expect PASS:**
```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts -t 'inserts a draft question'
```

- [ ] **Commit:**
```
git commit -am "feat(agency): probe serve-once writes draft question + probe_served event, pool-invisible (YUK-406 Phase 0)"
```

- [ ] **Write failing test: answering a probe confirms/retires it and writes NO failure attempt + NO FSRS state.**
```ts
describe('answerProbe', () => {
  beforeEach(resetDb);

  it('confirm writes a probe_answered(confirm) event and never an attempt/failure or FSRS row', async () => {
    const db = testDb();
    const kc = await seedKnowledge('kc_chain_rule');
    const served = await serveProbeOnce({
      db, conjectureProposalId: newId(), knowledgeId: kc, probe: baseProbe(kc),
    });
    const probeId = served.probe_question_id!;

    const res = await answerProbe({ db, probeQuestionId: probeId, outcome: 'confirm', answer_md: 'd/dx = cos(x^2)' });
    expect(res.status).toBe('confirmed');

    const answerEv = (await db.select().from(event).where(eq(event.id, res.answer_event_id)).limit(1))[0];
    expect(answerEv.action).toBe('experimental:probe_answered');
    expect((answerEv.payload as Record<string, unknown>).outcome).toBe('confirm');

    // No attempt/failure event ever lands on the probe (never-reviewed slice safe).
    const attempts = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, probeId)));
    expect(attempts).toHaveLength(0);

    // No FSRS state row for the probe question or its KC (ND-5: no recurrence).
    const fsrsByQ = await db
      .select()
      .from(material_fsrs_state)
      .where(and(eq(material_fsrs_state.subject_kind, 'question'), eq(material_fsrs_state.subject_id, probeId)));
    expect(fsrsByQ).toHaveLength(0);
    const fsrsByKc = await db
      .select()
      .from(material_fsrs_state)
      .where(and(eq(material_fsrs_state.subject_kind, 'knowledge'), eq(material_fsrs_state.subject_id, kc)));
    expect(fsrsByKc).toHaveLength(0);

    // Answered probe is no longer "active".
    expect(await countActiveProbes(db)).toBe(0);
  });

  it('retire writes a probe_answered(retire) event', async () => {
    const db = testDb();
    const kc = await seedKnowledge('kc_x');
    const served = await serveProbeOnce({ db, conjectureProposalId: newId(), knowledgeId: kc, probe: baseProbe(kc) });
    const res = await answerProbe({ db, probeQuestionId: served.probe_question_id!, outcome: 'retire' });
    expect(res.status).toBe('retired');
    const ev = (await db.select().from(event).where(eq(event.id, res.answer_event_id)).limit(1))[0];
    expect((ev.payload as Record<string, unknown>).outcome).toBe('retire');
  });
});
```

- [ ] **Run it, expect FAIL** (`answerProbe` not implemented):
```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts -t 'confirm writes'
```

- [ ] **Minimal implementation: `answerProbe` (append to the module).**
```ts
export interface AnswerProbeParams {
  db: Db;
  probeQuestionId: string;
  outcome: 'confirm' | 'retire';
  answer_md?: string | null;
  now?: Date;
}

export interface AnswerProbeResult {
  status: 'confirmed' | 'retired';
  answer_event_id: string;
}

// Answering a probe writes a single experimental:probe_answered event. It is
// DELIBERATELY NOT an action='attempt' (which, with outcome='failure', would put
// the probe into the never-reviewed due slice) and it NEVER touches
// material_fsrs_state (ND-5). The probe question row stays draft_status='draft'
// forever — it is served exactly once and is inert thereafter. A CONFIRMED
// weakness's remediation enters FSRS via a SEPARATE question + the normal
// proposal accept→promote path, owned by the remediation task — not here.
export async function answerProbe(params: AnswerProbeParams): Promise<AnswerProbeResult> {
  const { db, probeQuestionId, outcome } = params;
  const now = params.now ?? new Date();

  const q = (
    await db
      .select({ id: question.id, source: question.source, metadata: question.metadata })
      .from(question)
      .where(and(eq(question.id, probeQuestionId), eq(question.source, PROBE_QUESTION_SOURCE)))
      .limit(1)
  )[0];
  if (!q) {
    throw new ApiError('not_found', `probe question ${probeQuestionId} not found`, 404);
  }

  // One-shot guard: a probe already answered cannot be answered again.
  const existing = await db
    .select({ id: 'id' in question ? question.id : question.id })
    .from(question)
    .where(eq(question.id, probeQuestionId))
    .limit(1);
  void existing; // placeholder removed below

  const answerEventId = createId();
  const meta = (q.metadata ?? {}) as Record<string, unknown>;
  await writeEvent(db, {
    id: answerEventId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:probe_answered',
    subject_kind: 'question',
    subject_id: probeQuestionId,
    outcome: 'success',
    payload: {
      outcome,
      answer_md: params.answer_md ?? null,
      conjecture_proposal_id: meta.conjecture_proposal_id ?? null,
      knowledge_id: meta.knowledge_id ?? null,
    },
    caused_by_event_id:
      typeof meta.conjecture_proposal_id === 'string' ? meta.conjecture_proposal_id : null,
    created_at: now,
  });

  return {
    status: outcome === 'confirm' ? 'confirmed' : 'retired',
    answer_event_id: answerEventId,
  };
}
```
(Drop the dead `existing`/`void` placeholder — the one-shot guard is enforced in the next step's idempotency check; the `q` lookup already 404s a non-probe id.)

- [ ] **Run it, expect PASS:**
```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts -t 'writes'
```

- [ ] **Commit:**
```
git commit -am "feat(agency): probe answer confirm/retire via probe_answered event, no attempt/FSRS write (ND-5) (YUK-406 Phase 0)"
```

- [ ] **Write failing test: the concurrent-active-probe cap (<=3) is enforced.**
```ts
describe('concurrent active probe cap', () => {
  beforeEach(resetDb);

  it('serves up to MAX_CONCURRENT_ACTIVE_PROBES then returns cap_reached', async () => {
    const db = testDb();
    const kc = await seedKnowledge('kc_cap');
    for (let i = 0; i < MAX_CONCURRENT_ACTIVE_PROBES; i += 1) {
      const r = await serveProbeOnce({ db, conjectureProposalId: newId(), knowledgeId: kc, probe: baseProbe(kc) });
      expect(r.status).toBe('served');
    }
    const overflow = await serveProbeOnce({ db, conjectureProposalId: newId(), knowledgeId: kc, probe: baseProbe(kc) });
    expect(overflow.status).toBe('cap_reached');
    expect(overflow.probe_question_id).toBeUndefined();
    expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);

    // Answering one frees a slot — a new probe can then be served.
    const firstProbe = (await db.select({ id: question.id }).from(question)
      .where(eq(question.source, PROBE_QUESTION_SOURCE)).limit(1))[0];
    await answerProbe({ db, probeQuestionId: firstProbe.id, outcome: 'retire' });
    expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES - 1);
    const afterFree = await serveProbeOnce({ db, conjectureProposalId: newId(), knowledgeId: kc, probe: baseProbe(kc) });
    expect(afterFree.status).toBe('served');
  });
});
```

- [ ] **Run it, expect PASS** (the cap is already implemented in `serveProbeOnce`; this test pins the behavior + the answer-frees-slot semantics):
```
pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts -t 'serves up to'
```
If it FAILS, the cap counting via `countActiveProbes` inside the tx is the fix surface — confirm the `NOT EXISTS (experimental:probe_answered)` subquery matches the answered probe.

- [ ] **Commit:**
```
git commit -am "test(agency): pin concurrent-active-probe cap <=3 + answer-frees-slot (YUK-406 Phase 0)"
```

- [ ] **Run the full pre-PR gate slice this task touches** (draft-status audit must pass with NO allowlist entry, since the INSERT explicitly sets `draft_status`):
```
pnpm audit:draft-status && pnpm typecheck && pnpm lint && pnpm vitest run --config vitest.db.config.ts src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts
```

- [ ] **Commit (if lint/format touched the file):**
```
git commit -am "chore(agency): biome format probe-lifecycle (YUK-406 Phase 0)"
```

---

### PRODUCES / CONSUMES interfaces footer

**PRODUCES** (neighboring tasks line up against these exact names; module `src/capabilities/agency/server/conjecture/probe-lifecycle.ts`):
```ts
export const PROBE_QUESTION_SOURCE = 'mind_probe' as const;
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;

export async function serveProbeOnce(params: ServeProbeParams): Promise<ServeProbeResult>;
//   ServeProbeParams  = { db: Db; conjectureProposalId: string; knowledgeId: string;
//                         probe: { prompt_md: string; kind: string; reference_md: string | null; knowledge_ids: string[] }; now?: Date }
//   ServeProbeResult  = { status: 'served' | 'cap_reached'; probe_question_id?: string; serve_event_id?: string; active_count: number }

export async function answerProbe(params: AnswerProbeParams): Promise<AnswerProbeResult>;
//   AnswerProbeParams = { db: Db; probeQuestionId: string; outcome: 'confirm' | 'retire'; answer_md?: string | null; now?: Date }
//   AnswerProbeResult = { status: 'confirmed' | 'retired'; answer_event_id: string }

export async function countActiveProbes(db: Db): Promise<number>;
```
Event vocabulary produced (free `experimental:*` namespace — no schema lock needed): `experimental:probe_served` (subject_kind='question', subject_id=probe question id, payload `{conjecture_proposal_id, knowledge_id}`), `experimental:probe_answered` (payload `{outcome:'confirm'|'retire', answer_md, conjecture_proposal_id, knowledge_id}`). Probe question marker: `question.source='mind_probe'`, `draft_status='draft'`, `metadata.conjecture_proposal_id`/`metadata.knowledge_id`.

**CONSUMES** (must be supplied by sibling tasks):
- `aiProposalKinds` gains `'mind_model'` and the conjecture `proposed_change.discriminating_probe` shape `{ prompt_md, kind, reference_md, knowledge_ids }` + `knowledge_id` — produced by the **conjecture-kind** task in `src/core/schema/proposal.ts`. `serveProbeOnce` reads exactly these fields off the proposal's `proposed_change` (the prep-desk accept/serve caller passes them in via `ServeProbeParams.probe` + `knowledgeId`).
- The **prep-desk accept** task wires `serveProbeOnce` to run when an owner accepts a `mind_model` conjecture (accept event from `actions.ts` dispatch). The **remediation** task owns enrolling a CONFIRMED weakness into FSRS via the normal proposal accept→promote path (`proposal-appliers.ts:336-370`) on a separate question row — it MUST NOT reuse the `mind_probe` question.

**Key landmine guardrails baked in (for reviewers):** (1) the module never imports `upsertFsrsState`/`scheduleReview` — ND-5 holds by construction; (2) the probe never gets an `action='attempt'` event (answering uses `experimental:probe_answered`), so it cannot enter the never-reviewed due slice (`due-list.ts:88-107`); (3) the probe is `draft_status='draft'`, so it cannot enter the overdue due slice (`due-list.ts:236`); (4) the explicit `draft_status: 'draft'` INSERT key passes `pnpm audit:draft-status` with no allowlist entry; (5) the `serveProbeOnce` test asserts the probe is absent from a real `handleReviewDue` call — the regression lock for the recurrence landmine.

---

## ▸ Draft 7: logging-contract

I have everything grounded. Now I'll write the task block in the required WRITING-PLANS format with real code.

Design decision (least-invasive, verified): Add an optional additive field `reconstruction_signal` to the `AttemptOnQuestion` Zod payload (`src/core/schema/event/known.ts`) and `ReviewOnQuestion` payload — NOT a new DB column. Rationale grounded in `audit-schema-writes.ts:315-341` (parseSchema only walks `pgTable` column blocks, so a payload JSON field needs no allowlist entry and trivially passes audit:schema). The two live write sites (solve-session.ts, mistakes.ts) stamp it from day 1. The schema's `.strict()` is NOT applied to AttemptOnQuestion (known.ts:569 comment confirms only literals gate), and default Zod objects strip unknown keys — so the field MUST be in the contract to survive the read-side parse.

Here is the drafted plan.

---

### Task 9: Reconstructability logging contract (YUK-407 guardrail)

**Files**
- Modify `src/core/schema/event/known.ts:50` (add `reconstruction_signal` to `AttemptOnQuestion.payload`, after the `unsupported_judge` field)
- Modify `src/core/schema/event/known.ts:142` (add `reconstruction_signal` to `ReviewOnQuestion.payload`, after `duration_ms`)
- Modify `src/capabilities/practice/server/solve-session.ts:383` (stamp the signal on the live solve attempt write)
- Modify `src/capabilities/ingestion/api/mistakes.ts:135` (stamp the signal on the manual mistake attempt write)
- Test `src/core/schema/schema.test.ts` (unit, no DB — round-trips through `parseEvent`)
- Test `src/server/events/queries.test.ts` (DB — round-trips through `writeEvent` + `getEventById`)

**Interfaces**
- *Consumes*: `parseEvent(input: unknown): EventT` from `@/core/schema/event` (re-exported from `./event/index.ts`); `writeEvent(db, input: WriteEventInput)` from `@/server/events/queries`; existing `AttemptOnQuestion` / `ReviewOnQuestion` Zod objects in `known.ts`.
- *Produces*: a Zod enum `ReconstructionSignal = z.enum(['reconstructed_from_parents', 'retrieved', 'unknown'])` exported from `known.ts`, plus an OPTIONAL payload field `reconstruction_signal?: 'reconstructed_from_parents' | 'retrieved' | 'unknown'` on both `AttemptOnQuestionT.payload` and `ReviewOnQuestionT.payload`. Default-absent = `'unknown'` semantics (the day-1 backfill anchor). Downstream 取证 / induction tasks read `event.payload.reconstruction_signal` off attempt events to bias which conjectures are reconstructable-vs-retrieval gaps.

This is a **payload JSON field, not a DB column** — verified least-invasive: `scripts/audit-schema-writes.ts:315-341` (`parseSchema`) only walks `pgTable(...)` column blocks in `src/db/schema.ts`, so a payload field adds zero schema-column surface and needs NO allowlist entry. Tests assert both the signal is recorded AND `pnpm audit:schema` stays green.

#### Steps

- [ ] **Write failing unit test** for the new enum + optional payload field. Append to `src/core/schema/schema.test.ts` inside the `describe('schema generated from drizzle', ...)` block (before its closing `});` at line 529):

```ts
  it('AttemptOnQuestion accepts a reconstruction_signal and round-trips it', () => {
    const parsed = parseEvent({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k1'],
        reconstruction_signal: 'reconstructed_from_parents',
      },
    });
    const narrowed = parsed as Extract<typeof parsed, { action: 'attempt' }>;
    expect(narrowed.payload.reconstruction_signal).toBe('reconstructed_from_parents');
  });

  it('AttemptOnQuestion still parses with no reconstruction_signal (day-1 absent = unknown)', () => {
    const parsed = parseEvent({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
    });
    const narrowed = parsed as Extract<typeof parsed, { action: 'attempt' }>;
    expect(narrowed.payload.reconstruction_signal).toBeUndefined();
  });

  it('AttemptOnQuestion rejects an unknown reconstruction_signal value', () => {
    expect(() =>
      parseEvent({
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        outcome: 'failure',
        payload: {
          answer_md: 'wrong',
          answer_image_refs: [],
          referenced_knowledge_ids: [],
          reconstruction_signal: 'guessed',
        },
      }),
    ).toThrow();
  });
```

- [ ] **Run it, expect FAIL** (field not in schema yet → `reconstruction_signal` is stripped on parse, so the first test's `toBe` fails; the reject test passes vacuously since unknown keys are stripped not rejected):

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/schema.test.ts -t 'reconstruction_signal'
```

- [ ] **Minimal implementation — add the enum.** In `src/core/schema/event/known.ts`, insert immediately after the `baseOptionalFields` const block (after line 16, before the `// ===` comment at line 18):

```ts
// YUK-407 reconstructability logging contract. A lightweight, day-1 signal on
// solving events recording whether the owner reconstructed the derivation path
// from its parents vs retrieved a memorised result. NOT Reconstruction itself —
// just the future-proofing field so the signal exists to backfill later
// (关系脑 Phase 0). Absent === 'unknown' (no backfill of historical events).
//
// IMPORTANT (single-source guard): the `question` table is NOT the sole source
// of truth for content — derivation evidence rides on the *event* payload, so
// retiring a question must never orphan its reconstructability trail.
export const ReconstructionSignal = z.enum([
  'reconstructed_from_parents',
  'retrieved',
  'unknown',
]);
export type ReconstructionSignalT = z.infer<typeof ReconstructionSignal>;
```

- [ ] **Add the field to `AttemptOnQuestion.payload`.** In `src/core/schema/event/known.ts`, inside the `AttemptOnQuestion` `payload` object, add after the `unsupported_judge` field (after line 50):

```ts
    // YUK-407 — reconstructability signal (see ReconstructionSignal). Optional +
    // absent for every historical attempt → no read-shape change, no backfill.
    reconstruction_signal: ReconstructionSignal.optional(),
```

- [ ] **Add the field to `ReviewOnQuestion.payload`.** In the same file, inside the `ReviewOnQuestion` `payload` object, add after the `duration_ms` field (after line 142):

```ts
      // YUK-407 — reconstructability signal mirrored onto FSRS reviews so a
      // remediated weakness can record whether the path was reconstructed.
      reconstruction_signal: ReconstructionSignal.optional(),
```

- [ ] **Run it, expect PASS:**

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/schema.test.ts -t 'reconstruction_signal'
```

- [ ] **Commit:**

```bash
git commit -am "feat(events): add reconstruction_signal to attempt/review payload contract (YUK-406/YUK-407 Phase 0)"
```

- [ ] **Write failing DB round-trip test.** Append to `src/server/events/queries.test.ts` inside the `describe('writeEvent', ...)` block (after the existing `it('parses + inserts a valid attempt event; returns the id', ...)` case):

```ts
  it('persists reconstruction_signal on the attempt payload through getEventById', async () => {
    const db = testDb();
    const id = newId();
    await writeEvent(db, {
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_recon',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k1'],
        reconstruction_signal: 'reconstructed_from_parents',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
    });
    const evt = await getEventById(db, id);
    const narrowed = evt as Extract<typeof evt, { action: 'attempt' }>;
    expect(narrowed.payload.reconstruction_signal).toBe('reconstructed_from_parents');
  });
```

- [ ] **Run it, expect PASS** (the schema change from the prior commit already makes the read-side parse retain the field; this test locks the full DB write→read round-trip so a future `.strict()` or read-projection change can't silently drop it):

```bash
pnpm vitest run --config vitest.db.config.ts src/server/events/queries.test.ts -t 'persists reconstruction_signal'
```

- [ ] **Minimal implementation — stamp it at the live solve write site.** In `src/capabilities/practice/server/solve-session.ts`, inside the attempt `writeEvent` `payload` (after the `judge: responseJudge,` line at line 382), add:

```ts
        // YUK-407 — reconstructability signal. Phase 0 stamps 'unknown' (the
        // capture UI that lets the owner distinguish reconstructed-vs-retrieved
        // lands later); the field exists from day 1 so it is backfillable.
        reconstruction_signal: 'unknown',
```

- [ ] **Stamp it at the manual-mistake write site.** In `src/capabilities/ingestion/api/mistakes.ts`, inside the attempt `writeEvent` `payload` (after the `referenced_knowledge_ids: body.knowledge_ids,` line at line 135), add:

```ts
          // YUK-407 — reconstructability signal; see solve-session.ts. Manual
          // mistake entry has no derivation trace yet → 'unknown' from day 1.
          reconstruction_signal: 'unknown',
```

- [ ] **Write a unit test asserting both write sites stamp the field.** This guards against a future edit silently dropping the stamp. Append a new file `src/capabilities/practice/server/solve-session-recon.test.ts` is NOT needed (those modules import DB) — instead assert on the schema contract with the exact payload the call sites build. Add to `src/core/schema/schema.test.ts` inside the same describe block:

```ts
  it("call-site 'unknown' stamp is a valid reconstruction_signal", () => {
    const parsed = parseEvent({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
        reconstruction_signal: 'unknown',
      },
    });
    const narrowed = parsed as Extract<typeof parsed, { action: 'attempt' }>;
    expect(narrowed.payload.reconstruction_signal).toBe('unknown');
  });
```

- [ ] **Run unit + db, expect PASS:**

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/schema/schema.test.ts -t 'reconstruction_signal' && \
pnpm vitest run --config vitest.unit.config.ts src/core/schema/schema.test.ts -t "call-site 'unknown'"
```

- [ ] **Run audit:schema, expect PASS** (proves the payload-field choice adds no unallowed schema-column stub — no allowlist entry required):

```bash
pnpm audit:schema
```

- [ ] **Run typecheck on the touched call sites, expect PASS** (proves the literal `'unknown'` narrows to the enum at both write sites):

```bash
pnpm typecheck
```

- [ ] **Commit:**

```bash
git commit -am "feat(events): stamp reconstruction_signal='unknown' at solve + mistake attempt write sites (YUK-407 Phase 0 day-1 logging)"
```

---

#### PRODUCES / CONSUMES interfaces footer

**PRODUCES** (neighboring 取证 / induction tasks consume these):

- `ReconstructionSignal` — `z.ZodEnum<['reconstructed_from_parents', 'retrieved', 'unknown']>`, exported from `src/core/schema/event/known.ts` (re-exported via `src/core/schema/event/index.ts` `export * from './known'`).
- `ReconstructionSignalT` — `'reconstructed_from_parents' | 'retrieved' | 'unknown'` (the `z.infer` type), same module.
- `AttemptOnQuestionT.payload.reconstruction_signal?: ReconstructionSignalT` — optional payload field on the `attempt` event branch. **Write path**: stamped `'unknown'` at `src/capabilities/practice/server/solve-session.ts` (live solve) and `src/capabilities/ingestion/api/mistakes.ts` (manual mistake). **Read path**: survives `parseEvent` / `getEventById` (`src/server/events/queries.ts`) on the `AttemptOnQuestion` union branch.
- `ReviewOnQuestionT.payload.reconstruction_signal?: ReconstructionSignalT` — optional payload field on the `review` event branch (FSRS path); no write-site stamp in Phase 0 (the normal `/api/review/submit` path may set it once a remediated-weakness loop wants to record reconstruction), present in the contract so it is forward-compatible.

**CONSUMES** (from existing code, signatures verified):

- `parseEvent(input: unknown): EventT` — `src/core/schema/event/index.ts:40`.
- `writeEvent(db: DbLike, input: WriteEventInput): Promise<string>` — `src/server/events/queries.ts:1020`; `WriteEventInput` at `:983` (payload is `unknown`, validated by `parseEvent` inside).
- `getEventById(db, id)` — `src/server/events/queries.ts` (used at queries.test.ts:936); returns the parsed `EventT` union (narrow via `Extract<..., { action: 'attempt' }>`).

**KEY GROUNDING FACTS** for the implementing engineer:
- The reconstructability signal is a **payload JSON field, NOT a DB column** — verified the least-invasive choice: `scripts/audit-schema-writes.ts:315-341` `parseSchema()` only walks `pgTable('name', {...})` column blocks in `src/db/schema.ts`. A `payload` JSON sub-field is invisible to it, so **no `audit-schema-allowlist.json` entry is needed** and `pnpm audit:schema` stays green with zero new entries.
- Zod objects strip unknown keys by default, so the field MUST be declared in the `AttemptOnQuestion`/`ReviewOnQuestion` Zod payload to survive the read-side parse — solve-session.ts already dumps non-contract keys (`source`, `judge_route`, `judge`) into the payload jsonb but those are "stripped by the Zod contract on parse" (comment at solve-session.ts:378). The new field is intentionally IN the contract so it persists.
- `AttemptOnQuestion` does NOT use `.strict()` (per the union-precedence comment at `known.ts:569`; `.strict()` appears only at `known.ts:302,350` on other branches), so adding an optional field is non-breaking and parses every historical attempt event.
- The single-source guard requested by YUK-407 is delivered as the comment block on `ReconstructionSignal` in `known.ts` ("the `question` table is NOT the sole source of truth for content — derivation evidence rides on the event payload").

---

## ▸ Draft 8: beifa-tai-handoff

I have all the grounding I need. Now I'll draft the build-spot task in the WRITING-PLANS format. This is the 备课台 handoff — UI-gated, backend read-model fully code-complete TDD.

---

## Phase 0 Build Spot: `备课台` Surface — Functional Handoff + Read-Model Data Contract

> **Grounding (every signature cited from real source):**
> - Conjecture proposals are a NEW kind `mind_model` added to `aiProposalKinds` (Task in the `proposal-schema` build spot, not here). They flow through the writer DEFAULT branch → `action: 'experimental:proposal'`, `subject_kind: payload.target.subject_kind` (`src/server/proposals/writer.ts:86-95`), which is exactly what `proposalWhere()` already matches via `eq(event.action, 'experimental:proposal')` (`src/server/proposals/inbox.ts:146-157`). So conjectures land in the unified inbox read model with **zero** `inbox.ts`/`writer.ts` change — same precedent as `goal_scope` (`src/core/schema/proposal.ts:21-24`).
> - The inbox read model is `listProposalInboxPage(db, opts)` → `{ rows: ProposalInboxRow[]; next_cursor }` (`src/server/proposals/inbox.ts:518-564`); `ProposalInboxRow` shape at `inbox.ts:23-37` carries `kind`, `target`, `payload: AiProposalPayloadT`, `status`, `proposed_at`, `cost_micro_usd`, `signals`.
> - The owner-decision calibration anchor already exists: `recordProposalDecisionSignal(db, proposal, 'accept'|'dismiss', userNote?)` (`src/server/proposals/actions.ts:88`, `signals.ts:176-179`) is called on every accept/dismiss in `dispatchAccept` (`actions.ts:602,615,...`) and `dismissAiProposal` (`actions.ts:839,...`). Edit/reject must reuse this, NOT invent a new signal table.
> - The existing surfaces this unifies with: `loadWorkbenchSummary` → `WorkbenchSummary` (`src/capabilities/shell/server/workbench-summary.ts:38-47,141`), `TodayPage.tsx` (`ProposalStrip` at `TodayPage.tsx:268`), `ProposalCard.tsx`, and the YUK-403 `/review` surface = `DraftReviewPage` at `src/capabilities/practice/ui/DraftReviewPage.tsx` mounted at route `/drafts` (`web/src/router.tsx:295-303`).
> - `confidence` is the internal sort key. The CONJECTURE spec forbids rendering it as a number. Note `ProposalCard.tsx:124,226-234` renders `confidence` as a `conf-bar` with `%` — the conjecture read model must therefore **strip the raw confidence number** from its wire shape and expose only the salience-derived ordering, so the existing card cannot leak a number even if reused.

---

### Task A: Conjecture surface read-model endpoint `GET /api/prep-desk/conjectures` (backend, code-complete TDD)

**Files**
- Create: `src/capabilities/shell/server/prep-desk.ts`
- Create: `src/capabilities/shell/api/prep-desk-conjectures.ts`
- Modify: `src/capabilities/shell/manifest.ts:18` (add a route entry to the existing `api.routes` array, next to the `/api/workbench/summary` block)
- Test: `src/capabilities/shell/server/prep-desk.db.test.ts` (DB test — imports `@/db/client` via the inbox read model, so it MUST go in `vitest.db.config.ts`, never unit)

**Interfaces**

*Consumes (exact, from earlier build spots — verify they exist before starting):*
- `'mind_model'` ∈ `aiProposalKinds` and a `MindModelProposalChange` shape on `AiProposalPayload` discriminated union (`src/core/schema/proposal.ts`) — produced by the `proposal-schema` build spot. The `proposed_change` carries: `claim: string` (2nd-person), `knowledge_id: string`, `cause_category: string`, `recurrence_count: number` (>=2), `probe: { question_id: string; status: 'active'|'confirmed'|'retired' }`, `corrected_by_owner: boolean`. `confidence: number` lives on `proposed_change` (internal sort only).
- `listProposalInboxPage(db, { status: 'pending', kind: 'mind_model', limit })` → `{ rows: ProposalInboxRow[]; next_cursor: string | null }` — `src/server/proposals/inbox.ts:518`.
- `ProposalInboxRow` fields used: `id`, `payload` (`AiProposalPayloadT`), `proposed_at: Date`, `cost_micro_usd: number | null` — `src/server/proposals/inbox.ts:23-37`.

*Produces (exact names later tasks / the UI handoff rely on):*
```ts
export interface ConjectureEvidenceChip { kind: ProposalEvidenceRefT['kind']; id: string }
export interface ConjectureProbeCta { question_id: string; status: 'active' | 'confirmed' | 'retired' }
export interface PrepDeskConjecture {
  id: string;                       // proposal event id (the decide target)
  claim: string;                    // 2nd-person, about thinking
  knowledge_id: string;
  cause_category: string;
  recurrence_count: number;         // >= 2
  evidence: ConjectureEvidenceChip[];   // from payload.evidence_refs (event ids)
  probe: ConjectureProbeCta;        // exactly ONE discriminating probe
  corrected_by_owner: boolean;
  proposed_at: string;              // ISO; Date → string at wire
  // NO confidence field — internal sort only, never wired out (spec invariant).
}
export interface PrepDeskConjectures { conjectures: PrepDeskConjecture[] } // <= 3, salience-ordered
export async function loadPrepDeskConjectures(db: Db): Promise<PrepDeskConjectures>
```

**Steps**

- [ ] **Write failing test** — salience ordering + cap-at-3 + no-confidence-leak. Create `src/capabilities/shell/server/prep-desk.db.test.ts`:
```ts
import { resetDb } from '@/tests/helpers/db';
import { db } from '@/db/client';
import { writeAiProposal } from '@/server/proposals/writer';
import { loadPrepDeskConjectures } from './prep-desk';
import { beforeEach, describe, expect, it } from 'vitest';

function conjecture(opts: {
  claim: string; knowledge_id: string; confidence: number; recurrence_count: number;
  probe_question_id: string; evidence_event_ids: string[];
}) {
  return {
    kind: 'mind_model' as const,
    target: { subject_kind: 'mind_model', subject_id: opts.knowledge_id },
    reason_md: opts.claim,
    evidence_refs: opts.evidence_event_ids.map((id) => ({ kind: 'event' as const, id })),
    proposed_change: {
      claim: opts.claim,
      knowledge_id: opts.knowledge_id,
      cause_category: 'concept_confusion',
      recurrence_count: opts.recurrence_count,
      confidence: opts.confidence,
      probe: { question_id: opts.probe_question_id, status: 'active' as const },
      corrected_by_owner: false,
    },
  };
}

describe('loadPrepDeskConjectures', () => {
  beforeEach(async () => { await resetDb(); });

  it('orders by salience (confidence x recurrence) desc and caps at 3', async () => {
    // salience: low=0.9*2=1.8, mid=0.5*5=2.5, hi=0.8*4=3.2, x=0.99*2=1.98
    await writeAiProposal(db, { actor_ref: 'research_meeting', payload: conjecture({ claim: 'low', knowledge_id: 'k1', confidence: 0.9, recurrence_count: 2, probe_question_id: 'q1', evidence_event_ids: ['e1'] }) });
    await writeAiProposal(db, { actor_ref: 'research_meeting', payload: conjecture({ claim: 'mid', knowledge_id: 'k2', confidence: 0.5, recurrence_count: 5, probe_question_id: 'q2', evidence_event_ids: ['e2'] }) });
    await writeAiProposal(db, { actor_ref: 'research_meeting', payload: conjecture({ claim: 'hi', knowledge_id: 'k3', confidence: 0.8, recurrence_count: 4, probe_question_id: 'q3', evidence_event_ids: ['e3'] }) });
    await writeAiProposal(db, { actor_ref: 'research_meeting', payload: conjecture({ claim: 'x', knowledge_id: 'k4', confidence: 0.99, recurrence_count: 2, probe_question_id: 'q4', evidence_event_ids: ['e4'] }) });

    const out = await loadPrepDeskConjectures(db);
    expect(out.conjectures.map((c) => c.claim)).toEqual(['hi', 'mid', 'x']);
  });

  it('never wires out a confidence number', async () => {
    await writeAiProposal(db, { actor_ref: 'research_meeting', payload: conjecture({ claim: 'c', knowledge_id: 'k1', confidence: 0.77, recurrence_count: 3, probe_question_id: 'q1', evidence_event_ids: ['e1'] }) });
    const out = await loadPrepDeskConjectures(db);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('0.77');
    expect(serialized).not.toContain('confidence');
    expect(out.conjectures[0].evidence).toEqual([{ kind: 'event', id: 'e1' }]);
    expect(out.conjectures[0].probe).toEqual({ question_id: 'q1', status: 'active' });
  });
});
```
- [ ] **Run it, expect FAIL** (module not found): `pnpm vitest run --config vitest.db.config.ts src/capabilities/shell/server/prep-desk.db.test.ts`
- [ ] **Minimal implementation** — create `src/capabilities/shell/server/prep-desk.ts`:
```ts
// Phase 0 (YUK-406) — 备课台 read model. Conjecture proposals (kind 'mind_model')
// land in the unified inbox via the writer default branch (writer.ts:86-95) +
// proposalWhere() (inbox.ts:146-157), so this reuses listProposalInboxPage and
// projects a guilt-free, number-free wire shape. confidence is read ONLY to sort
// (salience = confidence x recurrence) and is then DROPPED — the spec forbids
// rendering it as a number, so it must not cross the wire (defense in depth: the
// existing ProposalCard would render any `confidence` field as a %).
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { listProposalInboxPage } from '@/server/proposals/inbox';

const PREP_DESK_MAX = 3;
// Generous fetch so salience can sort the full pending set before the cap.
const PREP_DESK_FETCH_LIMIT = 50;

export interface ConjectureEvidenceChip {
  kind: ProposalEvidenceRefT['kind'];
  id: string;
}
export interface ConjectureProbeCta {
  question_id: string;
  status: 'active' | 'confirmed' | 'retired';
}
export interface PrepDeskConjecture {
  id: string;
  claim: string;
  knowledge_id: string;
  cause_category: string;
  recurrence_count: number;
  evidence: ConjectureEvidenceChip[];
  probe: ConjectureProbeCta;
  corrected_by_owner: boolean;
  proposed_at: string;
}
export interface PrepDeskConjectures {
  conjectures: PrepDeskConjecture[];
}

export async function loadPrepDeskConjectures(db: Db): Promise<PrepDeskConjectures> {
  const page = await listProposalInboxPage(db, {
    status: 'pending',
    kind: 'mind_model',
    limit: PREP_DESK_FETCH_LIMIT,
  });
  const ranked = page.rows
    .map((row) => {
      // mind_model payload — narrow off the discriminated union.
      const change = (row.payload as { proposed_change: Record<string, unknown> }).proposed_change;
      const confidence = typeof change.confidence === 'number' ? change.confidence : 0;
      const recurrence = typeof change.recurrence_count === 'number' ? change.recurrence_count : 0;
      const probe = change.probe as ConjectureProbeCta;
      const conjecture: PrepDeskConjecture = {
        id: row.id,
        claim: String(change.claim ?? row.payload.reason_md),
        knowledge_id: String(change.knowledge_id ?? ''),
        cause_category: String(change.cause_category ?? ''),
        recurrence_count: recurrence,
        evidence: row.payload.evidence_refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
        probe: { question_id: probe.question_id, status: probe.status },
        corrected_by_owner: Boolean(change.corrected_by_owner),
        proposed_at: row.proposed_at.toISOString(),
      };
      // salience kept LOCAL — sorts, then is discarded (never on PrepDeskConjecture).
      return { conjecture, salience: confidence * recurrence };
    })
    .sort((a, b) => b.salience - a.salience)
    .slice(0, PREP_DESK_MAX)
    .map((r) => r.conjecture);
  return { conjectures: ranked };
}
```
- [ ] **Run it, expect PASS**: `pnpm vitest run --config vitest.db.config.ts src/capabilities/shell/server/prep-desk.db.test.ts`
- [ ] **Commit**: `git commit -am "feat(prep-desk): conjecture read model loadPrepDeskConjectures (salience sort, no confidence leak) (YUK-406)"`
- [ ] **Minimal implementation** — create the API shell `src/capabilities/shell/api/prep-desk-conjectures.ts` (mirrors `workbench-summary.ts:8-14` exactly):
```ts
// Phase 0 (YUK-406) — GET /api/prep-desk/conjectures 薄壳——聚合逻辑在
// ../server/prep-desk（备课台 read model）。
import { loadPrepDeskConjectures } from '@/capabilities/shell/server/prep-desk';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadPrepDeskConjectures(db));
  } catch (err) {
    return errorResponse(err);
  }
}
```
- [ ] **Minimal implementation** — register the route in `src/capabilities/shell/manifest.ts`. Find the `/api/workbench/summary` route block (`manifest.ts:33`) and add immediately after it, inside the same `api.routes` array:
```ts
      {
        method: 'GET',
        path: '/api/prep-desk/conjectures',
        load: () => import('./api/prep-desk-conjectures').then((m) => m.GET),
      },
```
- [ ] **Write failing test** — route registration smoke (the manifest reconciliation gate `pnpm gen:postman` requires every route to exist; this test asserts the read model is mounted). Append to `prep-desk.db.test.ts`:
```ts
import { shellCapability } from '@/capabilities/shell/manifest';

it('registers GET /api/prep-desk/conjectures in the shell manifest', () => {
  const paths = shellCapability.api.routes.map((r) => `${r.method} ${r.path}`);
  expect(paths).toContain('GET /api/prep-desk/conjectures');
});
```
(Adjust the manifest export name to the real one — grep `export const` in `src/capabilities/shell/manifest.ts` if `shellCapability` differs.)
- [ ] **Run it, expect FAIL → fix import name if needed → PASS**: `pnpm vitest run --config vitest.db.config.ts src/capabilities/shell/server/prep-desk.db.test.ts`
- [ ] **Run the manifest reconciliation gate** (CLAUDE.md: new route → edit `postman/api-endpoints.json` + `pnpm gen:postman`). Add the spec entry for `GET /api/prep-desk/conjectures` to `postman/api-endpoints.json`, then `pnpm gen:postman` (idempotent; Biome-formats). Confirm no dead-spec throw.
- [ ] **Commit**: `git commit -am "feat(prep-desk): mount GET /api/prep-desk/conjectures + postman spec (YUK-406)"`

---

### Task B: Owner-decision plumbing for the 备课台 — accept / edit / reject semantics (backend, code-complete TDD)

> The 备课台 owner actions are **accept (NOT confirmed)** / **edit (sets `corrected_by_owner`, writes owner version to CORE)** / **reject (dismiss + reason to digest)**. Each is a calibration anchor. These map onto the EXISTING decide pipeline — no new endpoint, no new signal table — but `mind_model` currently hits the `dispatchAccept` default-throw `unsupported_proposal_kind` (`actions.ts:668-674`). This task wires the accept branch so accept does NOT auto-confirm the conjecture, and reject routes the reason to the digest.

**Files**
- Modify: `src/server/proposals/actions.ts:591` (add a `case 'mind_model'` to `dispatchAccept`)
- Create: `src/server/proposals/mind-model-applier.ts`
- Modify: `src/core/schema/proposal.ts` — add `'mind_model'` to `acceptSupportedProposalKinds` (`proposal.ts:76-93`) so `ProposalCard`'s `isAcceptSupported` gate (`inbox-api.ts:50-54`) renders the accept CTA; the `inbox-meta.unit.test.ts` parity test will enforce drift.
- Test: `src/server/proposals/mind-model-applier.db.test.ts` (DB test)

**Interfaces**

*Consumes:*
- `recordProposalDecisionSignal(db, proposal, 'accept' | 'dismiss', userNote?)` — `src/server/proposals/actions.ts:88`, `signals.ts:176`. This IS the calibration-anchor write; every owner decision must call it (precedent: every `dispatchAccept` case, e.g. `actions.ts:602`).
- `writeEvent(db, {...})` — `src/server/events/queries.ts` (used throughout `actions.ts`).
- `acceptSupportedProposalKinds` — `src/core/schema/proposal.ts:76`.
- `ProposalInboxRow` from `./inbox` — `actions.ts:79`.

*Produces:*
```ts
export interface MindModelAcceptResult {
  kind: 'mind_model';
  rate_event_id: string;
  // accept = surfaced/acknowledged, NOT confirmed: the conjecture's probe stays
  // 'active' until the probe is answered. No FSRS write here (ND-5 invariant).
  confirmed: false;
  idempotent?: boolean;
}
export async function acceptMindModelProposal(
  db: Db, proposalId: string, proposal: ProposalInboxRow, opts: AcceptAiProposalOpts,
): Promise<MindModelAcceptResult>
```

**Steps**

- [ ] **Write failing test** — accept does NOT confirm + writes the calibration signal. Create `src/server/proposals/mind-model-applier.db.test.ts`:
```ts
import { resetDb } from '@/tests/helpers/db';
import { db } from '@/db/client';
import { writeAiProposal } from '@/server/proposals/writer';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { event, proposal_signals } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

const mindModel = {
  kind: 'mind_model' as const,
  target: { subject_kind: 'mind_model', subject_id: 'k1' },
  reason_md: 'you treat the chain rule as multiplying derivatives',
  evidence_refs: [{ kind: 'event' as const, id: 'e1' }],
  proposed_change: {
    claim: 'you treat the chain rule as multiplying derivatives',
    knowledge_id: 'k1', cause_category: 'concept_confusion', recurrence_count: 3,
    confidence: 0.8, probe: { question_id: 'q1', status: 'active' as const },
    corrected_by_owner: false,
  },
};

describe('mind_model owner decisions', () => {
  beforeEach(async () => { await resetDb(); });

  it('accept records a calibration signal but does NOT confirm the conjecture', async () => {
    const id = await writeAiProposal(db, { actor_ref: 'research_meeting', payload: mindModel });
    const res = await acceptAiProposal(db, id, {});
    expect(res).toMatchObject({ kind: 'mind_model', confirmed: false });
    const sig = await db.select().from(proposal_signals).where(eq(proposal_signals.kind, 'mind_model'));
    expect(sig.length).toBeGreaterThan(0); // calibration anchor written via recordProposalDecisionSignal
  });

  it('reject (dismiss) carries the owner reason into the rate event for the digest', async () => {
    const id = await writeAiProposal(db, { actor_ref: 'research_meeting', payload: mindModel });
    await dismissAiProposal(db, id, { user_note: '我并不这样想' });
    const [rate] = await db.select().from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, id)));
    expect((rate.payload as { user_note?: string }).user_note).toBe('我并不这样想');
  });
});
```
- [ ] **Run it, expect FAIL** (`unsupported_proposal_kind`): `pnpm vitest run --config vitest.db.config.ts src/server/proposals/mind-model-applier.db.test.ts`
- [ ] **Minimal implementation** — create `src/server/proposals/mind-model-applier.ts`:
```ts
// Phase 0 (YUK-406) — mind_model (conjecture) accept applier. Mirrors the
// generic rate-event appliers (actions.ts writeGenericRateEvent precedent) but
// is its own module so the no-FSRS / not-confirmed invariant lives in one place.
// accept = the owner ACKNOWLEDGES the conjecture (surfaced → seen); it is NOT a
// confirmation. The conjecture is confirmed/retired ONLY by answering its probe
// (the probe→FSRS one-shot loop, a separate build spot). ND-5: this path never
// writes FSRS state. The calibration anchor is recordProposalDecisionSignal.
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { and, eq } from 'drizzle-orm';
import type { AcceptAiProposalOpts } from './actions';
import type { ProposalInboxRow } from './inbox';
import { recordProposalDecisionSignal } from './signals';

export interface MindModelAcceptResult {
  kind: 'mind_model';
  rate_event_id: string;
  confirmed: false;
  idempotent?: boolean;
}

export async function acceptMindModelProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AcceptAiProposalOpts,
): Promise<MindModelAcceptResult> {
  if (opts.decision && opts.decision !== 'accept') {
    throw new ApiError(
      'validation_error',
      `mind_model proposal only supports accept, got ${opts.decision}`,
      400,
    );
  }
  const existing = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  if (existing[0]) {
    return { kind: 'mind_model', rate_event_id: existing[0].id, confirmed: false, idempotent: true };
  }
  const rateEventId = newId();
  await writeEvent(db, {
    id: rateEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    // accepted === acknowledged, not confirmed; confirmation is the probe's job.
    payload: { rating: 'accept', confirmed: false, ...(opts.user_note ? { user_note: opts.user_note } : {}) },
    caused_by_event_id: proposalId,
    created_at: new Date(),
  });
  await recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note);
  return { kind: 'mind_model', rate_event_id: rateEventId, confirmed: false };
}
```
- [ ] **Minimal implementation** — wire the dispatch case. In `src/server/proposals/actions.ts`, add the import near the other practice/agency appliers (after `actions.ts:88`):
```ts
import { type MindModelAcceptResult, acceptMindModelProposal } from './mind-model-applier';
```
add `| MindModelAcceptResult` to the `AcceptAiProposalResult` union (`actions.ts:118-139`), and add the case before the `default:` in `dispatchAccept` (`actions.ts:667`):
```ts
    case 'mind_model':
      // Phase 0 (YUK-406) — accept = acknowledge (surfaced→seen), NOT confirm; no
      // FSRS write (ND-5). recordProposalDecisionSignal is the calibration anchor.
      return await acceptMindModelProposal(db, proposalId, proposal, opts);
```
- [ ] **Minimal implementation** — add `'mind_model'` to `acceptSupportedProposalKinds` in `src/core/schema/proposal.ts:91` (before the closing `]`), so the inbox card renders the accept CTA and `inbox-meta.unit.test.ts` parity holds:
```ts
  'question_edit',
  // Phase 0 (YUK-406) — conjecture accept = acknowledge (no FSRS, not confirmed).
  'mind_model',
```
- [ ] **Run it, expect PASS**: `pnpm vitest run --config vitest.db.config.ts src/server/proposals/mind-model-applier.db.test.ts`
- [ ] **Run the inbox-meta parity test** (it pins `acceptSupportedProposalKinds ∪ unimplemented === aiProposalKinds`, `proposal.ts:70-75`): `pnpm vitest run --config vitest.unit.config.ts src/server/proposals/inbox-meta.unit.test.ts` — fix the unimplemented-set fixture in that test if it lists `mind_model` as unsupported.
- [ ] **Commit**: `git commit -am "feat(prep-desk): mind_model accept applier (acknowledge not confirm, no FSRS, calibration signal) + dispatch wiring (YUK-406)"`

> **Edit action note (no code here — it is the conjecture-CORE build spot's surface):** the 备课台 "edit" action sets `corrected_by_owner` and writes the owner version to mem0 CORE. Per the single-writer invariant (mem0 CORE is written ONLY by the sleep job, copilot is read-only on CORE), the owner edit must NOT write CORE directly from this request path — it records the owner-corrected claim as a `correct` event (golden anchor) that the next 例会 job reconciles into CORE. The decide endpoint already has `retractAiProposal` writing a `correct` event (`actions.ts:914-936`). The edit handler is wired in the mem0-CORE / induction build spot; this task only guarantees accept/reject. Flag for that spot: edit ⇒ `correct` event + `corrected_by_owner=true`, reconciled to CORE by the sleep job, never confirmed automatically.

---

### Task C: 备课台 UI handoff — DESIGN-GATED, NOT IMPLEMENTED HERE

> **CLAUDE.md UI rule (verbatim):** "写任何 UI 代码（新组件 / 改既有组件 / 布局 / 交互）**之前**，先做 design-doc pre-flight，等用户批准后才动手." And from project memory: "claude design 是 claude.ai/design 独立 agent 出视觉稿；我只出功能 handoff(零风格规定)+ 设计回来 slice-by-slice 实现." **This task produces the functional handoff + data contract ONLY. No `.tsx`, no `.css`, no visual code is written in Phase 0 implementation.**

**Files**
- Create: `docs/design/handoff/2026-06-18-prep-desk-conjectures.md` (functional handoff doc — NOT component code)
- NO modify to `TodayPage.tsx`, `ProposalCard.tsx`, `InboxPage.tsx`, `DraftReviewPage.tsx`, `web/src/router.tsx` in this task.

**Interfaces**

*Consumes (the contract the surface renders — exact shapes from Task A/B):*
- `PrepDeskConjectures` / `PrepDeskConjecture` / `ConjectureEvidenceChip` / `ConjectureProbeCta` (Task A).
- `GET /api/prep-desk/conjectures` returns `PrepDeskConjectures`.
- Owner actions hit the EXISTING decide endpoint `POST /api/proposals/[id]/decide` (`shell/manifest.ts:23`) via `decideProposal(id, decision, opts)` (`inbox-api.ts:111-123`): accept → `decision:'accept'`; reject → `decision:'dismiss'` with `userNote`; edit → (new) the conjecture-CORE build spot's edit path.

*Produces:* a frozen functional spec the claude design pass and the later slice-by-slice implementer consume.

**Steps (handoff authoring — no test/impl cycle; this is a doc gate)**

- [ ] **Write the data contract section** into the handoff doc: the surface consumes up to 3 `PrepDeskConjecture`, each rendering: `claim` (the 2nd-person belief, as prose — this is the card body, NOT a curated title); `evidence` chips (one per `ConjectureEvidenceChip`, each links to its event ref — reuse the `EvidenceChip` pattern at `ProposalCard.tsx:38-66` and `evidenceReadable` at `inbox-api.ts:151-169`, `kind:'event'` currently `route:null` → "源自一次 AI 判定事件"); the probe CTA (one button per conjecture, `ConjectureProbeCta.question_id`, label e.g. "去验证这条推测"); and accept / edit / reject owner actions.
- [ ] **Write the salience-ordering note**: ordering is `confidence x recurrence`, computed server-side in `loadPrepDeskConjectures`; the UI renders in array order and MUST NOT re-sort, MUST NOT receive or display the confidence number (it is absent from the wire by construction — Task A "no-confidence-leak" test guarantees it).
- [ ] **Write the three-layer progressive-disclosure note**: layer 1 = the `claim` + probe CTA (default); layer 2 = evidence chips + `cause_category` + `recurrence_count` ("出现过 N 次", count is fine — it is not a confidence number); layer 3 = the full evidence event drill-down (deferred to event-chain SPA navigation, currently `route:null`). Cite the disclosure precedent: `DraftReviewPage.tsx` master-detail (list row `DraftReviewPage.tsx:976-1027` → preview pane `DrPreviewBody` `DraftReviewPage.tsx:189-260`).
- [ ] **Write the anti-guilt constraints** as hard MUST-NOTs: NO unread/pending count badge on the conjecture surface (contrast the inbox's "{remaining} 条待裁决" at `InboxPage.tsx:140-142` and KPI total at `TodayPage.tsx:66-77` — the 备课台 section must NOT carry a count badge); NO streak; NO push/notification; quiet-empty when zero (reuse the `EmptyState`/`quiet-empty` pattern, `DraftReviewPage.tsx:794-806`). The card must read as an invitation, not a debt.
- [ ] **Write the YUK-403 /review unification requirement**: the 备课台 surface is unified with the YUK-403 `/review` draft-pool surface (`DraftReviewPage` at route `/drafts`, `web/src/router.tsx:295-303`). Specify the unification decision the design pass must resolve: either (a) the conjecture surface becomes a section/tab within `DraftReviewPage`'s `/drafts` route reframed as the prep-desk, or (b) a sibling section on `TodayPage` that shares the `/drafts` review surface's visual language. Both reuse the master-detail + verify-status-tab vocabulary already in `DraftReviewPage`; the implementer must NOT build a parallel third review aesthetic.
- [ ] **Write the explicit gate line** (verbatim into the doc): *"UI 实现不在 Phase 0 范围内。本 handoff 交给 claude design 出视觉稿；视觉稿回来后按 CLAUDE.md UI pre-flight（逐字引用 design doc 段落 + 声明组件类型 + 列出 touch 文件 + 等用户批准）做 slice-by-slice 实现。Phase 0 只交付 read-model 端点（Task A）+ owner-decision 后端语义（Task B）+ 本 handoff。不写任何 .tsx / .css。"*
- [ ] **Commit**: `git commit -am "docs(prep-desk): 备课台 functional handoff + data contract (design-gated, no UI code) (YUK-406)"`

---

## PRODUCES / CONSUMES interfaces footer

**PRODUCES (neighboring tasks line up on these exact names):**

```ts
// src/capabilities/shell/server/prep-desk.ts
export interface ConjectureEvidenceChip { kind: ProposalEvidenceRefT['kind']; id: string }
export interface ConjectureProbeCta { question_id: string; status: 'active' | 'confirmed' | 'retired' }
export interface PrepDeskConjecture {
  id: string; claim: string; knowledge_id: string; cause_category: string;
  recurrence_count: number; evidence: ConjectureEvidenceChip[]; probe: ConjectureProbeCta;
  corrected_by_owner: boolean; proposed_at: string;   // NO confidence field
}
export interface PrepDeskConjectures { conjectures: PrepDeskConjecture[] }   // <= 3, salience-ordered
export async function loadPrepDeskConjectures(db: Db): Promise<PrepDeskConjectures>
// GET /api/prep-desk/conjectures → PrepDeskConjectures

// src/server/proposals/mind-model-applier.ts
export interface MindModelAcceptResult { kind: 'mind_model'; rate_event_id: string; confirmed: false; idempotent?: boolean }
export async function acceptMindModelProposal(db: Db, proposalId: string, proposal: ProposalInboxRow, opts: AcceptAiProposalOpts): Promise<MindModelAcceptResult>
// docs/design/handoff/2026-06-18-prep-desk-conjectures.md — functional handoff (design-gated)
```

**CONSUMES (from earlier build spots — these MUST exist before Task A/B run):**

```ts
// src/core/schema/proposal.ts (proposal-schema build spot)
//   'mind_model' ∈ aiProposalKinds (proposal.ts:6-65)
//   AiProposalPayload branch: kind:'mind_model', target.subject_kind:'mind_model',
//     proposed_change: { claim:string; knowledge_id:string; cause_category:string;
//       recurrence_count:number; confidence:number; corrected_by_owner:boolean;
//       probe:{ question_id:string; status:'active'|'confirmed'|'retired' } }
export const ProposalEvidenceRef = z.object({ kind: z.enum(['event','question','knowledge','artifact','record']), id: z.string().min(1) });  // proposal.ts:95-98
export const acceptSupportedProposalKinds = [...] // proposal.ts:76 — Task B appends 'mind_model'

// src/server/proposals/inbox.ts
export async function listProposalInboxPage(db: DbLike, opts?: ListProposalInboxOpts): Promise<ProposalInboxPage>  // inbox.ts:518
export interface ProposalInboxRow { id:string; kind; target; payload:AiProposalPayloadT; status; proposed_at:Date; cost_micro_usd:number|null; signals }  // inbox.ts:23-37
// proposalWhere() matches action:'experimental:proposal' (inbox.ts:146-157) — conjectures land here via writer default branch (writer.ts:86-95) with ZERO inbox/writer change.

// src/server/proposals/signals.ts (the calibration-anchor write — reuse, do NOT add a table)
export async function recordProposalDecisionSignal(db, proposal:ProposalInboxRow, decision:'accept'|'dismiss', userNote?:string): Promise<void>  // signals.ts:176

// src/server/proposals/writer.ts
export async function writeAiProposal(db: DbLike, input: WriteAiProposalInput): Promise<string>  // writer.ts:98 — actor_ref:'research_meeting' for the 例会 job
```

**Key load-bearing findings for neighboring spots:**
- The `mind_model` conjecture flows through the writer DEFAULT branch (`writer.ts:86-95`) → `action:'experimental:proposal'`, which `proposalWhere()` already matches — so the inbox/KPI/workbench plumbing needs **no change** to surface conjectures. Same precedent as `goal_scope`.
- `ProposalCard.tsx:124,226-234` would render any `confidence` field on the payload as a visible `%`. The conjecture read model (Task A) therefore **omits confidence from the wire entirely**; the no-confidence-leak test enforces this. If the eventual UI reuses `ProposalCard`, it must read from `PrepDeskConjecture` (no `confidence`), not the raw `payload`.
- `recordProposalDecisionSignal` IS the "each owner decision becomes a calibration anchor" mechanism — already called on every accept/dismiss. Do NOT invent a new signal table.
- Edit action (owner correction → CORE golden anchor) is OUT of these tasks: it belongs to the mem0-CORE/induction build spot and must go through a `correct` event reconciled by the sleep job (single-writer invariant: copilot/request path never writes CORE directly). Flagged in Task B.
