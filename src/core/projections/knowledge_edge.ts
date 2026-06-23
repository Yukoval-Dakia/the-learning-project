// YUK-471 Wave 1 PR-A1 — knowledge_edge fold reducer (PURE, behavior-preserving).
//
// This is the EASY half of the first structural fold (PR-A1): a pure reducer that
// projects a `knowledge_edge` row from the event log. It is NOT YET WIRED into any
// runtime path — no double-write, no SoT flip (those land in PR-A2/PR-B). PR-A2's
// IO shell will: read events for (subject_kind='knowledge_edge', subject_id=edgeId),
// wrap each DB row as a FoldEvent, read the live-edge set for topology, and call
// this reducer.
//
// PURE contract: no IO / no DB / no newId / no Date. The `created_at`/`id` row
// metadata and the live topology mesh are PASSED IN. Event ordering is handled
// internally (see byCreatedThenId) so the caller does not have to pre-sort.
//
// The projected-row shape is imported from genesis.ts (ONE shared contract — the
// seed and the fold output cannot drift). KnowledgeEdgeRowSnapshot has NO `version`
// column (unlike knowledge); edges have no embed_* columns.

import { checkEdgeTopology } from '@/capabilities/knowledge/server/topology-gate';
import {
  GenesisExperimental,
  KnowledgeEdgeRowSnapshot,
  type KnowledgeEdgeRowSnapshotT,
} from '@/core/schema/event/genesis';
import { z } from 'zod';
import type { FoldEvent } from './fold-event';

// ---------- FoldEvent ----------
//
// The reducer consumes the flat `event`-row projection from ./fold-event (the SAME
// shape the node reducer consumes and PR-A2's IO shell builds — ONE shared envelope,
// no divergence between the two folds). The parsed Event-union member is
// reconstructed per-branch via safeParse (toParseInput), mirroring corrections.ts
// rowToCorrectEventInput, rather than trusting an unvalidated payload.

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns
// (mirrors the node reducer's helper + corrections.ts rowToCorrectEventInput) so the
// genesis branch can feed the dedicated GenesisExperimental schema (which enforces
// the subject_kind<->row-shape + subject_id<->row.id superRefine coherence).
function toParseInput(fe: FoldEvent): unknown {
  return {
    actor_kind: fe.actor_kind,
    actor_ref: fe.actor_ref,
    action: fe.action,
    subject_kind: fe.subject_kind,
    subject_id: fe.subject_id,
    outcome: fe.outcome,
    payload: fe.payload,
    caused_by_event_id: fe.caused_by_event_id ?? undefined,
  };
}

// Stable (created_at asc, id asc) comparator — the canonical event read order
// (identical tiebreak to the node reducer + corrections.ts). The reducer sorts
// internally so a caller that forgets to pre-sort still gets a correct projection.
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------- generate-edge payload schema ----------
//
// The `generate`(knowledge_edge) event payload (actions.ts:509-516). Validated via
// safeParse at the reducer boundary (consistency with the genesis branch + the node
// reducer's per-branch safeParse) so a malformed payload is rejected rather than
// silently producing an invalid row. All fields optional here; the create/archive
// branches assert the ones THEY require (a create with a missing endpoint is skipped,
// never projected with an empty-string field — an empty relation_type would also
// make a malformed prerequisite edge silently bypass the topology gate).
const GenerateEdgePayload = z.object({
  edge_op: z.enum(['create', 'archive']).optional(),
  from_knowledge_id: z.string().min(1).optional(),
  to_knowledge_id: z.string().min(1).optional(),
  relation_type: z.string().min(1).optional(),
  weight: z.number().finite().optional(),
  reasoning: z.string().nullable().optional(),
  propose_event_id: z.string().optional(),
  archive_edge_id: z.string().optional(),
});
type GenerateEdgePayloadT = z.infer<typeof GenerateEdgePayload>;

const ARCHIVE_EDGE_OP = 'archive';

// ---------- ADR-0034 topology at fold-apply ----------
//
// ADR-0034 §2 — the write-time structural consistency gate (TOPOLOGY layer) is reused
// VERBATIM here (checkEdgeTopology is a pure fn). The fold applies it when a
// `generate`(create) event ADDS a LIVE prerequisite edge — the forward write path —
// to catch a cycle / direction contradiction. This is STRUCTURAL only — NO LLM, NO
// reconcile ring (reconcile lands at the live write chokepoint in PR-A2 per owner
// fork (c); it is NOT a fold-apply concern, fold must stay deterministic).
//
// genesis seeds are TRUSTED ground truth and are NOT re-gated: a genesis backfill
// reproduces an EXISTING already-live row (it passed whatever gate applied when it
// was created); re-running topology during replay could reject a historically-valid
// row and break the fold(genesis)==row invariant. So topology runs on `generate`
// creates ONLY, never on genesis seeds or archive events.
//
// Verdict contract (src/capabilities/knowledge/server/topology-gate.ts:45-48):
//   | { status: 'ok' } | { status: 'reject'; gate; reason } | { status: 'warn'; gate; reason }
//   - 'reject' (cycle / direction_contradiction) → THROW (caller tx aborts).
//   - 'warn' (transitive_redundancy) → proceed (row has no verdict column to stamp).
//   - non-prerequisite → checkEdgeTopology returns ok; we skip the call entirely.

/**
 * Project a single `knowledge_edge` row from its event log.
 *
 * @param edgeId   The edge id to project (subject_id filter).
 * @param events   The edge's candidate events. Sorted INTERNALLY by (created_at asc,
 *                 id asc); caller order is not load-bearing. Events whose subject_id
 *                 !== edgeId are skipped.
 * @param liveMesh The set of currently-LIVE edges (archived_at IS NULL) to check
 *                 topology against when a create adds a LIVE prerequisite edge.
 *                 Supplied by the IO shell; kept pure.
 * @returns the projected row, or null if the edge has no matching (well-formed) events.
 * @throws when a create event adds a LIVE prerequisite edge that closes a cycle or
 *         reverses an existing prerequisite (ADR-0034 reject verdict).
 */
export function foldKnowledgeEdge(
  edgeId: string,
  events: FoldEvent[],
  liveMesh: KnowledgeEdgeRowSnapshotT[],
): KnowledgeEdgeRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: KnowledgeEdgeRowSnapshotT | null = null;

  for (const ev of ordered) {
    // Subject filter — only fold events keyed to THIS edge.
    if (ev.subject_id !== edgeId) continue;

    // genesis seed — TRUSTED ground truth. Validate the WHOLE event through
    // GenesisExperimental (enforces subject_kind<->row-shape + subject_id<->row.id
    // superRefine, matching the node reducer) so a seed whose id disagrees with the
    // envelope, or whose row is the wrong shape, is rejected — not blindly cast.
    if (ev.action === 'experimental:genesis' && ev.subject_kind === 'knowledge_edge') {
      const g = GenesisExperimental.safeParse(toParseInput(ev));
      if (!g.success) {
        warnMalformed('experimental:genesis', ev.id, g.error);
        continue;
      }
      // Narrow the union row to the edge shape (subject_kind==='knowledge_edge' means
      // superRefine already guaranteed it; this parse is the type-level narrowing).
      const seed = KnowledgeEdgeRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', ev.id, seed.error);
        continue;
      }
      row = seed.data;
      continue;
    }

    if (ev.action === 'generate' && ev.subject_kind === 'knowledge_edge') {
      const p = GenerateEdgePayload.safeParse(ev.payload);
      if (!p.success) {
        warnMalformed('generate', ev.id, p.error);
        continue;
      }
      const payload = p.data;

      // ARCHIVE signal — generate event with payload.edge_op === 'archive'.
      if (payload.edge_op === ARCHIVE_EDGE_OP) {
        if (row !== null) {
          // Stamp archived_at from the archive event's own created_at (mirrors
          // archiveKnowledgeEdge's `new Date()` written in the same tx). Preserves
          // the existing row's weight/reasoning/created_by.
          row = { ...row, archived_at: ev.created_at };
          continue;
        }
        // Archive on an edge with no preceding create/seed in this slice (edge
        // predates W1 and its genesis seed wasn't included). Defensive best-effort:
        // PR-A2's IO shell is expected to always include the genesis seed, so this
        // path should not trigger in practice. Require the structural fields — never
        // project an empty-string row.
        if (!payload.from_knowledge_id || !payload.to_knowledge_id || !payload.relation_type) {
          warnMalformed('generate(archive)', ev.id, 'missing required edge fields, no prior row');
          continue;
        }
        row = archiveRowFromArchiveEvent(edgeId, ev, payload);
        continue;
      }

      // CREATE — require the structural fields. Skip (do not project '') if absent:
      // an empty relation_type would also make isPrerequisite a false-negative that
      // silently bypasses the topology gate.
      if (!payload.from_knowledge_id || !payload.to_knowledge_id || !payload.relation_type) {
        warnMalformed('generate(create)', ev.id, 'missing required edge fields');
        continue;
      }

      const projected = rowFromGenerateEvent(edgeId, ev, payload);
      // ADR-0034 topology at fold-apply: a create ALWAYS yields a live edge
      // (archived_at=null), so the gate runs on every prerequisite create.
      if (projected.relation_type === 'prerequisite') {
        const verdict = checkEdgeTopology(
          {
            from_knowledge_id: projected.from_knowledge_id,
            to_knowledge_id: projected.to_knowledge_id,
            relation_type: projected.relation_type,
          },
          liveMesh.map((e) => ({
            from_knowledge_id: e.from_knowledge_id,
            to_knowledge_id: e.to_knowledge_id,
            relation_type: e.relation_type,
          })),
        );
        if (verdict.status === 'reject') {
          throw new Error(
            `foldKnowledgeEdge: ADR-0034 topology reject on edge ${edgeId} ` +
              `(gate=${verdict.gate}): ${verdict.reason}`,
          );
        }
        // 'warn' (transitive_redundancy) → proceed (no verdict column to stamp).
        // 'ok' → proceed.
      }
      row = projected;
    }

    // Unknown / irrelevant action for an edge row → skip (e.g. a rate event on the
    // edge's proposal does not mutate the edge projection).
  }

  return row;
}

// ---------- row builders (pure) ----------

// reasonOrNull — the generate-event payload encodes absent reasoning as '' (actions.ts:512
// `?? ''`) while the ROW stores null (actions.ts:496 `?? null`). Coerce ONLY '' → null
// (not other falsy values) so fold==row holds for the common absent case. RESIDUAL: an
// explicitly-empty-string reasoning is indistinguishable from absent in the event
// encoding — PR-A2 must fix the writer (generate payload `reasoning ?? ''` → `?? null`)
// to make it lossless, then this becomes a plain `?? null`.
function reasonOrNull(reasoning: string | null | undefined): string | null {
  return reasoning === '' ? null : (reasoning ?? null);
}

/**
 * Build a live edge row from a validated generate-CREATE payload.
 *
 * The generate event payload carries from/to/relation_type/weight/reasoning/
 * propose_event_id but NOT `created_by` (the row's created_by object, actions.ts:492-496
 * = `{ actor_kind, actor_ref, propose_event_id }`) — reconstructed here from the event
 * envelope's actor fields + the payload's propose_event_id. created_at is the event
 * row's own created_at (same-tx write). archived_at starts null (a create is live).
 * Callers guarantee from/to/relation_type are present (the create branch guards them).
 */
function rowFromGenerateEvent(
  edgeId: string,
  ev: FoldEvent,
  payload: GenerateEdgePayloadT,
): KnowledgeEdgeRowSnapshotT {
  return {
    id: edgeId,
    // biome-ignore lint/style/noNonNullAssertion: the create branch guards presence before calling.
    from_knowledge_id: payload.from_knowledge_id!,
    // biome-ignore lint/style/noNonNullAssertion: the create branch guards presence before calling.
    to_knowledge_id: payload.to_knowledge_id!,
    // biome-ignore lint/style/noNonNullAssertion: the create branch guards presence before calling.
    relation_type: payload.relation_type!,
    weight: payload.weight ?? 1,
    created_by: {
      actor_kind: ev.actor_kind,
      actor_ref: ev.actor_ref,
      ...(payload.propose_event_id ? { propose_event_id: payload.propose_event_id } : {}),
    },
    reasoning: reasonOrNull(payload.reasoning),
    created_at: ev.created_at,
    archived_at: null,
  };
}

/**
 * Best-effort archived row from an archive event with no preceding create/seed in the
 * slice. Defensive only — PR-A2's IO shell is expected to always include the genesis
 * seed for pre-W1 edges, making this unreachable. Callers guarantee from/to/relation_type
 * are present (the archive branch guards them). `weight` is unknown here (the archive
 * payload carries none), so it defaults to 1 like the table default; created_at falls
 * back to the archive event's own created_at (the true create timestamp was lost).
 */
function archiveRowFromArchiveEvent(
  edgeId: string,
  ev: FoldEvent,
  payload: GenerateEdgePayloadT,
): KnowledgeEdgeRowSnapshotT {
  return {
    id: edgeId,
    // biome-ignore lint/style/noNonNullAssertion: the archive branch guards presence before calling.
    from_knowledge_id: payload.from_knowledge_id!,
    // biome-ignore lint/style/noNonNullAssertion: the archive branch guards presence before calling.
    to_knowledge_id: payload.to_knowledge_id!,
    // biome-ignore lint/style/noNonNullAssertion: the archive branch guards presence before calling.
    relation_type: payload.relation_type!,
    weight: payload.weight ?? 1,
    created_by: {
      actor_kind: ev.actor_kind,
      actor_ref: ev.actor_ref,
      ...(payload.propose_event_id ? { propose_event_id: payload.propose_event_id } : {}),
    },
    reasoning: reasonOrNull(payload.reasoning),
    created_at: ev.created_at,
    archived_at: ev.created_at,
  };
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldKnowledgeEdge: skipping malformed event', { action, event_id: eventId, error });
}
