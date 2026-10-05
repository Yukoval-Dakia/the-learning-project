// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChoiceSetResponse } from './ChoiceSetResponse';
import { optionsFromChoicesMd } from './response-types';

afterEach(cleanup);

describe('ChoiceSetResponse', () => {
  it('keeps served option order (does not shuffle) and carries stable IDs', () => {
    const options = optionsFromChoicesMd(['先列条件', '求出结果', '检验边界'], 'q-paper');
    render(<ChoiceSetResponse options={options} mode="single" value={null} onChange={vi.fn()} />);
    const buttons = screen.getAllByRole('radio');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'A先列条件',
      'B求出结果',
      'C检验边界',
    ]);
    expect(buttons.map((button) => button.getAttribute('data-option-id'))).toEqual(
      options.map((option) => option.id),
    );
  });

  it('single selection returns the stable option id; multi selection toggles to explicit []', () => {
    const options = optionsFromChoicesMd(['甲', '乙'], 'q');
    const onChange = vi.fn();
    const { rerender } = render(
      <ChoiceSetResponse options={options} mode="single" value={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /乙/ }));
    expect(onChange).toHaveBeenLastCalledWith([options[1].id]);

    onChange.mockClear();
    rerender(
      <ChoiceSetResponse
        options={options}
        mode="multi"
        value={[options[0].id]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /甲/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
