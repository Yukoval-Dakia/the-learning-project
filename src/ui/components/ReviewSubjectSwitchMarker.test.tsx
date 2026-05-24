import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ReviewSubjectSwitchMarker,
  shouldShowSubjectSwitchMarker,
} from './ReviewSubjectSwitchMarker';

describe('ReviewSubjectSwitchMarker', () => {
  it('shows only when the subject id changes', () => {
    expect(
      shouldShowSubjectSwitchMarker(
        { id: 'wenyan', displayName: '文言文' },
        { id: 'math', displayName: '数学' },
      ),
    ).toBe(true);
    expect(
      shouldShowSubjectSwitchMarker(
        { id: 'math', displayName: '数学' },
        { id: 'math', displayName: '数学' },
      ),
    ).toBe(false);
    expect(shouldShowSubjectSwitchMarker(null, { id: 'math', displayName: '数学' })).toBe(false);
  });

  it('renders concise next-subject copy', () => {
    const html = renderToString(
      <ReviewSubjectSwitchMarker
        from={{ id: 'wenyan', displayName: '文言文' }}
        to={{ id: 'math', displayName: '数学' }}
      />,
    );

    expect(html).toContain('review-subject-switch');
    expect(html).toContain('下一题：数学');
    expect(html).toContain('从 文言文 切换到 数学');
    expect(html).toContain('data-subject="math"');
  });
});
