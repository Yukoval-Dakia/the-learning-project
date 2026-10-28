import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Review from '@/capabilities/practice/server/review-session-lifecycle';
import { artifact, learning_session, question } from '@/db/schema';
import { contractIntegrityDigest } from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './review-sessions';

function createRequest(body?: unknown): Request {
  return new Request('http://localhost/api/review-sessions', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

async function seedPaper(id: string): Promise<void> {
  const now = new Date();
  // YUK-1445 — a fresh paper opening really issues every slot through the serving
  // gate, so the fixture paper must carry a real published, admitted, servable
  // question (explicit deterministic option-set contract; no reference_md key
  // extraction). An empty question_ids paper now correctly 409s
  // ('no automatically servable slots').
  const questionId = `${id}_q1`;
  await testDb()
    .insert(question)
    .values({
      id: questionId,
      kind: 'choice',
      prompt_md: `并发开卷fixture题干 ${id}`,
      reference_md: null,
      knowledge_ids: [],
      difficulty: 3,
      source: 'manual',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  const options = [
    { option_id: `opt_${questionId}_a`, label: 'A', text: '选项甲' },
    { option_id: `opt_${questionId}_b`, label: 'B', text: '选项乙' },
  ];
  const contract = {
    structure: {
      group_id: questionId,
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: `并发开卷fixture题干 ${id}`, material_ids: [] }],
    },
    response_spec: {
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'single_choice' as const, options }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: [`opt_${questionId}_b`],
          },
          points: 1,
        },
      ],
      aggregation: { kind: 'sum' as const },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic' as const, comparator: 'exact_option_set' as const },
        },
      ],
      escalation: {
        on_unadmitted_model: 'withhold' as const,
        on_low_confidence: 'human_review' as const,
      },
    },
  };
  const published = await publishQuestionGroup(testDb(), {
    group_id: questionId,
    contract: { ...contract, integrity_digest: contractIntegrityDigest(contract) },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:review-sessions-publication',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  if (published.status !== 'published')
    throw new Error(`review-sessions fixture publication: ${published.status}`);
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'tool_quiz',
      title: `卷 ${id}`,
      knowledge_ids: [],
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      tool_kind: 'quiz_gen',
      tool_state: { question_ids: [questionId], sections: [] },
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

describe('canonical review-session resources', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('serializes concurrent creates for the same paper', async () => {
    await seedPaper('paper_concurrent');

    const responses = await Promise.all([
      POST(createRequest({ paper_id: 'paper_concurrent' })),
      POST(createRequest({ paper_id: 'paper_concurrent' })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);

    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ session_id: string }>),
    );
    expect(bodies[1]?.session_id).toBe(bodies[0]?.session_id);

    const rows = await testDb().execute<{ id: string }>(sql`
      SELECT id
      FROM learning_session
      WHERE artifact_id = 'paper_concurrent'
        AND type = 'review'
        AND status IN ('started', 'paused')
    `);
    expect(rows as unknown as Array<{ id: string }>).toHaveLength(1);
  });

  it('reuses the newest active session when legacy duplicates already exist', async () => {
    await seedPaper('paper_duplicate');
    const db = testDb();
    const older = await Review.startReviewSession(db, { artifactId: 'paper_duplicate' });
    const newer = await Review.startReviewSession(db, { artifactId: 'paper_duplicate' });
    await db
      .update(learning_session)
      .set({ created_at: new Date('2026-07-13T00:00:00Z') })
      .where(eq(learning_session.id, older.sessionId));
    await db
      .update(learning_session)
      .set({ created_at: new Date('2026-07-14T00:00:00Z') })
      .where(eq(learning_session.id, newer.sessionId));

    const response = await POST(createRequest({ paper_id: 'paper_duplicate' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session_id: newer.sessionId });
  });
});
