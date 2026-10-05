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

  it('renders the batch variant with the knowledge confirmed in the submitted forms', () => {
    const html = renderToString(
      <RecordLanding
        count={4}
        isBatch
        knowledge={[
          { id: 'k1', label: '判断句' },
          { id: 'k3', label: '通假字' },
        ]}
        navigate={noop}
        onRecordAnother={noop}
      />,
    );
    expect(html).toContain('4 道题');
    // batch → "继续传"
    expect(html).toContain('继续传');
    expect(html).toContain('判断句');
    expect(html).toContain('通假字');
    expect(html).not.toContain('wire');
  });

  // YUK-542 — persisted learning_session.warnings surface on the landing card as
  // the ported DegradeBanner (.ing-degrade warn). The caveat used to vanish once
  // the A8 landing mounted because the SSE timeline row only lives in the
  // extracting/reviewing phases.
  describe('warnings banner', () => {
    const persisted = [
      'StructureTask unavailable (timeout); fell back to GLM structure',
      'GLM fallback: page-level standalone, no sub-question split',
    ];

    it('renders the degrade banner when persisted warnings are present', () => {
      const html = renderToString(
        <RecordLanding
          count={4}
          isBatch
          knowledge={[{ id: 'k1', label: '判断句' }]}
          warnings={persisted}
          navigate={noop}
          onRecordAnother={noop}
        />,
      );
      expect(html).toContain('ing-degrade warn');
      expect(html).toContain('备用识别方式');
      expect(html).toContain('重点复核');
      // Same convention as the SSE timeline arm (VisionTab.test.tsx): the raw
      // internal English strings stay hidden behind the generic caveat.
      expect(html).not.toContain('fell back to GLM');
      expect(html).not.toContain('no sub-question split');
      // Landing card still intact around the banner.
      expect(html).toContain('收好了');
      expect(html).toContain('继续传');
    });

    it('omits the banner when warnings is empty or the prop is absent', () => {
      const emptyHtml = renderToString(
        <RecordLanding
          count={4}
          isBatch
          knowledge={[]}
          warnings={[]}
          navigate={noop}
          onRecordAnother={noop}
        />,
      );
      expect(emptyHtml).not.toContain('ing-degrade');

      // Manual landing (RecordPage) never passes warnings — no phantom banner.
      const absentHtml = renderToString(
        <RecordLanding
          count={1}
          isBatch={false}
          knowledge={[{ id: 'k1', label: '判断句' }]}
          navigate={noop}
          onRecordAnother={noop}
        />,
      );
      expect(absentHtml).not.toContain('ing-degrade');
    });
  });
});
