// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CoachKpi } from './CoachHub';

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
