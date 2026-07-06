// YUK-574 — db test for the learner-state header IO layer. Runs in the db vitest
// config (real Postgres testcontainer) because it exercises writeEvent + parseEvent
// (the cache event must be a valid ExperimentalEvent), the grouped watermark query,
// the cache round-trip, and the resolver's real watermark-driven invalidation.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resetDb } from '../../../../tests/helpers/db';
import {
  LEARNER_STATE_HEADER_ACTION,
  type LearnerStateProjection,
  readLatestLearnerStateHeaderCache,
  readLearnerStateProjection,
  readLearnerStateWatermarks,
  resolveLearnerStateHeader,
  writeLearnerStateHeaderCache,
} from './learner-state';

beforeEach(async () => {
  await resetDb();
});

const COLD_PROJECTION: LearnerStateProjection = {
  reviewDueCount: 0,
  activeGoalTitle: null,
  topCauseCategories: [],
  masterySummary: null,
  meanTheta: null,
  overnightSentence: null,
};

async function writeAttempt(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `attempt_${createId()}`,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: `q_${createId()}`,
    outcome: 'success',
    payload: { answer_md: 'a', answer_image_refs: [], referenced_knowledge_ids: [] },
    created_at: at,
  });
}

async function writeRate(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `rate_${createId()}`,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: `evt_${createId()}`,
    outcome: 'success',
    payload: { rating: 'accept' },
    created_at: at,
  });
}

async function writeDreamingScan(at: Date): Promise<void> {
  await writeEvent(db, {
    id: `dreaming_scan_${createId()}`,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'experimental:dreaming_scan',
    subject_kind: 'query',
    subject_id: `trigger_${createId()}`,
    outcome: 'success',
    payload: { proposals_created: 0, pending_after: 0 },
    created_at: at,
  });
}

async function cacheRowCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.session_id, sessionId), eq(event.action, LEARNER_STATE_HEADER_ACTION)));
  return rows.length;
}

describe('readLearnerStateWatermarks', () => {
  it('reads latest created_at per category; null when the category is empty', async () => {
    expect(await readLearnerStateWatermarks(db)).toEqual({
      attempt_at: null,
      dreaming_at: null,
      proposal_decision_at: null,
    });

    await writeAttempt(new Date('2026-07-06T08:00:00.000Z'));
    await writeAttempt(new Date('2026-07-06T09:00:00.000Z')); // newest attempt
    await writeDreamingScan(new Date('2026-07-06T03:00:00.000Z'));
    await writeRate(new Date('2026-07-06T07:00:00.000Z'));

    const wm = await readLearnerStateWatermarks(db);
    expect(wm.attempt_at).toBe('2026-07-06T09:00:00.000Z');
    expect(wm.dreaming_at).toBe('2026-07-06T03:00:00.000Z');
    expect(wm.proposal_decision_at).toBe('2026-07-06T07:00:00.000Z');
  });
});

describe('learner-state header cache round-trip', () => {
  it('writes a parseEvent-valid cache event (ingest_at opt-out) and reads it back', async () => {
    const now = new Date('2026-07-06T09:00:00.000Z');
    await writeLearnerStateHeaderCache(
      db,
      {
        session_id: 'ls_db_cache',
        header_md: '今日待复习 5 项',
        proposal_feedback: [
          {
            kind: 'knowledge_edge',
            relation: 'prerequisite',
            acceptance_rate: 0.6,
            top_dismiss_reasons: [],
            top_rubric_gates: [],
          },
        ],
        assembled_at: now.toISOString(),
        day_bucket: '2026-07-06',
        watermarks: {
          attempt_at: '2026-07-06T08:00:00.000Z',
          dreaming_at: null,
          proposal_decision_at: null,
        },
      },
      now,
    );

    const cached = await readLatestLearnerStateHeaderCache(db, 'ls_db_cache');
    expect(cached?.header_md).toBe('今日待复习 5 项');
    expect(cached?.day_bucket).toBe('2026-07-06');
    expect(cached?.proposal_feedback).toEqual([
      {
        kind: 'knowledge_edge',
        relation: 'prerequisite',
        acceptance_rate: 0.6,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
    ]);
    expect(cached?.watermarks.attempt_at).toBe('2026-07-06T08:00:00.000Z');

    // The raw row exists, is the header action, and is opted OUT of the mem0
    // outbox (ADR-0039 red line — a deterministic projection must not feed mem0).
    const rows = await db
      .select({ ingest_at: event.ingest_at, actor_ref: event.actor_ref })
      .from(event)
      .where(
        and(eq(event.session_id, 'ls_db_cache'), eq(event.action, LEARNER_STATE_HEADER_ACTION)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ingest_at).not.toBeNull();
    expect(rows[0]?.actor_ref).toBe('system:copilot_learner_state');
  });

  it('returns the NEWEST cache row for the session (latest wins)', async () => {
    const older = new Date('2026-07-06T08:00:00.000Z');
    const newer = new Date('2026-07-06T09:00:00.000Z');
    const base = {
      session_id: 'ls_db_latest',
      proposal_feedback: [],
      day_bucket: '2026-07-06',
      watermarks: { attempt_at: null, dreaming_at: null, proposal_decision_at: null },
    };
    await writeLearnerStateHeaderCache(
      db,
      { ...base, header_md: 'OLD', assembled_at: older.toISOString() },
      older,
    );
    await writeLearnerStateHeaderCache(
      db,
      { ...base, header_md: 'NEW', assembled_at: newer.toISOString() },
      newer,
    );
    const cached = await readLatestLearnerStateHeaderCache(db, 'ls_db_latest');
    expect(cached?.header_md).toBe('NEW');
  });
});

describe('resolveLearnerStateHeader (real cache IO + watermark-driven invalidation)', () => {
  it('assembles once, reuses the cache, and reassembles when dreaming runs', async () => {
    const now = () => new Date('2026-07-06T09:00:00.000Z');
    let projectionCalls = 0;
    const deps = {
      readProjectionFn: async () => {
        projectionCalls += 1;
        return { ...COLD_PROJECTION, reviewDueCount: projectionCalls };
      },
      loadProposalFeedbackFn: async () => [],
      now,
    };

    // Cold: assembles once, persists exactly one cache row.
    const h1 = await resolveLearnerStateHeader(db, 'ls_db_resolve', deps);
    expect(projectionCalls).toBe(1);
    expect(h1.header_md).toContain('1');
    expect(await cacheRowCount('ls_db_resolve')).toBe(1);

    // Warm, no new events: reuses the cache (NO reassembly), still one row.
    const h2 = await resolveLearnerStateHeader(db, 'ls_db_resolve', deps);
    expect(projectionCalls).toBe(1);
    expect(h2.header_md).toBe(h1.header_md);
    expect(await cacheRowCount('ls_db_resolve')).toBe(1);

    // Dreaming runs → the dreaming watermark advances → reassemble, second row.
    await writeDreamingScan(new Date('2026-07-06T08:59:00.000Z'));
    const h3 = await resolveLearnerStateHeader(db, 'ls_db_resolve', deps);
    expect(projectionCalls).toBe(2);
    expect(h3.header_md).toContain('2');
    expect(await cacheRowCount('ls_db_resolve')).toBe(2);
  });
});

describe('readLearnerStateProjection', () => {
  it('returns a cold projection on an empty DB (composition smoke, real readers)', async () => {
    const proj = await readLearnerStateProjection(db);
    expect(proj).toEqual(COLD_PROJECTION);
  });
});
