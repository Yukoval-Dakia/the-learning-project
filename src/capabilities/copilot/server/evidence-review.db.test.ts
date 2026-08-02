import { ai_task_runs } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  COPILOT_EVIDENCE_REVIEW_FAIL_CLOSED_REPLY,
  type CopilotEvidenceReviewRunTaskFn,
  reviewCopilotEvidenceReply,
} from './evidence-review';

const db = testDb();

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
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async () => ({
      task_run_id: 'reference_with_wrong_input_hash',
      text: '',
      structured_output: {
        protocol_version: 1,
        evidence_points: [
          {
            point_index: 0,
            request_unit_indices: [0],
            kind: 'observed_fact',
            statement_md: '只读结果返回了 exact event id。',
            source_refs: [
              {
                call_index: 0,
                side: 'output',
                json_pointer: '/event_id',
                role: 'value',
              },
            ],
          },
        ],
        request_coverage: [
          { request_unit_index: 0, status: 'answerable', evidence_point_indices: [0] },
        ],
        trace_coverage: [
          {
            call_index: 0,
            relevance: 'material',
            request_unit_indices: [0],
            evidence_point_indices: [0],
            rationale_md: '该 exact event id 直接回答 request atom。',
          },
        ],
        safe_reply: '只读结果返回 exact_event_01。',
      },
    }));

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
    const runTaskFn = vi.fn<CopilotEvidenceReviewRunTaskFn>(async (kind, input) => {
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
        return {
          task_run_id: taskRunId,
          text: '',
          structured_output: { protocol_version: 2 },
        };
      }
      return {
        task_run_id: taskRunId,
        text: '',
        structured_output: {
          protocol_version: 1,
          evidence_points: [
            {
              point_index: 0,
              request_unit_indices: [0],
              kind: 'observed_fact',
              statement_md: '只读结果返回了 exact event id。',
              source_refs: [
                {
                  call_index: 0,
                  side: 'output',
                  json_pointer: '/event_id',
                  role: 'value',
                },
              ],
            },
          ],
          request_coverage: [
            { request_unit_index: 0, status: 'answerable', evidence_point_indices: [0] },
          ],
          trace_coverage: [
            {
              call_index: 0,
              relevance: 'material',
              request_unit_indices: [0],
              evidence_point_indices: [0],
              rationale_md: '该 exact event id 直接回答 request atom。',
            },
          ],
          safe_reply: '只读结果返回 exact_event_01。',
        },
      };
    });

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
        rejection: expect.stringContaining('protocol_version'),
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
