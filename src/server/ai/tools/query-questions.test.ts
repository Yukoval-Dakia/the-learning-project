// ADR-0032 D9 / YUK-304 (lane B) — query_questions DomainTool (db partition).
// Wraps listQuestions (YUK-280 reader); the assertions here pin the WRAPPER
// contract (projection / include_drafts default / limit cap), not the reader's
// own axes (covered by src/server/questions/list tests).
import { beforeEach, describe, expect, it } from 'vitest';

import { knowledge, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { queryQuestionsTool } from './query-questions';
import type { ToolContext } from './types';

const BASE = new Date('2026-06-09T00:00:00.000Z');

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_query_questions',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function seed(): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values([
    { id: 'k_root', name: '文言文', domain: 'wenyan', created_at: BASE, updated_at: BASE },
    {
      id: 'k_zhi',
      name: '之的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
  await db.insert(question).values([
    {
      id: 'q_active',
      kind: 'short_answer',
      prompt_md: '活跃题面',
      reference_md: '答案',
      knowledge_ids: ['k_zhi'],
      difficulty: 3,
      source: 'manual',
      draft_status: null,
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'q_draft',
      kind: 'short_answer',
      prompt_md: '草稿题面',
      reference_md: '答案',
      knowledge_ids: ['k_zhi'],
      difficulty: 4,
      source: 'copilot_authored',
      draft_status: 'draft',
      created_at: new Date(BASE.getTime() + 1000),
      updated_at: new Date(BASE.getTime() + 1000),
    },
    {
      id: 'q_other',
      kind: 'choice',
      prompt_md: '其它知识点的题',
      reference_md: '答案',
      knowledge_ids: ['k_root'],
      difficulty: 2,
      source: 'manual',
      draft_status: null,
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
}

describe('query_questions DomainTool (ADR-0032 D9)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('contract fields', () => {
    expect(queryQuestionsTool.name).toBe('query_questions');
    expect(queryQuestionsTool.effect).toBe('read');
    expect(queryQuestionsTool.costClass).toBe('local');
    expect(queryQuestionsTool.mirrorEvent).toBe('never');
    expect('shape' in queryQuestionsTool.inputSchema).toBe(true);
  });

  it('filters by knowledge_id and INCLUDES drafts by default (duplicate-avoidance)', async () => {
    await seed();
    const out = await queryQuestionsTool.execute(ctx(), { knowledge_id: ['k_zhi'] });
    expect(out.total).toBe(2);
    const byId = new Map(out.items.map((i) => [i.id, i]));
    expect(byId.has('q_draft')).toBe(true);
    expect(byId.has('q_active')).toBe(true);
    expect(byId.has('q_other')).toBe(false);
    // Trimmed projection shape.
    expect(byId.get('q_draft')).toMatchObject({
      kind: 'short_answer',
      difficulty: 4,
      knowledge_ids: ['k_zhi'],
      draft_status: 'draft',
      source: 'copilot_authored',
      prompt_preview: '草稿题面',
    });
    expect(byId.get('q_draft')?.source_tier).toMatchObject({ tier: expect.any(Number) });
    // No full prompt_md leakage field.
    expect(Object.keys(byId.get('q_draft') ?? {})).not.toContain('prompt_md');
  });

  it('include_drafts=false excludes drafts (the API default behaviour)', async () => {
    await seed();
    const out = await queryQuestionsTool.execute(ctx(), {
      knowledge_id: ['k_zhi'],
      include_drafts: false,
    });
    expect(out.items.map((i) => i.id)).toEqual(['q_active']);
  });

  it('resolves a subject filter through the derived knowledge axis', async () => {
    await seed();
    const out = await queryQuestionsTool.execute(ctx(), { subject: 'wenyan' });
    expect(out.total).toBe(3);
    const none = await queryQuestionsTool.execute(ctx(), { subject: 'math' });
    expect(none.total).toBe(0);
  });

  it('caps limit at 50 via the input schema', () => {
    expect(() => queryQuestionsTool.inputSchema.parse({ limit: 51 })).toThrow();
    const parsed = queryQuestionsTool.inputSchema.parse({});
    expect(parsed).toMatchObject({ include_drafts: true, limit: 20, offset: 0 });
  });
});
