import { describe, expect, it } from 'vitest';

import { extractVisibleHtmlText, htmlContainsAssessment } from './learning-content';

describe('learning-content HTML normalization', () => {
  it('decodes character references and joins text split by inline tags', () => {
    const html =
      '<section><h2>&#39064;<span>&#30446;</span></h2><p>&copy;&nbsp;17×19？</p><p>答<span>案</span>&colon;323</p></section>';

    expect(extractVisibleHtmlText(html)).toBe('题目\n© 17×19？\n答案:323');
  });

  it.each([
    '<h2>&#39064;&#30446;</h2><p>&#31572;&#26696;&#65306;323</p>',
    '<h2>题<span>目</span></h2><p>答<span>案</span>：323</p>',
  ])('detects assessment labels in rendered text from %s', (html) => {
    expect(htmlContainsAssessment(html)).toBe(true);
  });

  it('does not classify configuration assignments or price tables as assessments', () => {
    const html =
      '<section><p>version = 4</p><table><tr><td>基础版</td><td>20</td></tr><tr><td>专业版</td><td>50</td></tr></table></section>';

    expect(htmlContainsAssessment(html)).toBe(false);
  });
});
