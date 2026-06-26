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

// NON-strict, intentionally (A8 — original brief's REVERT path). This is a W1-LIVE schema with
// live-row `.parse()` callers: the proposals.db.test `liveSnapshot` helper and the projection
// parity sites parse a FULL `knowledge` DB row, which carries the DERIVED embed_* columns
// (embedding / embed_model / embed_version / embed_content_hash). Non-strict STRIPS those extras
// down to the structural subset; `.strict()` would instead throw `unrecognized_keys` and break
// those callers (proposals.db.test.ts fails). The genesis per-kind safeParse dispatch stays safe
// today WITHOUT strict here because the three entity field sets are disjoint — a wrong-entity row
// fails on missing required fields (a knowledge row lacks goal's scope_knowledge_ids / a goal row
// lacks `name`), and the B3 discriminating-column assertion is the real wrong-entity guard. Only
// add `.strict()` to a knowledge schema if a future higher-overlap sibling makes silent-stripping
// unsafe AND the live-row callers are first migrated to omit the derived columns.
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

// NON-strict, intentionally (A8 REVERT — same rationale as KnowledgeRowSnapshot): a W1-LIVE schema
// whose live-row `.parse()` callers must STRIP, not reject, columns absent from this structural
// subset. The disjoint-field-set + B3 discriminating-column dispatch is the wrong-entity guard.
export const KnowledgeEdgeRowSnapshot = z.object({
  id: z.string().min(1),
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: z.string(), // 5 core enum | experimental:* — Zod-validated upstream at propose time
  weight: z.number().finite(), // real, default 1 — reject NaN/Infinity (genesis is ground truth)
  created_by: z.record(z.string(), z.unknown()), // AgentRef jsonb (opaque provenance)
  reasoning: z.string().nullable(), // nullable column
  created_at: z.coerce.date(),
  archived_at: z.coerce.date().nullable(), // nullable timestamp
});
export type KnowledgeEdgeRowSnapshotT = z.infer<typeof KnowledgeEdgeRowSnapshot>;

// ---------- GoalRowSnapshot (YUK-471 Wave 2 — goal entity fold) ----------
//
// The projected (fold) shape of a `goal` row (src/db/schema.ts:1177-1206). goal has NO
// derived maintenance columns (no embed_*), so EVERY column is structural fold truth — the
// full row IS the snapshot (design §1①). `version` is carried verbatim (mirrors
// KnowledgeRowSnapshot); the goal reducer's per-event version behavior MIRRORS the historical
// imperative writes EXACTLY (insertGoal → 0, accept → no bump, retract → no bump, the
// status/scope updates → +1). See src/core/projections/goal.ts for the per-site rationale.
//
// `.strict()` (critic B3): GoalRowSnapshot and the future LearningItemRowSnapshot share many
// columns (id/title/status/source/source_ref/created_at/updated_at/version). A non-strict Zod
// object strips unknown keys, so `GoalRowSnapshot.safeParse(learningItemRow)` could FALSE-PASS
// at the genesis parse barrier. `.strict()` rejects unknown keys so a wrong-entity row can
// never seed a goal genesis. Dates are z.coerce.date() (jsonb ISO-string roundtrip — same
// precedent as KnowledgeRowSnapshot).
export const GoalRowSnapshot = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subject_id: z.string().nullable(), // nullable column (cross-subject goals)
    scope_knowledge_ids: z.array(z.string()), // jsonb string[], default [] at the table
    sequence_hint: z.number().int(), // AI-internal ordering, NOT progress (ND-4)
    status: z.enum(['active', 'dormant', 'done']),
    source: z.string(), // provenance, set-once
    source_ref: z.string().nullable(), // nullable column (the propose event id)
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    version: z.number().int(),
  })
  .strict();
export type GoalRowSnapshotT = z.infer<typeof GoalRowSnapshot>;

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
// is the snapshot, a PLAIN `z.union` of the row shapes (NOT a discriminated
// union — the row shapes share no literal discriminant). The subject_kind ↔
// row-shape coherence is enforced POST-PARSE by the superRefine cross-check
// below, so a wrong snapshot shape under a given subject_kind still fails at the
// schema boundary.
//
// PER-KIND DISPATCH (YUK-471 Wave 2, critic B3 — REFACTOR from field-sniffing):
// W1 had only two members and distinguished the edge by `'from_knowledge_id' in row`
// (field-sniffing). Wave 2 grows the union (goal joins, mistake_variant + learning_item
// follow) with HIGH field overlap (goal + the future learning_item both have
// id/title/status/source/source_ref/created_at/updated_at/version). Field-sniffing cannot
// safely tell them apart, so the superRefine now does an EXPLICIT per-subject_kind
// `SpecificSnapshot.safeParse(row)`. GoalRowSnapshot is `.strict()` (new entity, no live-row
// `.parse()` caller passing extra columns); KnowledgeRowSnapshot / KnowledgeEdgeRowSnapshot are
// intentionally NON-strict (W1-LIVE schemas whose live-row callers strip derived embed_* columns —
// see their docblocks). The dispatch stays safe because the three entity field sets are DISJOINT
// (a wrong-entity row fails on a missing required field), reinforced by the
// discriminating-column assertion below (a goal row MUST carry the goal-specific
// `scope_knowledge_ids` + `sequence_hint` columns) so a sibling-entity row that happens to be
// shape-compatible can never false-pass. subject_id === row.id is preserved. The
// `SNAPSHOT_BY_SUBJECT_KIND` map + `DISCRIMINATING_COLUMNS` are the shared extension point:
// mistake_variant + learning_item lanes add their entry here.

// Per-subject_kind canonical snapshot schema. The superRefine safeParses payload.row against
// the schema for the declared subject_kind — a mismatch (wrong shape under a subject_kind, or
// an unknown key a .strict() schema rejects) fails the parse barrier.
const SNAPSHOT_BY_SUBJECT_KIND = {
  knowledge: KnowledgeRowSnapshot,
  knowledge_edge: KnowledgeEdgeRowSnapshot,
  goal: GoalRowSnapshot,
} as const;

// Columns that MUST be present on a row to discriminate it as the named entity, even after a
// shape-compatible safeParse. A sibling row could be GoalRowSnapshot-compatible after
// `.strict()` only if it carried EXACTLY goal's columns — these are the goal-only columns, so
// requiring them closes any residual overlap window (critic B3).
const DISCRIMINATING_COLUMNS: Record<string, readonly string[]> = {
  goal: ['scope_knowledge_ids', 'sequence_hint'],
};

export const GenesisExperimental = z
  .object({
    actor_kind: z.literal('system'), // backfill is an internal seed writer
    actor_ref: z.string().min(1), // e.g. 'genesis-backfill'
    action: z.literal('experimental:genesis'),
    subject_kind: z.enum(['knowledge', 'knowledge_edge', 'goal']),
    subject_id: z.string().min(1), // = the projected row id
    outcome: z.literal('success').nullable().optional(),
    payload: z.object({
      // PLAIN union of the row shapes (NOT discriminated — they share no literal
      // discriminant). The cross-check (payload.row shape matches subject_kind via
      // per-kind safeParse, and subject_id === row.id) is enforced post-parse by the
      // superRefine below so fold(genesis) == row holds.
      row: z.union([KnowledgeRowSnapshot, KnowledgeEdgeRowSnapshot, GoalRowSnapshot]),
    }),
    // baseOptionalFields parity (mirror the other reserved schemas):
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // The payload.row was parsed by the union, so `data.payload.row` is one of the snapshot
    // shapes — but the union does NOT enforce it matches `subject_kind`. Re-validate the row
    // against the schema for the DECLARED subject_kind (per-kind safeParse, critic B3) so a
    // subject_kind/row mismatch is rejected at the schema boundary.
    const row = data.payload.row as Record<string, unknown>;
    const schema = SNAPSHOT_BY_SUBJECT_KIND[data.subject_kind];
    const reparsed = schema.safeParse(row);
    if (!reparsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payload.row must be a ${data.subject_kind} row when subject_kind='${data.subject_kind}'`,
        path: ['payload', 'row'],
      });
    }
    // Discriminating-column assertion: even a shape-compatible row must carry the entity's
    // distinguishing columns so a sibling entity cannot false-pass.
    for (const col of DISCRIMINATING_COLUMNS[data.subject_kind] ?? []) {
      if (!(col in row)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `payload.row for subject_kind='${data.subject_kind}' must carry the discriminating column '${col}'`,
          path: ['payload', 'row', col],
        });
      }
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
