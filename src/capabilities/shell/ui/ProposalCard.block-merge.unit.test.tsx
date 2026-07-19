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
      change_summary: [{ label: '动作', value: '保留 1 块，并入 2 块' }],
      technical_details: JSON.stringify({
        primary_block_id: 'block-privateprimary123',
        merge_block_ids: ['block-privatefollowup123', 'block-privateextra123'],
      }),
      evidence_labels: {},
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
  it('keeps legacy cached rows readable without duplicating the kind label', () => {
    const p = proposal();
    p.presentation = undefined;
    const { container } = render(
      <div className="inbox-loom">
        <ProposalCard
          p={p}
          index={0}
          resolved={null}
          nameOf={(id) => id}
          navigate={() => {}}
          onResolve={() => {}}
          onError={() => {}}
        />
      </div>,
    );

    expect(screen.getAllByText('块合并')).toHaveLength(1);
    expect(container.querySelector('.proposal-title')).toBeNull();
  });

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

    const upfrontText = [
      '.proposal-title',
      '.proposal-body',
      '.proposal-change-summary',
      '.merge-preview',
      '.proposal-evidence',
    ]
      .map((selector) => container.querySelector(selector)?.textContent ?? '')
      .join(' ');
    expect(upfrontText).not.toContain('block-private');
    expect(upfrontText).not.toContain('session_private');
    expect(upfrontText).not.toContain('ingestion_session_id');

    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('block-privateprimary123');
  });

  it('never renders conjecture confidence or raw numeric details', () => {
    const p = proposal();
    p.kind = 'conjecture';
    p.payload = {
      kind: 'conjecture',
      reason_md: '建议用一道辨析题验证这个观察。',
      evidence_refs: [],
      proposed_change: {
        claim_md: '你可能混淆了两个定义',
        confidence: 0.73,
        predicted_p: 0.42,
      },
    };
    p.presentation = {
      title: '验证诊断推测：你可能混淆了两个定义',
      change_summary: [
        { label: '观察', value: '你可能混淆了两个定义' },
        { label: '重复信号', value: '3 次' },
      ],
      technical_details: '{"confidence":0.73,"predicted_p":0.42}',
      evidence_labels: {},
      block_merge: null,
    };

    const { container } = render(
      <div className="inbox-loom">
        <ProposalCard
          p={p}
          index={0}
          resolved={null}
          nameOf={(id) => id}
          navigate={() => {}}
          onResolve={() => {}}
          onError={() => {}}
        />
      </div>,
    );

    expect(container.textContent).not.toContain('73%');
    expect(container.textContent).not.toContain('0.73');
    expect(container.textContent).not.toContain('0.42');
    expect(container.querySelector('.proposal-technical-details')).toBeNull();
  });
});
