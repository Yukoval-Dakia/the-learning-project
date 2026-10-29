import { z } from 'zod';
import {
  GenesisExperimental,
  KnowledgeApprovalUpdateExperimental,
  KnowledgeRoleUpdateExperimental,
  KnowledgeRowSnapshot,
  type KnowledgeRowSnapshotT,
  ProposeKnowledge,
  RateEvent,
  SubjectRootNameUpdateExperimental,
} from '../schema/event';
import { KnowledgeMutationProposalChange } from '../schema/proposal';
import type { FoldEvent } from './fold-event';

// Archive is its own propose path, outside the mutation union; validate its payload.
const KnowledgeArchivePayload = z.object({
  node_id: z.string().min(1),
  expected_version: z.number().int().optional(),
  reasoning: z.string().nullable().optional(),
});

// Pure knowledge-node reducer. A mutation applies only when its propose event was
// accepted; the accepting rate carries the minted node ids and the materialization
// moment used for row timestamps. Replay order is a deterministic
// (materialization time, create-before-mutate, expected version, id) order, so the
// same event set folds to the same row regardless of DB result order. No IO, ids,
// or clocks: timestamps come from events and ids from accept payloads.

// Rebuild the parse input from the flat row so each branch validates its payload.
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

function mutationPreviousVersionForNode(fe: FoldEvent, nodeId: string): number | null {
  if (fe.subject_kind !== 'knowledge') return null;

  if (fe.action === 'experimental:subject_root_name_update' && fe.subject_id === nodeId) {
    const update = SubjectRootNameUpdateExperimental.safeParse(toParseInput(fe));
    return update.success ? update.data.payload.previous_version : null;
  }

  if (fe.action === 'experimental:knowledge_role_update' && fe.subject_id === nodeId) {
    const update = KnowledgeRoleUpdateExperimental.safeParse(toParseInput(fe));
    return update.success ? update.data.payload.previous_version : null;
  }

  if (fe.action === 'experimental:knowledge_approval_update' && fe.subject_id === nodeId) {
    const update = KnowledgeApprovalUpdateExperimental.safeParse(toParseInput(fe));
    return update.success ? update.data.payload.previous_version : null;
  }

  if (fe.action === 'experimental:knowledge_archive') {
    const archive = KnowledgeArchivePayload.safeParse(fe.payload);
    return archive.success && archive.data.node_id === nodeId
      ? (archive.data.expected_version ?? null)
      : null;
  }

  if (!fe.action.startsWith('experimental:knowledge_')) return null;
  const mutation = KnowledgeMutationProposalChange.safeParse({
    mutation: fe.action.replace(/^experimental:knowledge_/, ''),
    ...fe.payload,
  });
  if (!mutation.success) return null;

  switch (mutation.data.mutation) {
    case 'reparent':
      return mutation.data.node_id === nodeId ? mutation.data.expected_version : null;
    case 'merge':
      return mutation.data.into_id === nodeId || mutation.data.from_ids.includes(nodeId)
        ? (mutation.data.expected_versions[nodeId] ?? null)
        : null;
    case 'split':
      return mutation.data.from_id === nodeId ? mutation.data.expected_version : null;
  }
}

function replayTieKey(
  fe: FoldEvent,
  nodeId: string,
  materializedKnowledgeByProposeId: Map<string, string[]>,
): readonly [tier: number, version: number] {
  const createsNode =
    (fe.subject_kind === 'knowledge' &&
      fe.subject_id === nodeId &&
      (fe.action === 'experimental:genesis' || fe.action === 'experimental:auto_tag_kc_created')) ||
    (materializedKnowledgeByProposeId.get(fe.id)?.includes(nodeId) ?? false);
  if (createsNode) return [0, 0];

  const previousVersion = mutationPreviousVersionForNode(fe, nodeId);
  if (previousVersion !== null) return [1, previousVersion];

  return [2, 0];
}

// Canonical total order: materialization time, then create-before-mutate, then expected
// version, then id. The tuple keeps the comparator transitive; field-disjoint updates
// (merge into_id vs rename) commute within a millisecond.
function compareReplayEvents(
  a: FoldEvent,
  b: FoldEvent,
  nodeId: string,
  materializedKnowledgeByProposeId: Map<string, string[]>,
  acceptedAtByProposeId: Map<string, Date>,
): number {
  const ta = (acceptedAtByProposeId.get(a.id) ?? a.created_at).getTime();
  const tb = (acceptedAtByProposeId.get(b.id) ?? b.created_at).getTime();
  if (ta !== tb) return ta - tb;

  const [aTier, aVersion] = replayTieKey(a, nodeId, materializedKnowledgeByProposeId);
  const [bTier, bVersion] = replayTieKey(b, nodeId, materializedKnowledgeByProposeId);
  if (aTier !== bTier) return aTier - bTier;
  if (aVersion !== bVersion) return aVersion - bVersion;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Project one node from its events; callers may pass a superset. Null when no base exists. */
export function foldKnowledgeNode(
  nodeId: string,
  events: FoldEvent[],
): KnowledgeRowSnapshotT | null {
  // ---------- pass 1: accept resolution ----------
  // Only accepted proposes apply. The rate carries the minted ids for propose_new/split
  // and the materialization moment used for timestamps.
  const acceptedProposeIds = new Set<string>();
  const materializedKnowledgeByProposeId = new Map<string, string[]>();
  const acceptedAtByProposeId = new Map<string, Date>();

  for (const fe of events) {
    if (fe.action !== 'rate') continue;
    const rate = RateEvent.safeParse(toParseInput(fe));
    if (!rate.success) continue;
    if (rate.data.payload.rating !== 'accept') continue;
    const proposeId = fe.caused_by_event_id;
    if (!proposeId) continue;
    acceptedProposeIds.add(proposeId);
    // Stamped at accept time, not propose time.
    acceptedAtByProposeId.set(proposeId, fe.created_at);
    const mk = rate.data.payload.materialized_ids?.knowledge;
    if (mk) materializedKnowledgeByProposeId.set(proposeId, mk);
  }

  // ---------- pass 2: apply in canonical replay order ----------
  // Total tie order makes transitions independent of envelope ids or DB row order.
  const ordered = [...events].sort((a, b) =>
    compareReplayEvents(a, b, nodeId, materializedKnowledgeByProposeId, acceptedAtByProposeId),
  );

  let row: KnowledgeRowSnapshotT | null = null;

  for (const fe of ordered) {
    // Accept-time stamp for proposals; genesis and auto_tag fall back to their own event
    // time. Byte-exact parity requires the writer to use the same rate timestamp.
    const at = acceptedAtByProposeId.get(fe.id) ?? fe.created_at;

    // genesis seed
    if (fe.action === 'experimental:genesis') {
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      if (g.data.subject_kind !== 'knowledge' || g.data.subject_id !== nodeId) continue;
      const knownRow = KnowledgeRowSnapshot.safeParse(g.data.payload.row);
      if (!knownRow.success) {
        warnMalformed('experimental:genesis(row)', fe.id, knownRow.error);
        continue;
      }
      // Default the optional identity role the way the DB column default does, so every
      // folded row carries a defined role (legacy genesis payloads predate the column).
      row = {
        ...knownRow.data,
        role: knownRow.data.role ?? 'kc',
        merged_from: [...knownRow.data.merged_from],
      };
      continue;
    }

    // YUK-1600 — identity-role repair (ops backfill of pre-column nodes). Same discipline
    // as the root rename below: control-plane authorization at write time, not
    // proposal-gated, and the folded version increments so each event counts once.
    if (
      fe.action === 'experimental:knowledge_role_update' &&
      fe.subject_kind === 'knowledge' &&
      fe.subject_id === nodeId
    ) {
      const update = KnowledgeRoleUpdateExperimental.safeParse(toParseInput(fe));
      if (!update.success) {
        warnMalformed('experimental:knowledge_role_update', fe.id, update.error);
        continue;
      }
      if (row === null) continue;
      row = {
        ...row,
        role: update.data.payload.role,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // YUK-1604 — approval-status repair (ops backfill of pre-pending auto-tag KCs).
    // Same control-plane discipline and version counting as the role repair above.
    if (
      fe.action === 'experimental:knowledge_approval_update' &&
      fe.subject_kind === 'knowledge' &&
      fe.subject_id === nodeId
    ) {
      const update = KnowledgeApprovalUpdateExperimental.safeParse(toParseInput(fe));
      if (!update.success) {
        warnMalformed('experimental:knowledge_approval_update', fe.id, update.error);
        continue;
      }
      if (row === null) continue;
      row = {
        ...row,
        approval_status: update.data.payload.approval_status,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // Root rename/reset is not proposal-gated; the owner CAS and control-plane lock authorize
    // it at write time. Incrementing the folded version (not assigning payload.next_version)
    // counts each event once even when a same-ms merge cannot be causally ordered, and lets
    // the first event heal a legacy name-only mirror.
    if (
      fe.action === 'experimental:subject_root_name_update' &&
      fe.subject_kind === 'knowledge' &&
      fe.subject_id === nodeId
    ) {
      const update = SubjectRootNameUpdateExperimental.safeParse(toParseInput(fe));
      if (!update.success) {
        warnMalformed('experimental:subject_root_name_update', fe.id, update.error);
        continue;
      }
      if (row === null) continue;
      row = {
        ...row,
        name: update.data.payload.next_name,
        updated_at: fe.created_at,
        version: row.version + 1,
      };
      continue;
    }

    // auto-tag create — not a proposal, so its timestamp is the tag time.
    if (
      fe.action === 'experimental:auto_tag_kc_created' &&
      fe.subject_kind === 'knowledge' &&
      fe.subject_id === nodeId
    ) {
      const payload = fe.payload;
      // Never project an empty-name node into the tree.
      if (typeof payload.name !== 'string' || payload.name.length === 0) {
        warnMalformed('experimental:auto_tag_kc_created', fe.id, 'missing or empty name');
        continue;
      }
      const name = payload.name;
      const parent_id = typeof payload.parent_id === 'string' ? payload.parent_id : null;
      if (parent_id === null) continue;
      row = createRow(fe.subject_id, name, parent_id, null, fe.created_at);
      // Only 'pending' may be declared: an event cannot self-approve, and rejection is a
      // human decision, not a creation payload.
      if (payload.approval_status === 'pending') {
        row = { ...row, approval_status: 'pending' };
      }
      continue;
    }

    // propose_new
    if (fe.action === 'propose' && fe.subject_kind === 'knowledge') {
      if (!acceptedProposeIds.has(fe.id)) continue;
      const p = ProposeKnowledge.safeParse(toParseInput(fe));
      if (!p.success) {
        warnMalformed('propose', fe.id, p.error);
        continue;
      }
      const createdId = materializedKnowledgeByProposeId.get(fe.id)?.[0];
      if (!createdId || createdId !== nodeId) continue;
      row = createRow(
        createdId,
        p.data.payload.name,
        p.data.payload.parent_id,
        p.data.payload.domain ?? null,
        at,
      );
      continue;
    }

    // archive — its own propose path, not part of the mutation union. Must precede the
    // generic knowledge_ branch because it shares that prefix; mirrors applyArchive
    // (archived_at, version +1).
    if (fe.action === 'experimental:knowledge_archive' && fe.subject_kind === 'knowledge') {
      if (!acceptedProposeIds.has(fe.id)) continue; // accepted-only gate
      // The writer guarantees node_id === subject_id; verify instead of trusting it.
      const ap = KnowledgeArchivePayload.safeParse(fe.payload);
      if (!ap.success) {
        warnMalformed('experimental:knowledge_archive', fe.id, ap.error);
        continue;
      }
      if (ap.data.node_id !== fe.subject_id) {
        warnMalformed('experimental:knowledge_archive', fe.id, 'node_id !== subject_id');
        continue;
      }
      if (fe.subject_id !== nodeId || row === null) continue;
      row = {
        ...row,
        archived_at: at,
        updated_at: at,
        version: row.version + 1,
      };
      continue;
    }

    // reparent / merge / split
    if (fe.action.startsWith('experimental:knowledge_') && fe.subject_kind === 'knowledge') {
      if (!acceptedProposeIds.has(fe.id)) continue;
      const mutationKind = fe.action.replace(/^experimental:knowledge_/, '');
      const m = KnowledgeMutationProposalChange.safeParse({
        mutation: mutationKind,
        ...fe.payload,
      });
      if (!m.success) {
        warnMalformed(fe.action, fe.id, m.error);
        continue;
      }
      const change = m.data;

      switch (change.mutation) {
        case 'reparent': {
          if (change.node_id !== nodeId || row === null) break;
          if (change.new_parent_id === null) break;
          row = {
            ...row,
            parent_id: change.new_parent_id,
            domain: null,
            updated_at: at,
            version: row.version + 1,
          };
          break;
        }
        case 'merge': {
          if (change.into_id === nodeId && row !== null) {
            row = {
              ...row,
              merged_from: [...row.merged_from, ...change.from_ids],
              updated_at: at,
              version: row.version + 1,
            };
          }
          if (change.from_ids.includes(nodeId) && row !== null) {
            row = {
              ...row,
              archived_at: at,
              updated_at: at,
              version: row.version + 1,
            };
          }
          break;
        }
        case 'split': {
          if (change.from_id === nodeId && row !== null) {
            row = {
              ...row,
              archived_at: at,
              updated_at: at,
              version: row.version + 1,
            };
          }
          const minted = materializedKnowledgeByProposeId.get(fe.id);
          if (minted) {
            for (let i = 0; i < change.into.length; i++) {
              if (minted[i] !== nodeId) continue;
              const entry = change.into[i];
              if (entry.parent_id === null) continue;
              row = createRow(nodeId, entry.name, entry.parent_id, null, at);
            }
          }
          break;
        }
      }
    }
  }

  return row;
}

// Canonical create shape. approval_status defaults to approved for accept-path appliers;
// auto_tag may override to pending. `domain` is the root anchor: null for children, the
// declared domain for root proposals. role defaults to kc — proposal/auto-tag creations
// mint knowledge components; goal/container identity is stamped only by the creators that
// own it (seed roots, LearningIntent topic roots). embed_* is derived maintenance state,
// not truth.
function createRow(
  id: string,
  name: string,
  parent_id: string | null,
  domain: string | null,
  at: Date,
): KnowledgeRowSnapshotT {
  return {
    id,
    name,
    domain,
    parent_id,
    merged_from: [],
    archived_at: null,
    proposed_by_ai: true,
    approval_status: 'approved',
    role: 'kc',
    created_at: at,
    updated_at: at,
    version: 0,
  };
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldKnowledgeNode: skipping malformed event', { action, event_id: eventId, error });
}
