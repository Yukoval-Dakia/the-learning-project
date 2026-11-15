import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, learning_session, provider_attempt, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { type Mem0Like, createMemoryClient } from '@/server/ai/mem0/client';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { authorizeMemoryIngestReplay } from './memory-ingest-recovery-store';
import { claimMemoryIngest, memoryReconcileHandoffEventId } from './memory-reconcile-handoff-store';
import {
  buildMemoryEventIngestHandler,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
} from './triggers';

const ANSWER_ACTIONS = [
  'experimental:assessment_attempt',
  'attempt',
  'review',
  'experimental:confirmation_command',
] as const;

function providerBoundary() {
  const add = vi.fn<Mem0Like['add']>(async () => ({
    results: [{ id: 'mem-1', memory: 'learner asks about elimination' }],
  }));
  const getAll = vi.fn<Mem0Like['getAll']>(async () => ({ results: [] }));
  const sdk: Mem0Like = {
    add,
    getAll,
    search: vi.fn(async () => ({ results: [] })),
    delete: vi.fn(async () => ({ message: 'ok' })),
    history: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
  const client = createMemoryClient({
    env: {
      DATABASE_URL: process.env.DATABASE_URL,
      OPENCODE_API_KEY: 'fake-test-key',
      ZHIPU_API_KEY: 'fake-test-key',
      DASHSCOPE_API_KEY: 'fake-test-key',
    },
    memoryFactory: () => sdk,
  });
  const sent: string[] = [];
  const boss = {
    send: vi.fn(async (_queue: string, data: object) => {
      sent.push((data as { event_id: string }).event_id);
      return null;
    }),
  };
  return { add, getAll, client, boss, sent };
}

function answerPayload(action: string) {
  const verbatim = `VERBATIM_${action}`;
  if (action === 'attempt')
    return {
      answer_md: verbatim,
      answer_image_refs: [] as string[],
      referenced_knowledge_ids: [] as string[],
    };
  if (action === 'review')
    return {
      fsrs_rating: 'good' as const,
      fsrs_state_after: {
        due: new Date('2026-11-07T00:00:00Z'),
        stability: 2,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: new Date('2026-11-06T00:00:00Z'),
      },
      user_response_md: verbatim,
      referenced_knowledge_ids: [] as string[],
    };
  return {
    response_md: verbatim,
    response_set: { entries: [{ kind: 'text', text_md: verbatim }] },
  };
}

describe('learner answer memory gate', () => {
  beforeEach(async () => {
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'off');
    await resetDb();
  });
  afterEach(() => vi.unstubAllEnvs());

  // @invariant security: only purpose-allowed learner words reach Mem0 inference; answers, restricted asks, other actors, empty messages and unapproved event types cannot contribute, including through recovery
  // @fails-if an excluded input reaches the provider or an admitted ask includes envelope, answer, reference or attachment content
  it('admits only learner ask text and keeps excluded evidence out on poll, recovery and operator replay', async () => {
    const db = testDb();
    const boundary = providerBoundary();
    await db.insert(learning_session).values({
      id: 'session-mem-1',
      type: 'conversation',
      status: 'active',
      started_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    // answer events' subject feeds the derivation lineage — the row must exist and be clean
    await db.insert(question).values({
      id: 'q-mem-gate',
      kind: 'derivation',
      prompt_md: '解方程 x+2=5',
      reference_md: 'x=3',
      source: 'web_sourced',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const write = (
      id: string,
      action: string,
      payload: Record<string, unknown>,
      stamped = false,
      actor: 'user' | 'agent' | 'system' = 'user',
    ) =>
      writeEvent(db, {
        id,
        session_id: 'session-mem-1',
        actor_kind: actor,
        actor_ref: 'self',
        action,
        subject_kind: 'question',
        subject_id: 'q-mem-gate',
        outcome: 'success',
        affected_scopes: ['topic:algebra'],
        payload,
        ...(stamped ? { ingest_at: new Date() } : {}),
      });
    const answers = ANSWER_ACTIONS.map((action, index) => ({
      id: `evt-answer-${index}`,
      action,
    }));
    for (const row of answers) await write(row.id, row.action, answerPayload(row.action));
    const excludedIds: string[] = [];
    for (const [id, action, payload, actor] of [
      ['blank', 'experimental:copilot_user_ask', { user_message: ' \n\t ' }, 'user'],
      [
        'crisis',
        'experimental:copilot_user_ask',
        { user_message: 'PRIVATE_CRISIS', derivation_policy: 'crisis' },
        'user',
      ],
      [
        'restricted',
        'experimental:copilot_user_ask',
        { user_message: 'PRIVATE_RESTRICTED', derivation_policy: 'answer_only' },
        'user',
      ],
      ['agent', 'experimental:copilot_user_ask', { user_message: 'PRIVATE_AGENT' }, 'agent'],
      ['system', 'experimental:copilot_user_ask', { user_message: 'PRIVATE_SYSTEM' }, 'system'],
      ['unknown', 'experimental:historical_text', { user_message: 'PRIVATE_UNKNOWN' }, 'user'],
    ] as const) {
      await write(id, action, payload, false, actor);
      excludedIds.push(id);
    }
    const askId = 'evt-copilot-ask';
    const learnerMessage = '  我每次考试前都特别紧张，做题会漏条件。\n';
    await write(askId, 'experimental:copilot_user_ask', {
      user_message: learnerMessage,
      surface: 'review_answer',
      session_id: 'session-mem-1',
      derivation_policy: 'allow',
      chip_kind: 'explain',
      review_answer: { response_md: 'VERBATIM_ASK_ATTACHMENT' },
      confirmation: {
        response_set: { entries: [{ kind: 'text', text_md: 'VERBATIM_ASK_CONFIRM' }] },
      },
      question_snapshot: { question: { reference_md: 'PRIVATE_REFERENCE' } },
      reasoning_trace: 'PRIVATE_REASONING',
      discussion: { question_id: 'PRIVATE_DISCUSSION_ID', summary: 'PRIVATE_DISCUSSION' },
      answer_image_refs: ['PRIVATE_PHOTO'],
    });
    const ingest = () =>
      buildMemoryEventIngestHandler(db, boundary.boss, { memoryClient: boundary.client });
    const answerIds = answers.map((row) => row.id);
    const rejectedIds = [...answerIds, ...excludedIds];
    const purposeRestrictedIds = new Set(['crisis', 'restricted']);
    const pendingRejectedIds = rejectedIds.filter((id) => !purposeRestrictedIds.has(id));

    // writeEvent stamps purpose-restricted sources before the outbox. Forced
    // delivery and recovery below must still reject those same sources.
    await buildMemoryIngestOutboxPollHandler(db, boundary.boss)([]);
    expect(boundary.sent.slice().sort()).toEqual([...pendingRejectedIds, askId].sort());
    for (const id of rejectedIds) await ingest()([{ data: { event_id: id } }]);
    expect(boundary.add).not.toHaveBeenCalled();
    await ingest()([{ data: { event_id: askId } }]);
    expect(boundary.add).toHaveBeenCalledOnce();
    const sentText = boundary.add.mock.calls[0][0] as string;
    expect(sentText).toBe(
      `学习者本人原话（仅作为学习记忆的来源，不代表已确认的事实）：\n${learnerMessage}`,
    );
    expect(sentText).not.toContain('VERBATIM');
    expect(sentText).not.toContain('PRIVATE_');

    // Recovery floor: reopened rows are re-enqueued, yet the gate still refuses the paid add.
    await db.update(event).set({ ingest_at: null }).where(inArray(event.id, rejectedIds));
    boundary.sent.length = 0;
    await buildMemoryIngestOutboxRecoverHandler(db, boundary.boss)([]);
    expect(boundary.sent.slice().sort()).toEqual(rejectedIds.slice().sort());
    for (const id of rejectedIds) await ingest()([{ data: { event_id: id } }]);
    expect(boundary.add).toHaveBeenCalledOnce();
    expect(await db.select().from(provider_attempt)).toHaveLength(1);

    // Operator replay: no answer source may receive a grant; a stalled non-answer source still can.
    for (const id of answerIds) {
      await expect(
        authorizeMemoryIngestReplay(db, {
          sourceEventId: id,
          requestId: randomUUID(),
          expectedFenceId: memoryReconcileHandoffEventId('add_started', id),
          operator: 'operator-test',
          reason: 'attempted replay of a learner answer',
          allowPaidReplay: true,
        }),
      ).rejects.toThrow(/existing user event/);
    }
    const stalledAskId = 'evt-ask-stalled';
    await write(
      stalledAskId,
      'experimental:copilot_user_ask',
      { user_message: '再讲一遍逆元' },
      true,
    );
    await claimMemoryIngest(db, stalledAskId);
    const fence = memoryReconcileHandoffEventId('add_started', stalledAskId);
    await db
      .update(event)
      .set({ created_at: new Date(Date.now() - 180_000) })
      .where(eq(event.id, fence));
    const grant = await authorizeMemoryIngestReplay(db, {
      sourceEventId: stalledAskId,
      requestId: randomUUID(),
      expectedFenceId: fence,
      operator: 'operator-test',
      reason: 'operator replay of a stalled copilot add',
      allowPaidReplay: true,
    });
    expect(grant.source_event_id).toBe(stalledAskId);
  });
});
