import { generateOpenApiDocument } from '@/kernel/openapi';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateAppealBodySchema, CreateAttemptBodySchema } from './contracts';

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
