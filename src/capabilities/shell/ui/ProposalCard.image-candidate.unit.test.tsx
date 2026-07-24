// @vitest-environment jsdom
//
// YUK-229 — image_candidate 专属接受卡：付费前置提示、原图 <img> 降级路径、accept
// 接线走既有 decideProposal，非 image_candidate kind 不受影响。DeferredMarkdownRenderer
// 首帧渲纯文本 fallback（异步 import react-markdown 前），故 summary_md 文本同步可断言。

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProposalCard } from './ProposalCard';
import type { ProposalInboxRow } from './inbox-api';

const { decideProposalMock } = vi.hoisted(() => ({ decideProposalMock: vi.fn() }));
vi.mock('./inbox-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inbox-api')>();
  return { ...actual, decideProposal: decideProposalMock };
});

afterEach(() => {
  cleanup();
  decideProposalMock.mockReset();
});

function imageCandidateProposal(overrides?: {
  sourceUrl?: string;
  sourceTitle?: string;
  summaryMd?: string;
}): ProposalInboxRow {
  return {
    id: 'proposal_ic_1',
    kind: 'image_candidate',
    target: { subject_kind: 'source_asset', subject_id: null },
    payload: {
      kind: 'image_candidate',
      reason_md: '该来源页判为图题（含几何图形），建议接受以抽图铸题。',
      evidence_refs: [],
      proposed_change: {
        source_url: overrides?.sourceUrl ?? 'https://example.com/geometry-01.png',
        source_title: overrides?.sourceTitle ?? '2024 高考几何压轴图',
        summary_md: overrides?.summaryMd ?? '如图，**正方形** ABCD 内接一圆，求阴影面积。',
        knowledge_ids: ['k_geom_1'],
      },
    },
    presentation: null,
    status: 'pending',
    proposed_at: '2026-07-25T08:00:00.000Z',
    decided_at: null,
    actor_ref: 'sourcing',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'source_asset',
    signals: null,
  };
}

function renderCard(p: ProposalInboxRow) {
  return render(
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
}

describe('ProposalCard image_candidate', () => {
  it('renders the qualitative paid VLM affordance next to accept (no dollar estimate)', () => {
    const { container } = renderCard(imageCandidateProposal());
    expect(screen.getByText('接受将执行一次付费 VLM 抽图')).toBeTruthy();
    // 定性文案，不显预估金额：卡片正文不含美元预估。
    expect(container.querySelector('.image-candidate-cost-note')).toBeTruthy();
    expect(container.textContent ?? '').not.toMatch(/\$\d/);
  });

  it('does not auto-load the external image: shows summary + a click-to-reveal affordance', () => {
    const { container } = renderCard(imageCandidateProposal());
    // 默认不发被动 GET：无 <img>，只给显式「显示原图预览」按钮。
    expect(container.querySelector('img.ic-img')).toBeNull();
    expect(screen.getByRole('button', { name: /显示原图预览/ })).toBeTruthy();
    // summary_md 首帧走 DeferredMarkdownRenderer 的纯文本 fallback，文本同步可见。
    expect(screen.getByText(/正方形/)).toBeTruthy();
  });

  it('loads the image only after the user clicks reveal, with safe img attributes', async () => {
    const { container } = renderCard(imageCandidateProposal());
    expect(container.querySelector('img.ic-img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /显示原图预览/ }));
    const img = container.querySelector('img.ic-img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://example.com/geometry-01.png');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img?.getAttribute('alt')).toBe('2024 高考几何压轴图');
  });

  it('degrades to a URL + title text card when the revealed image fails to load', async () => {
    const { container } = renderCard(imageCandidateProposal());
    await userEvent.click(screen.getByRole('button', { name: /显示原图预览/ }));
    const img = container.querySelector('img.ic-img');
    expect(img).toBeTruthy();
    fireEvent.error(img as Element);
    expect(container.querySelector('img.ic-img')).toBeNull();
    expect(screen.getByText('2024 高考几何压轴图')).toBeTruthy();
    expect(screen.getByText('https://example.com/geometry-01.png')).toBeTruthy();
  });

  it('never emits an <img> or reveal button for a non-http(s) source_url', () => {
    const { container } = renderCard(
      imageCandidateProposal({ sourceUrl: 'data:image/png;base64,AAAA' }),
    );
    expect(container.querySelector('img.ic-img')).toBeNull();
    expect(screen.queryByRole('button', { name: /显示原图预览/ })).toBeNull();
    expect(container.querySelector('.ic-fallback')).toBeTruthy();
    expect(screen.getByText('data:image/png;base64,AAAA')).toBeTruthy();
  });

  it('refuses private / loopback hosts: no img, no reveal, non-public fallback note', () => {
    for (const url of [
      'http://localhost/x.png',
      'http://127.0.0.1/x.png',
      'http://192.168.1.10/scan.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x.png',
    ]) {
      const { container, unmount } = renderCard(imageCandidateProposal({ sourceUrl: url }));
      expect(container.querySelector('img.ic-img')).toBeNull();
      expect(screen.queryByRole('button', { name: /显示原图预览/ })).toBeNull();
      expect(screen.getByText(/非公开图片直链/)).toBeTruthy();
      unmount();
    }
  });

  it('wires accept through the canonical decideProposal(accept) call unchanged', async () => {
    decideProposalMock.mockResolvedValue({});
    const onResolve = vi.fn();
    render(
      <div className="inbox-loom">
        <ProposalCard
          p={imageCandidateProposal()}
          index={0}
          resolved={null}
          nameOf={(id) => id}
          navigate={() => {}}
          onResolve={onResolve}
          onError={() => {}}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: '接受' }));
    expect(decideProposalMock).toHaveBeenCalledWith('proposal_ic_1', 'accept', {});
  });

  it('neutralizes Markdown image syntax in summary_md (no <img>, renders a placeholder)', async () => {
    const { container } = renderCard(
      imageCandidateProposal({
        summaryMd: '题目：![内网探测](http://192.168.1.5/probe.png) 求阴影面积。',
      }),
    );
    // 等 react-markdown chunk 异步加载 + 重渲（首帧是纯文本 fallback）。
    const placeholder = await screen.findByTestId('ic-md-img-block');
    expect(placeholder.textContent).toContain('内网探测');
    // 关键：整张卡（未点预览）不产出任何真实 <img>——summary 里的 markdown 图片后门被堵。
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not render the image-candidate block or cost note for other kinds', () => {
    const other: ProposalInboxRow = {
      ...imageCandidateProposal(),
      id: 'proposal_edge_1',
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge', subject_id: 'k1' },
      payload: {
        kind: 'knowledge_edge',
        reason_md: '建议建立前置关系。',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
        },
      },
    };
    const { container } = renderCard(other);
    expect(container.querySelector('.proposal-image-candidate')).toBeNull();
    expect(container.querySelector('.image-candidate-cost-note')).toBeNull();
    expect(screen.queryByText('接受将执行一次付费 VLM 抽图')).toBeNull();
  });
});
