import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RatingAdvisor } from './RatingAdvisor';

describe('RatingAdvisor', () => {
  it('renders the idle state without claiming a final rating', () => {
    const html = renderToString(
      <RatingAdvisor advice={null} error={null} loading={false} onRequest={() => {}} />,
    );

    expect(html).toContain('AI 评分建议');
    expect(html).toContain('生成建议');
    expect(html).toContain('最终评分');
  });

  it('renders suggested rating, score, and reason', () => {
    const html = renderToString(
      <RatingAdvisor
        advice={{
          rating: 'hard',
          evidence_score: 0.6,
          reason: 'steps@1 给出 partial credit 0.60，默认推荐 hard',
        }}
        error={null}
        loading={false}
        onRequest={() => {}}
      />,
    );

    expect(html).toContain('rating-advisor--hard');
    expect(html).toContain('模糊');
    expect(html).toContain('60%');
    expect(html).toContain('partial credit');
    expect(html).toContain('重新建议');
  });

  it('renders unavailable advice and error copy explicitly', () => {
    const html = renderToString(
      <RatingAdvisor
        advice={{
          rating: null,
          evidence_score: null,
          reason: 'semantic@1 给出 unsupported，advisory 不可用',
        }}
        error="暂时无法生成建议"
        loading={false}
        onRequest={() => {}}
      />,
    );

    expect(html).toContain('无建议');
    expect(html).toContain('unsupported');
    expect(html).toContain('暂时无法生成建议');
  });
});
