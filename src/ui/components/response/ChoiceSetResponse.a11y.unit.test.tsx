// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChoiceSetResponse } from './ChoiceSetResponse';
import { optionsFromChoicesMd } from './response-types';

afterEach(cleanup);

describe('ChoiceSetResponse keyboard and accessible semantics', () => {
  it('exposes a named radio group and arrow-key selection', async () => {
    const user = userEvent.setup();
    const options = optionsFromChoicesMd(['甲', '乙', '丙'], 'q');
    const onChange = vi.fn();
    render(
      <ChoiceSetResponse
        options={options}
        mode="single"
        value={[options[0].id]}
        onChange={onChange}
        ariaLabel="答案选项"
      />,
    );
    const first = screen.getByRole('radio', { name: /甲/ });
    expect(screen.getByRole('radiogroup', { name: '答案选项' })).toBeTruthy();
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /乙/ }));
    expect(onChange).toHaveBeenLastCalledWith([options[1].id]);
  });

  it('number hotkeys select by input order and ignore text-entry focus', async () => {
    const options = optionsFromChoicesMd(['甲', '乙', '丙', '丁', '戊'], 'q');
    const onChange = vi.fn();
    render(
      <>
        <ChoiceSetResponse options={options} mode="single" value={null} onChange={onChange} hotkeys />
        <input aria-label="文本输入" />
      </>,
    );
    await userEvent.keyboard('5');
    expect(onChange).toHaveBeenLastCalledWith([options[4].id]);
    onChange.mockClear();
    screen.getByRole('textbox', { name: '文本输入' }).focus();
    await userEvent.keyboard('2');
    expect(onChange).not.toHaveBeenCalled();
  });
});
