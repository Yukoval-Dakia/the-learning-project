# ADR-0057 — Capability-owned live Copilot turn context

**Status:** Accepted
**Decision source:** owner 2026-09-05 delegated architecture decisions for low token use, modern structure, and advanced agent capability; YUK-939
**Related:** ADR-0051 · ADR-0054 · ADR-0055 · ADR-0056

## Context

Agent SDK session resume removed the need to resend the bounded conversation fold on every foreground
turn, but the initial implementation coupled two different concerns. It skipped the product turn
projection when it skipped model history, so a resumed turn also lost correction IDs, focused entity,
chip semantics, learner state, and proposal feedback. The separate `CopilotCorrectionIntentTask` then
spent another model attempt to reconstruct intent that is safe to resolve deterministically for explicit
IDs and relative references.

The generic runner serializes ordinary task input. Teaching it the shape of `CopilotRunInput` would move
product semantics into the central model-attempt runtime and make every future live-agent feature another
runner branch.

## Decision

There are three execution forms:

- `ModelTask` is one bounded model attempt owned by a capability TaskSpec. The central runtime owns only
  provider/model resolution, admission, budget, retry, cancellation, SDK terminal adaptation, cost, and
  attempt audit.
- `LiveCopilotSession` is the foreground conversational agent. The Copilot capability owns product turn
  projection, prompt compilation, Agent SDK resume, native Task children, correction binding, tools,
  reply validation, and persistence.
- `MissionRun` is an explicitly durable worker execution. It keeps a bounded structured history envelope,
  durable fences, and job-event delivery. It does not resume a foreground SDK session.

These forms remain distinct. This decision does not introduce microservices, a workflow DSL, a dynamic
plugin system, or a generic agent framework.

### Foreground prompt compilation

Copilot owns a private model-input codec. Cold, restart, and durable execution send the bounded structured
history envelope. A resume hit never resends conversation history. If no fact exists outside the SDK
transcript, the provider receives the exact plaintext user message. Otherwise it receives a compact,
deterministically ordered `TurnContext` sidecar followed by that unchanged plaintext.

The sidecar may carry only current facts the transcript cannot know: learner snapshot bytes, current
proposal feedback, ambient/focused entity, chip surface semantics, and the bound `correction_contract`. The
generic runner accepts an opaque compiled prompt and never reads Copilot fields. Product-input hashing
continues to audit the typed product input independently from provider prompt bytes.

A process-local tracker binds the deterministic digest of learner snapshot plus proposal feedback to the
Agent SDK session ID. Unchanged session context is omitted on later resumes; a changed digest is delivered
once. Ambient, chip, and correction facts remain per-turn. Delivery is recorded only after the SDK query
and SDK-session persistence both succeed. Clearing or replacing the SDK session clears its tracked digest.
This state needs no database schema because SDK session files are process-local by the same boundary.

### Correction resolution

The product turn projection is loaded even when its prose is not sent to the model. It supplies bounded
reply IDs and summaries for correction binding. Explicit `correction_target_turn_id`, an exact ID in the
message, and unambiguous relative phrases bind deterministically. A narrow prior-answer cue that can name
multiple replies produces deterministic clarification. Generic edits such as changing a learning plan or
knowledge node remain ordinary turns.

`CopilotCorrectionIntentTask` is deleted from the owner map, catalog, prompt census, and tests. There is no
compatibility placeholder and no classifier-only model attempt. A deterministic clarification may still
run the normal `CopilotTask` attempt so reply persistence retains a real model-attempt audit identity; its
candidate prose is ignored and the deterministic clarification is persisted.

### Resume failure boundary

The current Agent SDK wrapper does not expose reliable proof that a resume failure occurred before any
tool or product effect. Arbitrary error-string matching cannot distinguish an invalid session file from a
failure after execution began. This slice therefore clears the stored SDK session ID and fails the request,
as before. Same-request cold fallback remains gated on typed pre-effect evidence from the SDK wrapper.

## Consequences

- Plain resumed turns stop paying for the repeated bounded history JSON.
- Current page, chip, learner, proposal, and correction facts remain available without transcript replay.
- Correction intent no longer consumes a separate provider admission or task-run row.
- Native SDK Task research, propose-only mutation safety, evidence review, provider admission/cost/audit,
  durable Mission behavior, and the single public Copilot voice remain unchanged.
- A future route shell may become thinner, but this slice does not add another public abstraction or move
  execution-form details into route callers.

## Rejected alternatives

- Inspect `CopilotRunInput` in the generic runner. This violates capability ownership and makes the central
  runtime a product orchestrator.
- Resume plus bounded history. This double-stuffs the transcript and defeats the token objective.
- Skip product turn projection on resume. Model history suppression must not erase server-side correction
  identity or current-turn facts.
- Retry cold after matching arbitrary SDK error strings. It can duplicate tools or effects after an
  ambiguous partial execution.
