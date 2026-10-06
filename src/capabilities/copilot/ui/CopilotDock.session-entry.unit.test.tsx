// @vitest-environment jsdom

// YUK-1340 — Copilot 会话入口组件行为测试（RED→GREEN）。
//
// 生产缺陷（docs/planning/2026-10-07-local-release-result.md 日用验证 1）：
// 抽屉 bootstrap 默认选中「最近更新」的会话而不看 status；最新一条是
// ended/abandoned 时 composer 与快捷 chip 全部禁用，唯一出路是发现隐藏的
// 「对话记录」菜单里的「新对话」。
//
// 本文件渲染真实 CopilotDock（含真实 CopilotSessionPanel），用多状态、多日期
// 的会话列表夹具断言组件行为，不是 helper 镜像测试：
//   1) 有 active/idle 且存在更新的 ended → 落位可继续会话（sensible resumable）
//   2) 仅 ended/abandoned → 有清晰可用的新建入口（bootstrap 开新对话 + 可见按钮）
//   3) 显式查看历史保持只读 + 可见「开始新对话」，无隐藏自动历史变更
//   4) 异步 bootstrap 建会话不抢用户在等待期间的显式选择（race）

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, apiJsonMock, consumeDurableMock, sessionsQueryState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  apiJsonMock: vi.fn(),
  consumeDurableMock: vi.fn(),
  sessionsQueryState: {
    data: null as {
      sessions: Array<{
        id: string;
        status: string;
        title: string | null;
        created_at: string;
        updated_at: string;
      }>;
    } | null,
    refetch: vi.fn(),
  },
}));

vi.mock('@/ui/lib/api', () => ({
  ApiAuthError: class ApiAuthError extends Error {},
  ApiError: class ApiError extends Error {
    details: Record<string, unknown>;
    constructor(
      message: string,
      public status: number,
      public code?: string,
      details: Record<string, unknown> = {},
    ) {
      super(message);
      this.details = details;
    }
  },
  apiFetch: apiFetchMock,
  apiJson: apiJsonMock,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === 'copilot-sessions'
      ? {
          data: sessionsQueryState.data,
          isLoading: sessionsQueryState.data === null,
          refetch: sessionsQueryState.refetch,
        }
      : { data: null, isLoading: false, refetch: vi.fn() },
}));

vi.mock('@/ui/lib/use-copilot-dwell', () => {
  const signalState = { request: null, clearRequest: vi.fn() };
  return {
    openCopilotForNudge: vi.fn(),
    useCopilotDwell: () => ({ open: true, openDrawer: vi.fn(), closeDrawer: vi.fn() }),
    useCopilotOpenSignal: (selector: (state: typeof signalState) => unknown) =>
      selector(signalState),
  };
});

vi.mock('./useCopilotNudges', () => ({
  useCopilotNudges: () => ({
    nudges: [],
    dismiss: vi.fn(),
    markOpened: vi.fn(),
    isMutating: false,
  }),
}));

vi.mock('@/ui/lib/deferred-markdown-renderer', () => ({
  DeferredMarkdownRenderer: ({ children }: { children: string }) => <span>{children}</span>,
  preloadMarkdownRenderer: vi.fn(),
}));

function PlainButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props}>{children}</button>;
}

vi.mock('@/ui/primitives/Btn', () => ({ Btn: PlainButton }));
vi.mock('@/ui/primitives/Button', () => ({ Button: PlainButton }));
vi.mock('@/ui/primitives/IconBtn', () => ({ IconBtn: PlainButton }));
vi.mock('@/ui/primitives/LoomIcon', () => ({ LoomIcon: () => <span aria-hidden="true">◇</span> }));
vi.mock('@/ui/primitives/LoomBadge', () => ({
  LoomBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/ui/primitives/CopilotDrawer', () => ({
  CopilotDrawer: ({
    children,
    footer,
    headActions,
    summary,
    onClose,
  }: {
    children: ReactNode;
    footer: ReactNode;
    headActions: ReactNode;
    summary: ReactNode;
    onClose: () => void;
  }) => (
    <section>
      <button type="button" data-testid="drawer-close" onClick={onClose}>
        关闭
      </button>
      {headActions}
      {summary}
      {children}
      {footer}
    </section>
  ),
}));
vi.mock('@/ui/primitives/ToolUseCard', () => ({
  ToolUseCard: ({ summary, result }: { summary: string; result: ReactNode }) => (
    <article>
      <span>{summary}</span>
      {result}
    </article>
  ),
}));
vi.mock('./CopilotHeroCard', () => ({ CopilotHeroCard: () => null }));
vi.mock('./subtask-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subtask-events')>();
  return { ...actual, consumeDurableCopilotRun: consumeDurableMock };
});

import { CopilotDock } from './CopilotDock';

interface SessionFixture {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/** Realistic conversation history: multiple statuses + staggered dates. */
function session(partial: {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}): SessionFixture {
  return partial;
}

const HISTORY_MULTI_STATUS: SessionFixture[] = [
  session({
    id: 's-ended-new',
    status: 'ended',
    title: '椭圆难题复盘',
    created_at: '2026-10-07T09:00:00.000Z',
    updated_at: '2026-10-07T18:30:00.000Z',
  }),
  session({
    id: 's-idle',
    status: 'idle',
    title: '函数定义域整理',
    created_at: '2026-10-07T08:00:00.000Z',
    updated_at: '2026-10-07T12:00:00.000Z',
  }),
  session({
    id: 's-active-old',
    status: 'active',
    title: '英语时态对比',
    created_at: '2026-10-05T10:00:00.000Z',
    updated_at: '2026-10-05T11:00:00.000Z',
  }),
  session({
    id: 's-abandoned',
    status: 'abandoned',
    title: '物理电磁感应',
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T11:00:00.000Z',
  }),
];

const HISTORY_ONLY_TERMINAL: SessionFixture[] = [
  session({
    id: 's-ended',
    status: 'ended',
    title: '椭圆难题复盘',
    created_at: '2026-10-07T09:00:00.000Z',
    updated_at: '2026-10-07T18:30:00.000Z',
  }),
  session({
    id: 's-abandoned',
    status: 'abandoned',
    title: '旧的物理讨论',
    created_at: '2026-10-02T10:00:00.000Z',
    updated_at: '2026-10-02T11:00:00.000Z',
  }),
];

const HISTORY_LIVE_PLUS_OLDER_ENDED: SessionFixture[] = [
  session({
    id: 's-active-new',
    status: 'active',
    title: '函数定义域整理',
    created_at: '2026-10-07T08:00:00.000Z',
    updated_at: '2026-10-07T12:00:00.000Z',
  }),
  session({
    id: 's-ended-old',
    status: 'ended',
    title: '椭圆难题复盘',
    created_at: '2026-10-06T08:00:00.000Z',
    updated_at: '2026-10-06T09:00:00.000Z',
  }),
];

function createSessionResponse(id: string): { session: SessionFixture } {
  return {
    session: session({
      id,
      status: 'active',
      title: null,
      created_at: '2026-10-07T19:00:00.000Z',
      updated_at: '2026-10-07T19:00:00.000Z',
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function composerDisabled(): boolean {
  return (screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled;
}

function createPostCalls(): unknown[][] {
  return apiJsonMock.mock.calls.filter(
    ([url, init]) =>
      url === '/api/copilot/sessions' && (init as RequestInit | undefined)?.method === 'POST',
  );
}

async function openHistoryPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId('copilot-session-list-toggle'));
  return screen.findByTestId('copilot-session-panel');
}

describe('CopilotDock 会话入口 (YUK-1340)', () => {
  let createSessionHandler: () => Promise<{ session: SessionFixture }>;

  beforeEach(() => {
    window.sessionStorage.clear();
    apiFetchMock.mockReset();
    apiJsonMock.mockReset();
    consumeDurableMock.mockReset();
    sessionsQueryState.data = null;
    sessionsQueryState.refetch.mockReset();
    sessionsQueryState.refetch.mockResolvedValue(undefined);
    createSessionHandler = async () => createSessionResponse('s-created-default');
    apiJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/copilot/turns')) {
        const sessionId = new URL(url, 'http://local').searchParams.get('session_id') ?? '';
        return { session_id: sessionId, turns: [], active_runs: [] };
      }
      if (url === '/api/copilot/sessions' && init?.method === 'POST') {
        return createSessionHandler();
      }
      throw new Error(`unexpected apiJson call: ${url}`);
    });
    consumeDurableMock.mockImplementation(
      () =>
        new Promise(() => {
          /* subscription stays open in these tests */
        }),
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('落位最近的可继续会话（active/idle），不被更新的 ended 抢走，也不自动建会话', async () => {
    const user = userEvent.setup();
    sessionsQueryState.data = { sessions: HISTORY_MULTI_STATUS };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    // RED（修复前）：bootstrap 选中 sessions[0]（ended-new）→ composer 永久禁用。
    // GREEN（修复后）：s-idle 是最新 live 会话 → 可直接提问。
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(createPostCalls()).toHaveLength(0);

    const panel = await openHistoryPanel(user);
    const idleRow = within(panel).getByRole('button', { name: /函数定义域整理/ });
    expect(idleRow.getAttribute('aria-current')).toBe('true');
    // 只读历史仍可查看，但 bootstrap 不会停在 ended 上。
    expect(composerDisabled()).toBe(false);
  });

  it('仅有 ended/abandoned 时自动给出可用的新对话，无需发现隐藏菜单', async () => {
    const user = userEvent.setup();
    createSessionHandler = async () => createSessionResponse('s-created-case1');
    sessionsQueryState.data = { sessions: HISTORY_ONLY_TERMINAL };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    // RED（修复前）：无 POST、composer 永久禁用，学员卡死在只读 ended 会话。
    // GREEN（修复后）：bootstrap 走既有 createConversation 路径开新对话。
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));

    // 新对话确实可用：能输入。
    const input = screen.getByTestId('copilot-composer-input');
    await user.type(input, '今天想继续椭圆那道题。');
    expect((input as HTMLTextAreaElement).value).toBe('今天想继续椭圆那道题。');
  });

  it('显式查看历史保持只读，给出可见的「开始新对话」，无隐藏自动历史变更', async () => {
    const user = userEvent.setup();
    createSessionHandler = async () => createSessionResponse('s-created-case3');
    sessionsQueryState.data = { sessions: HISTORY_LIVE_PLUS_OLDER_ENDED };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await waitFor(() => expect(composerDisabled()).toBe(false));
    // 落位 active 会话时不应有任何自动建会话。
    expect(createPostCalls()).toHaveLength(0);

    const panel = await openHistoryPanel(user);
    await user.click(within(panel).getByRole('button', { name: /椭圆难题复盘/ }));

    // 历史只读：输入禁用；且查看历史本身不触发任何创建/修改。
    await waitFor(() => expect(composerDisabled()).toBe(true));
    expect(createPostCalls()).toHaveLength(0);
    expect(apiFetchMock).not.toHaveBeenCalled();

    // RED（修复前）：禁用控件旁没有可见的新建入口（只能去隐藏菜单找）。
    const notice = screen.getByTestId('copilot-readonly-notice');
    const startNew = within(notice).getByTestId('copilot-start-new');
    expect(notice.textContent).toContain('仅供回看');

    // 「开始新对话」是可用动作：显式点击才创建，随后可继续提问。
    await user.click(startNew);
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('异步 bootstrap 建会话不抢用户在等待期间的显式选择', async () => {
    const user = userEvent.setup();
    const createGate = deferred<{ session: SessionFixture }>();
    createSessionHandler = () => createGate.promise;
    sessionsQueryState.data = {
      sessions: [
        session({
          id: 's-ended-b',
          status: 'ended',
          title: '最新已结束对话',
          created_at: '2026-10-07T15:00:00.000Z',
          updated_at: '2026-10-07T18:00:00.000Z',
        }),
        session({
          id: 's-ended-a',
          status: 'ended',
          title: '更早的只读对话',
          created_at: '2026-10-06T08:00:00.000Z',
          updated_at: '2026-10-06T09:00:00.000Z',
        }),
      ],
    };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    // RED（修复前）：bootstrap 从不建会话（waitFor 超时），学员被按在 ended 会话上。
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));

    // 建会话进行中，学员显式打开历史查看更早的只读对话。
    const panel = await openHistoryPanel(user);
    await user.click(within(panel).getByRole('button', { name: /更早的只读对话/ }));
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('button', { name: /更早的只读对话/ })
          .getAttribute('aria-current'),
      ).toBe('true'),
    );

    // 创建完成：不得抢走用户选择，历史保持只读 + 可见新建入口。
    await act(async () => {
      createGate.resolve(createSessionResponse('s-created-race'));
    });
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    expect(
      within(panel)
        .getByRole('button', { name: /更早的只读对话/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(composerDisabled()).toBe(true);
    expect(screen.getByTestId('copilot-readonly-notice').textContent).toContain('仅供回看');
  });
});
