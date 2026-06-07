// YUK-275 — free-text 求卷 粗筛 + 参数解析 unit tests (pure DI, no live DB).
//
// runTaskFn is injected as a fixture and the db is a {}-stub; loadTreeSnapshotFn is
// stubbed so no live Postgres / knowledge tree is touched. This file is registered in
// vitest.shared.ts `fastTestInclude` (it only file-level imports @/server/copilot/
// quiz-intent — not in DB_TAINTED_DIRS — so it stays in the unit partition; without the
// allowlist entry the db config's src/**/*.test.ts glob would sweep it into the
// testcontainer partition).

import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeNode } from '@/server/knowledge/tree';
import {
  type QuizIntent,
  detectQuizIntent,
  parseQuizIntentOutput,
  resolveQuizIntent,
} from './quiz-intent';

// ── Stage 1: 粗筛 对照 fixture (CRITIC FIX P1 硬门槛) ───────────────────────────────

// ≥10 命中句 — every one MUST be true. Includes the owner判决句 + 强动词 + 求卷动词+量词.
const HIT_SENTENCES = [
  '选两篇高难度古诗词阅读给我', // owner 判决句
  '来五道阅读题',
  '给我几道题',
  '帮我组一套卷',
  '出套题',
  '出几道古诗词题',
  '刷题',
  '考考我',
  '给我来三道翻译题',
  '搞一份卷子练练', // 一份 量词
  'give me a quiz',
  '来点 practice paper',
];

// ≥10 误伤风险句 — every one MUST be false (normal conversation, NOT 求卷).
const MISS_SENTENCES = [
  '我来看看这道题',
  '来聊聊这道古诗词',
  '给我讲讲这道题的答案',
  '来帮我看看错题本',
  '这个知识点我没练习过',
  '这套测验题我做完了',
  '解释一下这道题的思路',
  '帮我把这道题讲一下',
  '这道古诗词是什么意思',
  '你能帮我分析这道题吗',
  '我想复习一下虚词的用法',
];

describe('detectQuizIntent (粗筛, pure)', () => {
  it('returns true for every 命中 fixture sentence (incl. owner 判决句)', () => {
    for (const s of HIT_SENTENCES) {
      expect(detectQuizIntent(s), `expected HIT: ${s}`).toBe(true);
    }
  });

  it('returns false for every 误伤风险 fixture sentence (no normal-conversation hijack)', () => {
    for (const s of MISS_SENTENCES) {
      expect(detectQuizIntent(s), `expected MISS: ${s}`).toBe(false);
    }
  });
});

// ── parseQuizIntentOutput (pure) ────────────────────────────────────────────────

describe('parseQuizIntentOutput (pure)', () => {
  it('brace-slices and Zod-parses a well-formed object embedded in prose', () => {
    const text = `好的，解析结果如下：
{"is_quiz_request":true,"knowledge_id":"k1","count":2,"difficulty_min":4,"unit":"篇","kind":null}
以上。`;
    const parsed = parseQuizIntentOutput(text);
    expect(parsed.is_quiz_request).toBe(true);
    expect(parsed.knowledge_id).toBe('k1');
    expect(parsed.count).toBe(2);
    expect(parsed.difficulty_min).toBe(4);
    expect(parsed.unit).toBe('篇');
  });

  it('throws on text with no JSON object', () => {
    expect(() => parseQuizIntentOutput('没有 JSON')).toThrow();
  });

  it('throws on a schema-invalid object (count out of range)', () => {
    expect(() =>
      parseQuizIntentOutput(
        '{"is_quiz_request":true,"knowledge_id":"k1","count":99,"difficulty_min":null,"unit":null,"kind":null}',
      ),
    ).toThrow();
  });
});

// ── resolveQuizIntent 四态 (DI: stub db + injected runTaskFn + stub loadTreeSnapshot) ──

const NODES: KnowledgeNode[] = [
  {
    id: 'k_poetry',
    name: '古诗词阅读',
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    mastery: 0.4,
    evidence_count: 3,
    last_evidence_at: null,
    last_active_at: new Date('2026-06-01T00:00:00Z'),
    effective_domain: 'wenyan',
  },
];

const db = {} as never;
const loadTreeSnapshotFn = async () => NODES;

function runTaskReturning(intent: QuizIntent) {
  return vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
    text: JSON.stringify(intent),
    task_run_id: 'tr_quiz_intent',
  }));
}

describe('resolveQuizIntent (四态)', () => {
  it('resolved: is_quiz_request:true + valid candidate id → status resolved, fields threaded', async () => {
    const runTaskFn = runTaskReturning({
      is_quiz_request: true,
      knowledge_id: 'k_poetry',
      count: 2,
      difficulty_min: 4,
      unit: '篇',
      kind: null,
    });

    const res = await resolveQuizIntent(
      { db, userMessage: '选两篇高难度古诗词阅读给我', runTaskFn },
      { loadTreeSnapshotFn },
    );

    expect(res).toEqual({
      status: 'resolved',
      knowledgeId: 'k_poetry',
      count: 2,
      difficultyMin: 4,
      unit: '篇',
      kind: null,
    });
    // The parse call carried the user message + the candidate list as input.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const [taskKind, input] = runTaskFn.mock.calls[0];
    expect(taskKind).toBe('QuizIntentParseTask');
    expect(input).toMatchObject({
      user_message: '选两篇高难度古诗词阅读给我',
      knowledge_candidates: [{ id: 'k_poetry', name: '古诗词阅读' }],
    });
  });

  it('not_quiz: is_quiz_request:false → status not_quiz (粗筛 误伤被解析兜回)', async () => {
    const runTaskFn = runTaskReturning({
      is_quiz_request: false,
      knowledge_id: null,
      count: null,
      difficulty_min: null,
      unit: null,
      kind: null,
    });

    const res = await resolveQuizIntent(
      { db, userMessage: '来看看这道题', runTaskFn },
      { loadTreeSnapshotFn },
    );

    expect(res).toEqual({ status: 'not_quiz' });
  });

  it('missing_knowledge: is_quiz_request:true but null knowledge_id → status missing_knowledge', async () => {
    const runTaskFn = runTaskReturning({
      is_quiz_request: true,
      knowledge_id: null,
      count: 3,
      difficulty_min: null,
      unit: null,
      kind: null,
    });

    const res = await resolveQuizIntent(
      { db, userMessage: '给我出三道题', runTaskFn },
      { loadTreeSnapshotFn },
    );

    expect(res).toEqual({ status: 'missing_knowledge' });
  });

  it('missing_knowledge: hallucinated (out-of-candidate) id is filtered → missing_knowledge', async () => {
    const runTaskFn = runTaskReturning({
      is_quiz_request: true,
      knowledge_id: 'k_ghost', // not in NODES
      count: 2,
      difficulty_min: null,
      unit: null,
      kind: null,
    });

    const res = await resolveQuizIntent(
      { db, userMessage: '给我两道题', runTaskFn },
      { loadTreeSnapshotFn },
    );

    expect(res).toEqual({ status: 'missing_knowledge' });
  });

  it('parse_failed: runTaskFn throws → status parse_failed (signal propagated, NOT free-form)', async () => {
    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM outage');
    });

    const res = await resolveQuizIntent(
      { db, userMessage: '给我两道题', runTaskFn },
      { loadTreeSnapshotFn },
    );

    expect(res).toEqual({ status: 'parse_failed' });
  });

  it('parse_failed: non-JSON model output → status parse_failed', async () => {
    const runTaskFn = vi.fn(async () => ({ text: 'sorry, no json here' }));

    const res = await resolveQuizIntent(
      { db, userMessage: '给我两道题', runTaskFn },
      { loadTreeSnapshotFn },
    );

    expect(res).toEqual({ status: 'parse_failed' });
  });
});
