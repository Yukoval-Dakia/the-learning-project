// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkbenchSummary } from '../workbench-api';
import { WeekHeat } from './WeekHeat';

afterEach(cleanup);

const heat: WorkbenchSummary['week_heat'] = [
  { day: '2026-07-17', count: 0 },
  { day: '2026-07-18', count: 3 },
];

describe('WeekHeat activity values', () => {
  it('exposes each date and count as a named list item', () => {
    render(<WeekHeat heat={heat} />);

    const list = screen.getByRole('list', { name: '过去 7 天活动' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(list).getByRole('listitem', { name: '2026-07-17，星期五，0 次活动' }),
    ).toBeTruthy();
    expect(
      within(list).getByRole('listitem', { name: '2026-07-18，星期六，3 次活动' }),
    ).toBeTruthy();
  });

  it('shows exact counts next to weekdays instead of relying on color', () => {
    render(<WeekHeat heat={heat} />);

    expect(screen.getByText('五 · 0')).toBeTruthy();
    expect(screen.getByText('六 · 3')).toBeTruthy();
  });
});
