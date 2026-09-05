# AI pipeline finalization and legacy convergence

**Decision:** root-terminal JSON, finalized once by the Copilot capability after the SDK query ends.
Delete the two post-root evidence-review TaskKinds and their runtime. Keep question/solve/teaching
semantic validators and deterministic proposal/correction gates. Foreground and explicit durable roots
use native depth-1 Task; old mailbox and ToolOperations work drains without deleting historical rows.

Grounded base: `090e882c`, ADR-0054 through ADR-0057. Owner delegates decisions for low token use,
modern architecture and advanced agents. No UI changes, production deployment, data deletion, generic
framework or whole-project re-layout.

## Cost-driven refinement

The first draft selected a same-query private `finalize_reply` MCP tool. It is superseded before merge:
the tool result normally requires another model turn and can replay the root context even for ordinary
no-tool replies. That conflicts with the low-token objective. There is no verified local SDK evidence
that `PostToolUse.continue:false` ends as a successful terminal result without another model call.

SDK `outputFormat` being unsupported on the current default profile does not prevent prompt-based JSON.
The repository already uses TaskSpec parsers for that pattern. A strict terminal envelope avoids the
extra model round and a second interactive state machine. Malformed output fails closed; there is no
automatic paid repair chain. This deliberately gives up in-query finalizer correction feedback.

Actual-provider refinement: the first new read terminal duplicated its correct reply as prose plus a
fenced JSON envelope. A narrow transport decoder may accept a sole JSON fence, or one suffix fence
only when the preceding prose exactly equals its decoded `reply_md` after outer trimming. Conflicting
preambles, multiple candidates and trailing text still fail closed. It never reconstructs an envelope
from raw prose or asks another model to repair formatting. Missing/unsealed durable terminal results
must project FAILED rather than DONE; a safe learning-validation fallback retains its separate policy.

The actual old read baseline (two synthetic nodes) recorded at least 57,817 input tokens and $0.201614
before an unmetered comparator timeout. This is a lower bound, not a before/after savings claim.

## Interface

The root emits only this JSON as its final assistant result:

```json
{"reply_md":"...","relied_on_tool_use_ids":["..."]}
```

`reply_md` is bounded to 64,000 characters. IDs are unique and bounded by the 60-call turn ceiling.
The model supplies no root ID, digest, verification status, proposal effect contract or cost identity.

`reply-finalization.ts` owns a small interface: trace hooks/DomainTool observations and one asynchronous
`finalizeTerminal` operation. It owns parsing, normalization, semantic gates, trace binding and the
immutable receipt. There is no private finalization MCP tool or generic runner product branch.

The generic collecting runner exposes neutral `terminalText` from the SDK successful result separately
from existing accumulated `text`/`onDelta` behavior. Copilot parses only terminal text, never a concatenation
of preambles, earlier assistant blocks or child prose. Non-streaming runTask already returns terminal text.

## Trace and finalization

- PreToolUse records the real SDK tool-use ID/ordinal. DomainTool settlement records exact executed
  input/output/error/effect; PostToolUse/PostToolUseFailure cover native Task and remote MCP settlement.
- The bridge correlates every Copilot DomainTool, not only safeHandoff, and exposes optional `tool_use_id`
  in observations and result envelopes. Native/remote post-hook context exposes their exact IDs.
- Bound the trace and hash large data; do not recreate dense source ledgers, request units or JSON pointers.
- After the query settles, reject missing/malformed terminal JSON, duplicate/foreign/failed/in-flight
  citations, incomplete trace, incorrect root identity or changed trace during finalization.
- Parse presentation metadata, apply correction against server-owned prior-turn IDs, compose authoritative
  proposal disclosure, and run existing learning-content checks on the exact visible text/HTML.
- Keep the existing conservative proposal-only normalization. For mixed prose, canonical disclosure is
  authority for effects but does not prove the semantic truth of arbitrary model sentences.
- Only the resulting prepared reply reaches writeCopilotReply. Hash exact UTF-8 candidate/final bytes;
  use canonical JSON hashing only for structured trace. No post-check normalization or raw trailing prose.
- Missing terminal/malformed output returns fixed server-authored failure content, including proposal
  disclosure if effects already occurred. Unsealed partial drafts are never persisted or streamed.
- Streaming emits the final persisted reply only. Durable recovery reuses the exact outcome marker;
  it does not mint a replacement paid root to reconstruct already committed output.

Receipt in `experimental:copilot_reply.payload.reply_finalization`: protocol version, assurance
`root_attested_structural`, server root task ID, candidate/reply/trace hashes, trace call count,
relied-on IDs, correction result, server proposal disclosure status, learning-content result and
presentation disposition. Historical `evidence_validation` payloads remain readable; new replies never
claim independent FULL semantic review.

## Assurance

Structural confirmation covers current-root provenance, bounded complete trace, exact final bytes,
deterministic correction/proposal contracts and no unvalidated presentation channel. It does NOT prove
factual entailment or request coverage in ordinary read replies. Dedicated generated question, solution
and teaching validators retain their semantic role; source IDs never replace them.

Validation after the root terminal must still inherit parent audit identity, cancellation and the
original absolute provider deadline. Release the root query lease before nested semantic calls so
the finalizer does not deadlock provider admission while waiting for its own child validation.

## Implementation and retirement

- Wire both `server/chat.ts` and `jobs/copilot_run.ts` to the same finalizer. Their root lifecycle and
  foreground SDK resume versus explicit durable worker remain separate.
- Delete CopilotEvidenceReviewTask/VerificationTask, evidence-review/submission/contract/checkpoint
  runtime and obsolete tests. Retain generic sealed-validation because other capabilities consume it.
- Move the realistic A01/A03/A04/C01/C04 actual trace corpus to finalization fixtures and use it in
  interface tests. Unique complex data is not obsolete merely because the old reviewer is removed.
- Keep old checkpoint/task rows, schema and migrations. No historical data is deleted.
- New search_memory_facts directly blocks under root cancellation/deadline; no new ToolOperations.
- All seven legacy operation/subagent controls are removed from manifest and actual MCP inventories,
  not merely from auto-approval lists. SDK bypassPermissions can skip canUseTool; PreToolUse/callback
  guards and actual tool availability are authoritative.
- Native children remain read-only, depth 1, background false, and return into their own live/Mission
  parent. They produce audit/replay subagent rows but never a mailbox continuation.
- Preserve legacy queue/reconcile/continuation consumers for pending work. Removing them requires
  deployed zero-nonterminal rows AND zero queued/active jobs through the maximum deadline/retry window.
  The production-observation/retention gate is separate from local refactor delivery.

## Acceptance

Interface scenarios cover plain/read/correction/proposal/learning/presentation, exact byte receipts,
malformed/partial/foreign IDs, concurrent or incomplete trace, preserved complex fixtures, and no raw
candidate leakage. Runner tests prove terminalText versus preamble/delta separation without changing
other callers. Live and durable tests prove one root, native child returns, cancellation/settlement,
legacy drain and no new old-control producers.

Run scoped unit/DB, typecheck/lint/audits/build, independent review and exact-head CI. Real-provider
acceptance records exact revision, input/output hashes, task-run IDs, provider/model, usage and cost.
Compare identical read fixtures; distinguish reported totals from lower bounds. Stop paid calls on
unknown costs. No claims that mock tests prove model output quality, or that handler tests prove queue E2E.
