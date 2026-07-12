// YUK-567 slice-1 — PrepDeskConjectures SSR render coverage. Locks the anti-guilt
// invariants (handoff §2/§3/§4) that make the 备课台 a "为你而备" felt surface and
// not a guilt/backlog dashboard: NO calibration number, NO backlog count, probe is
// "about to ask" (not a flashcard), accept = acknowledge (not "加进复习").

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PrepDeskConjectures } from './PrepDeskConjectures';
import type { PrepDeskConjectureWire } from './prep-desk-api';

function conjecture(overrides: Partial<PrepDeskConjectureWire> = {}): PrepDeskConjectureWire {
  return {
    id: 'evt_c1',
    claim: '你把链式法则当成两个导数相乘',
    knowledge_id: 'kn_chain_rule',
    cause_category: 'concept_misunderstanding',
    probe_md: 'd/dx sin(x^2) = ?',
    recurrence_count: 3,
    discriminating: true,
    corrected_by_owner: false,
    evidence: [
      { kind: 'question', id: 'q_a' },
      { kind: 'event', id: 'evt_b' },
    ],
    proposed_at: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function render(conjectures: PrepDeskConjectureWire[]): string {
  const qc = new QueryClient();
  qc.setQueryData(['prep-desk-conjectures'], { conjectures });
  return renderToString(
    <QueryClientProvider client={qc}>
      <PrepDeskConjectures />
    </QueryClientProvider>,
  );
}

describe('PrepDeskConjectures', () => {
  it('renders the claim + the "about to ask" probe when conjectures present', () => {
    const html = render([conjecture()]);
    expect(html).toContain('你把链式法则当成两个导数相乘'); // claim
    expect(html).toContain('团队正要问你的一道题'); // probe framing (§4)
    expect(html).toContain('d/dx sin(x^2) = ?'); // probe_md text
    expect(html).toContain('教研团的猜想 · 为你而备'); // team framing, not generic proposal
  });

  it('shows recurrence as a failure-cell count — the ONLY number on the card', () => {
    const html = render([conjecture({ recurrence_count: 4 })]);
    expect(html).toContain('反复出现 4 次');
  });

  it('NEVER renders a calibration number (anti-guilt KILL criterion, §2a)', () => {
    const html = render([conjecture()]);
    // No confidence / predicted-probability framing in any form.
    expect(html).not.toContain('把握'); // "73% 把握"
    expect(html).not.toContain('预测'); // "我们预测你会错"
    expect(html).not.toContain('predicted');
    expect(html).not.toContain('confidence');
    expect(html).not.toContain('置信'); // no confidence %
  });

  it('frames the probe as a question to be asked, NOT a flippable flashcard (§4 tripwire)', () => {
    const html = render([conjecture()]);
    expect(html).not.toContain('正面'); // flashcard front
    expect(html).not.toContain('背面'); // flashcard back
    expect(html).not.toContain('翻转'); // flip
    expect(html).not.toContain('答案'); // no answer side surfaced
  });

  it('accept reads as acknowledgement, never "加进复习" (§3 ND-5)', () => {
    const html = render([conjecture()]);
    expect(html).toContain('对，往这个方向想'); // acknowledge direction
    expect(html).toContain('不太像'); // soft reject
    expect(html).not.toContain('复习'); // never presents accept as adding to reviews
    expect(html).not.toContain('加进');
  });

  it('renders 0..3 with no backlog / unread count (§2b)', () => {
    const html = render([
      conjecture({ id: 'a' }),
      conjecture({ id: 'b' }),
      conjecture({ id: 'c' }),
    ]);
    // Three cards, but no "3 条等待" / "待裁决" backlog nag anywhere.
    expect(html).not.toContain('等待');
    expect(html).not.toContain('待裁决');
    expect(html).not.toContain('条待');
  });

  it('shows a calm empty state, not an achievement nag, when zero conjectures', () => {
    const html = render([]);
    expect(html).toContain('教研团暂无新猜想');
    expect(html).not.toContain('全部完成');
    expect(html).not.toContain('全部搞定');
    expect(html).not.toContain('caught up');
  });

  it('surfaces the evidence back-link (readable, no raw ids)', () => {
    const html = render([conjecture()]);
    expect(html).toContain('源自一道题'); // question evidence readable
    expect(html).toContain('源自一次 AI 判定事件'); // event evidence readable
    expect(html).not.toContain('q_a'); // raw evidence id never surfaced
  });
});
