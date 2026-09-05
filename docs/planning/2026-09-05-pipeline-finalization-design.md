# AI pipeline finalization and legacy convergence

**Decision:** implement one capability-private `finalize_reply` collector inside the existing
`CopilotTask` query. Delete the two post-root evidence-review TaskKinds and their runtime. Keep the
question/solve/teaching semantic validators and deterministic proposal/correction gates. Converge
foreground and explicit durable Copilot roots on native depth-1 `Task`; stop producing ToolOperations
and mailbox continuations while draining old pending work without deleting historical rows.

**Grounded base:** `090e882c36dc18e27408403da3f5417ac41790be`, ADR-0054 through ADR-0057, and
the current `chat.ts` / `copilot_run.ts` call chains. No UI change, deploy, production data deletion,
generic workflow engine, or whole-project re-layout is in this decision.

## Why this is the smallest viable seam

Today a read-bearing Copilot reply leaves the root query and starts a blind reference Task plus two
confirmed comparator passes; failures can add retries and a fallback comparison. The path serializes the
request, candidate and tool trace into large ledgers and checkpoints. It is expensive and the reply is
then rewritten/revalidated outside the live parent. In contrast, ordinary no-read replies still have no
typed terminal contract.

The runner already exposes the needed stable mechanisms: per-call MCP servers/allowlists, hooks,
`canUseTool`, one root `task_run_id`, native Task lifecycle, cancellation and terminal audit. A runner-wide
finalization abstraction would leak Copilot product semantics into the central runtime, contrary to
ADR-0057. Agent SDK `outputFormat` is also the wrong interface: `runner.ts` deliberately suppresses it
when the selected ModelProfile says structured output is unsupported (the current Xiaomi/MiMo lane), and
the collecting stream does not expose it as the authoritative Copilot reply. That would create provider-
dependent finalization.

The private collector is therefore a deep module at the Copilot seam: callers learn one operation, while
the module owns normalization, semantic gates, trace binding and the one-shot state machine. It is not a
DomainTool, is not registered by a capability manifest, writes no `tool_call_log`/`tool_use` mirror, and
cannot read or mutate product state except through the explicit validators/dependencies passed by its
Copilot caller.

## Chosen interface and state machine

Create `src/capabilities/copilot/server/reply-finalization.ts` with one factory:

```ts
createCopilotReplyFinalizer({
  rootTaskRunId, correctionContract, userContextText,
  trace, validateLearningContent, proposalDisclosure,
}) => {
  mcpServer,
  allowedToolName,
  hooks,
  canUseToolGuard,
  beforeDomainTool,
  consumeTerminalResult,
}
```

The private tool name is `mcp__copilot_internal__finalize_reply`. Its model-authored input is deliberately
small:

```ts
{
  reply_md: string;                    // 1..64,000 characters
  relied_on_tool_use_ids: string[];    // unique, at most the turn tool-call ceiling
}
```

The model does **not** supply the root ID, digests, statuses, proposal contract or validation result.
Those are server-owned closure state. `relied_on_tool_use_ids` are provenance claims only; they do not
prove the semantic truth or completeness of a sentence.

The factory owns a bounded turn trace. Every PreToolUse receives a monotonically assigned ordinal and
SDK `tool_use_id`; DomainTool settlement contributes the exact executed input/output/error/effect, while
PostToolUse/PostToolUseFailure contributes bounded native Task and remote-MCP settlement metadata. Add
`tool_use_id?: string` to `ToolExecutionResultObservation`, and change the existing bridge correlation to
claim IDs for every Copilot DomainTool, not only `safeHandoff`. A Copilot finalizer may cite only a known,
settled, successful current-root ID. Hash large inputs/outputs in the receipt; keep the existing in-memory
typed DomainTool result only as long as needed for proposal disclosure and content checks. Preserve the
existing 60-call accident ceiling; do not recreate request/reply units, JSON pointers, dense coverage,
source catalogs or a model-authored ledger.

`finalize_reply` is retryable until one submission seals. For each submission it performs, in order:

1. Validate size, uniqueness and current-root tool IDs. Reject unknown, failed, in-flight or foreign IDs.
2. Strip/parse reply-tail presentation metadata with the existing `extractPrimaryView` rules.
3. Apply `resolveCorrectionReply` against the server-owned correction contract.
4. Canonically compose the proposal disclosure from successful/failed `propose` observations. The server
   owns the wording and appends it before hashing; model prose can neither downgrade `FULL` nor claim a
   direct write. The composition is idempotent and replaces any prior canonical disclosure block.
5. Run `reviewCopilotLearningContent` on the resulting user-visible text and any ephemeral HTML. This
   preserves `QuizVerifyTask`, solve/semantic judging and `TeachingQualityTask`. If it returns the fixed
   unverified-content reply, reapply correction and canonical proposal disclosure, then assert that the
   final fixed text itself needs no further learning-content validation.
6. Apply the existing presentation policy to the accepted result: retain `primary_view` only where the
   current path would retain it; never let unvalidated HTML or a post-check marker bypass the gate.
7. Atomically seal an in-memory receipt over the exact candidate and final bytes plus the current trace
   snapshot. Return only `{status:'accepted', reply_sha256, trace_sha256}` to the model.

The receipt persisted in `experimental:copilot_reply.payload.reply_finalization` is compact:

```ts
{
  protocol_version: 1,
  assurance: 'root_attested_structural',
  root_task_run_id: string,
  candidate_sha256: string,
  reply_sha256: string,
  trace_sha256: string,
  trace_call_count: number,
  relied_on_tool_use_ids: string[],
  correction: 'normal' | 'clarify' | 'corrected',
  proposal_disclosure: 'none' | 'server_composed',
  learning_content: 'not_applicable' | 'passed' | 'blocked',
  primary_view: 'absent' | 'retained' | 'dropped'
}
```

After a seal, `beforeDomainTool` rejects further DomainTools and `canUseToolGuard` rejects native Task,
remote MCP and any second finalizer call. Parallel calls can race with the finalizer, so the terminal
consumer must additionally recompute the trace digest/version after the SDK query settles. A changed
trace, an in-flight call, a missing receipt, a receipt for a different root, or a digest mismatch is
fail-closed. The fixed failure reply is server-authored, includes canonical proposal disclosure when
effects already occurred, and is itself hashed/persisted as a failure finalization receipt. No raw root
text is exposed.

Only `consumeTerminalResult()` supplies `writeCopilotReply`. Ignore `StreamCollectResult.text` and every
assistant text block after the tool result. The exact consumed `reply_md` and selected `primary_view` are
passed as `preparedReply`; `writeCopilotReply` asserts byte/digest equality and does not normalize again.
Streaming continues to buffer root output and publishes the one persisted final text only after the domain
write. A root failure after a stable accepted receipt may preserve the existing partial/error UX, but the
only visible bytes are the sealed bytes. With no accepted receipt, never persist a partial model draft.

## Assurance change (explicit)

Remove the claim that every read-bearing reply receives an independent FULL evidence verification.
The new assurance is:

- confirmed structurally: one current-root reply, exact candidate/final digests, bounded complete call
  trace digest, valid current-root provenance IDs, no effects after seal, deterministic proposal/correction
  contracts, and no unvalidated final-byte rewrite;
- semantically checked where correctness is load-bearing: generated questions, solutions and teaching
  content continue through `content-validation.ts` and its dedicated model judges;
- **not independently confirmed:** the root model's interpretation, coverage or factual entailment of
  ordinary read results. `relied_on_tool_use_ids` are provenance, not truth. Prompt boundaries and actual-
  provider acceptance measure this weaker assurance honestly.

Do not retain `evidence_validation.status='pass'` for new replies. Historical payloads remain readable.

## Runtime migration

### Finalization and reviewer deletion

In one code change, wire the collector into both root consumers:

- `src/capabilities/copilot/server/chat.ts`: mount the private MCP server, compose its guard with the
  proposal/context budget and native Task guards, consume only the sealed result, and keep one
  `CopilotTask` for ordinary replies.
- `src/capabilities/copilot/jobs/copilot_run.ts`: use the same factory with durable cancellation probes and
  outcome-marker persistence; Mission remains an explicit worker root with `persistSession:false`.
- `src/capabilities/copilot/tasks/agent.ts`: replace the long evidence-review promise with the concise
  requirement to call `finalize_reply` exactly once after all tools; keep evidence scope rules, owner gate,
  correction and one-voice instructions.
- `src/capabilities/copilot/server/chat-contracts.ts` or the new finalization module: own the compact receipt
  schema; do not place it in the generic runner.

Delete active reviewer runtime and tests:

- `src/capabilities/copilot/tasks/evidence.ts`
- `src/capabilities/copilot/server/evidence-review.ts`
- `src/capabilities/copilot/server/evidence-contract.ts`
- `src/capabilities/copilot/server/evidence-submission.ts`
- `src/capabilities/copilot/server/evidence-checkpoint.ts`
- `src/capabilities/copilot/server/evidence-checkpoint-pg.ts`
- their `*.test.ts`, `*.unit.test.ts`, `*.db.test.ts` and actual-fixture files
- the evidence-only schemas in `src/capabilities/copilot/contracts.ts` and constants in
  `src/core/copilot-evidence.ts` (move the 60-call ceiling to the Copilot budget/finalizer owner)

Remove `CopilotEvidenceReviewTask` and `CopilotEvidenceVerificationTask` from
`src/capabilities/copilot/tasks/index.ts`, the task catalog/closed-union tests, prompt hashes, census
fixtures and architecture inventory. Keep `src/server/ai/sealed-validation.ts`: Practice intervention
review still consumes it. Keep the `copilot_evidence_checkpoint` table/schema and historical
`ai_task_runs` rows read-only in this change; no production data deletion is authorized. A later retention
decision may archive/drop them after production observation, never as part of runtime cutover.

### ToolOperations

Stop the only producer by removing `safeHandoff` from
`src/capabilities/copilot/server/tools/search-memory-facts.ts`. Remove
`get_tool_operation`/`wait_tool_operation`/`cancel_tool_operation` from active model allowlists and
capability registration. `search_memory_facts` now executes directly and blocks under the root deadline.

Keep `tool_operation` rows/events, replay projection, durable cancel sweep and startup recovery for the
compatibility window. They settle old queued/running rows and keep historic Dock replay truthful. Do not
insert any new row. After a deployed version has observed zero nonterminal rows across a full maximum
deadline/retry window, a separate gate may remove recovery/state-machine writers; the historical reader
and rows remain.

### Native Task and mailbox drain

Foreground already uses native depth-1 Task. Give explicit durable Copilot roots the same
`buildCopilotSubagents` definition, `SpawnContract`, trace hooks, cancellation and
`handleNativeSubagentTaskEvent` projection. The child is blocking, read-only, depth 1, `background:false`,
shares the live root family/deadline, returns as native `tool_result`, and never speaks directly.
Foreground and Mission roots remain independent; this does not resume a foreground SDK session on the
worker.

Stop new mailbox producers: remove `launch_researcher`/`get_subagent`/`wait_subagent` from active model
allowlists and never create a `copilot_continuation` for native children. Keep the old
`copilot_subagent_run`, `copilot_continuation` and reconcile handlers registered until pre-existing
queued/running subagent rows and pending/running continuations drain. They may complete exactly once under
their existing idempotency/lease rules. New native Task children continue using `subagent_run` as the
audit/projection noun with `mintContinuation:false`; historical rows and turns are not deleted.

Removal gate for legacy queue handlers: production readback shows zero nonterminal legacy mailbox rows and
zero queued/active jobs for at least one maximum 12-minute child deadline plus retry/reconcile interval.
Then remove only the producer/handler/recovery code and job registrations; retain tables and replay of
historic rows. Do not couple this to Mission lifecycle or remove `copilot_run`/job_events.

## Verification and acceptance

Replace implementation-pinned ledger/checkpoint tests with interface scenarios:

1. Plain answer: one `CopilotTask`, one accepted finalizer call, no evidence TaskKind, exact persisted/SSE
   bytes equal `reply_sha256`.
2. Read answer: two identical or parallel DomainTool calls receive distinct SDK IDs; only current-root,
   settled IDs can be cited; the trace digest covers every call without a dense ledger.
3. Late effect: finalizer plus a parallel/late DomainTool, Tavily call or native Task makes terminal consume
   fail closed; no candidate or trailing assistant prose is persisted/emitted.
4. Proposal: successful, skipped and failed propose results produce exact server-owned FULL/direct-write/
   retained-draft disclosure; the model cannot downgrade or omit it; proposal replan gate is unchanged.
5. Correction: exact/relative target, ambiguous clarification and malformed envelope all seal only the
   deterministic correction result.
6. Learning content: question, solution and ephemeral assessment invoke the existing question/solve/
   teaching validators; pass, rejection and validator error all bind the exact final bytes. Source IDs alone
   never satisfy these semantic gates.
7. Presentation: malformed/dangling marker is stripped before seal; unvalidated read-bearing hero follows
   the existing drop policy; no marker survives persistence.
8. Cancellation/partial: stable sealed bytes may use existing partial UX; unsealed root output is never
   visible. Durable outcome-marker recovery reproduces the same sealed bytes without another paid root.
9. ToolOperations: `search_memory_facts` creates no `tool_operation`; old running rows are recovered/settled,
   cancellation still drains legacy durable work, and historical projection remains readable.
10. Native Task: foreground and Mission each return one native child result into their own live root, share
    deadline/cancellation, create no continuation; seeded legacy mailbox rows still drain exactly once.

Run scoped unit/DB tests for the files above, task census/prompt hashes, `pnpm typecheck`, `pnpm lint`, and
`pnpm build`; do not run local full `pnpm test`. Actual-provider acceptance must include plain, read,
proposal and learning-content turns and seal exact revision, input/output digest, root and validator
task-run IDs, provider/model, tokens and cost. Push only after independent review, then require exact-head
GitHub `CI Gate`. No token-reduction claim is valid until before/after actual-provider evidence compares
the same fixtures; expected call-count reduction is not measured token evidence.

## Rejected alternatives and non-goals

- SDK `outputFormat`: unavailable on the current default profile and not authoritative in the collecting
  stream; it would split behavior by provider.
- A post-root finalizer Task or fallback paid chain: retains the cost and duplicate ownership being removed.
- Reuse `writeCopilotReply` as the seam: persistence must consume an already sealed result and must not own
  model/tool semantics.
- Source pointers as a factuality verdict: provenance is necessary but does not prove entailment.
- Delete semantic learning validators: explicitly rejected; their content correctness property is distinct.
- Drop legacy tables/rows or deploy cleanup: destructive and not authorized.
- Generic agent framework, workflow DSL, new UI surface, provider/auth changes, or whole-project structure
  discussion: deferred until pipeline acceptance.
