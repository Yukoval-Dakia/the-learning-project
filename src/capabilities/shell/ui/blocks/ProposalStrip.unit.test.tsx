import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ProposalStrip } from './ProposalStrip';

describe('ProposalStrip decision truth', () => {
  it('shows only proposals that actually require a learner decision', () => {
    const html = renderToStaticMarkup(
      <ProposalStrip
        proposals={{
          total: 2,
          decision_total: 1,
          by_kind: { knowledge_edge: 1, defer: 1 },
          status: 'pending',
        }}
        navigate={vi.fn()}
      />,
    );

    expect(html).toContain('prop-summary-n serif tnum">1</div>');
    expect(html).toContain('知识关系');
    expect(html).not.toContain('延后安排');
  });

  it('does not create a decision backlog when every pending proposal is observe-only', () => {
    const html = renderToStaticMarkup(
      <ProposalStrip
        proposals={{
          total: 2,
          decision_total: 0,
          by_kind: { defer: 1, archive: 1 },
          status: 'pending',
        }}
        navigate={vi.fn()}
      />,
    );

    expect(html).toContain('没有待审提议');
    expect(html).not.toContain('延后安排');
    expect(html).not.toContain('归档建议');
    expect(html).toContain('去收件箱');
    expect(html).not.toContain('去裁决');
  });
});
