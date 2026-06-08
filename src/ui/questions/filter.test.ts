// YUK-288 题库 UI — client-side filter unit tests (no DB; fast partition).

import { describe, expect, it } from 'vitest';
import { type StatusTab, isDraft, matchQuery, matchStatusTab, sortItems } from './filter';
import type { QuestionListItem } from './types';

function item(over: Partial<QuestionListItem> = {}): QuestionListItem {
  return {
    id: 'q1',
    kind: 'choice',
    prompt_md: 'prompt',
    source: 'manual',
    source_tier: { tier: 4, name: 'generated' },
    difficulty: 3,
    visual_complexity: null,
    knowledge_ids: [],
    root_question_id: null,
    variant_depth: 0,
    parent_question_id: null,
    part_index: null,
    draft_status: null,
    created_at_sec: 1000,
    ...over,
  };
}

describe('matchStatusTab (gap D)', () => {
  it('all → everything', () => {
    expect(matchStatusTab(item({ draft_status: 'draft' }), 'all')).toBe(true);
    expect(matchStatusTab(item({ draft_status: null }), 'all')).toBe(true);
  });
  it('active → non-draft only', () => {
    expect(matchStatusTab(item({ draft_status: null }), 'active')).toBe(true);
    expect(matchStatusTab(item({ draft_status: 'final' }), 'active')).toBe(true);
    expect(matchStatusTab(item({ draft_status: 'draft' }), 'active')).toBe(false);
  });
  it('draft → drafts only', () => {
    expect(matchStatusTab(item({ draft_status: 'draft' }), 'draft')).toBe(true);
    expect(matchStatusTab(item({ draft_status: null }), 'draft')).toBe(false);
  });
});

describe('isDraft', () => {
  it('is true only for draft_status === draft', () => {
    expect(isDraft(item({ draft_status: 'draft' }))).toBe(true);
    expect(isDraft(item({ draft_status: 'final' }))).toBe(false);
    expect(isDraft(item({ draft_status: null }))).toBe(false);
  });
});

describe('matchQuery (gap C)', () => {
  it('empty query matches everything', () => {
    expect(matchQuery(item(), '')).toBe(true);
    expect(matchQuery(item(), '   ')).toBe(true);
  });

  it('matches the markdown-stripped prompt (ignores * ` $ markers)', () => {
    const it1 = item({ prompt_md: '下列各句中「**之**」的用法' });
    expect(matchQuery(it1, '之')).toBe(true);
    expect(matchQuery(it1, '用法')).toBe(true);
    expect(matchQuery(it1, '不存在')).toBe(false);
  });

  it('matches the question id', () => {
    expect(matchQuery(item({ id: 'q_zhi_root' }), 'zhi')).toBe(true);
  });

  it('matches a knowledge id and its resolved label', () => {
    const it1 = item({ knowledge_ids: ['k_judge'] });
    expect(matchQuery(it1, 'k_judge')).toBe(true);
    // resolved label hit even when the id itself does not contain the query.
    expect(matchQuery(it1, '判断句', (id) => (id === 'k_judge' ? '判断句' : id))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchQuery(item({ prompt_md: 'Reading Comprehension' }), 'reading')).toBe(true);
  });
});

describe('sortItems', () => {
  const a = item({ id: 'a', created_at_sec: 100, difficulty: 1 });
  const b = item({ id: 'b', created_at_sec: 300, difficulty: 5 });
  const c = item({ id: 'c', created_at_sec: 200, difficulty: 3 });

  it('time desc = newest first', () => {
    expect(sortItems([a, b, c], 'time', 'desc').map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
  it('time asc = oldest first', () => {
    expect(sortItems([a, b, c], 'time', 'asc').map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });
  it('difficulty asc = easiest first', () => {
    expect(sortItems([a, b, c], 'difficulty', 'asc').map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });
  it('does not mutate the input array', () => {
    const input = [b, a, c];
    sortItems(input, 'time', 'desc');
    expect(input.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
});

// type-only guard: keep StatusTab exhaustively covered if a tab is added.
const _tabs: StatusTab[] = ['all', 'active', 'draft'];
