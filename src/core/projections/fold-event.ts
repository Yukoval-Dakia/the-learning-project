// FoldEvent — the flat `event`-row projection both W1 fold reducers consume.
//
// This is a STRUCTURAL view of exactly the `event` table columns the W1 structural
// folds (foldKnowledgeNode / foldKnowledgeEdge) read off each row. It is NOT the
// parsed Event union (EventT in ../schema/event/index.ts) — that discriminated
// union has no single common object shape (the generic ExperimentalEvent member
// drops subject_kind / actor_kind), and it omits the DB-only envelope columns
// `id` / `created_at` (pg columns on `event`, src/db/schema.ts:698-737, not Zod
// fields). The parsed Event is RECONSTRUCTED per-branch inside each reducer via
// safeParse, mirroring corrections.ts rowToCorrectEventInput
// (src/server/events/corrections.ts:19-32): the reducer builds the parse input
// from these flat columns and feeds the dedicated Zod schema for the branch it is
// handling, so a malformed payload is rejected at the reducer boundary instead of
// being trusted.
//
// PR-A2's IO shell maps each DB `event` row into ONE FoldEvent before calling
// either reducer, so the two folds consume the SAME shape (no divergent envelope
// between the node and edge reducers). The pure callers (the reducer tests)
// construct it explicitly.
//
// Columns carried (and why each fold needs them):
//   - id / created_at — event ordering & row timestamps. `id` is the (created_at,
//     id) tiebreak and matches a RATE's caused_by_event_id back to its propose
//     event (accept linkage); `created_at` orders events and stamps row timestamps.
//   - subject_kind / subject_id / action — routing (which reducer branch + which
//     row a create/mutate keys on).
//   - caused_by_event_id — the accept-linkage column (a RATE event names the
//     propose event it accepts here).
//   - actor_kind / actor_ref — typed re-parse input + edge `created_by`
//     reconstruction (opaque provenance; the folds never discriminate on them).
//   - outcome — part of the typed re-parse input (several schemas pin it).
//   - payload — the branch-specific jsonb; each reducer narrows it per branch.
export interface FoldEvent {
  id: string;
  created_at: Date;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  caused_by_event_id: string | null;
  payload: Record<string, unknown>;
}
