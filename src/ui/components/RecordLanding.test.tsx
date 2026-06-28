import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RecordLanding, knowledgeLabelsFor } from './RecordLanding';

// A8 (YUK-354): unit coverage for the success landing view + its pure id→label
// mapper. Static render (node env, no jsdom) mirrors ExtractionProgressBar.test.

describe('knowledgeLabelsFor', () => {
  const nodes = [
    { id: 'k1', name: '判断句' },
    { id: 'k2', name: '结构助词「之」' },
    { id: 'k3', name: '通假字' },
  ];

  it('maps selected ids to labels, preserving selection order', () => {
    expect(knowledgeLabelsFor(nodes, ['k2', 'k1'])).toEqual([
      { id: 'k2', label: '结构助词「之」' },
      { id: 'k1', label: '判断句' },
    ]);
  });

  it('falls back to the raw id when a label is missing (honest, not fabricated)', () => {
    expect(knowledgeLabelsFor(nodes, ['k9'])).toEqual([{ id: 'k9', label: 'k9' }]);
  });

  it('returns an empty list when nothing was selected', () => {
    expect(knowledgeLabelsFor(nodes, [])).toEqual([]);
  });
});

describe('RecordLanding', () => {
  const noop = () => {};

  it('renders the manual (single) success hero with the real knowledge node', () => {
    const html = renderToString(
      <RecordLanding
        count={1}
        isBatch={false}
        knowledge={[{ id: 'k1', label: '判断句' }]}
        navigate={noop}
        onRecordAnother={noop}
      />,
    );
    expect(html).toContain('收好了');
    expect(html).toContain('挂到了哪些知识点');
    expect(html).toContain('判断句');
    // single → "再录一份", not the batch "继续传"
    expect(html).toContain('再录一份');
    expect(html).not.toContain('继续传');
    // proposal CTA present (orchestrator proactively offers practice)
    expect(html).toContain('去出题');
  });

  it('renders the batch variant with an honest knowledge placeholder, not a fabricated list', () => {
    const html = renderToString(
      <RecordLanding
        count={4}
        isBatch
        knowledge={[]}
        knowledgeUnavailable
        navigate={noop}
        onRecordAnother={noop}
      />,
    );
    expect(html).toContain('4 道题');
    // batch → "继续传"
    expect(html).toContain('继续传');
    // honest placeholder for the missing knowledge_ids wire
    expect(html).toContain('导入响应未带知识点 id');
  });
});
