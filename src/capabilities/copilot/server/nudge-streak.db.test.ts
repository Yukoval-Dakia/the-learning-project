import { event, learning_session } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { NudgeConfig } from './nudge-config';
import { NUDGE_ACTION, NUDGE_DISMISSED_ACTION, evaluateNudgeTrigger } from './nudge-triggers';

const NOW = new Date('2026-07-20T04:00:00.000Z');
const LIVE_CFG: NudgeConfig = {
  enabled: true,
  dailyMax: 3,
  expiresHours: 24,
  streakN: 3,
  kcCooldownHours: 24,
};
const SHADOW_CFG: NudgeConfig = { ...LIVE_CFG, enabled: false };

async function seedAttempt(opts: {
  id: string;
  outcome: 'success' | 'failure' | 'partial';
  knowledgeIds: string[];
  at: Date;
  action?: 'attempt' | 'review';
  unsupported?: boolean;
  nestedUnsupported?: boolean;
  authoritativeKnowledgeIds?: string[];
}): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: opts.id,
      actor_kind: 'user',
      actor_ref: 'self',
      action: opts.action ?? 'attempt',
      subject_kind: 'question',
      subject_id: `q_${opts.id}`,
      outcome: opts.outcome,
      payload: {
        referenced_knowledge_ids: opts.knowledgeIds,
        ...(opts.unsupported ? { unsupported_judge: true } : {}),
        ...(opts.nestedUnsupported ? { judge: { coarse_outcome: 'unsupported' } } : {}),
        ...(opts.authoritativeKnowledgeIds
          ? { fsrs_subject_kind: 'knowledge', fsrs_subject_ids: opts.authoritativeKnowledgeIds }
          : {}),
      },
      created_at: opts.at,
    });
}

async function seedAttempts(
  attempts: Array<{
    id: string;
    outcome: 'success' | 'failure' | 'partial';
    knowledgeIds: string[];
    at: Date;
    unsupported?: boolean;
  }>,
): Promise<void> {
  await testDb()
    .insert(event)
    .values(
      attempts.map((attempt) => ({
        id: attempt.id,
        actor_kind: 'user' as const,
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question' as const,
        subject_id: `q_${attempt.id}`,
        outcome: attempt.outcome,
        payload: {
          referenced_knowledge_ids: attempt.knowledgeIds,
          ...(attempt.unsupported ? { unsupported_judge: true } : {}),
        },
        created_at: attempt.at,
      })),
    );
}

async function seedUnsupportedJudge(attemptId: string, at: Date): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: `judge_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'review_judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: { coarse_outcome: 'unsupported' },
      caused_by_event_id: attemptId,
      created_at: at,
    });
}

async function seedContestedJudge(
  attemptId: string,
  kind: 'corrected' | 'appealed',
  at: Date,
): Promise<void> {
  const judgeId = `judge_${kind}_${attemptId}`;
  await testDb()
    .insert(event)
    .values([
      {
        id: judgeId,
        actor_kind: 'agent',
        actor_ref: 'review_judge',
        action: 'judge',
        subject_kind: 'event',
        subject_id: attemptId,
        outcome: 'success',
        payload: { coarse_outcome: 'incorrect' },
        caused_by_event_id: attemptId,
        created_at: at,
      },
      kind === 'corrected'
        ? {
            id: `correction_${attemptId}`,
            actor_kind: 'agent',
            actor_ref: 'rejudge',
            action: 'correct',
            subject_kind: 'event',
            subject_id: judgeId,
            outcome: 'success',
            payload: {
              correction_kind: 'supersede',
              reason_md: 'upheld',
              replacement_event_id: `replacement_${attemptId}`,
              affected_refs: [{ kind: 'question', id: `q_${attemptId}` }],
            },
            caused_by_event_id: judgeId,
            created_at: new Date(at.getTime() + 1),
          }
        : {
            id: `appeal_${attemptId}`,
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'experimental:appeal_request',
            subject_kind: 'event',
            subject_id: judgeId,
            payload: { reason_md: 'recheck' },
            caused_by_event_id: judgeId,
            created_at: new Date(at.getTime() + 1),
          },
    ]);
}

async function seedWrongTail(kcId: string, count: number): Promise<string> {
  let latest = '';
  for (let i = 0; i < count; i++) {
    latest = `attempt_${kcId}_${i}`;
    await seedAttempt({
      id: latest,
      outcome: 'failure',
      knowledgeIds: [kcId],
      at: new Date(NOW.getTime() - (count - i) * 1_000),
      action: i % 2 === 0 ? 'attempt' : 'review',
    });
  }
  return latest;
}

async function evaluate(attemptEventId: string, config = LIVE_CFG) {
  return evaluateNudgeTrigger(
    testDb(),
    { kind: 'attempt_failure', attempt_event_id: attemptEventId },
    config,
    NOW,
  );
}

describe('evaluateNudgeTrigger — same-KC wrong streak', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fires at STREAK_N across attempt and review events for the same KC', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);

    const decision = await evaluate(triggerId);

    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event).toMatchObject({
      subject_kind: 'knowledge',
      subject_id: 'kc_a',
      caused_by_event_id: triggerId,
      payload: {
        kind: 'kc_wrong_streak',
        shadow: false,
        evidence: { kc_id: 'kc_a', streak_n: 3 },
      },
    });
    expect(decision.event.payload.expires_at).toBe('2026-07-21T04:00:00.000Z');
  });

  it('does not fire at STREAK_N - 1', async () => {
    const triggerId = await seedWrongTail('kc_a', 2);
    await expect(evaluate(triggerId)).resolves.toEqual({
      fire: false,
      reason: 'streak_below_threshold',
    });
  });

  it.each(['success', 'partial'] as const)(
    '%s breaks the consecutive wrong tail',
    async (outcome) => {
      await seedAttempt({
        id: `breaker_${outcome}`,
        outcome,
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 4_000),
      });
      const triggerId = await seedWrongTail('kc_a', 2);

      await expect(evaluate(triggerId)).resolves.toEqual({
        fire: false,
        reason: 'streak_below_threshold',
      });
    },
  );

  it.each([
    {
      label: 'top-level unsupported marker',
      outcome: 'failure' as const,
      options: { unsupported: true },
    },
    {
      label: 'nested review judge outcome stored as failure',
      outcome: 'failure' as const,
      options: { nestedUnsupported: true },
    },
    {
      label: 'nested tutor judge outcome stored as partial',
      outcome: 'partial' as const,
      options: { nestedUnsupported: true },
    },
    {
      label: 'nested judge outcome stored as success',
      outcome: 'success' as const,
      options: { nestedUnsupported: true },
    },
  ])('skips a historical event with $label', async ({ outcome, options }) => {
    await seedAttempt({
      id: 'older_failure',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 4_000),
    });
    await seedAttempt({
      id: 'unsupported',
      outcome,
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 3_000),
      action: 'review',
      ...options,
    });
    const triggerId = await seedWrongTail('kc_a', 2);

    const decision = await evaluate(triggerId);
    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.payload.evidence).toMatchObject({ streak_n: 3 });
  });

  it('skips a paper-shaped failure whose linked judge is unsupported', async () => {
    await seedAttempt({
      id: 'older_failure',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 4_000),
    });
    await seedAttempt({
      id: 'paper_unsupported',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 3_000),
    });
    await seedUnsupportedJudge('paper_unsupported', new Date(NOW.getTime() - 2_900));
    const triggerId = await seedWrongTail('kc_a', 2);

    const decision = await evaluate(triggerId);
    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.payload.evidence).toMatchObject({ streak_n: 3 });
  });

  it('does not fire when the trigger linked judge is unsupported', async () => {
    await seedWrongTail('kc_a', 3);
    await seedAttempt({
      id: 'paper_unsupported_trigger',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: NOW,
    });
    await seedUnsupportedJudge('paper_unsupported_trigger', new Date(NOW.getTime() + 1));

    await expect(evaluate('paper_unsupported_trigger')).resolves.toEqual({
      fire: false,
      reason: 'not_failure',
    });
  });

  it.each(['corrected', 'appealed'] as const)(
    'excludes a %s failure from the streak',
    async (kind) => {
      await seedAttempt({
        id: 'older_failure',
        outcome: 'failure',
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 4_000),
      });
      await seedAttempt({
        id: 'contested_attempt',
        outcome: 'failure',
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 3_000),
      });
      await testDb()
        .insert(event)
        .values({
          id: 'judge_contested',
          actor_kind: 'agent',
          actor_ref: 'review_judge',
          action: 'judge',
          subject_kind: 'event',
          subject_id: 'contested_attempt',
          outcome: 'success',
          payload: {
            cause: {
              primary_category: 'other',
              secondary_categories: [],
              analysis_md: 'seed',
              confidence: 1,
            },
            referenced_knowledge_ids: ['kc_a'],
            profile_version: 'seed',
            capability_ref: { id: 'exact', version: 'seed' },
            judge_route: 'exact',
            coarse_outcome: 'incorrect',
            feedback_md: 'seed',
          },
          caused_by_event_id: 'contested_attempt',
          created_at: new Date(NOW.getTime() - 2_900),
        });
      await testDb()
        .insert(event)
        .values(
          kind === 'corrected'
            ? {
                id: 'correction',
                actor_kind: 'agent',
                actor_ref: 'rejudge',
                action: 'correct',
                subject_kind: 'event',
                subject_id: 'judge_contested',
                outcome: 'success',
                payload: {
                  correction_kind: 'supersede',
                  reason_md: 'appeal upheld',
                  replacement_event_id: 'replacement_judge',
                  affected_refs: [{ kind: 'question', id: 'q_contested_attempt' }],
                },
                caused_by_event_id: 'judge_contested',
                created_at: new Date(NOW.getTime() - 2_800),
              }
            : {
                id: 'appeal',
                actor_kind: 'user',
                actor_ref: 'self',
                action: 'experimental:appeal_request',
                subject_kind: 'event',
                subject_id: 'judge_contested',
                payload: { reason_md: 'please recheck' },
                caused_by_event_id: 'judge_contested',
                created_at: new Date(NOW.getTime() - 2_800),
              },
        );
      const triggerId = await seedWrongTail('kc_a', 2);

      const decision = await evaluate(triggerId);
      expect(decision.fire).toBe(true);
      if (!decision.fire) throw new Error('expected fire');
      expect(decision.event.payload.evidence).toMatchObject({ streak_n: 3 });
    },
  );

  it.each(['unsupported', 'corrected', 'appealed'] as const)(
    'does not fire when the trigger itself is %s',
    async (kind) => {
      await seedWrongTail('kc_a', 3);
      await seedAttempt({
        id: 'contested_trigger',
        outcome: 'failure',
        knowledgeIds: ['kc_a'],
        at: NOW,
        unsupported: kind === 'unsupported',
      });
      if (kind !== 'unsupported') {
        await testDb()
          .insert(event)
          .values({
            id: 'trigger_judge',
            actor_kind: 'agent',
            actor_ref: 'review_judge',
            action: 'judge',
            subject_kind: 'event',
            subject_id: 'contested_trigger',
            outcome: 'success',
            payload: {},
            caused_by_event_id: 'contested_trigger',
            created_at: new Date(NOW.getTime() + 1),
          });
        await testDb()
          .insert(event)
          .values(
            kind === 'corrected'
              ? {
                  id: 'trigger_correction',
                  actor_kind: 'agent',
                  actor_ref: 'rejudge',
                  action: 'correct',
                  subject_kind: 'event',
                  subject_id: 'trigger_judge',
                  outcome: 'success',
                  payload: {
                    correction_kind: 'supersede',
                    reason_md: 'upheld',
                    replacement_event_id: 'replacement',
                    affected_refs: [{ kind: 'question', id: 'q_contested_trigger' }],
                  },
                  caused_by_event_id: 'trigger_judge',
                  created_at: new Date(NOW.getTime() + 2),
                }
              : {
                  id: 'trigger_appeal',
                  actor_kind: 'user',
                  actor_ref: 'self',
                  action: 'experimental:appeal_request',
                  subject_kind: 'event',
                  subject_id: 'trigger_judge',
                  payload: { reason_md: 'recheck' },
                  caused_by_event_id: 'trigger_judge',
                  created_at: new Date(NOW.getTime() + 2),
                },
          );
      }

      await expect(evaluate('contested_trigger')).resolves.toEqual({
        fire: false,
        reason: 'not_failure',
      });
    },
  );

  it('uses normalized FSRS knowledge IDs instead of stale raw review evidence', async () => {
    await seedWrongTail('kc_real', 2);
    await seedAttempt({
      id: 'stale_review_trigger',
      outcome: 'failure',
      knowledgeIds: ['kc_stale', 'kc_real'],
      authoritativeKnowledgeIds: ['kc_real'],
      at: NOW,
      action: 'review',
    });

    const decision = await evaluate('stale_review_trigger');
    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.subject_id).toBe('kc_real');
  });

  it('does not use a nonexistent raw KC when normalized review IDs are question-scoped', async () => {
    await seedWrongTail('kc_stale', 2);
    await seedAttempt({
      id: 'question_scoped_trigger',
      outcome: 'failure',
      knowledgeIds: ['kc_stale'],
      authoritativeKnowledgeIds: [],
      at: NOW,
      action: 'review',
    });

    await expect(evaluate('question_scoped_trigger')).resolves.toEqual({
      fire: false,
      reason: 'no_knowledge',
    });
  });

  it('selects the highest streak KC and uses kc id as a deterministic tie-break', async () => {
    await seedAttempt({
      id: 'a_old',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 5_000),
    });
    await seedAttempt({
      id: 'b_old',
      outcome: 'failure',
      knowledgeIds: ['kc_b'],
      at: new Date(NOW.getTime() - 5_000),
    });
    await seedAttempt({
      id: 'shared_1',
      outcome: 'failure',
      knowledgeIds: ['kc_b', 'kc_a'],
      at: new Date(NOW.getTime() - 2_000),
    });
    await seedAttempt({
      id: 'shared_2',
      outcome: 'failure',
      knowledgeIds: ['kc_b', 'kc_a'],
      at: new Date(NOW.getTime() - 1_000),
    });
    await seedAttempt({
      id: 'trigger',
      outcome: 'failure',
      knowledgeIds: ['kc_b', 'kc_a'],
      at: NOW,
    });

    const decision = await evaluate('trigger');

    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.subject_id).toBe('kc_a');
    expect(decision.event.caused_by_event_id).toBe('trigger');
  });

  it('selects an eligible lower-streak KC when the top candidate is cooling down', async () => {
    await seedAttempt({
      id: 'a_extra',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 4_000),
    });
    for (let i = 0; i < 3; i++) {
      await seedAttempt({
        id: `shared_${i}`,
        outcome: 'failure',
        knowledgeIds: ['kc_a', 'kc_b'],
        at: new Date(NOW.getTime() - (3 - i) * 1_000),
      });
    }
    await testDb()
      .insert(event)
      .values({
        id: 'prior_a_nudge',
        actor_kind: 'agent',
        actor_ref: 'copilot_nudge_trigger',
        action: NUDGE_ACTION,
        subject_kind: 'knowledge',
        subject_id: 'kc_a',
        payload: {
          kind: 'kc_wrong_streak',
          headline: 'seed',
          expires_at: NOW.toISOString(),
          shadow: false,
          in_active_session: false,
          evidence: { kc_id: 'kc_a', streak_n: 3 },
        },
        caused_by_event_id: 'old_a_attempt',
        created_at: new Date(NOW.getTime() - 3_600_000),
      });

    const decision = await evaluate('shared_2');
    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.subject_id).toBe('kc_b');
  });

  it('applies the 24h cooldown and dismiss fuse per KC', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);
    await testDb()
      .insert(event)
      .values({
        id: 'prior_nudge',
        actor_kind: 'agent',
        actor_ref: 'copilot_nudge_trigger',
        action: NUDGE_ACTION,
        subject_kind: 'knowledge',
        subject_id: 'kc_a',
        payload: {
          kind: 'kc_wrong_streak',
          headline: 'seed',
          expires_at: NOW.toISOString(),
          shadow: false,
          in_active_session: false,
          evidence: { kc_id: 'kc_a', streak_n: 3 },
        },
        caused_by_event_id: 'old_attempt',
        created_at: new Date(NOW.getTime() - 23 * 3_600_000),
      });

    await expect(evaluate(triggerId)).resolves.toEqual({ fire: false, reason: 'kc_cooldown' });

    await testDb().delete(event);
    const nextTriggerId = await seedWrongTail('kc_a', 3);
    await testDb()
      .insert(event)
      .values([
        {
          id: 'prior_kc_b_nudge',
          actor_kind: 'agent',
          actor_ref: 'copilot_nudge_trigger',
          action: NUDGE_ACTION,
          subject_kind: 'knowledge',
          subject_id: 'kc_b',
          payload: {
            kind: 'kc_wrong_streak',
            headline: 'seed',
            expires_at: NOW.toISOString(),
            shadow: false,
            in_active_session: false,
            evidence: {},
          },
          caused_by_event_id: 'old_b',
          created_at: NOW,
        },
        {
          id: 'dismiss_b',
          actor_kind: 'user',
          actor_ref: 'self',
          action: NUDGE_DISMISSED_ACTION,
          subject_kind: 'event',
          subject_id: 'prior_kc_b_nudge',
          payload: {},
          caused_by_event_id: 'prior_kc_b_nudge',
          created_at: NOW,
        },
      ]);

    const decision = await evaluate(nextTriggerId);
    expect(decision.fire).toBe(true);
  });

  it('applies the KC cooldown to shadow nudges', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);
    await testDb()
      .insert(event)
      .values({
        id: 'prior_shadow_nudge',
        actor_kind: 'agent',
        actor_ref: 'copilot_nudge_trigger',
        action: NUDGE_ACTION,
        subject_kind: 'knowledge',
        subject_id: 'kc_a',
        payload: {
          kind: 'kc_wrong_streak',
          headline: 'seed',
          expires_at: NOW.toISOString(),
          shadow: true,
          in_active_session: false,
          evidence: { kc_id: 'kc_a', streak_n: 3 },
        },
        caused_by_event_id: 'old_attempt',
        created_at: new Date(NOW.getTime() - 23 * 3_600_000),
      });

    await expect(evaluate(triggerId, SHADOW_CFG)).resolves.toEqual({
      fire: false,
      reason: 'kc_cooldown',
    });
  });

  it('does not let a delayed older trigger observe later attempts', async () => {
    await seedAttempt({
      id: 'older_trigger',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 3_000),
    });
    await seedAttempt({
      id: 'later_1',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 2_000),
    });
    await seedAttempt({
      id: 'later_2',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 1_000),
    });

    await expect(evaluate('older_trigger')).resolves.toEqual({
      fire: false,
      reason: 'streak_below_threshold',
    });
  });

  it('evaluates the complete reader in a read-only repeatable-read snapshot', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);
    const db = testDb();
    const transactionSpy = vi.spyOn(db, 'transaction');

    try {
      const decision = await evaluateNudgeTrigger(
        db,
        { kind: 'attempt_failure', attempt_event_id: triggerId },
        LIVE_CFG,
        NOW,
      );

      expect(decision.fire).toBe(true);
      expect(transactionSpy).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('short-circuits duplicate delivery before reading per-KC history', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);
    await testDb()
      .insert(event)
      .values({
        id: 'existing_nudge',
        actor_kind: 'system',
        actor_ref: 'copilot_nudge',
        action: NUDGE_ACTION,
        subject_kind: 'knowledge',
        subject_id: 'kc_a',
        caused_by_event_id: triggerId,
        payload: { kind: 'kc_wrong_streak' },
        created_at: NOW,
      });
    const db = testDb();
    const transactionSpy = vi.spyOn(db, 'transaction');

    try {
      const decision = await evaluateNudgeTrigger(
        db,
        { kind: 'attempt_failure', attempt_event_id: triggerId },
        LIVE_CFG,
        NOW,
      );

      expect(decision).toEqual({ fire: false, reason: 'already_nudged' });
      expect(transactionSpy).toHaveBeenCalledTimes(1);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('chunks correction and appeal reads when a page has many judges per attempt', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);
    const judges = Array.from({ length: 201 }, (_, i) => ({
      id: `judge_many_${i.toString().padStart(3, '0')}`,
      actor_kind: 'agent' as const,
      actor_ref: 'review_judge',
      action: 'judge',
      subject_kind: 'event' as const,
      subject_id: triggerId,
      outcome: 'success' as const,
      payload: { coarse_outcome: 'incorrect' },
      caused_by_event_id: triggerId,
      created_at: new Date(NOW.getTime() + i + 1),
    }));
    await testDb().insert(event).values(judges);

    const queries: Array<{ query: string; parameters: unknown[] }> = [];
    const client = testDb().$client;
    const previousDebug = client.options.debug;
    client.options.debug = (_connection, query, parameters) => {
      queries.push({ query, parameters });
    };
    try {
      const decision = await evaluate(triggerId);
      expect(decision.fire).toBe(true);
    } finally {
      client.options.debug = previousDebug;
    }

    const relatedReads = queries.filter(
      ({ parameters }) =>
        parameters.includes('experimental:appeal_request') || parameters.includes('correct'),
    );
    expect(relatedReads).toHaveLength(6);
    expect(relatedReads.every(({ parameters }) => parameters.length <= 102)).toBe(true);
  });

  it('keeps paging through more than 100 rows sharing one millisecond', async () => {
    const sharedMillisecond = new Date(NOW.getTime() - 10_000);
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `unsupported_same_ms_${i.toString().padStart(3, '0')}`,
      outcome: 'failure' as const,
      knowledgeIds: ['kc_a'],
      at: sharedMillisecond,
      unsupported: true,
    }));
    rows.push({
      id: 'eligible_same_ms_older_id',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: sharedMillisecond,
      unsupported: false,
    });
    await seedAttempts(rows);
    const triggerId = await seedWrongTail('kc_a', 2);

    const decision = await evaluate(triggerId);
    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.payload.evidence).toMatchObject({ streak_n: 3 });
  });

  it.each(['linked unsupported', 'corrected', 'appealed'] as const)(
    'excludes a %s failure at the page boundary before applying the breaker',
    async (kind) => {
      const excludedId = `boundary_excluded_${kind.replace(' ', '_')}`;
      await seedAttempt({
        id: 'boundary_older_failure',
        outcome: 'failure',
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 300_000),
      });
      await seedAttempt({
        id: excludedId,
        outcome: 'failure',
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 200_000),
      });
      if (kind === 'linked unsupported') {
        await seedUnsupportedJudge(excludedId, new Date(NOW.getTime() - 199_999));
      } else {
        await seedContestedJudge(excludedId, kind, new Date(NOW.getTime() - 199_999));
      }
      await seedAttempts(
        Array.from({ length: 99 }, (_, i) => ({
          id: `boundary_filler_${kind}_${i.toString().padStart(3, '0')}`,
          outcome: 'failure' as const,
          knowledgeIds: ['kc_a'],
          at: new Date(NOW.getTime() - 150_000 + i * 1_000),
          unsupported: true,
        })),
      );
      const triggerId = await seedWrongTail('kc_a', 2);

      const decision = await evaluate(triggerId);
      expect(decision.fire).toBe(true);
      if (!decision.fire) throw new Error('expected fire');
      expect(decision.event.payload.evidence).toMatchObject({ streak_n: 3 });
    },
  );

  it.each(['success', 'partial'] as const)(
    'stops at a %s breaker immediately behind page 100',
    async (outcome) => {
      await seedAttempt({
        id: `boundary_breaker_${outcome}`,
        outcome,
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 200_000),
      });
      await seedAttempts(
        Array.from({ length: 100 }, (_, i) => ({
          id: `boundary_unsupported_${outcome}_${i.toString().padStart(3, '0')}`,
          outcome: 'failure' as const,
          knowledgeIds: ['kc_a'],
          at: new Date(NOW.getTime() - 150_000 + i * 1_000),
          unsupported: true,
        })),
      );
      const triggerId = await seedWrongTail('kc_a', 2);

      await expect(evaluate(triggerId)).resolves.toEqual({
        fire: false,
        reason: 'streak_below_threshold',
      });
    },
  );

  it('finds eligible failures behind more than 100 excluded rows', async () => {
    await seedAttempt({
      id: 'old_eligible',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 200_000),
    });
    for (let i = 0; i < 101; i++) {
      await seedAttempt({
        id: `unsupported_${i.toString().padStart(3, '0')}`,
        outcome: 'failure',
        knowledgeIds: ['kc_a'],
        at: new Date(NOW.getTime() - 150_000 + i * 1_000),
        unsupported: true,
      });
    }
    const triggerId = await seedWrongTail('kc_a', 2);

    const decision = await evaluate(triggerId);
    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.payload.evidence).toMatchObject({ streak_n: 3 });
  });

  it('records active-session state for the existing silent-window read-model backstop', async () => {
    const triggerId = await seedWrongTail('kc_a', 3);
    await testDb()
      .insert(learning_session)
      .values({ id: 'active_practice', type: 'review', status: 'started' });

    const decision = await evaluate(triggerId, SHADOW_CFG);

    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error('expected fire');
    expect(decision.event.payload.in_active_session).toBe(true);
    expect(decision.event.payload.shadow).toBe(true);
  });
});
