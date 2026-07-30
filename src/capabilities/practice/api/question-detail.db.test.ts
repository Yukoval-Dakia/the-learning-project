// YUK-280 P4 (YUK-203) — GET /api/questions/[id] route DB integration test.
//
// Auth is enforced upstream by middleware (not re-tested here); this exercises
// the 200 detail path, the 404 on missing id, and 400 timeline_limit validation.

import { newId } from '@/core/ids';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './question-detail';

const NOW = new Date('2026-06-07T00:00:00Z');

async function seedQuestion(
  id: string,
  overrides: Partial<typeof question.$inferInsert> = {},
): Promise<void> {
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'reading',
      prompt_md: 'prompt',
      knowledge_ids: [],
      difficulty: 3,
      source: 'manual',
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    });
}

function interventionDiagnosticMetadata(dueAt: string, includeJudgeContract = false) {
  return {
    intervention_diagnostic: {
      schema_version: 1,
      intervention_id: 'intervention_detail_test',
      intervention_version: 1,
      diagnostic_kind: 'immediate',
      knowledge_id: 'kc_detail_test',
      due_at: dueAt,
    },
    ...(includeJudgeContract
      ? {
          probe_spec: {
            schema_version: 2,
            prompt_md: 'Explain why the transfer applies.',
            reference_md: 'private reference answer',
            expected_target_error_answer_md: 'private target-error answer',
            elicits_target_error_reason_md: 'private grading rationale',
            context_kind: 'abstract',
            representation_kind: 'natural_language',
            response_mode: 'short_answer',
            gold_response_signature: {
              kind: 'text',
              response_md: 'private gold signature',
            },
            target_error_response_signature: {
              kind: 'text',
              response_md: 'private target signature',
            },
          },
        }
      : {}),
  };
}

function mkReq(id: string, query = ''): Request {
  return new Request(`http://localhost/api/questions/${id}${query}`);
}

describe('GET /api/questions/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the detail aggregate for an existing question', async () => {
    const id = newId();
    await seedQuestion(id);

    const res = await GET(mkReq(id), { id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      source_tier: { tier: number; name: string };
      scheduling: unknown;
      backlinks: unknown[];
      computed_at_sec: number;
    };
    expect(body.id).toBe(id);
    expect(body.source_tier).toEqual({ tier: 4, name: 'generated' });
    expect(Array.isArray(body.backlinks)).toBe(true);
    expect(typeof body.computed_at_sec).toBe('number');
  });

  it('404s on a missing question', async () => {
    const res = await GET(mkReq('q_nope'), { id: 'q_nope' });
    expect(res.status).toBe(404);
  });

  it('404s product-owned intervention diagnostics instead of leaking future answers', async () => {
    const id = newId();
    await seedQuestion(id, {
      source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      reference_md: 'future diagnostic answer',
    });

    const res = await GET(mkReq(id), { id });

    expect(res.status).toBe(404);
  });

  it('returns an answer-safe intervention diagnostic projection to the canonical Practice face', async () => {
    const id = newId();
    await seedQuestion(id, {
      source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      prompt_md: 'Explain why the transfer applies.',
      reference_md: 'future diagnostic answer',
      rubric_json: { criteria: [], acceptable_answers: ['future diagnostic answer'] },
      source_ref: 'private-author-run',
      metadata: interventionDiagnosticMetadata('2026-06-07T00:00:00.000Z', true),
    });

    const res = await GET(mkReq(id, '?surface=practice'), { id });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id,
      source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      prompt_md: 'Explain why the transfer applies.',
      reference_md: null,
      rubric_json: null,
      source_ref: null,
      metadata: {},
      backlinks: [],
      backlinks_by_intent_source: {},
      timeline: [],
    });
    expect(JSON.stringify(body)).not.toContain('private reference answer');
    expect(JSON.stringify(body)).not.toContain('private target-error answer');
    expect(JSON.stringify(body)).not.toContain('private gold signature');
    expect(JSON.stringify(body)).not.toContain('private target signature');
  });

  it('404s a future diagnostic on the client-controlled Practice surface', async () => {
    const id = newId();
    await seedQuestion(id, {
      source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      prompt_md: 'future transfer prompt',
      reference_md: 'future transfer answer',
      draft_status: 'active',
      metadata: interventionDiagnosticMetadata('2099-01-01T00:00:00.000Z'),
    });

    const res = await GET(mkReq(id, '?surface=practice'), { id });

    expect(res.status).toBe(404);
  });

  it('404s a retired diagnostic on the Practice surface', async () => {
    const id = newId();
    await seedQuestion(id, {
      source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      draft_status: 'draft',
      metadata: interventionDiagnosticMetadata('2026-06-07T00:00:00.000Z'),
    });

    const res = await GET(mkReq(id, '?surface=practice'), { id });

    expect(res.status).toBe(404);
  });

  it('rejects unknown question surfaces', async () => {
    const id = newId();
    await seedQuestion(id);

    const res = await GET(mkReq(id, '?surface=question-bank'), { id });

    expect(res.status).toBe(400);
  });

  it('rejects an invalid timeline_limit with 400', async () => {
    const id = newId();
    await seedQuestion(id);
    const res = await GET(mkReq(id, '?timeline_limit=abc'), { id });
    expect(res.status).toBe(400);
  });

  it('rejects partial-numeric timeline_limit with 400 (parseInt leniency)', async () => {
    // P3 regression (coderabbit-route-34-timeline-limit-parseint): Number.parseInt
    // accepts '10abc' → 10 and '1.5' → 1; the strict /^[1-9]\d*$/ guard must reject
    // both rather than silently coercing.
    const id = newId();
    await seedQuestion(id);
    for (const raw of ['10abc', '1.5', '0', '-1', ' 10']) {
      const res = await GET(mkReq(id, `?timeline_limit=${encodeURIComponent(raw)}`), { id });
      expect(res.status).toBe(400);
    }
  });
});
