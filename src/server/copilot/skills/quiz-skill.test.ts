// YUK-262 — quiz-skill DB tests.
//
// The quiz skill is PURE service orchestration (no LLM run): it runs the S2 找题次序
// (injected here as a fixture so no real background jobs enqueue), assembles a
// tool_quiz artifact from the tier-sorted pool hits, persists it, and replies with a
// /practice/<id> link. Acceptance:
//   - pool ok  → a tool_quiz artifact row (intent_source/tool_kind='quiz_gen',
//     attrs.origin='copilot_quiz_skill', generation_status='ready'), valid tool_state
//     with primary_knowledge_id, reply text carries /practice/<id>, status:'ok'.
//   - pool short → artifact built with n<count questions, reply mentions partial.
//   - pool empty → NO artifact, status:'degraded' (pool_empty), reply references the
//     enqueued background lines, NO quiz body (no text-spray).
//   - knowledge missing → NO artifact, status:'degraded' (knowledge_not_found).
//   - runSourcingSequenceFn is called with the right params (trigger:'manual', count).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolState } from '@/core/schema/business';
import { artifact, knowledge, question } from '@/db/schema';
import type { ExistingPoolHit, SourcingSequenceResult } from '@/server/quiz/sourcing-sequence';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { buildQuizSkillToolState, formatQuizReply, runQuizSkill } from './quiz-skill';

const db = testDb();

const SESSION_ID = 'ls_copilot_quiz';

async function seedKnowledge(id: string, name = '虚词「之」'): Promise<string> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name,
    domain: 'wenyan',
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedQuestion(knowledgeId: string): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'reading',
    prompt_md: '解释下列句中「之」的用法',
    reference_md: '代词，指代前文。',
    rubric_json: null,
    knowledge_ids: [knowledgeId],
    difficulty: 3,
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
  return id;
}

// A sourcing-sequence fixture returning the given pool hits (no enqueue side effects).
function seqFixture(over: Partial<SourcingSequenceResult>): SourcingSequenceResult {
  return {
    existing: [],
    satisfiedFromPool: false,
    enqueued: [],
    needs: [],
    ...over,
  };
}

function hit(questionId: string, tier = 1, source = 'manual'): ExistingPoolHit {
  return { question_id: questionId, source, tier };
}

describe('runQuizSkill (U6 quiz skill)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('pool ok: builds a tool_quiz artifact and returns a /practice link', async () => {
    const knowledgeId = await seedKnowledge('kn_quiz_ok');
    const q1 = await seedQuestion(knowledgeId);
    const q2 = await seedQuestion(knowledgeId);
    const q3 = await seedQuestion(knowledgeId);

    let capturedParams: unknown;
    const runSourcingSequenceFn = vi.fn(async (params: unknown) => {
      capturedParams = params;
      return seqFixture({
        existing: [hit(q1), hit(q2), hit(q3)],
        satisfiedFromPool: true,
      });
    });

    const result = await runQuizSkill(
      { db, sessionId: SESSION_ID, knowledgeId, userMessage: '给我出套题' },
      { runSourcingSequenceFn },
    );

    expect(result.status).toBe('ok');
    expect(result.question_count).toBe(3);
    expect(result.artifact_id).toBeDefined();
    expect(result.text_md).toContain(`/practice/${result.artifact_id}`);

    // The sequence ran with the right params (manual trigger, default count 3).
    expect(runSourcingSequenceFn).toHaveBeenCalledTimes(1);
    expect(capturedParams).toMatchObject({ knowledgeId, trigger: 'manual', count: 3 });

    // The artifact row is a runnable, Copilot-origin tool_quiz paper.
    const [row] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.artifact_id as string));
    expect(row.type).toBe('tool_quiz');
    expect(row.intent_source).toBe('quiz_gen');
    expect(row.tool_kind).toBe('quiz_gen');
    expect(row.generation_status).toBe('ready');
    expect(row.verification_status).toBe('not_required');
    expect(row.source).toBe('ai_generated');
    expect((row.attrs as Record<string, unknown>).origin).toBe('copilot_quiz_skill');
    expect((row.attrs as Record<string, unknown>).copilot_session_id).toBe(SESSION_ID);

    // tool_state parses and carries valid section assignments.
    const parsed = ToolState.parse(row.tool_state);
    expect(parsed.question_ids).toEqual([q1, q2, q3]);
    expect(parsed.sections).toHaveLength(1);
    const assignments = parsed.sections?.[0].assignments ?? [];
    expect(assignments).toHaveLength(3);
    for (const a of assignments) {
      expect(a.primary_knowledge_id).toBe(knowledgeId);
      expect(a.selection_reason).toBe('copilot_quiz_skill');
    }
  });

  it('pool short: builds an n<count paper and the reply mentions partial', async () => {
    const knowledgeId = await seedKnowledge('kn_quiz_short');
    const q1 = await seedQuestion(knowledgeId);
    const q2 = await seedQuestion(knowledgeId);

    const runSourcingSequenceFn = vi.fn(async () =>
      seqFixture({ existing: [hit(q1), hit(q2)], enqueued: ['closed_book'] }),
    );

    const result = await runQuizSkill(
      { db, sessionId: SESSION_ID, knowledgeId, userMessage: '给我出套题', count: 3 },
      { runSourcingSequenceFn },
    );

    expect(result.status).toBe('ok');
    expect(result.question_count).toBe(2);
    expect(result.text_md).toContain('先给你');
    expect(result.text_md).toContain(`/practice/${result.artifact_id}`);

    const [row] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.artifact_id as string));
    const parsed = ToolState.parse(row.tool_state);
    expect(parsed.question_ids).toHaveLength(2);
  });

  it('pool empty: NO artifact, degraded with pool_empty, references background lines', async () => {
    const knowledgeId = await seedKnowledge('kn_quiz_empty');

    const runSourcingSequenceFn = vi.fn(async () =>
      seqFixture({
        existing: [],
        enqueued: ['external_sourcing', 'material_grounded', 'closed_book'],
      }),
    );

    const result = await runQuizSkill(
      { db, sessionId: SESSION_ID, knowledgeId, userMessage: '给我出套题' },
      { runSourcingSequenceFn },
    );

    expect(result.status).toBe('degraded');
    expect(result.degrade_reason).toBe('pool_empty');
    expect(result.question_count).toBe(0);
    expect(result.artifact_id).toBeUndefined();
    expect(result.enqueued).toEqual(['external_sourcing', 'material_grounded', 'closed_book']);
    // Explicit degradation notice — NO quiz body, NO /practice link.
    expect(result.text_md).toContain('后台');
    expect(result.text_md).not.toContain('/practice/');

    // No artifact row was written.
    const rows = await db.select().from(artifact);
    expect(rows).toHaveLength(0);
  });

  it('knowledge missing: NO artifact, degraded with knowledge_not_found', async () => {
    const runSourcingSequenceFn = vi.fn(async () => seqFixture({ knowledgeNodeMissing: true }));

    const result = await runQuizSkill(
      { db, sessionId: SESSION_ID, knowledgeId: 'kn_nope', userMessage: '给我出套题' },
      { runSourcingSequenceFn },
    );

    expect(result.status).toBe('degraded');
    expect(result.degrade_reason).toBe('knowledge_not_found');
    expect(result.question_count).toBe(0);
    expect(result.artifact_id).toBeUndefined();
    expect(result.text_md).not.toContain('/practice/');

    const rows = await db.select().from(artifact);
    expect(rows).toHaveLength(0);
  });

  it('every assignment has primary_knowledge_id derived from the question knowledge_ids', async () => {
    const k1 = await seedKnowledge('kn_primary', '主知识点');
    const k2 = await seedKnowledge('kn_secondary', '次知识点');
    const id = createId();
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'reading',
      prompt_md: 'q',
      reference_md: 'r',
      knowledge_ids: [k1, k2],
      difficulty: 3,
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    const runSourcingSequenceFn = vi.fn(async () => seqFixture({ existing: [hit(id)] }));

    const result = await runQuizSkill(
      { db, sessionId: SESSION_ID, knowledgeId: k1, userMessage: '出题', count: 1 },
      { runSourcingSequenceFn },
    );

    const [row] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.artifact_id as string));
    const parsed = ToolState.parse(row.tool_state);
    const assignment = parsed.sections?.[0].assignments[0];
    expect(assignment?.primary_knowledge_id).toBe(k1);
    expect(assignment?.secondary_knowledge_ids).toEqual([k2]);
  });
});

// Pure-helper cases (deterministic, no DB) — kept in this db-partition file to match
// the teaching/solve sibling layout (one file per skill).
describe('buildQuizSkillToolState (pure)', () => {
  it('throws on an empty hit set (no empty papers)', () => {
    expect(() => buildQuizSkillToolState([], [], { sessionId: SESSION_ID })).toThrow();
  });

  it('throws when a hit question has no knowledge_ids', () => {
    expect(() =>
      buildQuizSkillToolState([hit('q_x')], [{ id: 'q_x', knowledge_ids: [] }], {
        sessionId: SESSION_ID,
      }),
    ).toThrow();
  });

  it('records the selected tiers in session_meta for evidence', () => {
    const toolState = buildQuizSkillToolState(
      [hit('q_a', 1), hit('q_b', 2)],
      [
        { id: 'q_a', knowledge_ids: ['k1'] },
        { id: 'q_b', knowledge_ids: ['k1', 'k2'] },
      ],
      { sessionId: SESSION_ID },
    );
    const meta = toolState.session_meta as Record<string, unknown>;
    expect(meta.copilot_session_id).toBe(SESSION_ID);
    expect(meta.selected_tiers).toEqual([
      { question_id: 'q_a', tier: 1 },
      { question_id: 'q_b', tier: 2 },
    ]);
    expect(meta.tool_context_task_run_id).toBeNull();
  });
});

describe('formatQuizReply (pure)', () => {
  it('ok (full): short body with a /practice link', () => {
    const text = formatQuizReply({
      status: 'ok',
      artifactId: 'art_1',
      questionCount: 3,
      partial: false,
    });
    expect(text).toContain('共 3 道');
    expect(text).toContain('/practice/art_1');
  });

  it('ok (partial): mentions the partial fill', () => {
    const text = formatQuizReply({
      status: 'ok',
      artifactId: 'art_2',
      questionCount: 2,
      partial: true,
    });
    expect(text).toContain('先给你 2 道');
    expect(text).toContain('/practice/art_2');
  });

  it('degraded (pool_empty): explains background lines, NO link', () => {
    const text = formatQuizReply({ status: 'degraded', reason: 'pool_empty' });
    expect(text).toContain('后台');
    expect(text).not.toContain('/practice/');
  });

  it('degraded (knowledge_not_found): asks for another node, NO link', () => {
    const text = formatQuizReply({ status: 'degraded', reason: 'knowledge_not_found' });
    expect(text).toContain('没找到');
    expect(text).not.toContain('/practice/');
  });
});
