// YUK-777 B1 + B2 — the out-of-order (late-arrival) guard's two remaining holes.
//
// Both are the SAME structural mistake in different clothes: the guard enumerated the write
// targets it expected a newer attempt to have touched, and then asked those targets. Three
// review rounds produced three same-family holes that way, because an enumeration can always
// be one target short — and worse, a target that a previous late-skip DELIBERATELY did not
// write is invisible no matter how complete the enumeration is.
//
//   B2 (#Tu1cY) — the skip erases the evidence. Run B covers K1+K2, is judged late because of
//                 K2, so it skips EVERY derived write and leaves nothing on K1. Older run A,
//                 covering only K1, reads the projections, sees nothing newer, and walks K1
//                 backwards. One skip opens the gate for every older attempt behind it.
//   B1 (#TuxJJ) — the target was never in the enumeration. `mastery_state(ability_global)` is
//                 keyed by DOMAIN, so two attempts on sibling KCs collide there while sharing
//                 no knowledge id at all.

import { newId } from '@/core/ids';
import { HIERARCHICAL_ELO_ENABLED } from '@/core/theta';
import { knowledge, mastery_state, material_fsrs_state, question } from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { upsertMasteryState } from '@/server/mastery/state';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { recordJudgePendingAttempt } from '../server/judge-run-dispatch';
import { CreateAttemptBodySchema } from './contracts';
import { persistSubmit } from './submit';

const MINUTE = 60_000;

async function seedKnowledge(id: string, domain: string | null, parentId: string | null = null) {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({ id, name: id, domain, parent_id: parentId, created_at: now, updated_at: now });
}

async function seedQuestion(id: string, knowledgeIds: string[]) {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      prompt_md: `Prompt for ${id}`,
      kind: 'short_answer',
      reference_md: null,
      knowledge_ids: knowledgeIds,
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    });
}

async function buildValidated(questionId: string, now: Date, body: Record<string, unknown>) {
  const parsed = CreateAttemptBodySchema.parse({ question_id: questionId, ...body });
  const q = (await testDb().select().from(question).where(eq(question.id, questionId)))[0];
  return {
    body: parsed,
    now,
    questionId,
    activityRef: normalizeReviewSubmitActivityRef(parsed).activity_ref,
    q,
  };
}

/** A manual-rating judged shape — no judge call, so no profile/LLM is involved. */
function manualJudged() {
  return {
    judgeResult: null,
    judgeRoute: null,
    judgeTelemetry: null,
    executionProvenance: null,
    suggestedRating: null,
    finalRating: 'good' as const,
    adviceCauseCategory: null,
  };
}

describe('late-arrival guard — evidence water mark (YUK-777 B2)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('detects a late attempt from a newer attempt that WROTE NOTHING (the post-skip hole)', async () => {
    await seedKnowledge('k1', 'math');
    await seedKnowledge('k2', 'math');
    const olderQ = `q_${newId()}`;
    await seedQuestion(olderQ, ['k1']);
    const newerQ = `q_${newId()}`;
    await seedQuestion(newerQ, ['k1', 'k2']);

    const older = new Date(Date.now() - 10 * MINUTE);
    const newer = new Date(Date.now() - 1 * MINUTE);

    // Run B: a NEWER attempt on overlapping material (K1) that was itself judged late and so
    // skipped every derived write. Its ONLY trace is the pending-attempt evidence — which is
    // exactly the situation, because that row is written unconditionally at submit.
    await recordJudgePendingAttempt(testDb(), {
      runId: newId(),
      sessionId: null,
      questionId: newerQ,
      knowledgeIds: ['k1', 'k2'],
      submit: {
        body: { question_id: newerQ, rating: 'good', response_md: 'b', auto_rate: true },
        question_id: newerQ,
        subject_profile: {},
        question_snapshot: {},
        submitted_at: newer.toISOString(),
      },
      submittedAt: newer,
    });

    // Deliberately assert the premise: no derived state exists at all, so the projection half
    // of the guard has nothing to find. Without the evidence half this attempt sails through.
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);

    const persisted = await persistSubmit(
      await buildValidated(olderQ, older, { rating: 'good', referenced_knowledge_ids: ['k1'] }),
      manualJudged(),
      { attemptEventId: newId(), enforceAttemptOrdering: true },
    );

    expect(persisted.lateArrival).toBe(true);
    // Late ⇒ evidence only. The schedule must not have moved onto older evidence.
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
  });

  it('does NOT flag an attempt whose own pending row is the only newer-looking evidence', async () => {
    await seedKnowledge('k1', 'math');
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId, ['k1']);
    const runId = newId();
    // A run's own pending row is stamped at the answer instant. `created_at > now` is false for
    // it, but pin the self-exclusion explicitly: keying the guard on material alone would make
    // every durable attempt indict itself the moment the two stamps were not identical.
    const at = new Date(Date.now() - 5 * MINUTE);
    await recordJudgePendingAttempt(testDb(), {
      runId,
      sessionId: null,
      questionId,
      knowledgeIds: ['k1'],
      submit: {
        body: { question_id: questionId, rating: 'good', response_md: 'a', auto_rate: true },
        question_id: questionId,
        subject_profile: {},
        question_snapshot: {},
        submitted_at: at.toISOString(),
      },
      submittedAt: at,
    });

    const persisted = await persistSubmit(
      await buildValidated(questionId, at, { rating: 'good' }),
      manualJudged(),
      { attemptEventId: runId, enforceAttemptOrdering: true },
    );

    expect(persisted.lateArrival).toBe(false);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
  });

  it('ignores newer evidence on UNRELATED material', async () => {
    await seedKnowledge('k1', 'math');
    await seedKnowledge('k9', 'history');
    const mine = `q_${newId()}`;
    await seedQuestion(mine, ['k1']);
    const theirs = `q_${newId()}`;
    await seedQuestion(theirs, ['k9']);

    const older = new Date(Date.now() - 10 * MINUTE);
    const newer = new Date(Date.now() - 1 * MINUTE);
    await recordJudgePendingAttempt(testDb(), {
      runId: newId(),
      sessionId: null,
      questionId: theirs,
      knowledgeIds: ['k9'],
      submit: {
        body: { question_id: theirs, rating: 'good', response_md: 'x', auto_rate: true },
        question_id: theirs,
        subject_profile: {},
        question_snapshot: {},
        submitted_at: newer.toISOString(),
      },
      submittedAt: newer,
    });

    const persisted = await persistSubmit(
      await buildValidated(mine, older, { rating: 'good' }),
      manualJudged(),
      { attemptEventId: newId(), enforceAttemptOrdering: true },
    );

    // A guard that fired on any newer attempt anywhere would freeze the whole schedule
    // whenever a learner answers two questions out of order.
    expect(persisted.lateArrival).toBe(false);
  });
});

describe('late-arrival guard — shared θ_global domain row (YUK-777 B1)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('detects a late attempt from a SIBLING KC under the same domain (no shared knowledge id)', async () => {
    // The flag is a compile-time constant; if it were ever flipped off, no ability_global row
    // would be written and this hazard would not exist — so assert the premise rather than
    // let the test silently pass for the wrong reason.
    expect(HIERARCHICAL_ELO_ENABLED).toBe(true);

    await seedKnowledge('k1', 'math');
    await seedKnowledge('k2', 'math'); // sibling: same domain, DIFFERENT knowledge id
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId, ['k1']);

    const older = new Date(Date.now() - 10 * MINUTE);
    const newer = new Date(Date.now() - 1 * MINUTE);

    // A newer attempt on K2 already moved the SHARED domain row. Nothing on K1 moved, so every
    // knowledge-keyed read — FSRS and per-KC θ̂ alike — reports "no newer evidence".
    // Seeded through the PRODUCTION writer, so the row this guard reads is byte-shaped like
    // one `updateThetaForAttempt` would have left behind.
    await upsertMasteryState(testDb(), {
      subject_kind: 'ability_global',
      subject_id: 'math',
      theta_hat: 0.5,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: newer,
    });

    const persisted = await persistSubmit(
      await buildValidated(questionId, older, { rating: 'good' }),
      manualJudged(),
      { attemptEventId: newId(), enforceAttemptOrdering: true },
    );

    expect(persisted.lateArrival).toBe(true);
    // The shared domain row must not have absorbed the older observation, and its
    // `last_outcome_at` must not have been walked back.
    const [globalRow] = await testDb()
      .select()
      .from(mastery_state)
      .where(
        and(eq(mastery_state.subject_kind, 'ability_global'), eq(mastery_state.subject_id, 'math')),
      );
    expect(globalRow.theta_hat).toBe(0.5);
    expect(globalRow.last_outcome_at?.getTime()).toBe(newer.getTime());
  });

  it('an OLDER domain row does not suppress a legitimate advance', async () => {
    await seedKnowledge('k1', 'math');
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId, ['k1']);
    const long_ago = new Date(Date.now() - 60 * MINUTE);
    await upsertMasteryState(testDb(), {
      subject_kind: 'ability_global',
      subject_id: 'math',
      theta_hat: 0.5,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: long_ago,
    });

    const persisted = await persistSubmit(
      await buildValidated(questionId, new Date(), { rating: 'good' }),
      manualJudged(),
      { attemptEventId: newId(), enforceAttemptOrdering: true },
    );

    expect(persisted.lateArrival).toBe(false);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
  });
});
