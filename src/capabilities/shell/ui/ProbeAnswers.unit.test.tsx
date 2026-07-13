// YUK-567 slice-2 — ProbeAnswers SSR render coverage. Locks the felt framing +
// anti-guilt invariants of the 待你试做 probe 作答区: the probe is "the question the
// team is about to ask" (not a graded flashcard), no calibration numbers, and both a
// text answer AND an image-upload affordance are offered.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProbeAnswers } from './ProbeAnswers';
import type { PrepDeskProbeWire } from './probe-answer-api';

function probe(overrides: Partial<PrepDeskProbeWire> = {}): PrepDeskProbeWire {
  return {
    probe_question_id: 'q_probe1',
    prompt_md: '求 d/dx sin(x^2)。',
    knowledge_id: 'kn_chain_rule',
    ...overrides,
  };
}

function render(probes: PrepDeskProbeWire[]): string {
  const qc = new QueryClient();
  qc.setQueryData(['prep-desk-probes'], { probes });
  return renderToString(
    <QueryClientProvider client={qc}>
      <ProbeAnswers />
    </QueryClientProvider>,
  );
}

describe('ProbeAnswers', () => {
  it('renders the probe as "the question the team is about to ask" + an answer area', () => {
    const html = render([probe()]);
    expect(html).toContain('团队问你的一道题'); // framing, not a graded flashcard
    expect(html).toContain('求 d/dx sin(x^2)。'); // prompt_md
    expect(html).toContain('提交作答'); // submit affordance
  });

  it('offers an image-upload affordance (owner requirement: photo/handwriting answers)', () => {
    const html = render([probe()]);
    expect(html).toContain('传图'); // upload label
    expect(html).toContain('type="file"'); // a real file input
    expect(html).toContain('image/*'); // accepts images
  });

  it('never renders a calibration number on the probe (anti-guilt, same as slice-1)', () => {
    const html = render([probe()]);
    expect(html).not.toContain('把握');
    expect(html).not.toContain('预测');
    expect(html).not.toContain('predicted');
    expect(html).not.toContain('confidence');
    expect(html).not.toContain('置信');
  });

  it('renders nothing when there are no active probes (calm, no nag)', () => {
    const html = render([]);
    expect(html).not.toContain('团队问你的一道题');
    expect(html).not.toContain('提交作答');
  });
});
