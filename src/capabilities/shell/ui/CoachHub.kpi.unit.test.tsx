// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CoachKpi, CoachReport } from './CoachHub';

afterEach(cleanup);

describe('CoachKpi learner facts', () => {
  it('renders the authoritative integer on the first frame', () => {
    render(<CoachKpi label="复习次数" value={12} />);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('复习次数')).toBeTruthy();
  });

  it('renders currency precision without an animated intermediate value', () => {
    render(<CoachKpi label="AI 成本" value={8.933} prefix="$" decimals={3} />);
    expect(screen.getByText('$8.933')).toBeTruthy();
  });
});

describe('CoachReport native verdicts', () => {
  it('keeps independent ratings out of correctness and shows partial and ungraded answers', () => {
    render(
      <CoachReport
        navigate={() => {}}
        data={{
          window: { days: 7, from: 0, to: 1, time_zone: 'Asia/Shanghai' },
          totals: { reviews: 5, failures: 1, cost_usd: 0 },
          ratings: { again: 0, hard: 0, good: 5, easy: 0 },
          daily: [
            { date: '2026-10-05', count: 5, correct: 1, incorrect: 1, partial: 2, ungraded: 1 },
          ],
          top_causes: [],
          top_knowledge: [],
        }}
      />,
    );
    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.getByTitle('错 1')).toBeTruthy();
    expect(screen.getByTitle('部分正确 2')).toBeTruthy();
    expect(screen.getByTitle('未判分 1')).toBeTruthy();
  });
  it('does not present missing correctness as zero percent', () => {
    render(<CoachKpi label="正确率" value={null} unit="%" />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('%')).toBeNull();
  });
});
