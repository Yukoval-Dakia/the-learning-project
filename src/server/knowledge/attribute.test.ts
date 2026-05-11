import { mistake, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { parseAttributionOutput, runAttributionAndWrite } from './attribute';

describe('parseAttributionOutput', () => {
  it('parses well-formed JSON with all fields', () => {
    const text =
      '{"primary_category":"concept","secondary_categories":["memory"],"ai_analysis_md":"用户混淆了「之」的助词和动词用法","confidence":0.85}';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('concept');
    expect(out.secondary_categories).toEqual(['memory']);
    expect(out.confidence).toBe(0.85);
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text =
      '分析如下：\n\n{"primary_category":"reading","secondary_categories":[],"ai_analysis_md":"未注意「之」位置","confidence":0.6}\n\n以上。';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('reading');
  });

  it('defaults secondary_categories to []', () => {
    const text = '{"primary_category":"other","ai_analysis_md":"无法判断","confidence":0.2}';
    const out = parseAttributionOutput(text);
    expect(out.secondary_categories).toEqual([]);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseAttributionOutput('完全不是 JSON')).toThrow();
  });

  it('throws on invalid primary_category', () => {
    const text = '{"primary_category":"bogus","ai_analysis_md":"r","confidence":0.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });

  it('throws when confidence out of range', () => {
    const text = '{"primary_category":"concept","ai_analysis_md":"r","confidence":1.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });

  it('throws when ai_analysis_md missing', () => {
    const text = '{"primary_category":"concept","confidence":0.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });
});

async function insertMistake(opts: { mistakeId: string; questionId: string; version?: number }) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.questionId,
    kind: 'short_answer',
    prompt_md: 'test prompt',
    reference_md: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'test',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(mistake).values({
    id: opts.mistakeId,
    question_id: opts.questionId,
    wrong_answer_md: 'wrong',
    source: 'test',
    knowledge_ids: [],
    variants: [],
    created_at: now,
    updated_at: now,
    version: opts.version ?? 0,
  });
}

describe('runAttributionAndWrite', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const validInput = {
    prompt_md: '"之"在主谓之间的用法?',
    reference_md: '取消句子独立性',
    wrong_answer_md: '助词',
    knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'wenyan' }],
  };

  it('writes parsed cause to mistake row', async () => {
    const db = testDb();
    await insertMistake({ mistakeId: 'm1', questionId: 'q1' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"ai_analysis_md":"a","confidence":0.8}',
    });
    await runAttributionAndWrite({
      db,
      mistakeId: 'm1',
      expectedVersion: 0,
      input: validInput,
      runTaskFn: fakeRunTask,
    });
    const rows = await db
      .select({ cause: mistake.cause })
      .from(mistake)
      .where(eq(mistake.id, 'm1'));
    expect(rows[0]?.cause).toMatchObject({
      primary_category: 'concept',
      user_edited: false,
      confidence: 0.8,
    });
  });

  it('swallows runTask error (no update; no throw)', async () => {
    const db = testDb();
    await insertMistake({ mistakeId: 'm1', questionId: 'q1' });
    const fakeRunTask = async () => {
      throw new Error('LLM down');
    };
    await expect(
      runAttributionAndWrite({
        db,
        mistakeId: 'm1',
        expectedVersion: 0,
        input: validInput,
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    const rows = await db
      .select({ cause: mistake.cause })
      .from(mistake)
      .where(eq(mistake.id, 'm1'));
    expect(rows[0]?.cause).toBeNull();
  });

  it('swallows parse error (no update)', async () => {
    const db = testDb();
    await insertMistake({ mistakeId: 'm1', questionId: 'q1' });
    const fakeRunTask = async () => ({ text: '不是 JSON' });
    await expect(
      runAttributionAndWrite({
        db,
        mistakeId: 'm1',
        expectedVersion: 0,
        input: validInput,
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    const rows = await db
      .select({ cause: mistake.cause })
      .from(mistake)
      .where(eq(mistake.id, 'm1'));
    expect(rows[0]?.cause).toBeNull();
  });

  it('logs warn when version mismatch (cause already set or version mismatch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = testDb();
    // Insert mistake with version=1 but we'll pass expectedVersion=0 (mismatch)
    await insertMistake({ mistakeId: 'm1', questionId: 'q1', version: 1 });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"ai_analysis_md":"a","confidence":0.5}',
    });
    await runAttributionAndWrite({
      db,
      mistakeId: 'm1',
      expectedVersion: 0,
      input: validInput,
      runTaskFn: fakeRunTask,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
