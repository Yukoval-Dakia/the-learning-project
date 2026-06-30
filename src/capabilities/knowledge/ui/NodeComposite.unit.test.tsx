// A5 S3 (YUK-354) — static-HTML coverage for NodeComposite + TransferList +
// DiagnosticDrill. Pure presentational (renderToString, node env, no jsdom — same
// stack as BandChip/FrontierRail). Pins: the composite band + caption, the collapsed
// three-dim toggle, the cold-start note, the ⑥ red line (no bare probability / %), and
// the honest empty states for transfer + CDM/IRT (no fabricated numbers). The dim
// banding math itself is covered by node-dims.unit.test.ts.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiagnosticDrill, NodeComposite, TransferList } from './NodeComposite';
import type { MasteryBandInput } from './mastery-band';
import type { NodeThreeDimInput } from './node-dims';

function masteryInput(overrides: Partial<MasteryBandInput> = {}): MasteryBandInput {
  return {
    mastery: 0.7,
    mastery_lo: 0.5,
    mastery_hi: 0.85,
    low_confidence: false,
    evidence_count: 9,
    ...overrides,
  };
}

function input(overrides: Partial<NodeThreeDimInput> = {}): NodeThreeDimInput {
  return { mastery: masteryInput(), beta: 1, retrievability: 0.5, evidenceCount: 9, ...overrides };
}

describe('NodeComposite', () => {
  it('renders the composite band, the three-dim caption, and the collapsed toggle', () => {
    const html = renderToString(<NodeComposite input={input()} />);
    expect(html).toContain('kd-composite');
    expect(html).toContain('稳固'); // composite p(L) band for mastery 0.7
    expect(html).toContain('三维折叠为单标量');
    expect(html).toContain('展开三维'); // collapsed toggle label
    expect(html).not.toContain('收起三维');
  });

  it('shows the cold-start note when evidence is thin', () => {
    const html = renderToString(
      <NodeComposite
        input={{ mastery: null, beta: null, retrievability: null, evidenceCount: 0 }}
      />,
    );
    expect(html).toContain('kd-cold-note');
    expect(html).toContain('真实作答还少');
    expect(html).toContain('未知'); // cold composite → explicit unknown band, never 0
  });

  it('omits the cold note for a well-evidenced node', () => {
    const html = renderToString(<NodeComposite input={input({ evidenceCount: 9 })} />);
    expect(html).not.toContain('kd-cold-note');
  });

  it('never leaks a bare probability / % (⑥ red line)', () => {
    const html = renderToString(<NodeComposite input={input()} />);
    expect(html).not.toContain('%');
    expect(html).not.toContain('0.7');
    expect(html).not.toContain('0.5');
  });
});

describe('TransferList (honest empty state)', () => {
  it('renders the no-transfer empty state (borrowed-θ dark-ship) without fabricating sources', () => {
    const html = renderToString(<TransferList />);
    expect(html).toContain('quiet-empty');
    expect(html).toContain('暂无可识别的迁移来源');
  });
});

describe('DiagnosticDrill (honest empty state)', () => {
  it('renders the collapsed CDM/IRT bar with the evidence-insufficient subtitle', () => {
    const html = renderToString(<DiagnosticDrill />);
    expect(html).toContain('kd-diag');
    expect(html).toContain('CDM 属性画像 / IRT 区分度');
    expect(html).toContain('证据不足，慢热期暂不出诊断');
    // collapsed → the fake-precision body is not rendered yet, and no numbers leak.
    expect(html).not.toContain('%');
  });
});
