// ADR-0031 / YUK-304 (lane B) — write_quiz DomainTool (db partition).
//
// The load-bearing contrast (RP-2): DRAFT questions are ACCEPTED here (opposite
// precondition from write_review_plan) so a paper can include questions
// authored in the same copilot turn, pre-accept.
import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { ToolContext } from './types';
import { writeQuizTool } from './write-quiz';

const BASE = new Date('2026-06-09T00:00:00.000Z');

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_write_quiz',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function seedQuestion(opts: {
  id: string;
  knowledgeIds?: string[];
  draft?: boolean;
}): Promise<void> {
  await testDb()
    .insert(question)
    .values({
      id: opts.id,
      kind: 'short_answer',
      prompt_md: `题面 ${opts.id}`,
      reference_md: '答案。',
      knowledge_ids: opts.knowledgeIds ?? ['k_a'],
      difficulty: 3,
      source: opts.draft ? 'copilot_authored' : 'manual',
      draft_status: opts.draft ? 'draft' : null,
      created_at: BASE,
      updated_at: BASE,
    });
}

describe('write_quiz DomainTool (ADR-0031 lane B)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('contract fields', () => {
    expect(writeQuizTool.name).toBe('write_quiz');
    expect(writeQuizTool.effect).toBe('write');
    expect(writeQuizTool.costClass).toBe('local');
    expect(writeQuizTool.mirrorEvent).toBe('when_causal');
    // mcp-bridge requires a plain ZodObject inputSchema.
    expect('shape' in writeQuizTool.inputSchema).toBe(true);
    expect(
      writeQuizTool.summarize(
        { question_ids: ['q'] },
        {
          artifact_id: 'art_x',
          question_count: 3,
          knowledge_ids: [],
          practice_path: '/practice/art_x',
        },
      ).length,
    ).toBeLessThanOrEqual(120);
  });

  it('assembles DRAFT questions into a runnable paper (RP-2 opposite precondition)', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q_draft', knowledgeIds: ['k_a', 'k_b'], draft: true });
    await seedQuestion({ id: 'q_pool', knowledgeIds: ['k_c'] });

    const out = await writeQuizTool.execute(ctx(), {
      title: '之的用法练习',
      question_ids: ['q_draft', 'q_pool'],
    });
    expect(out.question_count).toBe(2);
    expect(out.practice_path).toBe(`/practice/${out.artifact_id}`);
    expect(out.knowledge_ids.sort()).toEqual(['k_a', 'k_b', 'k_c']);

    const [row] = await db.select().from(artifact).where(eq(artifact.id, out.artifact_id));
    expect(row.type).toBe('tool_quiz');
    expect(row.title).toBe('之的用法练习');
    // Zero-whitelist runnability: the practice list/start gate on intent_source.
    expect(row.intent_source).toBe('quiz_gen');
    expect(row.tool_kind).toBe('quiz_gen');
    expect((row.attrs as { origin?: string }).origin).toBe('copilot_write_quiz');
    expect(row.generation_status).toBe('ready');
    expect(row.verification_status).toBe('not_required');

    const toolState = row.tool_state as {
      question_ids: string[];
      sections: Array<{
        feedback_policy: string;
        assignments: Array<{
          question_id: string;
          primary_knowledge_id: string;
          secondary_knowledge_ids: string[];
          selection_reason: string;
        }>;
      }>;
      session_meta: { origin?: string; tool_context_task_run_id?: string };
    };
    // Practice order = input order; ToolState barrier shape held.
    expect(toolState.question_ids).toEqual(['q_draft', 'q_pool']);
    expect(toolState.sections).toHaveLength(1);
    expect(toolState.sections[0].feedback_policy).toBe('immediate');
    expect(toolState.sections[0].assignments[0]).toMatchObject({
      question_id: 'q_draft',
      primary_knowledge_id: 'k_a',
      secondary_knowledge_ids: ['k_b'],
      selection_reason: 'copilot_write_quiz',
    });
    expect(toolState.session_meta.origin).toBe('copilot_write_quiz');
    expect(toolState.session_meta.tool_context_task_run_id).toBe('tr_write_quiz');

    // The draft question itself was NOT touched (still draft until accept).
    const [q] = await db.select().from(question).where(eq(question.id, 'q_draft'));
    expect(q.draft_status).toBe('draft');
  });

  it('default title when none is given', async () => {
    await seedQuestion({ id: 'q_1' });
    const out = await writeQuizTool.execute(ctx(), { question_ids: ['q_1'] });
    const [row] = await testDb().select().from(artifact).where(eq(artifact.id, out.artifact_id));
    expect(row.title).toBe('练习卷');
  });

  it('rejects missing ids, duplicates, and knowledge-less questions (no artifact written)', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q_ok' });
    await seedQuestion({ id: 'q_nolabel', knowledgeIds: [] });

    await expect(
      writeQuizTool.execute(ctx(), { question_ids: ['q_ok', 'q_gone'] }),
    ).rejects.toThrow(/do not exist.*q_gone/);
    await expect(writeQuizTool.execute(ctx(), { question_ids: ['q_ok', 'q_ok'] })).rejects.toThrow(
      /duplicate/,
    );
    await expect(
      writeQuizTool.execute(ctx(), { question_ids: ['q_ok', 'q_nolabel'] }),
    ).rejects.toThrow(/no knowledge_id.*q_nolabel/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  it('rejects an empty paper at the schema boundary', () => {
    expect(() => writeQuizTool.inputSchema.parse({ question_ids: [] })).toThrow();
  });
});
