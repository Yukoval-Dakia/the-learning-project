import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { generateOpenApiDocument } from '@/kernel/openapi';
import { CreateAppealBodySchema, CreateAttemptBodySchema } from './contracts';
import {
  CreatePaperSubmissionBodySchema,
  LegacyPaperSubmissionBodySchema,
} from './paper-contracts';

describe('practice attempt and appeal contracts', () => {
  it('keeps attempt defaults aligned with the route handler', () => {
    const body = CreateAttemptBodySchema.parse({ question_id: 'q1', rating: 'good' });

    expect(body.referenced_knowledge_ids).toEqual([]);
    expect(body.answer_image_refs).toEqual([]);
    expect(body.auto_rate).toBe(false);
    const missingIdentity = CreateAttemptBodySchema.safeParse({ rating: 'good' });
    expect(missingIdentity.success).toBe(false);
    if (!missingIdentity.success) {
      expect(missingIdentity.error.issues[0]?.message).toBe(
        'activity_ref, question_id, or mistake_id is required',
      );
    }
  });

  it('accepts an optional 1-5 self_confidence and rejects out-of-range/non-integer (YUK-444)', () => {
    // observe-only capture field: present only when the learner picked a 1-5 value;
    // absent/null when skipped → server conditional-spread keeps the event byte-identical.
    expect(
      CreateAttemptBodySchema.parse({ question_id: 'q1', rating: 'good', self_confidence: 3 }),
    ).toMatchObject({ self_confidence: 3 });
    expect(CreateAttemptBodySchema.safeParse({ question_id: 'q1', rating: 'good' }).success).toBe(
      true,
    );
    for (const bad of [0, 6, 3.5]) {
      expect(
        CreateAttemptBodySchema.safeParse({
          question_id: 'q1',
          rating: 'good',
          self_confidence: bad,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts optional supplied judge provenance evidence', () => {
    const body = CreateAttemptBodySchema.parse({
      question_id: 'q1',
      rating: 'good',
      judge_task_run_id: 'tr-1',
      judge_provenance_token: 'signed-token',
    });

    expect(body.judge_task_run_id).toBe('tr-1');
    expect(body.judge_provenance_token).toBe('signed-token');
  });

  it('renders the three supported attempt identity forms as OpenAPI anyOf', () => {
    const document = generateOpenApiDocument([
      {
        name: 'test',
        description: 'test',
        api: {
          routes: [
            {
              method: 'POST',
              path: '/api/attempts',
              operationId: 'createAttemptForContractTest',
              request: { body: CreateAttemptBodySchema },
              responses: { 201: z.object({ ok: z.boolean() }) },
              successStatus: 201,
            },
          ],
        },
      },
    ]) as {
      paths: Record<
        string,
        { post: { requestBody: { content: { 'application/json': { schema: unknown } } } } }
      >;
    };
    const schema = document.paths['/api/attempts'].post.requestBody.content['application/json']
      .schema as { anyOf: Array<{ required?: string[] }> };

    expect(schema.anyOf).toHaveLength(3);
    expect(schema.anyOf.map((branch) => branch.required)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['activity_ref', 'rating']),
        expect.arrayContaining(['question_id', 'rating']),
        expect.arrayContaining(['mistake_id', 'rating']),
      ]),
    );
  });

  it('validates appeal handles and the reason length cap', () => {
    expect(CreateAppealBodySchema.safeParse({ judge_event_id: 'judge_1' }).success).toBe(true);
    expect(CreateAppealBodySchema.safeParse({ judge_event_id: '' }).success).toBe(false);
    expect(
      CreateAppealBodySchema.safeParse({
        judge_event_id: 'judge_1',
        reason_md: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe('paper submission capture contract (YUK-784)', () => {
  // 卷提交 wire 的过程框字段，镜像 CreateAttemptBodySchema.reasoning_trace 的形态：
  // nullable().optional()，上界单一真源 REASONING_TRACE_MAX_LEN。缺省 absent → 既有提交逐字不变。
  const base = {
    session_id: 'review_1',
    question_id: 'q1',
    answer_md: '答',
  };

  it('accepts an optional reasoning_trace and keeps it absent when omitted (byte-identical default)', () => {
    const parsed = LegacyPaperSubmissionBodySchema.parse(base);
    expect(Object.hasOwn(parsed, 'reasoning_trace')).toBe(false);
    expect(
      LegacyPaperSubmissionBodySchema.parse({ ...base, reasoning_trace: '先列方程' }),
    ).toMatchObject({ reasoning_trace: '先列方程' });
    // null 是合法显式空（与 attempts 契约同型，server 侧 conditional-spread 落库时判空）。
    expect(
      LegacyPaperSubmissionBodySchema.safeParse({ ...base, reasoning_trace: null }).success,
    ).toBe(true);
  });

  it('rejects an over-cap reasoning_trace (same source of truth as the solo path)', () => {
    expect(
      LegacyPaperSubmissionBodySchema.safeParse({
        ...base,
        reasoning_trace: 'x'.repeat(REASONING_TRACE_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    expect(
      LegacyPaperSubmissionBodySchema.safeParse({
        ...base,
        reasoning_trace: 'x'.repeat(REASONING_TRACE_MAX_LEN),
      }).success,
    ).toBe(true);
  });

  it('resource-form (paper_id) body shares the same capture field', () => {
    const parsed = CreatePaperSubmissionBodySchema.parse({
      paper_id: 'paper_1',
      question_id: 'q1',
      answer_md: '答',
      reasoning_trace: '先列方程',
    });
    expect(parsed.reasoning_trace).toBe('先列方程');
  });
});
