import { event, learning_session } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
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
      },
      created_at: opts.at,
    });
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

  it('excludes unsupported-judge failures from the streak', async () => {
    await seedAttempt({
      id: 'unsupported',
      outcome: 'failure',
      knowledgeIds: ['kc_a'],
      at: new Date(NOW.getTime() - 3_000),
      unsupported: true,
    });
    const triggerId = await seedWrongTail('kc_a', 2);

    await expect(evaluate(triggerId)).resolves.toEqual({
      fire: false,
      reason: 'streak_below_threshold',
    });
  });

  it.each(['corrected', 'appealed'] as const)(
    'excludes a %s failure from the streak',
    async (kind) => {
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

      await expect(evaluate(triggerId)).resolves.toEqual({
        fire: false,
        reason: 'streak_below_threshold',
      });
    },
  );

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
