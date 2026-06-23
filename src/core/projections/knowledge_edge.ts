// YUK-471 Wave 1 PR-A1 — knowledge_edge fold reducer (PURE, behavior-preserving).
//
// This is the EASY half of the first structural fold (PR-A1): a pure reducer that
// projects a `knowledge_edge` row from the ordered event log. It is NOT YET WIRED
// into any runtime path — no double-write, no SoT flip (those land in PR-A2/PR-B).
// PR-A2's IO shell will: read events for (subject_kind='knowledge_edge',
// subject_id=edgeId) ordered by (created_at asc, id asc), wrap each DB row as a
// FoldEvent, read the live-edge set for topology, and call this reducer.
//
// PURE contract: no IO / no DB / no newId / no Date. The event ordering, the
// `created_at`/`id` row metadata, and the live topology mesh are all PASSED IN.
//
// The projected-row shape is imported from genesis.ts (ONE shared contract — the
// seed and the fold output cannot drift). See KnowledgeEdgeRowSnapshot there for
// the column subset (excludes nothing on this table — edges have no embed_*
// columns; the only structural omission is that there is NO `version` column on
// knowledge_edge, unlike knowledge).

import { checkEdgeTopology } from '@/capabilities/knowledge/server/topology-gate';
import {
  KnowledgeEdgeRowSnapshot,
  type KnowledgeEdgeRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { FoldEvent } from './fold-event';

// ---------- FoldEvent ----------
//
// The reducer consumes the flat `event`-row projection from ./fold-event (the
// SAME shape the node reducer consumes and PR-A2's IO shell builds — ONE shared
// envelope, no divergence between the two folds). See ./fold-event.ts for the
// column list and rationale: the parsed Event union (EventT) is reconstructed
// per-branch inside the reducer via safeParse, mirroring corrections.ts
// rowToCorrectEventInput, rather than trusting a pre-parsed `EventT`.

// ---------- Archive signal ----------
//
// Edge archive is emitted by the proposal-accept path as a `generate` event with
// `payload.edge_op === 'archive'` and `subject_id === edgeId` (src/server/proposals/
// actions.ts:406-425). The soft-delete itself (archiveKnowledgeEdge, src/capabilities/
// knowledge/server/edges.ts:228) only UPDATEs archived_at and emits NO event of its
// own — so this `generate(edge_op=archive)` event is the SINGLE archive signal the
// fold keys on. detected by payload.edge_op === 'archive' on an edge generate event.

const ARCHIVE_EDGE_OP = 'archive';

// ---------- ADR-0034 topology at fold-apply ----------
//
// ADR-0034 §2 — the write-time structural consistency gate (TOPOLOGY layer) is
// reused VERBATIM here (checkEdgeTopology is a pure fn). The fold applies it when
// a create/generate event ADDS a LIVE prerequisite edge to catch a cycle /
// direction contradiction that slipped past the write-time gate (e.g. a genesis
// seed backfill that never went through the propose path). This is STRUCTURAL
// only — NO LLM, NO reconcile ring (that is ADR-0034 §3, a separate follow-up).
//
// Verdict contract (src/capabilities/knowledge/server/topology-gate.ts:45-48):
//   | { status: 'ok' }
//   | { status: 'reject'; gate: 'cycle' | 'direction_contradiction' | 'transitive_redundancy'; reason }
//   | { status: 'warn';  gate: ...; reason }
// Behavior:
//   - 'reject' (cycle / direction_contradiction) → THROW (the caller's tx aborts;
//     a cyclic prerequisite graph is a hard structural error, not a warn).
//   - 'warn' (transitive_redundancy) → proceed (the row has no verdict column to
//     stamp; warn is advisory and the caller decides whether to downweight — the
//     fold reproduces the row as-is).
//   - non-prerequisite edge OR an archive event OR an already-archived seed →
//     passthrough (checkEdgeTopology itself returns ok for non-prerequisite; we
//     additionally skip the check on archive/archived-seed to avoid recomputing).

/**
 * Project a single `knowledge_edge` row from its ordered event log.
 *
 * @param edgeId   The edge id to project (subject_id filter).
 * @param events   The edge's events, ALREADY ordered (created_at asc, id asc) by
 *                 the caller. Events whose subject_id !== edgeId are skipped.
 * @param liveMesh The set of currently-LIVE edges (archived_at IS NULL) to check
 *                 topology against when a create/generate adds a LIVE prerequisite
 *                 edge. Supplied by the IO shell; kept pure.
 * @returns the projected row, or null if the edge has no matching events.
 * @throws when a create/generate event adds a LIVE prerequisite edge that closes
 *         a cycle or reverses an existing prerequisite (ADR-0034 reject verdict).
 */
export function foldKnowledgeEdge(
  edgeId: string,
  events: FoldEvent[],
  liveMesh: KnowledgeEdgeRowSnapshotT[],
): KnowledgeEdgeRowSnapshotT | null {
  let row: KnowledgeEdgeRowSnapshotT | null = null;

  for (const ev of events) {
    // Subject filter — only fold events keyed to THIS edge.
    if (ev.subject_id !== edgeId) continue;

    if (ev.action === 'experimental:genesis' && ev.subject_kind === 'knowledge_edge') {
      // SEED — payload.row is the byte-for-byte snapshot (genesis.ts). Validate it
      // through KnowledgeEdgeRowSnapshot rather than trusting a blind cast: the fold
      // treats genesis as ground truth, so a malformed seed would silently corrupt
      // the projection. On failure warn + skip (mirrors the node reducer's
      // warnMalformed style); on success use the parsed row.
      const seed = KnowledgeEdgeRowSnapshot.safeParse((ev.payload as { row: unknown }).row);
      if (!seed.success) {
        console.warn('foldKnowledgeEdge: skipping malformed genesis seed', {
          event_id: ev.id,
          error: seed.error,
        });
        continue;
      }
      row = seed.data;
      continue;
    }

    if (ev.action === 'generate' && ev.subject_kind === 'knowledge_edge') {
      const payload = ev.payload as {
        edge_op?: string;
        from_knowledge_id?: string;
        to_knowledge_id?: string;
        relation_type?: string;
        weight?: number;
        reasoning?: string | null;
        propose_event_id?: string;
        archive_edge_id?: string;
      };

      // ARCHIVE signal — generate event with payload.edge_op === 'archive'.
      if (payload.edge_op === ARCHIVE_EDGE_OP) {
        if (row === null) {
          // Archive on an edge with no preceding create/seed (edge existed pre-W1
          // and its genesis seed wasn't in this slice). Best-effort: project an
          // archived row from the archive payload, created_at from this event.
          row = archiveRowFromArchiveEvent(edgeId, ev, payload);
        } else {
          // Stamp archived_at from the archive event's own created_at (mirrors
          // archiveKnowledgeEdge's `new Date()` written in the same tx).
          row = { ...row, archived_at: ev.created_at };
        }
        continue;
      }

      // CREATE — project a live edge row from the generate payload (actions.ts:509-516).
      // ADR-0034 topology at fold-apply: a create that ADDS a LIVE prerequisite
      // edge is gated. Skip the check for non-prerequisite (the gate returns ok
      // anyway, but we avoid the call) and skip when this row is already archived
      // (an archived edge is not live, cannot close a cycle).
      const projected = rowFromGenerateEvent(edgeId, ev, payload);
      const isPrerequisite = projected.relation_type === 'prerequisite';
      const isLive = projected.archived_at === null;
      if (isPrerequisite && isLive) {
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

    // Unknown / irrelevant action for an edge row → skip (mirrors corrections.ts
    // skipping malformed rows, except here the event parsed fine — it just does
    // not mutate the edge projection, e.g. a rate event on the edge's proposal).
  }

  return row;
}

// ---------- row builders (pure) ----------

/**
 * Build a live edge row from a generate-CREATE event.
 *
 * The generate event payload (actions.ts:509-516) carries from/to/relation_type/
 * weight/reasoning/propose_event_id but NOT `created_by` (the row's created_by
 * object). The row's `created_by` was `{ actor_kind, actor_ref, propose_event_id }`
 * (actions.ts:492-496) — reconstructed here from the event envelope's actor fields
 * plus the payload's propose_event_id provenance link. `created_at` is the event
 * row's own created_at (same-tx write at actions.ts:498/501). archived_at starts
 * null (a create yields a live edge).
 */
function rowFromGenerateEvent(
  edgeId: string,
  ev: FoldEvent,
  payload: {
    from_knowledge_id?: string;
    to_knowledge_id?: string;
    relation_type?: string;
    weight?: number;
    reasoning?: string | null;
    propose_event_id?: string;
  },
): KnowledgeEdgeRowSnapshotT {
  return {
    id: edgeId,
    from_knowledge_id: payload.from_knowledge_id ?? '',
    to_knowledge_id: payload.to_knowledge_id ?? '',
    relation_type: payload.relation_type ?? '',
    weight: payload.weight ?? 1,
    created_by: {
      actor_kind: ev.actor_kind,
      actor_ref: ev.actor_ref,
      ...(payload.propose_event_id ? { propose_event_id: payload.propose_event_id } : {}),
    },
    // The generate-event payload encodes absent reasoning as '' (actions.ts:512
    // `?? ''`) while the ROW stores null (actions.ts:496 `?? null`). `|| null`
    // recovers the common absent case so fold==row holds for it. RESIDUAL: an
    // explicitly-empty-string reasoning is indistinguishable from absent in the
    // event encoding — PR-A2 must fix the writer (actions.ts generate payload
    // `reasoning ?? ''` → `?? null`) so the encoding is lossless, then this reverts
    // to `?? null`.
    reasoning: payload.reasoning || null,
    created_at: ev.created_at,
    archived_at: null,
  };
}

/**
 * Best-effort archived row from an archive event with no preceding create/seed.
 * Mirrors the CREATE builder for from/to/relation_type/created_by but stamps
 * archived_at from the archive event. created_at falls back to the archive event's
 * own created_at (the true create timestamp was lost — the edge predates the W1
 * event log and its genesis seed is not in this slice).
 */
function archiveRowFromArchiveEvent(
  edgeId: string,
  ev: FoldEvent,
  payload: {
    from_knowledge_id?: string;
    to_knowledge_id?: string;
    relation_type?: string;
    reasoning?: string | null;
    propose_event_id?: string;
    archive_edge_id?: string;
  },
): KnowledgeEdgeRowSnapshotT {
  return {
    id: edgeId,
    from_knowledge_id: payload.from_knowledge_id ?? '',
    to_knowledge_id: payload.to_knowledge_id ?? '',
    relation_type: payload.relation_type ?? '',
    weight: 1, // unknown — archive payload carries no weight; default like the table
    created_by: {
      actor_kind: ev.actor_kind,
      actor_ref: ev.actor_ref,
      ...(payload.propose_event_id ? { propose_event_id: payload.propose_event_id } : {}),
    },
    // `|| null` (not `?? null`): the generate payload encodes absent reasoning as
    // '' (actions.ts:512) while the row stores null — see the note in
    // rowFromGenerateEvent. Same residual applies until PR-A2 makes the writer
    // lossless.
    reasoning: payload.reasoning || null,
    created_at: ev.created_at,
    archived_at: ev.created_at,
  };
}
