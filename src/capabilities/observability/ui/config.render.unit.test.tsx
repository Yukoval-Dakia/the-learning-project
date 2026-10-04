// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConfigSurface } from './config';
import type { ConfigData } from './config-model';
import { configFixture } from './config-test-fixture';

const clients: QueryClient[] = [];
beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'test-token', removeItem: vi.fn() },
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});
function setup(
  data: ConfigData,
  initial = 'ai-models',
  respond?: (init?: RequestInit) => Response,
) {
  const fetch = vi.fn(
    async (_url: unknown, init?: RequestInit) => respond?.(init) ?? Response.json(data),
  );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  function Host() {
    const [params, setParams] = useState(new URLSearchParams({ section: initial }));
    return (
      <AdminConfigSurface
        navigate={vi.fn()}
        getQuery={(key) => params.get(key)}
        setQuery={(key, value) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            if (value === null) next.delete(key);
            else next.set(key, value);
            return next;
          })
        }
      />
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
  return { fetch, user: userEvent.setup() };
}
describe('configuration page', () => {
  it('renders the requested section, true resolver facts, global pin and typed readonly state', async () => {
    const data = configFixture();
    data.tasks[0].global_pin = { provider: 'opencode-go', model: 'glm-5.3-flash' };
    data.tasks[0].effective_binding = {
      provider: 'opencode-go',
      model: 'glm-5.3-flash',
      error: null,
    };
    const { user } = setup(data);
    expect(await screen.findByText('opencode-go / glm-5.3-flash')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '编辑 JevScoringDecisionTask' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.type(screen.getByRole('searchbox'), 'missing-task');
    expect(screen.getAllByText('没有匹配项，请调整搜索条件。').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '总览' }));
    expect(screen.getByText(/没有 worker 确认信息/)).toBeTruthy();
  });
  it('distinguishes committed writes from stale snapshots and then refreshes', async () => {
    const data = configFixture();
    let refreshEpoch = 4;
    const { user, fetch } = setup(data, 'locale', (init) =>
      init?.method === 'PATCH'
        ? Response.json({
            committed_epoch: 5,
            snapshot_epoch: 4,
            snapshot_current: false,
            changes: [],
          })
        : Response.json({ ...data, snapshot: { ...data.snapshot, epoch: refreshEpoch } }),
    );
    await screen.findByText('AI 输出语言');
    await user.selectOptions(screen.getByRole('combobox', { name: '输出语言' }), 'en');
    await user.click(screen.getByRole('button', { name: '保存语言' }));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      '已保存，等待刷新。 不代表 worker 已确认。',
    );
    const write = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      changes: [{ action: 'set', key: 'locale.learner', value: 'en' }],
    });
    expect(new Headers(write?.[1]?.headers).get('x-internal-token')).toBe('test-token');
    refreshEpoch = 5;
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '刷新配置' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole('button', { name: '刷新配置' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('当前进程已刷新'));
  });
  it('sends grouped model reset through the reset API', async () => {
    const data = configFixture();
    const { user, fetch } = setup(data, 'ai-models', (init) =>
      init?.method === 'POST'
        ? Response.json({
            committed_epoch: 4,
            snapshot_epoch: 4,
            snapshot_current: true,
            changes: [],
          })
        : Response.json(data),
    );
    await user.click(await screen.findByRole('button', { name: '编辑 QuizGenTask' }));
    await user.click(screen.getByRole('button', { name: '恢复默认模型' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    const call = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(call?.[0]).toBe('/api/admin/config/reset');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      keys: ['task.QuizGenTask.provider', 'task.QuizGenTask.model'],
    });
  });
  it('shows missing facts without enabling a misleading model editor', async () => {
    const data = configFixture();
    data.facts_injected = false;
    data.providers = [];
    setup(data);
    expect(await screen.findByText(/运行时事实尚未就绪；模型编辑暂不可用/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '编辑 QuizGenTask' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('supports load failure and an explicit retry', async () => {
    const data = configFixture();
    let fail = true;
    const { user } = setup(data, 'overview', () =>
      fail ? Response.json({ message: '服务暂时不可用' }, { status: 503 }) : Response.json(data),
    );
    await screen.findByText('服务暂时不可用');
    fail = false;
    await user.click(screen.getByRole('button', { name: /重试/ }));
    expect(await screen.findByRole('heading', { name: '部署固定项' })).toBeTruthy();
  });
});
