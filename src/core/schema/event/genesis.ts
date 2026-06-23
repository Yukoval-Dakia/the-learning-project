import { z } from 'zod';

// ====================================================================
// GenesisExperimental — pre-W1 row backfill seed (YUK-471 Wave 1, Codex #4)
// ====================================================================
//
// The first structural fold (PR-A1) projects `knowledge` / `knowledge_edge`
// rows from the event log. But every row that EXISTS before Wave 1 has no
// originating event — the fold would project an empty world. PR-A2's genesis
// backfill closes this gap by writing ONE system event per pre-W1 row whose
// payload is a full snapshot of that row, so `fold(genesis) == row` byte for
// byte. The node/edge reducers treat `experimental:genesis` as the seed action
// that establishes a row's initial projected state.
//
// HARD REQ 1 (mirror StateSnapshotExperimental, ./state-snapshot.ts §HARD REQ 1):
// this dedicated Zod schema is validated by writeEvent's parseEvent barrier. A
// malformed seed would silently corrupt the WHOLE projection (the fold trusts
// genesis as ground truth), so the generic ExperimentalEvent fallback REJECTS
// the reserved `experimental:genesis` action (see RESERVED_EXPERIMENTAL_ACTIONS
// in ./experimental.ts) — a malformed seed payload can never lose schema
// validation by falling through to the loose generic record.
//
// actor_kind pinned to `'system'` (mirror state-snapshot §6.3): the genesis
// seed is a system-emitted backfill row, not an agent or user action.

// ---------- KnowledgeRowSnapshot ----------
//
// The projected (fold) shape of a `knowledge` row. EXCLUDES embed_* columns
// (embedding / embed_model / embed_version / embed_content_hash) — those are
// DERIVED maintenance state (nightly embed_backfill / reparent recompute), NOT
// structural truth the fold reproduces. Every field below mirrors the column
// shape at src/db/schema.ts:54-103 (the structural subset).
//
// Dates are z.coerce.date() because the seed payload roundtrips through jsonb
// (ISO string on the way out, Date on the way back) — same precedent as
// FsrsStateSchema in ./blocks.ts:68. This schema is EXPORTED so the W1 node
// reducer imports it as the canonical projected-knowledge-row contract: genesis
// and the reducer share ONE row shape (no drift between seed and fold output).

export const KnowledgeRowSnapshot = z.object({
  id: z.string().min(1),
  name: z.string(),
  domain: z.string().nullable(), // nullable column
  parent_id: z.string().nullable(), // nullable column
  merged_from: z.array(z.string()), // jsonb string[], default [] at the table
  archived_at: z.coerce.date().nullable(), // nullable timestamp
  proposed_by_ai: z.boolean(),
  approval_status: z.enum(['pending', 'approved', 'rejected']),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  version: z.number().int(),
});
export type KnowledgeRowSnapshotT = z.infer<typeof KnowledgeRowSnapshot>;

// ---------- KnowledgeEdgeRowSnapshot ----------
//
// The projected (fold) shape of a `knowledge_edge` row (src/db/schema.ts:1052-1081).
// NO `version` column on this table (unlike `knowledge`). `created_by` is the
// AgentRef jsonb — kept loose here (z.record) so the seed never re-validates the
// envelope the row already persisted; the reducer treats it as opaque provenance.
// EXPORTED for the W1 edge reducer (same single-row-contract rationale as above).

export const KnowledgeEdgeRowSnapshot = z.object({
  id: z.string().min(1),
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: z.string(), // 5 core enum | experimental:* — Zod-validated upstream at propose time
  weight: z.number(), // real, default 1
  created_by: z.record(z.string(), z.unknown()), // AgentRef jsonb (opaque provenance)
  reasoning: z.string().nullable(), // nullable column
  created_at: z.coerce.date(),
  archived_at: z.coerce.date().nullable(), // nullable timestamp
});
export type KnowledgeEdgeRowSnapshotT = z.infer<typeof KnowledgeEdgeRowSnapshot>;

// ---------- GenesisExperimental ----------
//
// Field-level parity with the existing reserved experimental schemas
// (UserCauseExperimental / RecordCaptureExperimental / MemoryBriefRefreshExperimental /
// StateSnapshotExperimental): actor_kind literal, action literal, subject literals,
// optional base fields. This parity is what lets parseEvent route to this branch
// deterministically and reject malformed payloads instead of falling through to
// the loose generic.
//
// `subject_kind` is the row's table; `subject_id` is the row id. `payload.row`
// is the snapshot, a DISCRIMINATED union keyed by subject_kind so the wrong
// snapshot shape under a given subject_kind is rejected at the schema boundary
// (a `knowledge` subject carrying an edge-shaped row fails to parse).

export const GenesisExperimental = z
  .object({
    actor_kind: z.literal('system'), // backfill is an internal seed writer
    actor_ref: z.string().min(1), // e.g. 'genesis-backfill'
    action: z.literal('experimental:genesis'),
    subject_kind: z.enum(['knowledge', 'knowledge_edge']),
    subject_id: z.string().min(1), // = the projected row id
    outcome: z.literal('success').nullable().optional(),
    payload: z.object({
      // Discriminated snapshot: the row shape must match subject_kind. The cross
      // check (payload.row matches subject_kind, and subject_id === row.id) is
      // enforced in the superRefine below so fold(genesis) == row holds.
      row: z.union([KnowledgeRowSnapshot, KnowledgeEdgeRowSnapshot]),
    }),
    // baseOptionalFields parity (mirror the other reserved schemas):
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // subject_kind <-> row-shape coherence + subject_id <-> row.id coherence.
    // KnowledgeEdgeRowSnapshot is distinguishable by `from_knowledge_id`
    // (knowledge rows have no such field). This keeps the genesis seed honest:
    // the subject_kind cannot disagree with the snapshot it carries, and the
    // event's subject_id must name the same row the snapshot reproduces.
    const row = data.payload.row;
    const isEdgeRow = 'from_knowledge_id' in row;
    if (data.subject_kind === 'knowledge' && isEdgeRow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payload.row must be a knowledge row when subject_kind='knowledge'",
        path: ['payload', 'row'],
      });
    }
    if (data.subject_kind === 'knowledge_edge' && !isEdgeRow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payload.row must be a knowledge_edge row when subject_kind='knowledge_edge'",
        path: ['payload', 'row'],
      });
    }
    if (data.subject_id !== row.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subject_id must equal payload.row.id (fold seeds the row by its own id)',
        path: ['subject_id'],
      });
    }
  });
export type GenesisExperimentalT = z.infer<typeof GenesisExperimental>;
