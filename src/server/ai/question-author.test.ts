// ADR-0031 / YUK-304 (lane B) — runQuestionAuthor seed core (db partition).
//
// Proves the 决定4/决定5 write contract: ONE transaction inserts the draft
// question row (draft_status='draft', structured tree with server-regenerated
// node ids, DERIVED prompt_md/reference_md) + the paired `question_draft`
// proposal; hallucinated knowledge ids are intersected code-side; a fully
// invalid seed soft-skips; parse failures throw (the DomainTool wrapper maps
// throws to status:'failed').
import { describe, expect, it, vi } from 'vitest';

import { knowledge, question } from '@/db/schema';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { beforeEach } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { runQuestionAuthor } from './question-author';

const BASE = new Date('2026-06-09T00:00:00.000Z');

async function seedKnowledge(): Promise<void> {
  await testDb()
    .insert(knowledge)
    .values([
      { id: 'k_wenyan', name: '文言文', domain: 'wenyan', created_at: BASE, updated_at: BASE },
      {
        id: 'k_zhi',
        name: '之的用法',
        domain: null,
        parent_id: 'k_wenyan',
        created_at: BASE,
        updated_at: BASE,
      },
      {
        id: 'k_archived',
        name: '已归档',
        domain: null,
        parent_id: 'k_wenyan',
        archived_at: BASE,
        created_at: BASE,
        updated_at: BASE,
      },
    ]);
}

function draftFixture(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'short_answer',
    difficulty: 3,
    knowledge_ids: ['k_zhi'],
    structured: {
      id: 'llm_placeholder',
      role: 'standalone',
      prompt_text: '解释「之」在「学而时习之」中的用法。',
      answers: ['代词，指代所学的内容。'],
      analysis: '「之」承前指代。',
    },
    choices_md: null,
    judge_kind_override: 'semantic',
    rubric_json: {
      criteria: [{ name: 'correctness', weight: 1, descriptor: '答出指代' }],
      required_points: ['代词', '指代'],
    },
    ...overrides,
  });
}

function mockRunTask(text: string) {
  return vi.fn(async () => ({
    text,
    task_run_id: 'tr_question_author_model',
    cost_usd: 0.01,
  }));
}

function deps(runTaskFn: ReturnType<typeof mockRunTask>) {
  return {
    db: testDb(),
    actorRef: 'agent:copilot',
    taskRunId: 'tr_author',
    causedByEventId: 'ev_user_ask',
    runTaskFn,
  };
}

describe('runQuestionAuthor (ADR-0031 lane B)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a draft question + question_draft proposal in one shot (knowledge seed)', async () => {
    const db = testDb();
    await seedKnowledge();
    const runTaskFn = mockRunTask(draftFixture());

    const result = await runQuestionAuthor(
      { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
      deps(runTaskFn),
    );
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') throw new Error('unreachable');

    // The model got the validated knowledge context + the subject profile.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [kind, input] = runTaskFn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(kind).toBe('QuestionAuthorTask');
    expect(input.knowledge_context).toEqual([{ id: 'k_zhi', name: '之的用法' }]);

    // Question row: draft gate + derived markdown + server-regenerated node id.
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(1);
    const q = rows[0];
    expect(q.id).toBe(result.questionId);
    expect(q.draft_status).toBe('draft');
    expect(q.source).toBe('copilot_authored');
    expect(q.kind).toBe('short_answer');
    expect(q.knowledge_ids).toEqual(['k_zhi']);
    expect(q.prompt_md).toContain('解释「之」');
    expect(q.reference_md).toContain('代词');
    expect(q.structured?.role).toBe('standalone');
    // Hallucinated/placeholder LLM node id never survives.
    expect(q.structured?.id).not.toBe('llm_placeholder');
    expect((q.created_by as { task_kind?: string }).task_kind).toBe('QuestionAuthorTask');
    expect(
      (q.metadata as { author_question?: { seed_mode?: string } }).author_question?.seed_mode,
    ).toBe('knowledge');

    // The paired proposal exists, pending, with the materialized question id.
    const proposals = await listProposalInboxRows(db, { status: 'pending' });
    expect(proposals.map((p) => p.kind)).toEqual(['question_draft']);
    expect(proposals[0].id).toBe(result.proposalId);
    expect(proposals[0].payload.proposed_change).toMatchObject({
      question_id: result.questionId,
      seed_mode: 'knowledge',
      knowledge_ids: ['k_zhi'],
    });
  });

  it('material seed: stem+sub tree persists with derived prompt/reference + provenance metadata', async () => {
    const db = testDb();
    await seedKnowledge();
    const runTaskFn = mockRunTask(
      draftFixture({
        kind: 'reading',
        knowledge_ids: ['k_zhi'],
        structured: {
          id: 'r',
          role: 'stem',
          prompt_text: '阅读下面的文段：学而时习之，不亦说乎。',
          sub_questions: [
            {
              id: 's1',
              role: 'sub',
              question_no: '1',
              prompt_text: '「说」是什么意思？',
              answers: ['通「悦」'],
            },
            {
              id: 's2',
              role: 'sub',
              question_no: '2',
              prompt_text: '翻译整句。',
              answers: ['学了又按时温习，不也很高兴吗？'],
            },
          ],
        },
      }),
    );

    const result = await runQuestionAuthor(
      {
        seed_mode: 'material',
        knowledge_ids: ['k_zhi'],
        material_body_md: '学而时习之，不亦说乎。',
        material_url: 'https://example.edu/lunyu',
        material_title: '论语·学而',
      },
      deps(runTaskFn),
    );
    expect(result.status).toBe('proposed');

    // material body rode on the run input (the task cannot fetch — critic #5).
    const [, input] = runTaskFn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(input.material).toMatchObject({ body_md: '学而时习之，不亦说乎。', title: '论语·学而' });

    const [q] = await db.select().from(question);
    expect(q.structured?.role).toBe('stem');
    expect(q.structured?.sub_questions).toHaveLength(2);
    // node ids regenerated + unique
    const ids = [q.structured?.id, ...(q.structured?.sub_questions?.map((s) => s.id) ?? [])];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('s1');
    expect(q.prompt_md).toContain('阅读下面的文段');
    expect(q.reference_md).toContain('通「悦」');
    expect(
      (q.metadata as { author_question?: { material_url?: string } }).author_question?.material_url,
    ).toBe('https://example.edu/lunyu');

    const proposals = await listProposalInboxRows(db, { status: 'pending' });
    expect(proposals[0].payload.proposed_change).toMatchObject({
      seed_mode: 'material',
      material_url: 'https://example.edu/lunyu',
    });
  });

  it('soft-skips when every seed knowledge id is unknown or archived (no LLM call)', async () => {
    await seedKnowledge();
    const runTaskFn = mockRunTask(draftFixture());
    const result = await runQuestionAuthor(
      { seed_mode: 'knowledge', knowledge_ids: ['k_nope', 'k_archived'] },
      deps(runTaskFn),
    );
    expect(result.status).toBe('skipped:knowledge_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(await testDb().select().from(question)).toHaveLength(0);
  });

  it('intersects hallucinated echoed knowledge_ids; full hallucination falls back to the seed set', async () => {
    const db = testDb();
    await seedKnowledge();
    // The model echoes one real + one invented id → intersect keeps the real one.
    const partial = await runQuestionAuthor(
      { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
      deps(mockRunTask(draftFixture({ knowledge_ids: ['k_zhi', 'k_invented'] }))),
    );
    expect(partial.status).toBe('proposed');
    let rows = await db.select().from(question);
    expect(rows[0].knowledge_ids).toEqual(['k_zhi']);

    await resetDb();
    await seedKnowledge();
    // Fully bogus echo → fall back to the validated seed set (quiz_gen salvage).
    const bogus = await runQuestionAuthor(
      { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
      deps(mockRunTask(draftFixture({ knowledge_ids: ['k_invented'] }))),
    );
    expect(bogus.status).toBe('proposed');
    rows = await db.select().from(question);
    expect(rows[0].knowledge_ids).toEqual(['k_zhi']);
  });

  it('throws on parse failure / malformed tree, leaving NO question row and NO proposal', async () => {
    const db = testDb();
    await seedKnowledge();

    await expect(
      runQuestionAuthor(
        { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
        deps(mockRunTask('not json at all')),
      ),
    ).rejects.toThrow(/no JSON object/);

    // Malformed tree: stem without sub_questions (passes Zod, rejected by the
    // normalization barrier).
    await expect(
      runQuestionAuthor(
        { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
        deps(
          mockRunTask(
            draftFixture({
              structured: { id: 'r', role: 'stem', prompt_text: '材料', sub_questions: [] },
            }),
          ),
        ),
      ),
    ).rejects.toThrow(/sub_question/);

    expect(await db.select().from(question)).toHaveLength(0);
    expect(await listProposalInboxRows(db, { status: 'pending' })).toHaveLength(0);
  });

  it("material seed without material_body_md throws (URL-only seeds can't ground a passage)", async () => {
    await seedKnowledge();
    const runTaskFn = mockRunTask(draftFixture());
    await expect(
      runQuestionAuthor(
        {
          seed_mode: 'material',
          knowledge_ids: ['k_zhi'],
          material_url: 'https://example.edu/only-url',
        },
        deps(runTaskFn),
      ),
    ).rejects.toThrow(/material_body_md/);
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});
