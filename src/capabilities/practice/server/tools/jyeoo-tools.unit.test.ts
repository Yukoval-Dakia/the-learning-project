// YUK-986 (Supply-Agent/1) — 两个新 DomainTool 的契约单测（无 db）。
// 锁死：名字/effect/costClass/mirrorEvent/无 safeHandoff（db 写工具）+ 输入 schema 的关键拒绝。

import { describe, expect, it } from 'vitest';
import { jyeooFetchCandidatesTool } from './jyeoo-fetch-candidates';
import { storeSourcedQuestionTool } from './store-sourced-question';

describe('jyeooFetchCandidatesTool contract', () => {
  it('is a local-cost read tool with remote-safe idempotent handoff', () => {
    expect(jyeooFetchCandidatesTool.name).toBe('jyeoo_fetch_candidates');
    expect(jyeooFetchCandidatesTool.effect).toBe('read');
    expect(jyeooFetchCandidatesTool.costClass).toBe('local');
    expect(jyeooFetchCandidatesTool.mirrorEvent).toBe('when_causal');
    // db 写（staged 资产 + canary）→ 不得声明 safeHandoff（registry 只允许 idempotent read）。
    expect(jyeooFetchCandidatesTool.safeHandoff).toBeUndefined();
    expect(jyeooFetchCandidatesTool.description).toContain('jyeoo');
  });

  it('rejects out-of-range input at the schema boundary', () => {
    const base = { grade: 11, subject: 'math2', pages: 2, max_papers: 2, session_max: 10 };
    expect(jyeooFetchCandidatesTool.inputSchema.safeParse(base).success).toBe(true);
    expect(jyeooFetchCandidatesTool.inputSchema.safeParse({ ...base, grade: 13 }).success).toBe(
      false,
    );
    expect(jyeooFetchCandidatesTool.inputSchema.safeParse({ ...base, grade: 10 }).success).toBe(
      true,
    );
    expect(jyeooFetchCandidatesTool.inputSchema.safeParse({ ...base, pages: 0 }).success).toBe(
      false,
    );
    expect(
      jyeooFetchCandidatesTool.inputSchema.safeParse({ ...base, session_max: 0 }).success,
    ).toBe(false);
    expect(
      jyeooFetchCandidatesTool.inputSchema.safeParse({ ...base, session_max: 41 }).success,
    ).toBe(false);
  });
});

describe('storeSourcedQuestionTool contract', () => {
  it('is a local-cost write tool (the only question-writing seam)', () => {
    expect(storeSourcedQuestionTool.name).toBe('store_sourced_question');
    expect(storeSourcedQuestionTool.effect).toBe('write');
    expect(storeSourcedQuestionTool.costClass).toBe('local');
    expect(storeSourcedQuestionTool.mirrorEvent).toBe('when_causal');
    // 题面写库 → 不得声明 safeHandoff。
    expect(storeSourcedQuestionTool.safeHandoff).toBeUndefined();
  });

  it('rejects malformed extraction_hash, empty knowledge_ids, and bad attribution_state', () => {
    const candidate = {
      candidate_id: 'cand-1',
      question: {
        kind: 'short_answer',
        prompt_md: '题干',
        reference_md: '答案',
        difficulty: 3,
        source_url: 'https://www.jyeoo.com/math2/ques/detail/x',
        source_title: '来源卷',
        extract: 'https://www.jyeoo.com/math2/ques/detail/x',
        knowledge_ids: [],
      },
      extraction_hash: `sha256:${'a'.repeat(64)}`,
      knowledge_hints: [],
      figures: null,
      image_refs: null,
      structured: null,
      staged_asset_ids: [],
    };
    const base = {
      candidate,
      knowledge_ids: ['kc-1'],
      attribution_state: 'matched' as const,
      subject_id: 'math',
    };
    expect(storeSourcedQuestionTool.inputSchema.safeParse(base).success).toBe(true);
    expect(
      storeSourcedQuestionTool.inputSchema.safeParse({
        ...base,
        candidate: { ...candidate, extraction_hash: 'not-a-hash' },
      }).success,
    ).toBe(false);
    expect(
      storeSourcedQuestionTool.inputSchema.safeParse({ ...base, knowledge_ids: [] }).success,
    ).toBe(false);
    expect(
      storeSourcedQuestionTool.inputSchema.safeParse({ ...base, attribution_state: 'fuzzy' })
        .success,
    ).toBe(false);
  });
});
