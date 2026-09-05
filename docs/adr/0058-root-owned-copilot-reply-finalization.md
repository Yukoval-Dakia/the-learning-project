# ADR-0058: Root-owned Copilot reply finalization

**Status:** Accepted
**Date:** 2026-09-05
**Context:** `docs/planning/2026-09-05-pipeline-finalization-design.md`
**Related:** ADR-0054 · ADR-0056 · ADR-0057

## Context

The former blind-reference/comparator chain duplicated reply ownership, model calls and evidence
ledgers. A private finalizer tool would add a round trip. A strict terminal JSON replacement failed
two actual-provider reads on formatting despite correct content; narrow wrapper decoding was insufficient.

## Decision

The root produces terminal Markdown. The generic collecting runner exposes exact SDK success
`result` as neutral `terminalText`; the Copilot capability finalizes it once after the query ends.
No model-authored envelope, private MCP finalizer, paid repair or parallel fallback protocol.

The server owns the root ID, successful `observed_completed_tool_use_ids`, bounded complete trace,
exact UTF-8 candidate/final hashes, correction binding, proposal disclosure, presentation policy and
existing question/solve/teaching semantic validators. Only finalized persisted bytes reach the client.
Missing/invalid terminal or unfinished/late trace fails closed; durable structural failures project FAILED.

Receipt assurance `execution_trace_bound` proves execution provenance, not factual entailment or which
facts the model relied on. Failed tools remain visible in trace/disclosure, not successful observed IDs.

Delete the two Copilot evidence-review TaskKinds and their ledger/checkpoint runtime and obsolete
tests. Preserve realistic fixtures, generic sealed validation for other consumers, historical database
rows/schema/readers and pending queue recovery. No deployment or production data deletion.

## Consequences

One root remains the sole reply author. No format-only paid retry and no repeated reviewer context.
Semantic learning gates and deterministic effect contracts still bind final bytes. Normalized replies
invalidate the SDK cursor for next-turn cold recovery. Actual synthetic measurements establish only
sample-specific savings, not production-wide quality or cost claims.
