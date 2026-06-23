import { describe, expect, it } from 'vitest';
import type { FoldEvent } from './fold-event';
import { foldKnowledgeNode } from './knowledge';

// ====================================================================
// foldKnowledgeNode — pure node reducer unit tests (YUK-471 W1 PR-A1).
//
// No DB, no IO. Every event is constructed in-memory as a flat FoldEvent (the
// `event`-row projection: id + created_at + actor_*/action/subject_*/outcome/
// caused_by_event_id/payload). We deliberately do NOT call parseEvent here — the
// fold safeParses internally (reconstructing the typed Event member from the flat
// columns); passing plain objects that match the schema shapes exercises that
// path and keeps the test pure.
// ====================================================================

// ---------- builders ----------

let seq = 0;
function nextId(prefix = 'evt'): string {
  seq += 1;
  return `${prefix}_${seq.toString().padStart(4, '0')}`;
}

// A fixed epoch so timestamps are deterministic and orderable.
const T0 = new Date('2026-06-23T00:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

// propose_new propose event (action='propose').
function proposeNew(opts: {
  id?: string;
  created_at: Date;
  name: string;
  parent_id: string;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('propose'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'tag_knowledge',
    action: 'propose',
    subject_kind: 'knowledge',
    subject_id: opts.parent_id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { name: opts.name, parent_id: opts.parent_id, reasoning: 'because' },
  };
}

// A rate event accepting (or dismissing) a propose event, pinning materialized ids.
function rate(opts: {
  id?: string;
  created_at: Date;
  causedBy: string;
  rating: 'accept' | 'dismiss' | 'rollback';
  materializedKnowledge?: string[];
}): FoldEvent {
  return {
    id: opts.id ?? nextId('rate'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.causedBy,
    outcome: 'success',
    caused_by_event_id: opts.causedBy,
    payload: {
      rating: opts.rating,
      ...(opts.materializedKnowledge
        ? { materialized_ids: { knowledge: opts.materializedKnowledge } }
        : {}),
    },
  };
}

// experimental:knowledge_<mutation> propose event. The payload is the
// KnowledgeMutationProposalChange MINUS its `mutation` discriminator (mirrors
// proposals.ts writeKnowledgeMutationProposal `...rest`).
function mutationPropose(opts: {
  id?: string;
  created_at: Date;
  action: `experimental:knowledge_${'reparent' | 'merge' | 'split'}`;
  subject_id: string;
  payload: Record<string, unknown>;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('mut'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'tag_knowledge',
    action: opts.action,
    subject_kind: 'knowledge',
    subject_id: opts.subject_id,
    outcome: 'partial',
    caused_by_event_id: null,
    payload: { ...opts.payload, reasoning: 'because', evidence_refs: [] },
  };
}

// experimental:knowledge_archive propose event. Archive is NOT part of the
// KnowledgeMutationProposalChange union — its event payload is { node_id,
// expected_version } (+ reasoning), mirroring writeArchiveProposal.
function archivePropose(opts: {
  id?: string;
  created_at: Date;
  node_id: string;
  expected_version: number;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('archive'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'tag_knowledge',
    action: 'experimental:knowledge_archive',
    subject_kind: 'knowledge',
    subject_id: opts.node_id,
    outcome: 'partial',
    caused_by_event_id: null,
    payload: {
      node_id: opts.node_id,
      expected_version: opts.expected_version,
      reasoning: 'because',
    },
  };
}

function genesis(opts: {
  id?: string;
  created_at: Date;
  // a full KnowledgeRowSnapshot (the seed)
  row: {
    id: string;
    name: string;
    domain: string | null;
    parent_id: string | null;
    merged_from: string[];
    archived_at: Date | null;
    proposed_by_ai: boolean;
    approval_status: 'pending' | 'approved' | 'rejected';
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}): FoldEvent {
  return {
    id: opts.id ?? nextId('genesis'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'knowledge',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

function autoTag(opts: {
  id?: string;
  created_at: Date;
  kcId: string;
  name: string;
  parent_id: string;
}): FoldEvent {
  return {
    id: opts.id ?? nextId('autotag'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'tag_knowledge',
    action: 'experimental:auto_tag_kc_created',
    subject_kind: 'knowledge',
    subject_id: opts.kcId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: {
      source: 'tag_knowledge',
      auto_created_kc_id: opts.kcId,
      subject_root_id: opts.parent_id,
      parent_id: opts.parent_id,
      name: opts.name,
      generated_by: 'tag_knowledge',
      reasoning: 'auto',
    },
  };
}

// An unrelated event (attempt) that must be ignored by the knowledge fold.
function unrelatedAttempt(created_at: Date): FoldEvent {
  return {
    id: nextId('attempt'),
    created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_1',
    outcome: 'success',
    caused_by_event_id: null,
    payload: {
      answer_md: 'x',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
  };
}

// ---------- tests ----------

describe('foldKnowledgeNode', () => {
  it('returns null for an unknown / never-created node', () => {
    expect(foldKnowledgeNode('k_never', [])).toBeNull();
    expect(foldKnowledgeNode('k_never', [unrelatedAttempt(at(1))])).toBeNull();
  });

  it('creates a row via propose_new + accept, with row.id from materialized_ids', () => {
    const p = proposeNew({ created_at: at(10), name: 'Photosynthesis', parent_id: 'k_root' });
    const r = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_new'],
    });
    const row = foldKnowledgeNode('k_new', [p, r]);
    expect(row).not.toBeNull();
    expect(row?.id).toBe('k_new');
    expect(row?.name).toBe('Photosynthesis');
    expect(row?.parent_id).toBe('k_root');
    expect(row?.domain).toBeNull();
    expect(row?.merged_from).toEqual([]);
    expect(row?.archived_at).toBeNull();
    expect(row?.proposed_by_ai).toBe(true);
    expect(row?.approval_status).toBe('approved');
    expect(row?.version).toBe(0);
    // ACCEPT-TIME: row timestamps = the ACCEPT event's created_at (at(11)), NOT the
    // propose event's (at(10)) — the imperative applyProposeNew stamps `now` at
    // accept-time.
    expect(row?.created_at).toEqual(at(11));
    expect(row?.updated_at).toEqual(at(11));
  });

  it('stamps propose_new row created_at from the ACCEPT event, not the propose event', () => {
    // propose at T1, accept at T2 → row.created_at === T2 (accept-time, the
    // materialization moment), proving the fold keys timestamps off the rate event.
    const T1 = at(1000);
    const T2 = at(9000);
    const p = proposeNew({ created_at: T1, name: 'Delayed', parent_id: 'k_root' });
    const r = rate({
      created_at: T2,
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_delayed'],
    });
    const row = foldKnowledgeNode('k_delayed', [p, r]);
    expect(row?.created_at).toEqual(T2);
    expect(row?.updated_at).toEqual(T2);
  });

  it('ignores a propose with NO accept (still pending)', () => {
    const p = proposeNew({ created_at: at(10), name: 'X', parent_id: 'k_root' });
    // no rate event minted any id; even if we GUESS the id, nothing was created
    expect(foldKnowledgeNode('k_new', [p])).toBeNull();
  });

  it('ignores a propose whose rate is dismiss (accepted-only gate)', () => {
    const p = proposeNew({ created_at: at(10), name: 'X', parent_id: 'k_root' });
    const r = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'dismiss',
      // dismiss mints nothing; even if knowledge listed, the gate is rating
      materializedKnowledge: ['k_new'],
    });
    expect(foldKnowledgeNode('k_new', [p, r])).toBeNull();
  });

  it('reparent: sets parent_id, domain=null, version+1', () => {
    const p = proposeNew({ created_at: at(10), name: 'X', parent_id: 'k_root' });
    const rp = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_new'],
    });
    const mut = mutationPropose({
      created_at: at(20),
      action: 'experimental:knowledge_reparent',
      subject_id: 'k_new',
      payload: { node_id: 'k_new', new_parent_id: 'k_other', expected_version: 0 },
    });
    const rm = rate({ created_at: at(21), causedBy: mut.id, rating: 'accept' });
    const row = foldKnowledgeNode('k_new', [p, rp, mut, rm]);
    expect(row?.parent_id).toBe('k_other');
    expect(row?.domain).toBeNull();
    expect(row?.version).toBe(1);
    // ACCEPT-TIME: updated_at = the reparent ACCEPT (at(21)); created_at = the
    // propose_new ACCEPT (at(11)) — both keyed off their rate events, not proposes.
    expect(row?.updated_at).toEqual(at(21));
    expect(row?.created_at).toEqual(at(11));
  });

  it('archive via merge from_id: sets archived_at + version+1', () => {
    // archive of a node = appearing as a from_id of an accepted merge
    const pInto = proposeNew({ created_at: at(1), name: 'Into', parent_id: 'k_root' });
    const rInto = rate({
      created_at: at(2),
      causedBy: pInto.id,
      rating: 'accept',
      materializedKnowledge: ['k_into'],
    });
    const pFrom = proposeNew({ created_at: at(3), name: 'From', parent_id: 'k_root' });
    const rFrom = rate({
      created_at: at(4),
      causedBy: pFrom.id,
      rating: 'accept',
      materializedKnowledge: ['k_from'],
    });
    const merge = mutationPropose({
      created_at: at(30),
      action: 'experimental:knowledge_merge',
      subject_id: 'k_into',
      payload: {
        from_ids: ['k_from'],
        into_id: 'k_into',
        expected_versions: { k_from: 0 },
      },
    });
    const rMerge = rate({ created_at: at(31), causedBy: merge.id, rating: 'accept' });
    const events = [pInto, rInto, pFrom, rFrom, merge, rMerge];

    // ACCEPT-TIME: merge effects stamp at the merge ACCEPT (at(31)), not the merge
    // propose (at(30)).
    const fromRow = foldKnowledgeNode('k_from', events);
    expect(fromRow?.archived_at).toEqual(at(31));
    expect(fromRow?.version).toBe(1);

    const intoRow = foldKnowledgeNode('k_into', events);
    expect(intoRow?.merged_from).toEqual(['k_from']);
    expect(intoRow?.archived_at).toBeNull();
    expect(intoRow?.version).toBe(1);
  });

  it('archive (experimental:knowledge_archive): sets archived_at + version+1', () => {
    const p = proposeNew({ created_at: at(10), name: 'Doomed', parent_id: 'k_root' });
    const rp = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_doomed'],
    });
    const arch = archivePropose({ created_at: at(30), node_id: 'k_doomed', expected_version: 0 });
    const ra = rate({ created_at: at(31), causedBy: arch.id, rating: 'accept' });
    const row = foldKnowledgeNode('k_doomed', [p, rp, arch, ra]);
    // ACCEPT-TIME: archive effect stamps at the archive ACCEPT (at(31)); created_at
    // is the propose_new ACCEPT (at(11)).
    expect(row?.archived_at).toEqual(at(31));
    expect(row?.version).toBe(1);
    expect(row?.updated_at).toEqual(at(31));
    expect(row?.created_at).toEqual(at(11));
  });

  it('archive with no accept (pending) leaves the node unarchived', () => {
    const p = proposeNew({ created_at: at(10), name: 'Doomed', parent_id: 'k_root' });
    const rp = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_doomed'],
    });
    const arch = archivePropose({ created_at: at(30), node_id: 'k_doomed', expected_version: 0 });
    // no rate accepting `arch` → archive must NOT apply
    const row = foldKnowledgeNode('k_doomed', [p, rp, arch]);
    expect(row?.archived_at).toBeNull();
    expect(row?.version).toBe(0);
  });

  it('split: from_id archived+1; N new rows version=0 with right names/parents', () => {
    const pFrom = proposeNew({ created_at: at(1), name: 'Whole', parent_id: 'k_root' });
    const rFrom = rate({
      created_at: at(2),
      causedBy: pFrom.id,
      rating: 'accept',
      materializedKnowledge: ['k_whole'],
    });
    const split = mutationPropose({
      created_at: at(40),
      action: 'experimental:knowledge_split',
      subject_id: 'k_whole',
      payload: {
        from_id: 'k_whole',
        into: [
          { name: 'PartA', parent_id: 'k_root' },
          { name: 'PartB', parent_id: 'k_other' },
        ],
        expected_version: 0,
      },
    });
    // materialized_ids.knowledge order matches into[] order
    const rSplit = rate({
      created_at: at(41),
      causedBy: split.id,
      rating: 'accept',
      materializedKnowledge: ['k_partA', 'k_partB'],
    });
    const events = [pFrom, rFrom, split, rSplit];

    // ACCEPT-TIME: split effects stamp at the split ACCEPT (at(41)), not the split
    // propose (at(40)).
    const whole = foldKnowledgeNode('k_whole', events);
    expect(whole?.archived_at).toEqual(at(41));
    expect(whole?.version).toBe(1);

    const a = foldKnowledgeNode('k_partA', events);
    expect(a?.name).toBe('PartA');
    expect(a?.parent_id).toBe('k_root');
    expect(a?.version).toBe(0);
    expect(a?.archived_at).toBeNull();
    expect(a?.created_at).toEqual(at(41));

    const b = foldKnowledgeNode('k_partB', events);
    expect(b?.name).toBe('PartB');
    expect(b?.parent_id).toBe('k_other');
    expect(b?.version).toBe(0);
  });

  it('genesis seed establishes the base state, then a mutation applies on top', () => {
    const g = genesis({
      created_at: at(0),
      row: {
        id: 'k_seed',
        name: 'Seeded',
        domain: 'biology',
        parent_id: 'k_root',
        merged_from: [],
        archived_at: null,
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: at(-1000),
        updated_at: at(-1000),
        version: 3,
      },
    });
    // seed-only: row is the snapshot verbatim
    const seeded = foldKnowledgeNode('k_seed', [g]);
    expect(seeded?.name).toBe('Seeded');
    expect(seeded?.domain).toBe('biology');
    expect(seeded?.version).toBe(3);
    expect(seeded?.created_at).toEqual(at(-1000));

    // reparent on top: version 3 -> 4, domain nulled
    const mut = mutationPropose({
      created_at: at(50),
      action: 'experimental:knowledge_reparent',
      subject_id: 'k_seed',
      payload: { node_id: 'k_seed', new_parent_id: 'k_new_parent', expected_version: 3 },
    });
    const rm = rate({ created_at: at(51), causedBy: mut.id, rating: 'accept' });
    const after = foldKnowledgeNode('k_seed', [g, mut, rm]);
    expect(after?.version).toBe(4);
    expect(after?.parent_id).toBe('k_new_parent');
    expect(after?.domain).toBeNull();
    // ACCEPT-TIME: updated_at = the reparent ACCEPT (at(51)), not the propose (at(50)).
    expect(after?.updated_at).toEqual(at(51));
  });

  it('auto_tag_kc_created creates a KC row keyed on subject_id', () => {
    const tag = autoTag({ created_at: at(5), kcId: 'k_auto', name: 'AutoKC', parent_id: 'k_root' });
    const row = foldKnowledgeNode('k_auto', [tag]);
    expect(row?.id).toBe('k_auto');
    expect(row?.name).toBe('AutoKC');
    expect(row?.parent_id).toBe('k_root');
    expect(row?.proposed_by_ai).toBe(true);
    expect(row?.approval_status).toBe('approved');
    expect(row?.version).toBe(0);
    expect(row?.created_at).toEqual(at(5));
  });

  it('ignores unrelated / irrelevant events (attempts, other nodes)', () => {
    const p = proposeNew({ created_at: at(10), name: 'Mine', parent_id: 'k_root' });
    const r = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_mine'],
    });
    const otherP = proposeNew({ created_at: at(12), name: 'Other', parent_id: 'k_root' });
    const otherR = rate({
      created_at: at(13),
      causedBy: otherP.id,
      rating: 'accept',
      materializedKnowledge: ['k_other'],
    });
    const events = [unrelatedAttempt(at(1)), p, r, otherP, otherR, unrelatedAttempt(at(99))];
    const row = foldKnowledgeNode('k_mine', events);
    expect(row?.id).toBe('k_mine');
    expect(row?.name).toBe('Mine');
    // the other node folds to its own row, unaffected
    expect(foldKnowledgeNode('k_other', events)?.name).toBe('Other');
  });

  it('is order-stable: shuffling the input array yields identical output', () => {
    const g = genesis({
      created_at: at(0),
      row: {
        id: 'k_x',
        name: 'X',
        domain: null,
        parent_id: 'k_root',
        merged_from: [],
        archived_at: null,
        proposed_by_ai: true,
        approval_status: 'approved',
        created_at: at(0),
        updated_at: at(0),
        version: 0,
      },
    });
    const mut1 = mutationPropose({
      created_at: at(10),
      action: 'experimental:knowledge_reparent',
      subject_id: 'k_x',
      payload: { node_id: 'k_x', new_parent_id: 'k_p1', expected_version: 0 },
    });
    const r1 = rate({ created_at: at(11), causedBy: mut1.id, rating: 'accept' });
    const mut2 = mutationPropose({
      created_at: at(20),
      action: 'experimental:knowledge_reparent',
      subject_id: 'k_x',
      payload: { node_id: 'k_x', new_parent_id: 'k_p2', expected_version: 1 },
    });
    const r2 = rate({ created_at: at(21), causedBy: mut2.id, rating: 'accept' });

    const inOrder = [g, mut1, r1, mut2, r2];
    const shuffled = [r2, mut2, r1, g, mut1];
    const a = foldKnowledgeNode('k_x', inOrder);
    const b = foldKnowledgeNode('k_x', shuffled);
    expect(a).toEqual(b);
    // final state reflects the LAST reparent (mut2) by created_at order
    expect(a?.parent_id).toBe('k_p2');
    expect(a?.version).toBe(2);
  });

  it('is pure / deterministic: same input twice → deep-equal output (no Date/newId)', () => {
    const p = proposeNew({ created_at: at(10), name: 'Det', parent_id: 'k_root' });
    const r = rate({
      created_at: at(11),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_det'],
    });
    const events = [p, r];
    const first = foldKnowledgeNode('k_det', events);
    const second = foldKnowledgeNode('k_det', events);
    expect(first).toEqual(second);
    // determinism over time: a fresh build of the SAME logical input is identical
    // (proves no Date.now()/new Date() inside — the only timestamps come from the
    // events' created_at, which we control).
    const rebuilt = foldKnowledgeNode('k_det', [
      proposeNew({ id: p.id, created_at: at(10), name: 'Det', parent_id: 'k_root' }),
      rate({
        id: r.id,
        created_at: at(11),
        causedBy: p.id,
        rating: 'accept',
        materializedKnowledge: ['k_det'],
      }),
    ]);
    expect(rebuilt).toEqual(first);
  });

  it('tiebreaks events with identical created_at by id (stable application order)', () => {
    // Two reparents at the SAME created_at; (created_at,id) order must be stable.
    const p = proposeNew({ id: 'aaa_propose', created_at: at(0), name: 'T', parent_id: 'k_root' });
    const r = rate({
      id: 'aab_rate',
      created_at: at(0),
      causedBy: p.id,
      rating: 'accept',
      materializedKnowledge: ['k_t'],
    });
    // both mutations share created_at=at(100); id order zzz_a < zzz_b decides
    const mutA = mutationPropose({
      id: 'zzz_a',
      created_at: at(100),
      action: 'experimental:knowledge_reparent',
      subject_id: 'k_t',
      payload: { node_id: 'k_t', new_parent_id: 'k_pA', expected_version: 0 },
    });
    const rA = rate({ id: 'zzz_a_rate', created_at: at(100), causedBy: mutA.id, rating: 'accept' });
    const mutB = mutationPropose({
      id: 'zzz_b',
      created_at: at(100),
      action: 'experimental:knowledge_reparent',
      subject_id: 'k_t',
      payload: { node_id: 'k_t', new_parent_id: 'k_pB', expected_version: 1 },
    });
    const rB = rate({ id: 'zzz_b_rate', created_at: at(100), causedBy: mutB.id, rating: 'accept' });
    const out = foldKnowledgeNode('k_t', [mutB, rB, mutA, rA, p, r]);
    // mutA (id zzz_a) applies before mutB (id zzz_b) → final parent is k_pB
    expect(out?.parent_id).toBe('k_pB');
    expect(out?.version).toBe(2);
  });
});
