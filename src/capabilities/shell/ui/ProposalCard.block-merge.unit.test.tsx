// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProposalCard } from './ProposalCard';
import type { ProposalInboxRow } from './inbox-api';

afterEach(cleanup);

function proposal(): ProposalInboxRow {
  return {
    id: 'proposal_private',
    kind: 'block_merge',
    target: { subject_kind: 'question_block', subject_id: 'block_private_a' },
    payload: {
      kind: 'block_merge',
      reason_md:
        '检测到 block-privateprimary123 与 block-privatefollowup123 在换页处被切断，建议合并。',
      evidence_refs: [],
      proposed_change: {
        primary_block_id: 'block-privateprimary123',
        merge_block_ids: ['block-privatefollowup123', 'block-privateextra123'],
        ingestion_session_id: 'session_private',
        continuity_signal: 'numbering',
        confidence: 0.82,
      },
    },
    presentation: {
      title: '合并 3 个被切断的题块',
      block_merge: {
        primary: {
          id: 'block-privateprimary123',
          label: '第 1 块 · 题号 12 · 第 1 页',
          excerpt: '已知函数 f(x) 在区间上连续，',
        },
        merged: [
          {
            id: 'block-privatefollowup123',
            label: '第 2 块 · 题号 12 · 第 1 页',
            excerpt: '并满足 f(0)=1，求函数的最小值。',
          },
          {
            id: 'block-privateextra123',
            label: '第 3 块 · 题号 12 · 第 2 页',
            excerpt: '请写出完整推导过程。',
          },
        ],
        continuity_label: '题号连续',
      },
    },
    status: 'pending',
    proposed_at: '2026-07-19T08:00:00.000Z',
    decided_at: null,
    actor_ref: 'block_assembly',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'question_block',
    signals: null,
  };
}

describe('ProposalCard block-merge presentation', () => {
  it('shows curated excerpts and continuity without leaking raw ids', () => {
    const { container } = render(
      <div className="inbox-loom">
        <ProposalCard
          p={proposal()}
          index={0}
          resolved={null}
          nameOf={(id) => id}
          navigate={() => {}}
          onResolve={() => {}}
          onError={() => {}}
        />
      </div>,
    );

    expect(screen.getByText('合并 3 个被切断的题块')).toBeTruthy();
    expect(screen.getByText('已知函数 f(x) 在区间上连续，')).toBeTruthy();
    expect(screen.getByText('并满足 f(0)=1，求函数的最小值。')).toBeTruthy();
    expect(screen.getByText('请写出完整推导过程。')).toBeTruthy();
    expect(screen.getByText('连续依据：题号连续')).toBeTruthy();
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getAllByText(/第 [12] 块 · 题号 12 · 第 1 页/)).toHaveLength(4);

    const visibleText = container.textContent ?? '';
    expect(visibleText).not.toContain('block-private');
    expect(visibleText).not.toContain('session_private');
    expect(visibleText).not.toContain('ingestion_session_id');
  });
});
