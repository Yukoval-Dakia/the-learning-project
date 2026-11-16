import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMemoryEventIngestHandler } from '@/capabilities/agency/server/memory/triggers';
import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import {
  CRISIS_GUARD_CONFIG_VERSION,
  type CrisisDetectionClass,
  crisisTemplateForClass,
} from '@/core/crisis/classify';
import { event, job_events, knowledge } from '@/db/schema';
import { COPILOT_REPLY_ACTION, COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { __resetRateLimitForTests } from '@/kernel/request-rate-limit';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memoryClientMock } from '../../../../tests/helpers/memory-client-mock';
import { runCopilotRun } from '../jobs/copilot_run';
import { copilotCapability } from '../manifest';
import type { ExecuteCopilotTurn } from '../server/copilot-execution';
import { assembleCopilotRunInput } from '../server/copilot-run-input';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { CRISIS_GUARD_EVENT_ACTION } from '../server/crisis-guard';
import { parsePersistedJobData } from '../server/durable-dispatch';

const boss = vi.hoisted(() => ({
  send: vi.fn(async () => 'offline-job'),
  getJobById: vi.fn(async () => null),
}));
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: async () => boss,
  fromPgBossDrizzleTx: () => ({}),
}));
// Only queue delivery is substituted. Real route/session/acceptance/worker owners run.
vi.mock('@/kernel/background-job-enqueue', () => ({ shouldEnqueueBackgroundJobs: () => true }));

const app = buildHonoApp([copilotCapability, ingestionCapability], {
  epochGate: async () => ({ runnable: true }),
});
const token = 'offline-crisis-invariant-token';

type Hit = { policy: 'crisis'; detectionClass: Exclude<CrisisDetectionClass, 'none'> };
type Miss = { policy: 'allow' };
type ChatCase = {
  kind: 'chat';
  name: string;
  user_message: string;
  review_answer?: unknown;
  expected: Hit | Miss;
};
type AnswerCase = {
  kind: 'answer';
  name: string;
  wrong_answer_md: string;
  expected: Hit | Miss;
};

const cases: (ChatCase | AnswerCase)[] = [
  {
    kind: 'chat',
    name: 'chat first-person method intent 跳楼',
    user_message: '我想跳楼',
    expected: { policy: 'crisis', detectionClass: 'explicit' },
  },
  {
    kind: 'chat',
    name: 'chat first-person ingestion 吞药',
    user_message: '我准备吞一整瓶安眠药',
    expected: { policy: 'crisis', detectionClass: 'explicit' },
  },
  {
    kind: 'chat',
    name: 'chat endurance collapse',
    user_message: '我撑不下去了',
    expected: { policy: 'crisis', detectionClass: 'indirect' },
  },
  {
    kind: 'chat',
    name: 'chat ironic meme usage',
    user_message: '这次再考砸我就原地去世😂',
    expected: { policy: 'crisis', detectionClass: 'quoted_ironic' },
  },
  {
    kind: 'chat',
    name: 'chat non-suicidal distress',
    user_message: '最近每天只睡3个小时',
    expected: { policy: 'crisis', detectionClass: 'distress' },
  },
  {
    kind: 'chat',
    name: 'chat crisis turn carrying a review_answer attachment gets support, not 400',
    user_message: '我想割腕',
    review_answer: {
      authorize_submission: true,
      question_id: 'unvalidated_attachment',
      assessment: {},
    },
    expected: { policy: 'crisis', detectionClass: 'explicit' },
  },
  {
    kind: 'chat',
    name: 'chat schoolwork mentioning bare 自杀 stays ordinary',
    user_message: '作业题：分析课文中主人公自杀的社会原因',
    expected: { policy: 'allow' },
  },
  {
    kind: 'chat',
    name: 'chat third-party why-question is released',
    user_message: '他为什么想死',
    expected: { policy: 'allow' },
  },
  {
    kind: 'chat',
    name: 'chat academic English mention stays ordinary',
    user_message: 'Why does the protagonist commit suicide at the end of the novel?',
    expected: { policy: 'allow' },
  },
  {
    kind: 'answer',
    name: 'manual mistake answer carrying a crisis expression is marked',
    wrong_answer_md: '我不会做这道题，我撑不下去了',
    expected: { policy: 'crisis', detectionClass: 'indirect' },
  },
  {
    kind: 'answer',
    name: 'manual mistake answer about an academic suicide mention is unmarked',
    wrong_answer_md: '答：课文里人物自杀是时代悲剧的体现。',
    expected: { policy: 'allow' },
  },
];

async function postChat(body: Record<string, unknown>) {
  return app.request('/api/copilot/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'x-internal-token': token,
    },
    body: JSON.stringify(body),
  });
}

async function acceptTurn(row: ChatCase) {
  const response = await postChat({
    user_message: row.user_message,
    triggered_by: 'chat',
    ...(row.review_answer !== undefined ? { review_answer: row.review_answer } : {}),
  });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
  const receipt = (await response.json()) as {
    run_id: string;
    session_id: string;
    derivation_policy: string;
  };
  return receipt;
}

/** The immutable job payload accepted at admission, read back from QUEUED. */
async function deliveredJobData(runId: string, sessionId: string) {
  const [queued] = await testDb()
    .select({ payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, COPILOT_RUN_TABLE),
        eq(job_events.business_id, runId),
        eq(job_events.event_type, COPILOT_RUN_EVENTS.QUEUED),
      ),
    )
    .limit(1);
  const data = queued && parsePersistedJobData(queued.payload, runId, sessionId);
  if (!data) throw new Error('accepted run has no persisted job_data');
  return data;
}

const learnerHeader = { header_md: '学习者状态 fixture。', proposal_feedback: [] };

/** Records the provider seam; returns a complete accepted terminal result. */
function providerStub() {
  return vi.fn<ExecuteCopilotTurn>(async () => {
    const replyText = '学术问题按普通回合回答。';
    const digest = createHash('sha256').update(replyText, 'utf8').digest('hex');
    return {
      taskRunId: 'offline_provider_stub',
      finishReason: 'end_turn',
      partial: false,
      contextDigest: 'offline_ctx',
      finalization: {
        replyText,
        preparedReply: { text: replyText },
        accepted: true,
        receipt: {
          protocol_version: 2,
          assurance: 'unsealed',
          root_task_run_id: 'offline_provider_stub',
          candidate_sha256: digest,
          reply_sha256: digest,
          trace_sha256: digest,
          trace_call_count: 0,
          observed_completed_tool_use_ids: [],
          correction: 'normal',
          proposal_disclosure: 'none',
        },
      },
    };
  });
}

async function sessionEvents(sessionId: string) {
  return testDb().select().from(event).where(eq(event.session_id, sessionId));
}

async function runFrames(runId: string) {
  return testDb()
    .select({ event_type: job_events.event_type, payload: job_events.payload })
    .from(job_events)
    .where(
      and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, runId)),
    );
}

beforeEach(async () => {
  await resetDb();
  await testDb().delete(job_events);
  __resetRateLimitForTests();
  boss.send.mockClear();
  boss.getJobById.mockClear();
  vi.stubEnv('INTERNAL_TOKEN', token);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('crisis referral at real boundaries', () => {
  // @invariant crisis: a learner crisis expression is forced into the restricted derivation lane — fixed reviewed template instead of a provider call, a de-identified guard event, and exclusion from memory and derived channels — while academic mentions stay ordinary and every answer write point carries the same mark
  // @fails-if a classified chat turn reaches the provider or keeps 'allow', the guard event or crisis_template finish is missing, an academic utterance is forced to crisis, or a persisted learner answer loses the crisis mark
  it.each(cases)('$name', async (row) => {
    if (row.kind === 'answer') {
      const kcId = `kc_${randomUUID()}`;
      const now = new Date();
      await testDb()
        .insert(knowledge)
        .values({ id: kcId, name: '写入点科目', domain: 'math', created_at: now, updated_at: now });
      const response = await app.request('/api/mistakes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': token,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          prompt_md: '计算 1+1。',
          reference_md: '2',
          wrong_answer_md: row.wrong_answer_md,
          knowledge_ids: [kcId],
          cause: null,
          difficulty: 2,
          question_kind: 'short_answer',
        }),
      });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
      const { mistake_id: attemptId } = (await response.json()) as { mistake_id: string };
      const [attempt] = await testDb().select().from(event).where(eq(event.id, attemptId));
      expect(attempt?.action).toBe('attempt');
      if (row.expected.policy === 'crisis') {
        expect(attempt?.payload).toMatchObject({
          derivation_policy: 'crisis',
          crisis_detection_class: row.expected.detectionClass,
          crisis_guard_version: CRISIS_GUARD_CONFIG_VERSION,
        });
        // Marked at write time: already stamped out of memory ingest and brief scopes.
        expect(attempt?.ingest_at).not.toBeNull();
        expect(attempt?.affected_scopes).toEqual([]);
      } else {
        expect(attempt?.payload.derivation_policy ?? 'allow').toBe('allow');
        expect(attempt?.payload.crisis_detection_class).toBeUndefined();
        // Unmarked answers remain ordinary pending-ingest events.
        expect(attempt?.ingest_at).toBeNull();
      }
      return;
    }

    const receipt = await acceptTurn(row);
    const { run_id: runId, session_id: sessionId } = receipt;
    if (row.expected.policy === 'allow') {
      expect(receipt.derivation_policy).toBe('allow');
      const rows = await sessionEvents(sessionId);
      const ask = rows.find((r) => r.id === runId);
      expect(ask?.action).toBe(COPILOT_USER_ASK_ACTION);
      expect(ask?.payload.derivation_policy).toBe('allow');
      expect(rows.some((r) => r.action === CRISIS_GUARD_EVENT_ACTION)).toBe(false);
      // The academic turn still reaches the provider; nothing silently templates it.
      const provider = providerStub();
      const result = await runCopilotRun({
        db: testDb(),
        data: await deliveredJobData(runId, sessionId),
        executeCopilotTurnFn: provider,
        resolveCopilotRunInputFn: (db, params) =>
          assembleCopilotRunInput(db, params, {
            resolveLearnerStateHeaderFn: async () => learnerHeader,
          }),
      });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('done');
      return;
    }

    expect(receipt.derivation_policy).toBe('crisis');
    const template = crisisTemplateForClass(row.expected.detectionClass);
    const provider = vi.fn<ExecuteCopilotTurn>();
    const result = await runCopilotRun({
      db: testDb(),
      data: await deliveredJobData(runId, sessionId),
      executeCopilotTurnFn: provider,
    });
    // The template path never engages the paid model or tools.
    expect(provider).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'done',
      reply: template.text_md,
      task_run_id: `copilot_run_crisis_${runId}`,
    });
    const frames = await runFrames(runId);
    const done = frames.find((frame) => frame.event_type === COPILOT_RUN_EVENTS.DONE);
    expect(done?.payload.finish_reason).toBe('crisis_template');
    expect(frames.some((f) => f.event_type === COPILOT_RUN_EVENTS.STARTED)).toBe(false);
    expect(frames.some((f) => f.event_type === COPILOT_RUN_EVENTS.EXECUTION_STARTED)).toBe(false);

    const rows = await sessionEvents(sessionId);
    const ask = rows.find((r) => r.id === runId);
    const guard = rows.find((r) => r.action === CRISIS_GUARD_EVENT_ACTION);
    const reply = rows.find((r) => r.action === COPILOT_REPLY_ACTION);
    expect(ask?.payload.derivation_policy).toBe('crisis');
    expect(guard?.payload).toMatchObject({
      detection_class: row.expected.detectionClass,
      entry_point: 'copilot_chat',
      guard_version: CRISIS_GUARD_CONFIG_VERSION,
      template_version: template.version,
      template_review_status: template.review_status,
      derivation_policy: 'crisis',
      ...(row.review_answer !== undefined ? { dropped_attachment_kind: 'review_answer' } : {}),
    });
    expect(reply?.payload).toMatchObject({
      reply_md: template.text_md,
      derivation_policy: 'crisis',
      durable_finish_reason: 'crisis_template',
    });
    // Write-time opt-out on ask, guard and reply: stamped out of the memory
    // outbox and every scope-derived channel before any reader sees them.
    for (const r of rows) {
      expect(r.ingest_at).not.toBeNull();
      expect(r.affected_scopes).toEqual([]);
    }
    // The live-policy gate agrees: replaying the same events into the real
    // memory ingest handler reaches no provider and enqueues nothing.
    const memory = memoryClientMock();
    const send = vi.fn(async () => 'memory_job');
    await buildMemoryEventIngestHandler(
      testDb(),
      { send },
      { memoryClient: memory },
    )(rows.map((r) => ({ data: { event_id: r.id } })));
    expect(memory.addEventMemoryOnce).not.toHaveBeenCalled();
    expect(memory.findByEventId).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
