// A5 S1 (YUK-354) — static-HTML coverage for BandChip. Pure presentational
// (renderToString, no jsdom). Pins the ⑥ red line: only band/interval/source/low-conf
// qualitative output — NEVER a bare probability or %. Cold start renders the explicit
// 未知 band (not 0). Band-mapping math itself is covered by mastery-band.unit.test.ts.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BandChip } from './BandChip';
import type { MasteryBandInput } from './mastery-band';

function input(overrides: Partial<MasteryBandInput> = {}): MasteryBandInput {
  return {
    mastery: 0.7,
    mastery_lo: 0.5,
    mastery_hi: 0.85,
    low_confidence: false,
    evidence_count: 5,
    ...overrides,
  };
}

describe('BandChip', () => {
  it('renders the discrete band label, the hard source class, and a qualitative title', () => {
    const html = renderToString(<BandChip input={input()} />);
    expect(html).toContain('band-chip');
    expect(html).toContain('src-hard');
    expect(html).toContain('稳固'); // point band for 0.7
    // title carries the real interval (成长–精熟 for lo=0.5/hi=0.85) + 硬轨校准.
    expect(html).toContain('区间 成长–精熟');
    expect(html).toContain('硬轨校准');
  });

  it('marks soft source (prior) when there is no calibration evidence', () => {
    const html = renderToString(<BandChip input={input({ evidence_count: 0 })} />);
    expect(html).toContain('src-soft');
    expect(html).toContain('软轨先验');
  });

  it('shows the low-confidence marker + is-low class when low_confidence', () => {
    const html = renderToString(<BandChip input={input({ low_confidence: true })} />);
    expect(html).toContain('is-low');
    expect(html).toContain('低置信');
  });

  it('renders the explicit unknown band on cold start (never 0 / never %)', () => {
    const html = renderToString(
      <BandChip
        input={input({ mastery: null, mastery_lo: null, mastery_hi: null, evidence_count: 0 })}
      />,
    );
    expect(html).toContain('未知');
    expect(html).toContain('src-soft');
    expect(html).toContain('低置信');
    // ⑥ red line — no bare probability / %.
    expect(html).not.toContain('%');
    expect(html).not.toContain('0.');
  });

  it('never renders a bare probability or % for a populated band', () => {
    const html = renderToString(<BandChip input={input({ mastery: 0.7 })} />);
    expect(html).not.toContain('%');
    expect(html).not.toContain('0.7');
    expect(html).not.toContain('70');
  });
});
