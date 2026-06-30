// A5 S1 (YUK-354) — static-HTML coverage for BandChip. Pure presentational
// (renderToString, no jsdom). Pins the ⑥ red line: only band/interval/source/low-conf
// qualitative output — NEVER a bare probability or %. Cold start renders the explicit
// 未知 band (not 0). Band-mapping math itself is covered by mastery-band.unit.test.ts.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BandChip, BandChipView } from './BandChip';
import type { MasteryBandInput, MasteryBandView } from './mastery-band';

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

// A5 S3 (YUK-354) — BandChipView reuses the same chrome with axis-specific labels
// (the NodeComposite difficulty axis renders 难度档名 instead of mastery 档名).
describe('BandChipView (custom labels)', () => {
  const diffBands = ['容易', '适中', '偏难', '很难'] as const;

  it('renders the difficulty-axis label for a populated band, not the mastery label', () => {
    const view: MasteryBandView = {
      unknown: false,
      band: 2,
      loBand: 2,
      hiBand: 2,
      source: 'hard',
      lowConf: false,
    };
    const html = renderToString(<BandChipView view={view} labels={diffBands} />);
    expect(html).toContain('偏难'); // difficulty band 2
    expect(html).not.toContain('稳固'); // never the mastery label for the difficulty axis
    expect(html).toContain('硬轨校准');
  });

  it('renders the explicit unknown label + soft/low-conf for a neutral-β difficulty axis', () => {
    const view: MasteryBandView = { unknown: true, source: 'soft', lowConf: true };
    const html = renderToString(
      <BandChipView view={view} labels={diffBands} unknownLabel="未知" />,
    );
    expect(html).toContain('未知');
    expect(html).toContain('src-soft');
    expect(html).toContain('低置信');
    expect(html).not.toContain('%');
  });
});
