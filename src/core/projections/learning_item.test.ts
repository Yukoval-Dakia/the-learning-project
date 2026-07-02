import { describe, expect, it } from 'vitest';
import type { LearningItemRowSnapshotT } from '../schema/event/genesis';
import type { FoldEvent } from './fold-event';
import { applyKnowledgeMergeToIds, foldLearningItem } from './learning_item';

// ====================================================================
// foldLearningItem — pure learning_item reducer unit tests (YUK-471 Wave 2).
//
// No DB, no IO. Every event is constructed in-memory as a flat FoldEvent. The reducer safeParses
// internally; passing plain objects matching the schema shapes exercises that path.
//
// BASE = experimental:genesis only (design §3②/§3⑥ — learning_item has NO fold-blind field, so
// the INSERT sites write a per-id genesis as the BASE, not a dedicated create event). Then the W2
// action events: complete (→done, completed_at, version+1) / relearn (→in_progress, completed_at
// cleared, version+1) / archive (→archived_at + archived_reason, NO version bump).
//
// EXCLUDED columns (child_learning_item_ids / ai_score / due_at / reviewed_at) are NOT part of the
// snapshot, so a row that differs ONLY in those columns folds clean (they never enter parity).
// TERMINAL-STATUS GUARD: each transition applies ONLY when the row matches the imperative writer's
// WHERE; an out-of-window event is a no-op.
// ====================================================================

let seq = 0;
function nextId(prefix = 'evt'): string {
  seq += 1;
  return `${prefix}_${seq.toString().padStart(4, '0')}`;
}

const T0 = new Date('2026-06-25T00:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function liSnapshot(over: Partial<LearningItemRowSnapshotT> = {}): LearningItemRowSnapshotT {
  return {
    id: 'li_1',
    source: 'learning_intent',
    source_ref: 'prop_1',
    title: 'Master integrals',
    content: 'one-line intent',
    knowledge_ids: ['k_a'],
    primary_artifact_id: 'art_1',
    parent_learning_item_id: null,
    status: 'pending',
    user_pinned: false,
    completed_at: null,
    dismissed_at: null,
    archived_at: null,
    archived_reason: null,
    created_at: T0,
    updated_at: T0,
    version: 0,
    ...over,
  };
}

// experimental:genesis — the backfill / creation BASE event (the sole seed).
function genesis(opts: { created_at: Date; row: LearningItemRowSnapshotT }): FoldEvent {
  return {
    id: nextId('genesis'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'learning_item',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

function complete(opts: { created_at: Date; itemId: string }): FoldEvent {
  return {
    id: nextId('complete'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:learning_item_complete',
    subject_kind: 'learning_item',
    subject_id: opts.itemId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: {},
  };
}

function relearn(opts: { created_at: Date; itemId: string }): FoldEvent {
  return {
    id: nextId('relearn'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:learning_item_relearn',
    subject_kind: 'learning_item',
    subject_id: opts.itemId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: {},
  };
}

function archive(opts: { created_at: Date; itemId: string; reason?: string }): FoldEvent {
  return {
    id: nextId('archive'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:learning_item_archive',
    subject_kind: 'learning_item',
    subject_id: opts.itemId,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { reason: opts.reason ?? 'proposal_retracted' },
  };
}

describe('foldLearningItem — base (genesis)', () => {
  it('returns null when the item was never seeded', () => {
    expect(foldLearningItem('li_1', [])).toBeNull();
  });

  it('genesis-only folds byte-equal to the seeded snapshot', () => {
    const row = liSnapshot();
    const folded = foldLearningItem('li_1', [genesis({ created_at: T0, row })]);
    expect(folded).toEqual(row);
  });

  it('a genesis for a DIFFERENT id is ignored', () => {
    const other = liSnapshot({ id: 'li_other' });
    expect(foldLearningItem('li_1', [genesis({ created_at: T0, row: other })])).toBeNull();
  });

  it('parent_learning_item_id is carried verbatim (snapshot-only field, no event mutates it)', () => {
    const row = liSnapshot({ id: 'li_child', parent_learning_item_id: 'li_hub' });
    const folded = foldLearningItem('li_child', [genesis({ created_at: T0, row })]);
    expect(folded?.parent_learning_item_id).toBe('li_hub');
  });
});

describe('foldLearningItem — complete', () => {
  it('pending → done with completed_at + version+1', () => {
    const row = liSnapshot({ status: 'pending', version: 0 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      complete({ created_at: at(1000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('done');
    expect(folded?.completed_at?.getTime()).toBe(at(1000).getTime());
    expect(folded?.updated_at.getTime()).toBe(at(1000).getTime());
    expect(folded?.version).toBe(1);
  });

  it('in_progress → done (the other in-window status)', () => {
    const row = liSnapshot({ status: 'in_progress', version: 2 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      complete({ created_at: at(1000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('done');
    expect(folded?.version).toBe(3);
  });

  it('TERMINAL-GUARD: complete on an already-done row is a no-op (mirrors the imperative 409)', () => {
    const row = liSnapshot({ status: 'done', completed_at: T0, version: 5 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      complete({ created_at: at(1000), itemId: 'li_1' }),
    ]);
    // unchanged — the imperative writer's WHERE status IN (pending,in_progress) never matched.
    expect(folded?.status).toBe('done');
    expect(folded?.completed_at?.getTime()).toBe(T0.getTime());
    expect(folded?.version).toBe(5);
  });

  it('ARCHIVED-GUARD: complete on an archived (but pending) row is a no-op (full imperative WHERE mirror, review #3)', () => {
    // The imperative SELECT guards isNull(archived_at) before the status assert — an archived row
    // 404s before any UPDATE. The reducer mirrors the FULL WHERE: a status-match alone is not enough.
    const row = liSnapshot({
      status: 'pending',
      archived_at: T0,
      archived_reason: 'gone',
      version: 0,
    });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      complete({ created_at: at(1000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('pending'); // NOT done
    expect(folded?.completed_at).toBeNull();
    expect(folded?.version).toBe(0);
  });
});

describe('foldLearningItem — relearn', () => {
  it('done → in_progress, completed_at cleared, version+1', () => {
    const row = liSnapshot({ status: 'done', completed_at: at(500), version: 1 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      relearn({ created_at: at(2000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('in_progress');
    expect(folded?.completed_at).toBeNull();
    expect(folded?.updated_at.getTime()).toBe(at(2000).getTime());
    expect(folded?.version).toBe(2);
  });

  it('resting → in_progress (the other in-window status)', () => {
    const row = liSnapshot({ status: 'resting', version: 0 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      relearn({ created_at: at(2000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('in_progress');
    expect(folded?.version).toBe(1);
  });

  it('TERMINAL-GUARD: relearn on a pending row is a no-op (mirrors the imperative 409)', () => {
    const row = liSnapshot({ status: 'pending', version: 0 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      relearn({ created_at: at(2000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('pending');
    expect(folded?.version).toBe(0);
  });

  it('ARCHIVED-GUARD: relearn on an archived (but done) row is a no-op (full imperative WHERE mirror, review #3)', () => {
    const row = liSnapshot({
      status: 'done',
      completed_at: T0,
      archived_at: at(500),
      archived_reason: 'gone',
      version: 1,
    });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      relearn({ created_at: at(2000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('done'); // NOT in_progress
    expect(folded?.version).toBe(1);
  });

  it('complete then relearn round-trip (done → in_progress with both version bumps)', () => {
    const row = liSnapshot({ status: 'pending', version: 0 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      complete({ created_at: at(1000), itemId: 'li_1' }),
      relearn({ created_at: at(2000), itemId: 'li_1' }),
    ]);
    expect(folded?.status).toBe('in_progress');
    expect(folded?.completed_at).toBeNull();
    expect(folded?.version).toBe(2);
  });
});

describe('foldLearningItem — archive', () => {
  it('sets archived_at + archived_reason + updated_at, NO version bump (B1)', () => {
    const row = liSnapshot({ status: 'pending', version: 3 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      archive({ created_at: at(3000), itemId: 'li_1', reason: 'proposal_retracted' }),
    ]);
    expect(folded?.archived_at?.getTime()).toBe(at(3000).getTime());
    expect(folded?.archived_reason).toBe('proposal_retracted');
    expect(folded?.updated_at.getTime()).toBe(at(3000).getTime());
    expect(folded?.version).toBe(3); // NO bump (mirrors the bare retract UPDATE)
    // status is untouched by archive — archived is a tombstone timestamp, NOT a status.
    expect(folded?.status).toBe('pending');
  });

  it('TIEBREAK CAPTURE (review #1): same-ms genesis+archive with archive id sorting FIRST mis-orders WITHOUT a strict-earlier genesis', () => {
    // This is the exact failure mode the actions.ts genesis-if-missing clamp prevents at the WRITE
    // side: the reducer sorts by (created_at asc, id asc). If a genesis-if-missing and its archive
    // share created_at (same-ms, cross-tx) AND the archive's cuid2 id sorts BEFORE the genesis's,
    // the archive applies to a not-yet-seeded (null) row → no-op → the genesis then seeds an
    // UN-archived row → fold.archived_at = null. Constructed with EXPLICIT ids so the (created_at,
    // id) order is deterministic ('aaa_archive' < 'zzz_genesis').
    const row = liSnapshot({ status: 'pending', archived_at: null, version: 0 });
    const sameMs = T0;
    const genesisLate: FoldEvent = {
      id: 'zzz_genesis', // sorts AFTER the archive id at equal created_at
      created_at: sameMs,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      action: 'experimental:genesis',
      subject_kind: 'learning_item',
      subject_id: 'li_1',
      outcome: 'success',
      caused_by_event_id: null,
      payload: { row },
    };
    const archiveEarlyId: FoldEvent = {
      id: 'aaa_archive', // sorts BEFORE the genesis id at equal created_at
      created_at: sameMs,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_archive',
      subject_kind: 'learning_item',
      subject_id: 'li_1',
      outcome: 'success',
      caused_by_event_id: null,
      payload: { reason: 'proposal_retracted' },
    };
    const folded = foldLearningItem('li_1', [genesisLate, archiveEarlyId]);
    // The bug WOULD have manifested here (archive no-ops before the base exists) — captured.
    expect(folded?.archived_at).toBeNull();

    // The CLAMP fix makes the WRITER stamp genesis STRICTLY EARLIER (created_at - 1ms), so the
    // genesis always sorts first regardless of the id coin-flip → the archive lands → archived_at
    // set. (This is what actions.ts now writes.)
    const genesisEarly: FoldEvent = { ...genesisLate, created_at: new Date(sameMs.getTime() - 1) };
    const foldedFixed = foldLearningItem('li_1', [genesisEarly, archiveEarlyId]);
    expect(foldedFixed?.archived_at?.getTime()).toBe(sameMs.getTime());
    expect(foldedFixed?.archived_reason).toBe('proposal_retracted');
  });

  it('TERMINAL-GUARD: archive on an already-archived row is a no-op (idempotent retract)', () => {
    const row = liSnapshot({ archived_at: at(500), archived_reason: 'first', version: 0 });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      archive({ created_at: at(3000), itemId: 'li_1', reason: 'second' }),
    ]);
    // unchanged — WHERE archived_at IS NULL never matched, so the second archive leaves the row.
    expect(folded?.archived_at?.getTime()).toBe(at(500).getTime());
    expect(folded?.archived_reason).toBe('first');
  });
});

describe('foldLearningItem — excluded columns never enter parity', () => {
  it('the snapshot carries no child_learning_item_ids / ai_score / due_at / reviewed_at keys', () => {
    const row = liSnapshot();
    const folded = foldLearningItem('li_1', [genesis({ created_at: T0, row })]);
    expect(folded).not.toBeNull();
    const keys = Object.keys(folded as object);
    expect(keys).not.toContain('child_learning_item_ids');
    expect(keys).not.toContain('ai_score');
    expect(keys).not.toContain('due_at');
    expect(keys).not.toContain('reviewed_at');
  });

  it('user_pinned is RETAINED in the snapshot and carried verbatim from genesis', () => {
    const row = liSnapshot({ user_pinned: true });
    const folded = foldLearningItem('li_1', [genesis({ created_at: T0, row })]);
    expect(folded?.user_pinned).toBe(true);
  });
});

describe('foldLearningItem — B5 honest reject (malformed payloads at the barrier)', () => {
  it('a genesis with a sibling-entity row (goal shape) is rejected → no seed → null', () => {
    // goal carries scope_knowledge_ids + sequence_hint but NOT content/knowledge_ids — the
    // .strict() LearningItemRowSnapshot + discriminating-column check reject it.
    // A deliberately wrong-entity (goal) snapshot, cast through unknown to the genesis helper's
    // row type — the reducer must reject it at the .strict() + discriminating-column barrier.
    const goalishRow = {
      id: 'li_1',
      title: 'Goalish',
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    } as unknown as LearningItemRowSnapshotT;
    const goalish = genesis({ created_at: T0, row: goalishRow });
    expect(foldLearningItem('li_1', [goalish])).toBeNull();
  });

  it('a complete event with a stray payload key is rejected (.strict() payload) → no transition', () => {
    const row = liSnapshot({ status: 'pending' });
    const badComplete = complete({ created_at: at(1000), itemId: 'li_1' });
    // .strict() payload on LearningItemCompleteExperimental rejects an unexpected key.
    (badComplete.payload as Record<string, unknown>).stray = true;
    const folded = foldLearningItem('li_1', [genesis({ created_at: T0, row }), badComplete]);
    // the malformed complete is skipped → the row stays pending (not done).
    expect(folded?.status).toBe('pending');
    expect(folded?.version).toBe(0);
  });
});

// YUK-543 — the shared pure merge-rewrite helper (used by BOTH the imperative applyMerge writers
// and this reducer's merge branch, so fold == row).
describe('applyKnowledgeMergeToIds (YUK-543)', () => {
  it('replaces every from id with into, preserving position + deduping', () => {
    expect(applyKnowledgeMergeToIds(['a', 'x', 'b'], new Set(['a', 'b']), 'c')).toEqual(['c', 'x']);
  });
  it('returns a fresh copy unchanged when no id matches (no-op)', () => {
    const ids = ['x', 'y'];
    const out = applyKnowledgeMergeToIds(ids, new Set(['a']), 'c');
    expect(out).toEqual(['x', 'y']);
    expect(out).not.toBe(ids);
  });
  it('dedupes when into is already present', () => {
    expect(applyKnowledgeMergeToIds(['c', 'a', 'x'], new Set(['a']), 'c')).toEqual(['c', 'x']);
  });
  it('per-from single-application agrees with all-from application (order invariance)', () => {
    const ids = ['a', 'x', 'b'];
    const stepwise = applyKnowledgeMergeToIds(
      applyKnowledgeMergeToIds(ids, new Set(['a']), 'c'),
      new Set(['b']),
      'c',
    );
    const oneShot = applyKnowledgeMergeToIds(ids, new Set(['a', 'b']), 'c');
    expect(stepwise).toEqual(oneShot);
  });
});

// YUK-543 — the merge Q3 reducer branch: an ACCEPTED experimental:knowledge_merge rewrites the
// item's knowledge_ids from the absorbed from_id to the survivor into_id.
function mergeProposeEvent(opts: {
  id: string;
  created_at: Date;
  from_ids: string[];
  into_id: string;
}): FoldEvent {
  return {
    id: opts.id,
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'experimental:knowledge_merge',
    subject_kind: 'knowledge',
    subject_id: opts.into_id,
    outcome: 'partial',
    caused_by_event_id: null,
    payload: { from_ids: opts.from_ids, into_id: opts.into_id },
  };
}
function rate(opts: {
  created_at: Date;
  proposeId: string;
  rating: 'accept' | 'dismiss' | 'rollback';
}): FoldEvent {
  return {
    id: nextId('rate'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.proposeId,
    outcome: 'success',
    caused_by_event_id: opts.proposeId,
    payload: { rating: opts.rating },
  };
}

describe('foldLearningItem — knowledge_ids merge rewrite (YUK-543)', () => {
  it('an accepted merge rewrites the absorbed KC to the survivor (dedupe), other columns untouched', () => {
    const row = liSnapshot({ knowledge_ids: ['k_a', 'k_b'], version: 3 });
    const merge = mergeProposeEvent({
      id: 'merge_1',
      created_at: at(1000),
      from_ids: ['k_a'],
      into_id: 'k_c',
    });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      merge,
      rate({ created_at: at(1001), proposeId: 'merge_1', rating: 'accept' }),
    ]);
    expect(folded?.knowledge_ids).toEqual(['k_c', 'k_b']);
    // knowledge_ids-only change — no version/updated_at bump.
    expect(folded?.version).toBe(3);
    expect(folded?.updated_at).toEqual(T0);
  });

  it('a PENDING (unrated) merge does NOT rewrite', () => {
    const row = liSnapshot({ knowledge_ids: ['k_a'] });
    const merge = mergeProposeEvent({
      id: 'merge_2',
      created_at: at(1000),
      from_ids: ['k_a'],
      into_id: 'k_c',
    });
    const folded = foldLearningItem('li_1', [genesis({ created_at: T0, row }), merge]);
    expect(folded?.knowledge_ids).toEqual(['k_a']);
  });

  it('a DISMISSED merge does NOT rewrite', () => {
    const row = liSnapshot({ knowledge_ids: ['k_a'] });
    const merge = mergeProposeEvent({
      id: 'merge_3',
      created_at: at(1000),
      from_ids: ['k_a'],
      into_id: 'k_c',
    });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      merge,
      rate({ created_at: at(1001), proposeId: 'merge_3', rating: 'dismiss' }),
    ]);
    expect(folded?.knowledge_ids).toEqual(['k_a']);
  });

  it('a non-intersecting accepted merge is a no-op (row untouched)', () => {
    const row = liSnapshot({ knowledge_ids: ['k_a'], version: 2 });
    const merge = mergeProposeEvent({
      id: 'merge_4',
      created_at: at(1000),
      from_ids: ['k_zzz'],
      into_id: 'k_c',
    });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      merge,
      rate({ created_at: at(1001), proposeId: 'merge_4', rating: 'accept' }),
    ]);
    expect(folded?.knowledge_ids).toEqual(['k_a']);
    expect(folded?.version).toBe(2);
  });

  it('CHAINED merges resolve to the terminal survivor (A→B then B→C ⇒ C)', () => {
    const row = liSnapshot({ knowledge_ids: ['k_a', 'k_x'] });
    const mergeAB = mergeProposeEvent({
      id: 'merge_ab',
      created_at: at(1000),
      from_ids: ['k_a'],
      into_id: 'k_b',
    });
    const mergeBC = mergeProposeEvent({
      id: 'merge_bc',
      created_at: at(2000),
      from_ids: ['k_b'],
      into_id: 'k_c',
    });
    const folded = foldLearningItem('li_1', [
      genesis({ created_at: T0, row }),
      mergeAB,
      rate({ created_at: at(1001), proposeId: 'merge_ab', rating: 'accept' }),
      mergeBC,
      rate({ created_at: at(2001), proposeId: 'merge_bc', rating: 'accept' }),
    ]);
    expect(folded?.knowledge_ids).toEqual(['k_c', 'k_x']);
  });
});
