// Pure knowledge-edge reducer. No IO or clocks: the live mesh is passed in and events
// are sorted internally. The row shape is shared with genesis; edges have no version.

import { z } from 'zod';
import {
  GenesisExperimental,
  KnowledgeEdgeRowSnapshot,
  type KnowledgeEdgeRowSnapshotT,
} from '@/core/schema/event/genesis';
import { checkEdgeTopology } from '@/core/topology-gate';
import type { FoldEvent } from './fold-event';

// Rebuild the parse input from the flat row; genesis's superRefine checks coherence.
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

// Canonical event order; sorting internally means callers need not pre-sort.
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Validate at the boundary; create/archive branches require their own fields. An empty
// relation_type would bypass the topology gate, so it is never projected.
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

// ADR-0034 topology gate runs only in write mode ('enforce'): when a create adds a
// live prerequisite or derived_from edge. Replay ('trust', the default) never gates —
// a create that predates a gate, or whose inverse twin appeared later, must still fold
// or a legal pre-gate pair could never be archived or repaired (YUK-1601 P1). Genesis
// seeds are likewise trusted. Reject throws; warn proceeds because there is no
// verdict column.

export type EdgeTopologyMode = 'enforce' | 'trust';

/**
 * Project one edge; caller order is irrelevant. `liveMesh` is the currently live edge
 * set used for topology. Throws only in write mode (`topology: 'enforce'`) when a
 * prerequisite or derived_from create violates ADR-0034; the default replay mode
 * trusts history.
 */
export function foldKnowledgeEdge(
  edgeId: string,
  events: FoldEvent[],
  liveMesh: KnowledgeEdgeRowSnapshotT[],
  opts?: { topology?: EdgeTopologyMode },
): KnowledgeEdgeRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: KnowledgeEdgeRowSnapshotT | null = null;

  for (const ev of ordered) {
    if (ev.subject_id !== edgeId) continue;

    // Genesis is trusted, but validate the whole event rather than casting blindly.
    if (ev.action === 'experimental:genesis' && ev.subject_kind === 'knowledge_edge') {
      const g = GenesisExperimental.safeParse(toParseInput(ev));
      if (!g.success) {
        warnMalformed('experimental:genesis', ev.id, g.error);
        continue;
      }
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
          // Archive time comes from the event; other columns are preserved.
          row = { ...row, archived_at: ev.created_at };
          continue;
        }
        // No seed in the slice: best-effort row. Never project empty structural fields.
        if (!payload.from_knowledge_id || !payload.to_knowledge_id || !payload.relation_type) {
          warnMalformed('generate(archive)', ev.id, 'missing required edge fields, no prior row');
          continue;
        }
        row = archiveRowFromArchiveEvent(edgeId, ev, payload);
        continue;
      }

      // CREATE — require structural fields; empty relation_type would bypass the gate.
      if (!payload.from_knowledge_id || !payload.to_knowledge_id || !payload.relation_type) {
        warnMalformed('generate(create)', ev.id, 'missing required edge fields');
        continue;
      }

      const projected = rowFromGenerateEvent(edgeId, ev, payload);
      // A create always yields a live edge, so the write-mode gate applies to every
      // prerequisite and derived_from create (YUK-1601: derived_from joins the
      // inversion check). Replay mode trusts the recorded history.
      const gatedRelation =
        projected.relation_type === 'prerequisite' || projected.relation_type === 'derived_from';
      if (opts?.topology === 'enforce' && gatedRelation) {
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
          // No node snapshot in a historical fold; pass [] explicitly, never by omission.
          [],
        );
        if (verdict.status === 'reject') {
          throw new Error(
            `foldKnowledgeEdge: ADR-0034 topology reject on edge ${edgeId} ` +
              `(gate=${verdict.gate}): ${verdict.reason}`,
          );
        }
        // 'warn' and 'ok' both proceed.
      }
      row = projected;
    }
  }

  return row;
}

// Absent reasoning is null; an explicit empty string is genuine and preserved.
function reasonOrNull(reasoning: string | null | undefined): string | null {
  return reasoning ?? null;
}

/**
 * Build a live row from a validated create payload. created_by comes from the envelope
 * plus propose_event_id; timestamps come from the same-tx event.
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
 * Defensive archived row when no seed is in the slice. Weight and true create time are
 * unknown, so created_at falls back to the archive event.
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
