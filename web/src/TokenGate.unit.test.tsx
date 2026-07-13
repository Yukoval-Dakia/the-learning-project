// @vitest-environment jsdom

import { TOKEN_STORAGE_KEY, apiFetch } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenGate } from './TokenGate';

function response(status: number): Response {
  return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'unauthorized' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderGate(queryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <div>应用已进入</div>
      </TokenGate>
    </QueryClientProvider>,
  );
  return queryClient;
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

describe('TokenGate', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('提供可访问的输入与提交按钮，验证成功后才保存 token 并进入应用', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(200));
    const user = userEvent.setup();
    renderGate();

    const input = await screen.findByLabelText('访问令牌');
    const submit = screen.getByRole('button', { name: '进入 Loom' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await user.type(input, 'valid-local-token');
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    expect(await screen.findByText('应用已进入')).toBeTruthy();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('valid-local-token');
    expect(document.body.textContent).not.toContain('valid-local-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('已保存 token 必须先通过服务端验证，不能直接展示应用', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    const fetchMock = vi.mocked(fetch);
    let resolveCheck: ((value: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveCheck = resolve;
      }),
    );

    renderGate();
    expect(screen.queryByText('应用已进入')).toBeNull();
    expect(screen.getByText('正在验证已保存的访问令牌…')).toBeTruthy();

    await act(async () => resolveCheck?.(response(200)));
    expect(await screen.findByText('应用已进入')).toBeTruthy();
  });

  it('无效 token 不落 localStorage，并显示可重试错误', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(401));
    const user = userEvent.setup();
    renderGate();

    const input = await screen.findByLabelText('访问令牌');
    await user.type(input, 'wrong-token');
    await user.click(screen.getByRole('button', { name: '进入 Loom' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '访问令牌无效，请重新输入。',
    );
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText('应用已进入')).toBeNull();
    expect(document.body.textContent).not.toContain('wrong-token');
  });

  it('任一 apiFetch 401 都立即卸载应用、清 query cache 并回到 gate', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-token');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(200));
    const queryClient = new QueryClient();
    renderGate(queryClient);
    expect(await screen.findByText('应用已进入')).toBeTruthy();
    queryClient.setQueryData(['private'], { secret: 'cached' });

    fetchMock.mockResolvedValueOnce(response(401));
    let thrown: unknown;
    await act(async () => {
      try {
        await apiFetch('/api/private');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(await screen.findByLabelText('访问令牌')).toBeTruthy();
    expect(screen.queryByText('应用已进入')).toBeNull();
    await waitFor(() => expect(queryClient.getQueryData(['private'])).toBeUndefined());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
