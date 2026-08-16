import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ai_task_runs } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
  type CopilotEvidenceReviewRunTaskFn,
  reviewCopilotEvidenceReply,
} from './evidence-review';
import type {
  CopilotEvidenceModelTraceCall,
  ReferenceEvidenceSubmission,
} from './evidence-submission';

const db = testDb();

function findTaggedSourceId(value: unknown, exactValue: unknown): string | undefined {
  if (Array.isArray(value)) {
    if (/^s(?:0|[1-9]\d*)$/.test(String(value[0])) && Object.is(value[1], exactValue)) {
      return String(value[0]);
    }
    for (const item of value) {
      const found = findTaggedSourceId(item, exactValue);
      if (found) return found;
    }
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findTaggedSourceId(item, exactValue);
      if (found) return found;
    }
  }
  return undefined;
}

function submitSimpleReference(
  input: unknown,
  submission: ReferenceEvidenceSubmission | undefined,
): void {
  if (!submission) throw new Error('reference submission missing');
  const evidenceTrace = (input as { evidence_trace: CopilotEvidenceModelTraceCall[] })
    .evidence_trace;
  const sourceId = findTaggedSourceId(evidenceTrace[0]?.output, 'exact_event_01');
  if (!sourceId) throw new Error('event id source missing');
  submission.appendEvidencePoints({
    points: [
      {
        request_unit_indices: [0],
        kind: 'observed_fact',
        statement_md: '只读结果返回了 exact event id。',
        sources: [{ source_id: sourceId, role: 'value' }],
      },
    ],
  });
  submission.setSafeReply({ safe_reply: '只读结果返回 exact_event_01。' });
  submission.completeReference();
}

describe('Copilot evidence validator provenance binding', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fails closed when a blind reference result cannot bind to its exact paid input', async () => {
    await db.insert(ai_task_runs).values({
      id: 'reference_with_wrong_input_hash',
      task_kind: 'CopilotEvidenceReviewTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      input_hash: '0'.repeat(64),
      status: 'success',
      finish_reason: 'stop',
      usage_json: { inputTokens: 8_000, outputTokens: 1_200 },
      started_at: new Date('2026-08-02T00:00:00.000Z'),
      finished_at: new Date('2026-08-02T00:00:20.000Z'),
    });
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (_kind, input, _ctx, submission) => {
        submitSimpleReference(input, submission as ReferenceEvidenceSubmission | undefined);
        return { task_run_id: 'reference_with_wrong_input_hash', text: '' };
      },
    );

    const result = await reviewCopilotEvidenceReply({
      db,
      requestContext: { user_message: '核验 exact_event_01。' },
      candidateReply: 'exact_event_01 存在。',
      candidateTaskRunId: 'candidate_task',
      toolTrace: [
        {
          name: 'query_events',
          effect: 'read',
          input: { filter: { eventId: 'exact_event_01' } },
          output: { event_id: 'exact_event_01' },
          error_reason: null,
          executed: true,
        },
      ],
      runTaskFn,
    });

    expect(result).toEqual({
      status: 'failed_closed',
      replyText: COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
      referenceTaskRunIds: ['reference_with_wrong_input_hash'],
    });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('binds a repaired blind attempt to its feedback-bearing paid input', async () => {
    let referenceAttempt = 0;
    const observedInputs: unknown[] = [];
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(
      async (kind, input, _ctx, submission) => {
        observedInputs.push(input);
        if (kind === 'CopilotEvidenceVerificationTask') return { text: '' };

        referenceAttempt += 1;
        const taskRunId = `reference_feedback_${referenceAttempt}`;
        await db.insert(ai_task_runs).values({
          id: taskRunId,
          task_kind: kind,
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro',
          input_hash: sha256CanonicalJson(input),
          status: 'success',
          finish_reason: 'stop',
          usage_json: { inputTokens: 14_000, outputTokens: 2_400 },
          started_at: new Date(`2026-08-02T00:01:0${referenceAttempt}.000Z`),
          finished_at: new Date(`2026-08-02T00:01:2${referenceAttempt}.000Z`),
        });
        if (referenceAttempt === 1) {
          return { task_run_id: taskRunId, text: '' };
        }
        submitSimpleReference(input, submission as ReferenceEvidenceSubmission | undefined);
        return { task_run_id: taskRunId, text: '' };
      },
    );

    const result = await reviewCopilotEvidenceReply({
      db,
      requestContext: { user_message: '核验 exact_event_01。' },
      candidateReply: 'exact_event_01 存在。',
      candidateTaskRunId: 'candidate_task',
      toolTrace: [
        {
          name: 'query_events',
          effect: 'read',
          input: { filter: { eventId: 'exact_event_01' } },
          output: { event_id: 'exact_event_01' },
          error_reason: null,
          executed: true,
        },
      ],
      runTaskFn,
    });

    expect(result).toMatchObject({
      status: 'failed_closed',
      referenceTaskRunIds: ['reference_feedback_1', 'reference_feedback_2'],
    });
    expect(observedInputs[1]).toMatchObject({
      contract_feedback: {
        previous_attempt: 1,
        rejection: 'evidence_points_missing',
      },
    });
    expect(sha256CanonicalJson(observedInputs[0])).not.toBe(sha256CanonicalJson(observedInputs[1]));

    const boundRuns = await db
      .select({
        id: ai_task_runs.id,
        inputHash: ai_task_runs.input_hash,
        promptFingerprint: ai_task_runs.prompt_fingerprint,
        resultDigest: ai_task_runs.result_digest,
      })
      .from(ai_task_runs);
    expect(boundRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'reference_feedback_1',
          inputHash: sha256CanonicalJson(observedInputs[0]),
          promptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          resultDigest: null,
        }),
        expect.objectContaining({
          id: 'reference_feedback_2',
          inputHash: sha256CanonicalJson(observedInputs[1]),
          promptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
  });
});
