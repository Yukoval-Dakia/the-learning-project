import {
  GenesisExperimental,
  KnowledgeRowSnapshot,
  type KnowledgeRowSnapshotT,
  ProposeKnowledge,
  RateEvent,
} from '../schema/event';
import { KnowledgeMutationProposalChange } from '../schema/proposal';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldKnowledgeNode — the W1 structural fold for a single `knowledge` row
// (YUK-471 Wave 1, PR-A1). PURE node reducer.
// ====================================================================
//
// Projects the current structural state of ONE knowledge node (`nodeId`) from
// the event log. This is the read-model half of event-sourcing the knowledge
// tree: instead of mutating the `knowledge` table in place, the accept path
// appends events, and this fold REPRODUCES the row the imperative appliers
// (applyProposeNew / applyReparent / applyArchive / applyMerge / applySplit in
// src/capabilities/knowledge/server/proposals.ts) would have written.
//
// BEHAVIOR-PRESERVING (PR-A1): this reducer is NOT wired into any runtime path
// yet (no double-write, no SoT flip — those are PR-A2 / PR-B). It is a pure
// function landing with the schema so PR-A2 can build the IO shell (reverse
// index + DB read) around a verified, deterministic core.
//
// PURITY CONTRACT: no IO, no DB, no newId(), no Date.now() / new Date(). Same
// input → byte-identical output. The reducer NEVER mints ids or timestamps — it
// reads node ids from the accepting RATE event's payload.materialized_ids (the
// keystone added by known.ts RateEvent payload #1) and stamps row timestamps
// from the ACCEPT event's `created_at`. Determinism is what makes fold(events) ==
// row a checkable invariant.
//
// SHARED FoldEvent — the reducer consumes the flat `event`-row projection from
// ./fold-event (the SAME shape the edge reducer consumes and PR-A2's IO shell
// builds). The flat columns it reads:
//   - `id` / `created_at` — accept linkage + (created_at, id) ordering tiebreak +
//     row timestamps.
//   - `subject_kind` / `subject_id` — routing. Present on the SPECIALISED Event
//     members (ProposeKnowledge, GenesisExperimental …) but DROPPED by the
//     generic `ExperimentalEvent` member, so the fold reads them off the flat
//     envelope, not the re-parsed content. The auto-tag KC-create event
//     (`experimental:auto_tag_kc_created`) is a GENERIC experimental event whose
//     subject_kind/subject_id only survive on the envelope.
//   - `caused_by_event_id` — accept linkage (a RATE event names the propose event
//     it accepts here).
//   - `action` / `outcome` / `actor_kind` / `actor_ref` / `payload` — typed
//     re-parse input (the reducer reconstructs the Event-union member per branch
//     via safeParse, mirroring corrections.ts rowToCorrectEventInput, instead of
//     trusting a pre-parsed `EventT`).

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns
// (mirrors corrections.ts rowToCorrectEventInput). Each per-branch safeParse below
// feeds this to its dedicated schema so a malformed payload is rejected at the
// reducer boundary rather than trusted.
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
// (identical tiebreak to corrections.ts, the fold blueprint).
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Pure structural fold of a single `knowledge` node from the event log.
 *
 * @param nodeId  the knowledge row id to project
 * @param events  ALL candidate events (flat FoldEvent rows). The reducer internally
 *                SELECTS which affect `nodeId` — callers pass a superset (the
 *                PR-A2 IO shell narrows via a reverse index first, but the reducer
 *                must be correct on a superset too).
 * @returns the projected row, or `null` if `nodeId` was never created/seeded.
 */
export function foldKnowledgeNode(
  nodeId: string,
  events: FoldEvent[],
): KnowledgeRowSnapshotT | null {
  // ---------- pass 1: accept-resolution index ----------
  //
  // A node mutation takes effect ONLY if its propose event was ACCEPTED — i.e.
  // there is a RATE event with payload.rating==='accept' whose caused_by_event_id
  // names the propose event. dismiss / rollback (and a propose with no rate at
  // all) → no effect. We also capture that accept's materialized_ids, which is the
  // ONLY source of the minted node ids for propose_new / split (the propose event
  // itself does not carry them — they were minted by the accept path), AND the
  // accept event's created_at (the materialization moment, used to stamp the
  // projected row's timestamps — see ACCEPT-TIME note below).
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
    // The rate event's created_at = the materialization moment (applyX stamps `now`
    // at accept-time, not at propose-time). Keyed by the propose event id so pass 2
    // can look it up when applying that propose's effect.
    acceptedAtByProposeId.set(proposeId, fe.created_at);
    const mk = rate.data.payload.materialized_ids?.knowledge;
    if (mk) materializedKnowledgeByProposeId.set(proposeId, mk);
  }

  // ---------- pass 2: apply in (created_at asc, id asc) order ----------
  // Walk the SOURCE events in the canonical read order (created_at, id) — the same
  // order corrections.ts reads and the accept path wrote them — and apply each
  // effect on `nodeId` to a running row. Ordering is driven by the envelope id (a
  // true tiebreak when two events share a created_at), which is exactly why the
  // fold takes the envelope-wrapped FoldEvent rather than bare EventT.
  const ordered = [...events].sort(byCreatedThenId);

  let row: KnowledgeRowSnapshotT | null = null;

  for (const fe of ordered) {
    // ACCEPT-TIME row timestamp. Row created_at/updated_at = the ACCEPT event's
    // created_at (the imperative applyX stamps `now` at accept-time, not at
    // propose-time), looked up via the propose event id (fe.id). For seed (genesis)
    // and auto_tag this falls back to fe.created_at (genesis carries its own
    // snapshot timestamps; auto_tag is NOT a proposal — its create IS the tag-time
    // write moment). PR-A2 MUST align the accept-path writer to stamp the row from
    // the same rate-event created_at (single source) for byte-exact fold==row;
    // until then sub-ms drift is expected and the parity harness should compare
    // created_at/updated_at with tolerance or the writer must be aligned.
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
      // The seed IS the base state (version, timestamps and all carried verbatim).
      row = { ...knownRow.data, merged_from: [...knownRow.data.merged_from] };
      continue;
    }

    // auto-tag create — subject_kind / subject_id come from the flat envelope (the
    // generic ExperimentalEvent member drops them from the re-parsed content).
    // auto_tag is NOT a proposal: its row timestamp is fe.created_at (the tag-time
    // write moment), so it does NOT consult acceptedAtByProposeId.
    if (
      fe.action === 'experimental:auto_tag_kc_created' &&
      fe.subject_kind === 'knowledge' &&
      fe.subject_id === nodeId
    ) {
      const payload = fe.payload;
      const name = typeof payload.name === 'string' ? payload.name : '';
      const parent_id = typeof payload.parent_id === 'string' ? payload.parent_id : null;
      if (parent_id === null) continue;
      row = createRow(fe.subject_id, name, parent_id, fe.created_at);
      continue;
    }

    // propose_new (subject_kind from the envelope — uniform with the other branches)
    if (fe.action === 'propose' && fe.subject_kind === 'knowledge') {
      if (!acceptedProposeIds.has(fe.id)) continue;
      const p = ProposeKnowledge.safeParse(toParseInput(fe));
      if (!p.success) {
        warnMalformed('propose', fe.id, p.error);
        continue;
      }
      const createdId = materializedKnowledgeByProposeId.get(fe.id)?.[0];
      if (!createdId || createdId !== nodeId) continue;
      row = createRow(createdId, p.data.payload.name, p.data.payload.parent_id, at);
      continue;
    }

    // archive (experimental:knowledge_archive) — handled SEPARATELY from
    // reparent/merge/split because `archive` is NOT a member of the
    // KnowledgeMutationProposalChange discriminated union (which is only
    // reparent/merge/split). It is its own propose path (writeArchiveProposal in
    // proposals.ts) whose event payload is { node_id, expected_version, reasoning };
    // acceptProposal reconstructs mutation='archive' and calls applyArchive
    // (archived_at + version+1). This branch MUST precede the generic
    // `experimental:knowledge_` branch below (archive shares that prefix). Effect
    // mirrors applyArchive: set archived_at, version+1. The target node id is the
    // event subject_id (== payload.node_id, asserted by writeArchiveProposal).
    if (fe.action === 'experimental:knowledge_archive' && fe.subject_kind === 'knowledge') {
      if (!acceptedProposeIds.has(fe.id)) continue; // accepted-only gate
      if (fe.subject_id !== nodeId || row === null) continue;
      row = {
        ...row,
        archived_at: at,
        updated_at: at,
        version: row.version + 1,
      };
      continue;
    }

    // reparent / merge / split (subject_kind from the envelope)
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
          // into_id: append from_ids to merged_from, version+1
          if (change.into_id === nodeId && row !== null) {
            row = {
              ...row,
              merged_from: [...row.merged_from, ...change.from_ids],
              updated_at: at,
              version: row.version + 1,
            };
          }
          // each from_id: archived_at, version+1
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
          // from_id: archived_at, version+1
          if (change.from_id === nodeId && row !== null) {
            row = {
              ...row,
              archived_at: at,
              updated_at: at,
              version: row.version + 1,
            };
          }
          // a new split id matching nodeId: CREATE
          const minted = materializedKnowledgeByProposeId.get(fe.id);
          if (minted) {
            for (let i = 0; i < change.into.length; i++) {
              if (minted[i] !== nodeId) continue;
              const entry = change.into[i];
              if (entry.parent_id === null) continue;
              row = createRow(nodeId, entry.name, entry.parent_id, at);
            }
          }
          break;
        }
      }
    }
  }

  return row;
}

// createRow — the canonical projected shape an applyProposeNew / applySplit /
// auto_tag create produces. approval_status is ALWAYS 'approved' (the only value
// the appliers write). domain null, merged_from [], proposed_by_ai true, version
// 0, created_at === updated_at === the event time. EXCLUDES embed_* (derived
// maintenance state, not structural truth — KnowledgeRowSnapshot omits them).
function createRow(id: string, name: string, parent_id: string, at: Date): KnowledgeRowSnapshotT {
  return {
    id,
    name,
    domain: null,
    parent_id,
    merged_from: [],
    archived_at: null,
    proposed_by_ai: true,
    approval_status: 'approved',
    created_at: at,
    updated_at: at,
    version: 0,
  };
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldKnowledgeNode: skipping malformed event', { action, event_id: eventId, error });
}
