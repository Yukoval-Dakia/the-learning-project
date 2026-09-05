# ADR-0058 — Root-owned Copilot reply finalization

**Status:** Accepted
**Decision source:** YUK-939; `docs/planning/2026-09-05-pipeline-finalization-design.md`
**Related:** ADR-0054 · ADR-0056 · ADR-0057

## Context

Copilot read-bearing replies previously left the root query for a blind reference task and two
comparison passes. That path duplicated reply ownership, spent multiple provider calls, and persisted a
dense evidence ledger. Plain replies had no equivalent typed terminal contract.

## Decision

Foreground and explicit durable Copilot roots end with one strict JSON envelope containing only final
Markdown and the successful current-root tool-use IDs relied on. The collecting runner exposes the
exact SDK success `result` as neutral `terminalText`; only the Copilot capability parses it. The server owns root identity, exact UTF-8 candidate/reply
digests, bounded trace digest, correction binding, canonical proposal disclosure, presentation policy,
and the existing question/solve/teaching validators. Only a stable sealed result may be persisted or
published; assistant preambles, malformed JSON, raw and trailing SDK prose fail closed. Missing,
foreign, failed, in-flight, or validation-time-mutated trace state also fails closed. The transport
decoder tolerates only a sole JSON fence or one suffix fence with an exactly matching duplicated
`reply_md` preamble; ambiguous/conflicting wrappers remain invalid. Invalid durable finalization
projects FAILED, never a successful DONE marker.

A private finalizer MCP was rejected because its tool result normally requires another model round trip
with the full context on every plain turn. Post-terminal service finalization performs no repair call and
keeps the root model as the sole author.

The receipt assurance is `root_attested_structural`. Tool-use IDs prove provenance, not factual
entailment. Ordinary read interpretation is no longer called independently FULL-verified. The two
Copilot evidence-review TaskKinds and active ledger/checkpoint runtime are deleted; historical database
schema and rows stay readable. Generic `sealed-validation.ts` remains for other consumers.

## Consequences

- One Copilot root owns generation and finalization without a paid fallback reviewer chain.
- Proposal/correction/presentation contracts and semantic learning-content gates bind the exact final
  bytes.
- A 60-call trace ceiling remains without request units, JSON pointers, source catalogs, or dense
  ledgers.
- Production token reduction remains unclaimed until same-fixture actual-provider evidence is captured.
