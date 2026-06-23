// YUK-471 Wave 0 (ADR-0044 §3) — attempt-tx `experimental:state_snapshot` append.
//
// Group B (tests 8-11) — the solo /api/review/submit attempt tx appends EXACTLY
//   one experimental:state_snapshot whose θ̂/FSRS before/after EXACTLY bracket the
//   real mastery_state / material_fsrs_state transition the attempt performed.
// Group C (tests 12-13) — the snapshot row skips the memory outbox (ingest_at
//   non-NULL at INSERT), while the attempt's own review event has ingest_at NULL.
//
// ANTI-TAUTOLOGY (w0-PLAN §6.8): `after` is read from the LIVE mastery_state /
//   material_fsrs_state row AFTER commit (the independent oracle), NOT trusted
//   from the snapshot payload. `before` is the seeded value / row-absence (the
//   other independent oracle). The snapshot payload is the SUBJECT under test —
//   we compare it AGAINST the live rows, never against itself.

import { newId } from '@/core/ids';
import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import { event, mastery_state, material_fsrs_state, question } from '@/db/schema';
import { getFsrsState } from '@/server/fsrs/state';
import { getMasteryState } from '@/server/mastery/state';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './submit';

const QUESTION_BASE = {
  kind: 'short_answer' as const,
  reference_md: null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(id: string, overrides: Partial<typeof question.$inferInsert> = {}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `Prompt for ${id}`,
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
    ...overrides,
  });
}

function submitReq(body: unknown) {
  return new Request('http://localhost/api/review/submit', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** Read the single state_snapshot event for an attempt event id (parsed). */
async function readSnapshot(attemptEventId: string) {
  const db = testDb();
  const rows = await db
    .select()
    .from(event)
    .where(
      and(eq(event.action, 'experimental:state_snapshot'), eq(event.subject_id, attemptEventId)),
    );
  return rows;
}

describe('YUK-471 W0 — solo submit appends experimental:state_snapshot', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Test 8 — exactly one snapshot per attempt, correctly anchored to the review event.
  it('appends exactly one state_snapshot per attempt, anchored to the review event', async () => {
    await seedQuestion('q_snap1', { knowledge_ids: ['kc_snap1'] });

    const res = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_snap1' }, rating: 'good' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review_event: { id: string } };
    const reviewEventId = body.review_event.id;

    const snaps = await readSnapshot(reviewEventId);
    expect(snaps).toHaveLength(1);
    const snap = snaps[0];
    expect(snap.subject_kind).toBe('event');
    expect(snap.subject_id).toBe(reviewEventId);
    expect(snap.caused_by_event_id).toBe(reviewEventId);
    expect(snap.actor_kind).toBe('system');
    // The dedicated schema parses it (HARD REQ 1 — proves the parse barrier routed
    // to StateSnapshotExperimental, not the loose generic fallback).
    const parsed = StateSnapshotExperimental.parse({
      actor_kind: snap.actor_kind,
      actor_ref: snap.actor_ref,
      action: snap.action,
      subject_kind: snap.subject_kind,
      subject_id: snap.subject_id,
      outcome: snap.outcome,
      payload: snap.payload,
      caused_by_event_id: snap.caused_by_event_id ?? undefined,
    });
    expect(parsed.payload.attempt_event_id).toBe(reviewEventId);
  });

  // Test 9 — θ̂ before/after bracket the real mastery_state transition.
  //   (a) seeded KC (before = seeded θ̂, after = live posterior).
  //   (b) cold-start KC (before = null, after = live seeded θ̂).
  it('θ̂ snapshot before/after match the live mastery_state transition (seeded + cold-start)', async () => {
    const db = testDb();

    // (a) seeded KC — a pre-existing mastery_state row with a real prior θ̂.
    await seedQuestion('q_seeded', { knowledge_ids: ['kc_seeded'] });
    const seededTheta = 0.42;
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: 'kc_seeded',
      theta_hat: seededTheta,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: new Date(),
      updated_at: new Date(),
    });

    const resSeeded = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_seeded' }, rating: 'good' }),
    );
    expect(resSeeded.status).toBe(200);
    const reviewSeeded = ((await resSeeded.json()) as { review_event: { id: string } }).review_event
      .id;

    // ORACLE: read the live posterior row (independent of the snapshot payload).
    const liveSeeded = await getMasteryState(db, 'kc_seeded');
    expect(liveSeeded).not.toBeNull();
    const livePosterior = (liveSeeded as { theta_hat: number }).theta_hat;
    // sanity: a graded success moved θ̂ off the seeded value.
    expect(livePosterior).not.toBe(seededTheta);

    const snapSeeded = (await readSnapshot(reviewSeeded))[0];
    const payloadSeeded = StateSnapshotExperimental.parse({
      actor_kind: snapSeeded.actor_kind,
      actor_ref: snapSeeded.actor_ref,
      action: snapSeeded.action,
      subject_kind: snapSeeded.subject_kind,
      subject_id: snapSeeded.subject_id,
      outcome: snapSeeded.outcome,
      payload: snapSeeded.payload,
    }).payload;
    const thetaSeeded = payloadSeeded.theta_snapshots.find((t) => t.kc_id === 'kc_seeded');
    expect(thetaSeeded).toBeDefined();
    // before = seeded prior θ̂ (the independent oracle, NOT read from the snapshot).
    // 8 digits, not 10: jsonb stores a double with a ~1e-8 round-trip delta vs the
    // live row read back through Drizzle — still proves the snapshot brackets the
    // EXACT transition (not a tautology — before/after come from independent oracles).
    expect(thetaSeeded?.before).toBeCloseTo(seededTheta, 6);
    // after = the LIVE posterior θ̂ (independent oracle).
    expect(thetaSeeded?.after).toBeCloseTo(livePosterior, 6);

    // (b) cold-start KC — no prior mastery_state row → before MUST be null.
    await seedQuestion('q_cold', { knowledge_ids: ['kc_cold'] });
    const preCold = await getMasteryState(db, 'kc_cold');
    expect(preCold).toBeNull(); // confirm cold-start precondition

    const resCold = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_cold' }, rating: 'good' }),
    );
    expect(resCold.status).toBe(200);
    const reviewCold = ((await resCold.json()) as { review_event: { id: string } }).review_event.id;

    const liveCold = await getMasteryState(db, 'kc_cold');
    expect(liveCold).not.toBeNull();
    const liveColdTheta = (liveCold as { theta_hat: number }).theta_hat;

    const snapCold = (await readSnapshot(reviewCold))[0];
    const payloadCold = StateSnapshotExperimental.parse({
      actor_kind: snapCold.actor_kind,
      actor_ref: snapCold.actor_ref,
      action: snapCold.action,
      subject_kind: snapCold.subject_kind,
      subject_id: snapCold.subject_id,
      outcome: snapCold.outcome,
      payload: snapCold.payload,
    }).payload;
    const thetaCold = payloadCold.theta_snapshots.find((t) => t.kc_id === 'kc_cold');
    expect(thetaCold).toBeDefined();
    // cold-start → before is null (NOT 0 — preserves the null≠0 distinction).
    expect(thetaCold?.before).toBeNull();
    expect(thetaCold?.after).toBeCloseTo(liveColdTheta, 6);
  });

  // Test 10 — FSRS before/after bracket the real material_fsrs_state transition.
  it('FSRS snapshot before/after match the live material_fsrs_state transition (cold-start)', async () => {
    const db = testDb();
    // Cold-start subject: no prior material_fsrs_state row → before MUST be null.
    await seedQuestion('q_fsrs', { knowledge_ids: ['kc_fsrs'] });
    const preFsrs = await getFsrsState(db, 'knowledge', 'kc_fsrs');
    expect(preFsrs).toBeNull(); // confirm cold-start precondition

    const res = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_fsrs' }, rating: 'good' }),
    );
    expect(res.status).toBe(200);
    const reviewEventId = ((await res.json()) as { review_event: { id: string } }).review_event.id;

    // ORACLE: the live FSRS row after commit (independent of snapshot payload).
    const liveFsrs = await getFsrsState(db, 'knowledge', 'kc_fsrs');
    expect(liveFsrs).not.toBeNull();
    const liveCard = (liveFsrs as { state: { stability: number; reps: number } }).state;

    const snap = (await readSnapshot(reviewEventId))[0];
    const payload = StateSnapshotExperimental.parse({
      actor_kind: snap.actor_kind,
      actor_ref: snap.actor_ref,
      action: snap.action,
      subject_kind: snap.subject_kind,
      subject_id: snap.subject_id,
      outcome: snap.outcome,
      payload: snap.payload,
    }).payload;
    const fsrsSnap = payload.fsrs_snapshots.find(
      (f) => f.subject_kind === 'knowledge' && f.subject_id === 'kc_fsrs',
    );
    expect(fsrsSnap).toBeDefined();
    // cold-start → before null.
    expect(fsrsSnap?.before).toBeNull();
    // after = the LIVE card (independent oracle) — compare load-bearing fields.
    expect(fsrsSnap?.after.stability).toBeCloseTo(liveCard.stability, 8);
    expect(fsrsSnap?.after.reps).toBe(liveCard.reps);
  });

  // Test 10b — FSRS before is captured when a prior card exists (non-null oracle).
  it('FSRS snapshot before == the prior live card when a card already exists', async () => {
    const db = testDb();
    await seedQuestion('q_fsrs2', { knowledge_ids: ['kc_fsrs2'] });

    // First submit creates the card.
    const res1 = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_fsrs2' }, rating: 'good' }),
    );
    expect(res1.status).toBe(200);
    // ORACLE: the card after the first submit is the `before` for the SECOND submit.
    const cardAfter1 = (await getFsrsState(db, 'knowledge', 'kc_fsrs2'))?.state;
    expect(cardAfter1).toBeDefined();

    const res2 = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_fsrs2' }, rating: 'good' }),
    );
    expect(res2.status).toBe(200);
    const review2 = ((await res2.json()) as { review_event: { id: string } }).review_event.id;

    const snap = (await readSnapshot(review2))[0];
    const payload = StateSnapshotExperimental.parse({
      actor_kind: snap.actor_kind,
      actor_ref: snap.actor_ref,
      action: snap.action,
      subject_kind: snap.subject_kind,
      subject_id: snap.subject_id,
      outcome: snap.outcome,
      payload: snap.payload,
    }).payload;
    const fsrsSnap = payload.fsrs_snapshots.find(
      (f) => f.subject_kind === 'knowledge' && f.subject_id === 'kc_fsrs2',
    );
    expect(fsrsSnap).toBeDefined();
    expect(fsrsSnap?.before).not.toBeNull();
    // before of submit #2 == the live card produced by submit #1 (independent oracle).
    expect(fsrsSnap?.before?.stability).toBeCloseTo(
      (cardAfter1 as { stability: number }).stability,
      8,
    );
    expect(fsrsSnap?.before?.reps).toBe((cardAfter1 as { reps: number }).reps);
  });

  // Test 12 (Group C) — HARD REQ 2: the snapshot row skips the outbox (ingest_at
  //   non-NULL at INSERT), while the attempt's own review event has ingest_at NULL.
  it('snapshot event has ingest_at non-null at INSERT; the review event has ingest_at NULL', async () => {
    await seedQuestion('q_outbox', { knowledge_ids: ['kc_outbox'] });

    const res = await POST(
      submitReq({ activity_ref: { kind: 'question', id: 'q_outbox' }, rating: 'good' }),
    );
    expect(res.status).toBe(200);
    const reviewEventId = ((await res.json()) as { review_event: { id: string } }).review_event.id;

    const db = testDb();
    const snapRows = await db
      .select({ ingest_at: event.ingest_at })
      .from(event)
      .where(
        and(eq(event.action, 'experimental:state_snapshot'), eq(event.subject_id, reviewEventId)),
      );
    expect(snapRows).toHaveLength(1);
    // HARD REQ 2 — the outbox poller's `WHERE ingest_at IS NULL` never selects it.
    expect(snapRows[0].ingest_at).not.toBeNull();

    // Contrast: the attempt's own review event IS pending ingest (ingest_at NULL).
    const reviewRows = await db
      .select({ ingest_at: event.ingest_at })
      .from(event)
      .where(eq(event.id, reviewEventId));
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0].ingest_at).toBeNull();
  });
});
