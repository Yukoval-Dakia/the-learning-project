import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EmbeddedCheckSection,
  getEmbeddedCheckFeedbackLabel,
  shouldHideEmbeddedCheckScore,
} from './EmbeddedCheckSection';

describe('EmbeddedCheckSection', () => {
  it('renders ready inline questions with subject-aware markdown', () => {
    const html = renderToString(
      <EmbeddedCheckSection
        status="ready"
        notation="latex"
        questions={[
          {
            id: 'q1',
            kind: 'single_choice',
            prompt_md: 'Solve $x^2=4$.',
            choices_md: ['x=1', 'x=2'],
          },
          {
            id: 'q2',
            kind: 'fill_blank',
            prompt_md: 'Write the positive root.',
            choices_md: null,
          },
        ]}
      />,
    );

    expect(html).toContain('自检题 · 2 题');
    expect(html).toContain('Solve');
    expect(html).toContain('class="katex"');
    expect(html).toContain('x=1');
    expect(html).toContain('embedded-check-question__answer');
  });

  it('uses explicit unsupported feedback copy instead of partial-correct copy', () => {
    const unsupportedByOutcome = {
      outcome: 'partial' as const,
      judge: { route: 'semantic', score: null, coarse_outcome: 'unsupported' },
    };
    const unsupportedByRoute = {
      outcome: 'partial' as const,
      judge: { route: 'unsupported', score: null },
    };

    expect(getEmbeddedCheckFeedbackLabel(unsupportedByOutcome)).toBe('暂不支持自动判分');
    expect(getEmbeddedCheckFeedbackLabel(unsupportedByRoute)).toBe('暂不支持自动判分');
    expect(shouldHideEmbeddedCheckScore(unsupportedByOutcome)).toBe(true);
  });
});
