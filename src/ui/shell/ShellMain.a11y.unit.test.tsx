// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellMain } from './ShellMain';

afterEach(cleanup);

describe('ShellMain modal isolation', () => {
  it('removes page content from pointer, keyboard, and assistive navigation while blocked', () => {
    const { container } = render(
      <ShellMain blockedByModal>
        <button type="button">页面操作</button>
      </ShellMain>,
    );

    const main = container.querySelector('.main');
    expect(main?.hasAttribute('inert')).toBe(true);
    expect(main?.getAttribute('aria-hidden')).toBe('true');
  });

  it('restores page interaction after the modal closes', () => {
    const { container, rerender } = render(
      <ShellMain blockedByModal>
        <button type="button">页面操作</button>
      </ShellMain>,
    );

    rerender(
      <ShellMain blockedByModal={false}>
        <button type="button">页面操作</button>
      </ShellMain>,
    );

    const main = container.querySelector('.main');
    expect(main?.hasAttribute('inert')).toBe(false);
    expect(main?.hasAttribute('aria-hidden')).toBe(false);
  });
});
