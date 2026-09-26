// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaveStateChip } from './SaveStateChip';

afterEach(cleanup);

describe('SaveStateChip', () => {
  it('distinguishes idle from server-acknowledged saved and shows generation', () => {
    const { rerender } = render(<SaveStateChip state="idle" generation={3} />);
    expect(screen.getByText('草稿自动保存')).toBeTruthy();
    expect(screen.getByText('· v3')).toBeTruthy();
    rerender(<SaveStateChip state="saved" generation={4} />);
    expect(screen.getByText('已保存')).toBeTruthy();
  });

  it('shows retry only for a failed save and invokes its callback', () => {
    const onRetry = vi.fn();
    render(<SaveStateChip state="error" onRetry={onRetry} />);
    screen.getByRole('button', { name: '保存失败 · 重试' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('surfaces version conflict distinctly from generic failure', () => {
    render(<SaveStateChip state="conflict" generation={2} />);
    expect(screen.getByText('版本有更新 · 先刷新再改')).toBeTruthy();
  });
});
