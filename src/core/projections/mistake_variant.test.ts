import { describe, expect, it } from 'vitest';
import type { MistakeVariantRowSnapshotT } from '../schema/event/genesis';
import type { FoldEvent } from './fold-event';
import { foldMistakeVariant } from './mistake_variant';

// ====================================================================
// foldMistakeVariant — pure mistake_variant reducer unit tests (YUK-471 Wave 2).
//
// No DB, no IO. Every event is constructed in-memory as a flat FoldEvent. The reducer safeParses
// internally; passing plain objects matching the schema shapes exercises that path.
//
// BASE EVENT (critic A4): the row's initial state comes from EITHER experimental:genesis (backfill,
// pre-W2 rows) OR experimental:mistake_variant_create (runtime creation) — BOTH carry the full
// initial snapshot INCLUDING the fold-blind cause_category. The headline assertion is that
// cause_category SURVIVES the fold (it is reproduced from the base event, never recomputed).
//
// EVENT CHAIN: base → E2 accept (rate, payload.rating='accept', materialized_question_id → active +
// variant_question_id) / E3 verify (experimental:variant_verify, verdict fail → broken +
// failure_reasons / pass → touch updated_at) / E4 dismiss (rate, rating='dismiss' → dismissed) /
// E5 retract (correct, correction_kind='retract' → dismissed). NO version column.
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

function mvSnapshot(over: Partial<MistakeVariantRowSnapshotT> = {}): MistakeVariantRowSnapshotT {
  return {
    id: 'mv_1',
    parent_question_id: 'q_parent',
    variant_question_id: null,
    proposal_event_id: 'evt_propose',
    status: 'draft',
    failure_reasons: [],
    cause_category: 'concept_confusion',
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

// experimental:mistake_variant_create — the runtime creation BASE event (critic A4).
function create(opts: { created_at: Date; row: MistakeVariantRowSnapshotT }): FoldEvent {
  return {
    id: nextId('create'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'variant_gen',
    action: 'experimental:mistake_variant_create',
    subject_kind: 'mistake_variant',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

// experimental:genesis — the backfill BASE event.
function genesis(opts: { created_at: Date; row: MistakeVariantRowSnapshotT }): FoldEvent {
  return {
    id: nextId('genesis'),
    created_at: opts.created_at,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'mistake_variant',
    subject_id: opts.row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row: opts.row },
  };
}

// E2 accept — a rate event chained to the variant_question proposal (proposal_event_id). subject is
// the proposal (subject_kind='event'), payload.rating='accept' + materialized_question_id.
function rateAccept(opts: {
  created_at: Date;
  proposalId: string;
  materializedQuestionId: string;
  mvId?: string;
}): FoldEvent {
  return {
    id: nextId('accept'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.proposalId,
    outcome: 'success',
    caused_by_event_id: opts.proposalId,
    payload: {
      rating: 'accept',
      materialized_question_id: opts.materializedQuestionId,
      mistake_variant_id: opts.mvId ?? 'mv_1',
    },
  };
}

// E4 dismiss — a rate event chained to the proposal, payload.rating='dismiss'.
function rateDismiss(opts: { created_at: Date; proposalId: string }): FoldEvent {
  return {
    id: nextId('dismiss'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.proposalId,
    outcome: 'success',
    caused_by_event_id: opts.proposalId,
    payload: { rating: 'dismiss' },
  };
}

// E3 verify — experimental:variant_verify chained to the proposal. verdict fail → broken.
function verify(opts: {
  created_at: Date;
  proposalId: string;
  variantQuestionId: string;
  verdict: 'pass' | 'fail';
  failureReasons?: string[];
}): FoldEvent {
  return {
    id: nextId('verify'),
    created_at: opts.created_at,
    actor_kind: 'agent',
    actor_ref: 'variant_verify',
    action: 'experimental:variant_verify',
    subject_kind: 'question',
    subject_id: opts.variantQuestionId,
    outcome: opts.verdict === 'pass' ? 'success' : 'partial',
    caused_by_event_id: opts.proposalId,
    payload: {
      verdict: opts.verdict,
      failure_reasons: opts.failureReasons ?? [],
    },
  };
}

// E5 retract — a correct event chained to the proposal, payload.correction_kind='retract'.
function correctRetract(opts: { created_at: Date; proposalId: string }): FoldEvent {
  return {
    id: nextId('correct'),
    created_at: opts.created_at,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.proposalId,
    outcome: 'success',
    caused_by_event_id: opts.proposalId,
    payload: { correction_kind: 'retract', reason_md: 'retracted' },
  };
}

describe('foldMistakeVariant — base event (create vs genesis)', () => {
  it('seeds the full row from the create event verbatim (incl cause_category)', () => {
    const snap = mvSnapshot({ cause_category: 'careless_slip', status: 'draft' });
    const row = foldMistakeVariant('mv_1', [create({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('seeds the full row from a backfill genesis verbatim (incl cause_category)', () => {
    const snap = mvSnapshot({ cause_category: 'method_gap', status: 'active' });
    const row = foldMistakeVariant('mv_1', [genesis({ created_at: at(0), row: snap })]);
    expect(row).toEqual(snap);
  });

  it('returns null when no base event seeds/creates the row', () => {
    expect(foldMistakeVariant('mv_unknown', [])).toBeNull();
  });
});

describe('foldMistakeVariant — cause_category survives the fold (headline, fold-blindness fix)', () => {
  it('reproduces cause_category through the full create→accept→verify(pass) chain', () => {
    const snap = mvSnapshot({
      cause_category: 'concept_confusion',
      proposal_event_id: 'evt_propose',
    });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_propose',
        materializedQuestionId: 'q_variant',
      }),
      verify({
        created_at: at(2000),
        proposalId: 'evt_propose',
        variantQuestionId: 'q_variant',
        verdict: 'pass',
      }),
    ]);
    // cause_category is NEVER carried by accept/verify — it survives ONLY because the base event
    // snapshotted it (the fold-blindness compensation, critic A4).
    expect(row?.cause_category).toBe('concept_confusion');
    expect(row?.status).toBe('active');
    expect(row?.variant_question_id).toBe('q_variant');
  });
});

describe('foldMistakeVariant — E2 accept', () => {
  it('accept flips draft → active, sets variant_question_id, stamps updated_at', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_propose',
        materializedQuestionId: 'q_variant',
      }),
    ]);
    expect(row?.status).toBe('active');
    expect(row?.variant_question_id).toBe('q_variant');
    expect(row?.updated_at.getTime()).toBe(at(1000).getTime());
  });
});

describe('foldMistakeVariant — E3 verify', () => {
  it('verify FAIL flips active → broken with failure_reasons', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_propose',
        materializedQuestionId: 'q_variant',
      }),
      verify({
        created_at: at(2000),
        proposalId: 'evt_propose',
        variantQuestionId: 'q_variant',
        verdict: 'fail',
        failureReasons: ['off-target', 'too easy'],
      }),
    ]);
    expect(row?.status).toBe('broken');
    expect(row?.failure_reasons).toEqual(['off-target', 'too easy']);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
  });

  it('verify PASS touches updated_at only (status stays active)', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_propose',
        materializedQuestionId: 'q_variant',
      }),
      verify({
        created_at: at(2000),
        proposalId: 'evt_propose',
        variantQuestionId: 'q_variant',
        verdict: 'pass',
      }),
    ]);
    expect(row?.status).toBe('active');
    expect(row?.failure_reasons).toEqual([]);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
  });
});

describe('foldMistakeVariant — E4 dismiss / E5 retract', () => {
  it('dismiss flips draft → dismissed', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateDismiss({ created_at: at(1000), proposalId: 'evt_propose' }),
    ]);
    expect(row?.status).toBe('dismissed');
    expect(row?.updated_at.getTime()).toBe(at(1000).getTime());
  });

  it('retract flips active → dismissed (correct/retract chained to the proposal)', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_propose',
        materializedQuestionId: 'q_variant',
      }),
      correctRetract({ created_at: at(2000), proposalId: 'evt_propose' }),
    ]);
    expect(row?.status).toBe('dismissed');
    expect(row?.variant_question_id).toBe('q_variant'); // preserved
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime());
  });

  it('retract from draft → dismissed too', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      correctRetract({ created_at: at(2000), proposalId: 'evt_propose' }),
    ]);
    expect(row?.status).toBe('dismissed');
  });

  // ── BLOCKER boundary (review fix) — retract is a NO-OP on a terminal (broken|dismissed) row ──
  //
  // The imperative writer (actions.ts retractAiProposal) guards BOTH its SELECT and its UPDATE
  // WHERE on `inArray(status, ['draft','active'])`, so a broken / dismissed row is NEVER touched
  // by retract. retractAiProposal only requireProposal (not assertPending), so a retract `correct`
  // event CAN be written after a verify-FAIL or a dismiss — the fold sees it and MUST mirror the
  // imperative no-op (status-guard), else fold != row. (foldGoal has the same guard, goal.ts:208.)
  it('retract is a NO-OP on a BROKEN row (verify-FAIL then retract → status stays broken)', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_propose',
        materializedQuestionId: 'q_variant',
      }),
      verify({
        created_at: at(2000),
        proposalId: 'evt_propose',
        variantQuestionId: 'q_variant',
        verdict: 'fail',
        failureReasons: ['off-target'],
      }),
      correctRetract({ created_at: at(3000), proposalId: 'evt_propose' }),
    ]);
    // imperative retract excludes broken → live row stays broken at the verify-FAIL timestamp.
    expect(row?.status).toBe('broken');
    expect(row?.failure_reasons).toEqual(['off-target']);
    expect(row?.updated_at.getTime()).toBe(at(2000).getTime()); // NOT bumped to the retract time
  });

  it('retract is a NO-OP on a DISMISSED row (dismiss then retract → updated_at unchanged)', () => {
    const snap = mvSnapshot({ status: 'draft', proposal_event_id: 'evt_propose' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap }),
      rateDismiss({ created_at: at(1000), proposalId: 'evt_propose' }),
      correctRetract({ created_at: at(2000), proposalId: 'evt_propose' }),
    ]);
    // imperative retract excludes dismissed → live row keeps the dismiss-time updated_at.
    expect(row?.status).toBe('dismissed');
    expect(row?.updated_at.getTime()).toBe(at(1000).getTime()); // NOT overwritten by the retract
  });
});

describe('foldMistakeVariant — isolation', () => {
  it('ignores events for other mistake_variant ids + other proposals (superset input)', () => {
    const snap1 = mvSnapshot({ id: 'mv_1', proposal_event_id: 'evt_p1' });
    const snap2 = mvSnapshot({ id: 'mv_2', proposal_event_id: 'evt_p2' });
    const row = foldMistakeVariant('mv_1', [
      create({ created_at: at(0), row: snap1 }),
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_p1',
        materializedQuestionId: 'q_v1',
        mvId: 'mv_1',
      }),
      create({ created_at: at(0), row: snap2 }),
      // an accept for mv_2's proposal must NOT affect mv_1
      rateAccept({
        created_at: at(1000),
        proposalId: 'evt_p2',
        materializedQuestionId: 'q_v2',
        mvId: 'mv_2',
      }),
    ]);
    expect(row?.id).toBe('mv_1');
    expect(row?.variant_question_id).toBe('q_v1');
  });
});
