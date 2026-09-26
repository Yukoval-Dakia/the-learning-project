// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelfConfidenceField } from './SelfConfidenceField';

afterEach(cleanup);

describe('SelfConfidenceField — capture / optional / keyboard', () => {
  it('未自评时是可选形态：没有任何档被选中，「不评」为当前态', () => {
    render(<SelfConfidenceField value={undefined} onChange={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(6);
    for (const score of [1, 2, 3, 4, 5]) {
      expect(
        screen
          .getByRole('button', { name: `把握 ${score} 分（共 5 分）` })
          .getAttribute('aria-pressed'),
      ).toBe('false');
    }
    expect(screen.getByRole('button', { name: '不评' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('选档 → onChange(score)，受控 value 反映选中态', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SelfConfidenceField value={null} onChange={onChange} />);
    const four = screen.getByRole('button', { name: '把握 4 分（共 5 分）' });
    four.click();
    expect(onChange).toHaveBeenLastCalledWith(4);
    rerender(<SelfConfidenceField value={4} onChange={onChange} />);
    expect(four.getAttribute('aria-pressed')).toBe('true');
    expect(four.className).toContain('is-selected');
    expect(screen.getByRole('button', { name: '不评' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('「不评」清空 → onChange(null)（optional：键可缺席）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelfConfidenceField value={3} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '不评' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('键盘可达：组内方向键移动焦点，Enter 选择，Home/End 跳两端', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelfConfidenceField value={null} onChange={onChange} ariaLabel="第 1 题信心自评" />);
    expect(screen.getByRole('group', { name: '第 1 题信心自评' })).toBeTruthy();

    const three = screen.getByRole('button', { name: '把握 3 分（共 5 分）' });
    three.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '把握 4 分（共 5 分）' }),
    );
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(4);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '把握 1 分（共 5 分）' }),
    );
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '把握 5 分（共 5 分）' }),
    );
  });

  it('disabled：不触发 onChange（作答面冻结时宿主传入）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelfConfidenceField value={2} onChange={onChange} disabled />);
    await user.click(screen.getByRole('button', { name: '把握 5 分（共 5 分）' }));
    await user.click(screen.getByRole('button', { name: '不评' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
