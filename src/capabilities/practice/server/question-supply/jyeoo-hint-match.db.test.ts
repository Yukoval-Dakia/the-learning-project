// YUK-986 (Supply-Agent/1) — jyeoo hint 确定性名匹配 db 测试。
// 关键不变量：子节点 domain=null（沿 parent 链继承），匹配必须解析 effective domain——
// 只按 knowledge.domain 直查会漏掉全部子节点（实现期修掉的真 bug，此测试锁死回归）。

import { beforeEach, describe, expect, it } from 'vitest';
import { knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  findSubjectRootKnowledgeId,
  hintSegments,
  matchJyeooKnowledgeHints,
  normalizeHint,
} from './jyeoo-hint-match';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-01T00:00:00Z');

async function seedMathTree(): Promise<void> {
  await db.insert(knowledge).values([
    {
      id: 'math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-probability',
      name: '概率论',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-geometric',
      name: '几何概型',
      domain: null,
      parent_id: 'kc-probability',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-archived',
      name: '旧集合',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
      archived_at: NOW,
    },
    // 另一科目的同名节点不得被 math 匹配串线。
    {
      id: 'yuwen-root',
      name: '语文',
      domain: 'yuwen',
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-yuwen-geo',
      name: '几何概型',
      domain: null,
      parent_id: 'yuwen-root',
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
}

describe('normalizeHint / hintSegments', () => {
  it('normalizes whitespace and case', () => {
    expect(normalizeHint('  几何概型　')).toBe('几何概型');
    expect(normalizeHint('Set  Theory')).toBe('set theory');
  });

  it('splits composite hints on 、 with the whole string first', () => {
    expect(hintSegments('转化思想、综合法')).toEqual(['转化思想、综合法', '转化思想', '综合法']);
  });
});

describe('matchJyeooKnowledgeHints', () => {
  it('matches child nodes through parent-chain effective domain (never just roots)', async () => {
    await seedMathTree();
    const result = await matchJyeooKnowledgeHints(db, 'math', ['几何概型', '转化思想、综合法']);
    expect(result.matched).toEqual([
      { hint: '几何概型', knowledgeId: 'kc-geometric', knowledgeName: '几何概型' },
    ]);
    expect(result.unmatched).toEqual(['转化思想、综合法']);
  });

  it('matches a composite hint via one of its segments', async () => {
    await seedMathTree();
    const result = await matchJyeooKnowledgeHints(db, 'math', ['综合法、几何概型、数学运算']);
    expect(result.matched.map((m) => m.knowledgeId)).toEqual(['kc-geometric']);
    expect(result.unmatched).toEqual([]);
  });

  it('never matches archived nodes or another domain’s same-named node', async () => {
    await seedMathTree();
    const archived = await matchJyeooKnowledgeHints(db, 'math', ['旧集合']);
    expect(archived.matched).toEqual([]);
    expect(archived.unmatched).toEqual(['旧集合']);

    const yuwen = await matchJyeooKnowledgeHints(db, 'yuwen', ['几何概型']);
    expect(yuwen.matched.map((m) => m.knowledgeId)).toEqual(['kc-yuwen-geo']);
  });

  it('dedupes repeated matches and reports ambiguous duplicate names', async () => {
    await seedMathTree();
    await db.insert(knowledge).values({
      id: 'kc-geometric-dup',
      name: '几何概型 ',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    });
    const result = await matchJyeooKnowledgeHints(db, 'math', ['几何概型', '几何概型']);
    expect(result.matched).toHaveLength(1);
    expect(result.ambiguous).toEqual(['几何概型']);
  });
});

describe('findSubjectRootKnowledgeId', () => {
  it('returns the domain-carrying root and null for an unknown domain', async () => {
    await seedMathTree();
    expect(await findSubjectRootKnowledgeId(db, 'math')).toBe('math-root');
    expect(await findSubjectRootKnowledgeId(db, 'physics')).toBeNull();
  });
});
