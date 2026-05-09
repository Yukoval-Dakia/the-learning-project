import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { parseAttributionOutput, runAttributionAndWrite } from './attribute';

describe('parseAttributionOutput', () => {
  it('parses well-formed JSON with all fields', () => {
    const text = '{"primary_category":"concept","secondary_categories":["memory"],"ai_analysis_md":"用户混淆了「之」的助词和动词用法","confidence":0.85}';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('concept');
    expect(out.secondary_categories).toEqual(['memory']);
    expect(out.confidence).toBe(0.85);
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text = '分析如下：\n\n{"primary_category":"reading","secondary_categories":[],"ai_analysis_md":"未注意「之」位置","confidence":0.6}\n\n以上。';
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

function makeAttributeMockDb(opts: { updateChanges?: number } = {}) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => ({
      run: async () => {
        if (/update mistake/i.test(sql)) {
          updates.push({ sql, binds });
        }
        return { success: true, meta: { changes: opts.updateChanges ?? 1 } };
      },
    }),
  }));
  return { db: { prepare } as unknown as D1Database, updates };
}

describe('runAttributionAndWrite', () => {
  const validInput = {
    prompt_md: '"之"在主谓之间的用法?',
    reference_md: '取消句子独立性',
    wrong_answer_md: '助词',
    knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'wenyan' }],
  };

  it('writes parsed cause to mistake row', async () => {
    const { db, updates } = makeAttributeMockDb();
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
    expect(updates).toHaveLength(1);
    const cause = JSON.parse(updates[0].binds[0] as string);
    expect(cause.primary_category).toBe('concept');
    expect(cause.user_edited).toBe(false);
    expect(cause.confidence).toBe(0.8);
    expect(updates[0].binds[2]).toBe('m1');
    expect(updates[0].binds[3]).toBe(0);
  });

  it('swallows runTask error (no update; no throw)', async () => {
    const { db, updates } = makeAttributeMockDb();
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
    expect(updates).toHaveLength(0);
  });

  it('swallows parse error (no update)', async () => {
    const { db, updates } = makeAttributeMockDb();
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
    expect(updates).toHaveLength(0);
  });

  it('logs warn when changes=0 (cause already set or version mismatch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = makeAttributeMockDb({ updateChanges: 0 });
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
