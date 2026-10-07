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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  render as renderComponent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, apiJsonMock, consumeDurableMock, sessionsQueryState, drawerState } =
  vi.hoisted(() => ({
    apiFetchMock: vi.fn(),
    apiJsonMock: vi.fn(),
    consumeDurableMock: vi.fn(),
    drawerState: { open: true },
    sessionsQueryState: {
      data: null as {
        server_time?: string;
        supported_derivation_policies?: Array<'allow' | 'answer_only'>;
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

vi.mock('@/ui/lib/use-copilot-dwell', () => {
  const signalState = { request: null, clearRequest: vi.fn() };
  return {
    openCopilotForNudge: vi.fn(),
    useCopilotDwell: () => ({
      open: drawerState.open,
      openDrawer: vi.fn(),
      closeDrawer: () => {
        drawerState.open = false;
      },
    }),
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
import {
  PENDING_COPILOT_TURN_STORAGE_KEY,
  loadCopilotDerivationPreference,
  saveCopilotDerivationPreference,
} from './durable-reconnect-storage';

let queryClient: QueryClient;
function render(ui: ReactNode) {
  return renderComponent(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

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

/** Frozen clock: 2026-10-07T20:00:00Z. All fixture ages are relative to this. */
const FROZEN_NOW = new Date('2026-10-07T20:00:00.000Z');

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

/** P1: recently ended + stale idle (>24h) — server would create new, not reuse stale idle. */
const HISTORY_STALE_IDLE_PLUS_RECENT_ENDED: SessionFixture[] = [
  session({
    id: 's-ended-recent',
    status: 'ended',
    title: '刚结束的对话',
    created_at: '2026-10-07T18:00:00.000Z',
    updated_at: '2026-10-07T19:00:00.000Z',
  }),
  session({
    id: 's-idle-stale',
    status: 'idle',
    title: '过期闲置对话',
    created_at: '2026-10-05T08:00:00.000Z',
    updated_at: '2026-10-05T10:00:00.000Z',
  }),
];

/** P1 variant: recently ended + stale active (>24h) — same contract. */
const HISTORY_STALE_ACTIVE_PLUS_RECENT_ENDED: SessionFixture[] = [
  session({
    id: 's-ended-recent-b',
    status: 'ended',
    title: '最近完结讨论',
    created_at: '2026-10-07T17:00:00.000Z',
    updated_at: '2026-10-07T18:30:00.000Z',
  }),
  session({
    id: 's-active-stale',
    status: 'active',
    title: '过期进行中对话',
    created_at: '2026-10-04T08:00:00.000Z',
    updated_at: '2026-10-04T10:00:00.000Z',
  }),
];

/** Within window: idle updated 5h before FROZEN_NOW → still reusable. */
const HISTORY_FRESH_IDLE: SessionFixture[] = [
  session({
    id: 's-idle-fresh',
    status: 'idle',
    title: '新鲜闲置对话',
    created_at: '2026-10-07T14:00:00.000Z',
    updated_at: '2026-10-07T15:00:00.000Z',
  }),
];

/** Boundary: idle updated exactly 24h before FROZEN_NOW → gte cutoff → reusable. */
const HISTORY_IDLE_AT_BOUNDARY: SessionFixture[] = [
  session({
    id: 's-idle-boundary',
    status: 'idle',
    title: '边界闲置对话',
    created_at: '2026-10-06T18:00:00.000Z',
    updated_at: '2026-10-06T20:00:00.000Z',
  }),
];

/** Just past boundary: idle updated 24h+1ms before FROZEN_NOW → outside window. */
const HISTORY_IDLE_PAST_BOUNDARY: SessionFixture[] = [
  session({
    id: 's-idle-past-boundary',
    status: 'idle',
    title: '刚好过期对话',
    created_at: '2026-10-06T18:00:00.000Z',
    updated_at: '2026-10-06T19:59:59.999Z',
  }),
];

/** Illegal updated_at: conservative → treat as not reusable → create new. */
const HISTORY_IDLE_INVALID_TIME: SessionFixture[] = [
  session({
    id: 's-idle-invalid-time',
    status: 'idle',
    title: '时间戳异常对话',
    created_at: '2026-10-07T10:00:00.000Z',
    updated_at: 'not-a-date',
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
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    drawerState.open = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_NOW);
    window.sessionStorage.clear();
    window.localStorage.clear();
    apiFetchMock.mockReset();
    apiJsonMock.mockReset();
    consumeDurableMock.mockReset();
    sessionsQueryState.data = null;
    sessionsQueryState.refetch.mockReset();
    sessionsQueryState.refetch.mockImplementation(async () => ({
      server_time: FROZEN_NOW.toISOString(),
      supported_derivation_policies: ['allow', 'answer_only'],
      ...sessionsQueryState.data,
    }));
    createSessionHandler = async () => createSessionResponse('s-created-default');
    apiJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/copilot/sessions' && init?.method !== 'POST')
        return sessionsQueryState.refetch();
      if (url === '/api/today/copilot-summary') return null;
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
    vi.useRealTimers();
    cleanup();
    queryClient.clear();
  });

  it('保留受限偏好并显示旧服务器未支持，输入内容不会发送或丢失', async () => {
    const user = userEvent.setup();
    saveCopilotDerivationPreference('answer_only');
    sessionsQueryState.data = {
      sessions: HISTORY_MULTI_STATUS,
      supported_derivation_policies: undefined,
    };
    render(<CopilotDock pathname="/subjects/math" navigate={vi.fn()} />);
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect((screen.getByLabelText('本轮用途') as HTMLSelectElement).value).toBe('answer_only');
    expect(screen.getByRole('status').textContent).toContain('当前服务器不支持');
    const input = screen.getByTestId('copilot-composer-input');
    await user.type(input, '仅为临时假设：含边界、反例与未经验证的长式推导。');
    await user.click(screen.getByTestId('copilot-composer-send'));
    await waitFor(() =>
      expect(screen.getByTestId('copilot-error').textContent).toContain('当前服务器'),
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toContain('未经验证');
    expect(loadCopilotDerivationPreference()).toBe('answer_only');
  });

  it('检查服务器支持时显示加载状态，不静默切换已保存的用途', async () => {
    saveCopilotDerivationPreference('answer_only');
    const gate = deferred<unknown>();
    sessionsQueryState.refetch.mockReturnValueOnce(gate.promise);
    render(<CopilotDock pathname="/subjects/math" navigate={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('检查');
    expect((screen.getByLabelText('本轮用途') as HTMLSelectElement).value).toBe('answer_only');
    await act(async () =>
      gate.resolve({
        server_time: FROZEN_NOW.toISOString(),
        sessions: HISTORY_MULTI_STATUS,
        supported_derivation_policies: ['allow', 'answer_only'],
      }),
    );
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(screen.getByRole('status').textContent).toContain('聊天和必要运行记录仍会保存');
    expect(loadCopilotDerivationPreference()).toBe('answer_only');
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

  // ── YUK-1340 P1: 自动续接必须遵循 status + 24h 年龄规则 ──────────────────

  it('P1: 超过24h的 idle 不能自动续接，即使它是唯一的 live 候选（应新建）', async () => {
    createSessionHandler = async () => createSessionResponse('s-created-stale-idle');
    sessionsQueryState.data = { sessions: HISTORY_STALE_IDLE_PLUS_RECENT_ENDED };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    // RED（修复前）：bootstrap 只看 status，自动选中 s-idle-stale（>24h），
    //   把新问题写进过时对话。
    // GREEN（修复后）：s-idle-stale 超出服务端24h复用窗口 → 走 createConversation。
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('P1: 超过24h的 active 不能自动续接（应新建）', async () => {
    createSessionHandler = async () => createSessionResponse('s-created-stale-active');
    sessionsQueryState.data = { sessions: HISTORY_STALE_ACTIVE_PLUS_RECENT_ENDED };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('窗口内 active/idle 仍自动续接，不新建', async () => {
    sessionsQueryState.data = { sessions: HISTORY_FRESH_IDLE };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(createPostCalls()).toHaveLength(0);

    const panel = await openHistoryPanel(userEvent.setup());
    expect(
      within(panel)
        .getByRole('button', { name: /新鲜闲置对话/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('恰好24h边界的 idle 仍在复用窗口内（gte 语义，与服务端一致）', async () => {
    sessionsQueryState.data = { sessions: HISTORY_IDLE_AT_BOUNDARY };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(createPostCalls()).toHaveLength(0);

    const panel = await openHistoryPanel(userEvent.setup());
    expect(
      within(panel)
        .getByRole('button', { name: /边界闲置对话/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('刚好超过24h边界的 idle 不可自动续接（应新建）', async () => {
    createSessionHandler = async () => createSessionResponse('s-created-past-boundary');
    sessionsQueryState.data = { sessions: HISTORY_IDLE_PAST_BOUNDARY };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('updated_at 非法时保守处理为不可续接（应新建）', async () => {
    createSessionHandler = async () => createSessionResponse('s-created-invalid-time');
    sessionsQueryState.data = { sessions: HISTORY_IDLE_INVALID_TIME };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('显式选择超过24h的 idle 会话仍可继续（不改显式选择语义）', async () => {
    const user = userEvent.setup();
    createSessionHandler = async () => createSessionResponse('s-created-for-explicit');
    sessionsQueryState.data = { sessions: HISTORY_STALE_IDLE_PLUS_RECENT_ENDED };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    // bootstrap 因过期候选走新建
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));

    // 用户显式打开历史，点选过期 idle 会话
    const panel = await openHistoryPanel(user);
    await user.click(within(panel).getByRole('button', { name: /过期闲置对话/ }));

    // 显式选择不受 24h 窗口限制：idle → composer 可用
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(
      within(panel)
        .getByRole('button', { name: /过期闲置对话/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  async function reopen(view: ReturnType<typeof render>) {
    await userEvent.setup().click(screen.getByTestId('drawer-close'));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <CopilotDock pathname="/practice" navigate={vi.fn()} />
      </QueryClientProvider>,
    );
    drawerState.open = true;
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <CopilotDock pathname="/practice" navigate={vi.fn()} />
      </QueryClientProvider>,
    );
  }

  it.each(['idle', 'active'])(
    'revalidates retained automatic %s across the 24h boundary on reopen',
    async (status) => {
      sessionsQueryState.data = {
        sessions: HISTORY_IDLE_AT_BOUNDARY.map((row) => ({ ...row, status })),
      };
      const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
      await waitFor(() => expect(composerDisabled()).toBe(false));
      sessionsQueryState.data.server_time = new Date(FROZEN_NOW.getTime() + 1).toISOString();
      await reopen(view);
      await waitFor(() => expect(createPostCalls()).toHaveLength(1));
      await waitFor(() => expect(composerDisabled()).toBe(false));
      const calls = apiJsonMock.mock.calls.filter(([url]) => String(url).includes('/turns'));
      expect(calls.at(-1)?.[0]).toContain('s-created-default');
    },
  );

  it('uses server_time when a slow client clock would reuse an expired session', async () => {
    vi.setSystemTime(new Date(FROZEN_NOW.getTime() - 86_400_000));
    sessionsQueryState.data = {
      server_time: FROZEN_NOW.toISOString(),
      sessions: HISTORY_IDLE_PAST_BOUNDARY,
    };
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('cached data cannot bootstrap or send before a fresh fetch, and failed fetch can be retried', async () => {
    sessionsQueryState.data = { sessions: HISTORY_FRESH_IDLE };
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(queryClient.getQueriesData({ queryKey: ['copilot-sessions'] })).toHaveLength(1);
    const turnsBeforeReopen = apiJsonMock.mock.calls.filter(([url]) =>
      String(url).includes('/turns'),
    ).length;
    const gate = deferred<{ server_time: string; sessions: SessionFixture[] }>();
    sessionsQueryState.refetch.mockImplementationOnce(() => gate.promise);
    await reopen(view);
    await waitFor(() => expect(sessionsQueryState.refetch).toHaveBeenCalledTimes(2));
    expect(composerDisabled()).toBe(true);
    expect(apiJsonMock.mock.calls.filter(([url]) => String(url).includes('/turns'))).toHaveLength(
      turnsBeforeReopen,
    );
    expect(createPostCalls()).toHaveLength(0);
    await act(async () => gate.reject(new Error('sessions temporarily unavailable')));
    expect(composerDisabled()).toBe(true);
    await userEvent.setup().click(await screen.findByTestId('copilot-sessions-retry'));
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('retained automatic selection waits for this reopen, even if the prior open request finishes late', async () => {
    sessionsQueryState.data = { sessions: HISTORY_FRESH_IDLE };
    const first = deferred<{ server_time: string; sessions: SessionFixture[] }>();
    const second = deferred<{ server_time: string; sessions: SessionFixture[] }>();
    sessionsQueryState.refetch
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(sessionsQueryState.refetch).toHaveBeenCalledOnce());
    await reopen(view);
    await waitFor(() => expect(sessionsQueryState.refetch).toHaveBeenCalledTimes(2));
    await act(async () =>
      first.resolve({ server_time: FROZEN_NOW.toISOString(), sessions: HISTORY_FRESH_IDLE }),
    );
    expect(composerDisabled()).toBe(true);
    expect(createPostCalls()).toHaveLength(0);
    await act(async () =>
      second.resolve({ server_time: FROZEN_NOW.toISOString(), sessions: HISTORY_FRESH_IDLE }),
    );
    await waitFor(() => expect(composerDisabled()).toBe(false));
  });

  it('explicit old idle selection survives reopen while the sessions fetch fails', async () => {
    sessionsQueryState.data = { sessions: HISTORY_STALE_IDLE_PLUS_RECENT_ENDED };
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(createPostCalls()).toHaveLength(1));
    const panel = await openHistoryPanel(userEvent.setup());
    await userEvent.setup().click(within(panel).getByRole('button', { name: /过期闲置对话/ }));
    await waitFor(() => expect(composerDisabled()).toBe(false));
    sessionsQueryState.refetch.mockRejectedValueOnce(new Error('offline'));
    await reopen(view);
    await waitFor(() => expect(sessionsQueryState.refetch).toHaveBeenCalledTimes(3));
    expect(composerDisabled()).toBe(false);
    expect(createPostCalls()).toHaveLength(1);
    expect(
      within(panel)
        .getByRole('button', { name: /过期闲置对话/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('recovers a pending old session with its exact original body and key despite failed sessions fetch', async () => {
    const requestBody = {
      session_id: 's-original-old',
      user_message: '恢复椭圆边界问题',
      triggered_by: 'chat',
      ambient_context: { route: '/notes/original' },
    };
    window.sessionStorage.setItem(
      PENDING_COPILOT_TURN_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        turns: [
          {
            v: 2,
            idempotencyKey: 'original-idempotency-key',
            userMessageId: 'original-user',
            aiMessageId: 'original-ai',
            userMessage: requestBody.user_message,
            requestBody,
          },
        ],
      }),
    );
    sessionsQueryState.refetch.mockRejectedValue(new Error('offline'));
    apiFetchMock.mockRejectedValue(new Error('uncertain acceptance'));
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const recovery = await screen.findByTestId('copilot-pending-recovery');
    expect(apiFetchMock).not.toHaveBeenCalled();
    await userEvent.setup().click(within(recovery).getByText('恢复'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());
    const init = apiFetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(init.body)).toEqual(requestBody);
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('original-idempotency-key');
    expect(createPostCalls()).toHaveLength(0);
  });

  it('revalidates an automatically created session after close/reopen without bypassing age', async () => {
    sessionsQueryState.data = { sessions: HISTORY_ONLY_TERMINAL };
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(composerDisabled()).toBe(false));
    expect(createPostCalls()).toHaveLength(1);
    sessionsQueryState.data = {
      server_time: '2026-10-08T19:00:00.001Z',
      sessions: [createSessionResponse('s-created-default').session],
    };
    createSessionHandler = async () => createSessionResponse('s-created-next-open');
    await reopen(view);
    await waitFor(() => expect(createPostCalls()).toHaveLength(2));
  });

  it('explicit new conversation can recover from a failed fresh list and survives reopen', async () => {
    sessionsQueryState.refetch.mockRejectedValue(new Error('offline'));
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await screen.findByTestId('copilot-sessions-retry');
    await userEvent.setup().click(screen.getByTestId('copilot-start-new'));
    await waitFor(() => expect(composerDisabled()).toBe(false));
    await reopen(view);
    expect(composerDisabled()).toBe(false);
    expect(createPostCalls()).toHaveLength(1);
  });

  it('late create cannot steal a repeated explicit selection, and late turns cannot mix message contexts', async () => {
    const gate = deferred<{ session: SessionFixture }>();
    const oldTurns = deferred<{
      session_id: string;
      turns: Array<{ role: 'ai'; text: string; event_id: string; at: string }>;
      active_runs: [];
    }>();
    sessionsQueryState.data = { sessions: HISTORY_MULTI_STATUS };
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(composerDisabled()).toBe(false));
    const user = userEvent.setup();
    const panel = await openHistoryPanel(user);
    const ended = within(panel).getByRole('button', { name: /椭圆难题复盘/ });
    apiJsonMock.mockImplementationOnce(() => oldTurns.promise);
    await user.click(ended);
    createSessionHandler = () => gate.promise;
    await user.click(screen.getByTestId('copilot-start-new'));
    await user.click(within(panel).getByRole('button', { name: /函数定义域整理/ }));
    await user.click(ended);
    await act(async () => gate.resolve(createSessionResponse('s-late')));
    expect(ended.getAttribute('aria-current')).toBe('true');
    expect(composerDisabled()).toBe(true);
    await user.click(within(panel).getByRole('button', { name: /函数定义域整理/ }));
    await act(async () =>
      oldTurns.resolve({
        session_id: 's-ended-new',
        turns: [
          {
            role: 'ai',
            text: '迟到的椭圆历史只属于原对话',
            event_id: 'old-reply',
            at: '2026-10-07T19:00:00Z',
          },
        ],
        active_runs: [],
      }),
    );
    expect(screen.queryByText('迟到的椭圆历史只属于原对话')).toBeNull();
    expect(
      within(panel)
        .getByRole('button', { name: /函数定义域整理/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(composerDisabled()).toBe(false);
    expect(createPostCalls()).toHaveLength(1);
    await reopen(view);
    expect(createPostCalls()).toHaveLength(1);
  });

  it('keeps the original active run on reopen across age expiry without creating or reposting', async () => {
    sessionsQueryState.data = { sessions: HISTORY_IDLE_AT_BOUNDARY };
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ run_id: 'run-original' }), {
        status: 202,
        headers: { Location: '/api/jobs/copilot_run/run-original/events' },
      }),
    );
    const view = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(composerDisabled()).toBe(false));
    const user = userEvent.setup();
    await user.type(screen.getByTestId('copilot-composer-input'), '保留正在处理的椭圆问题');
    await user.click(screen.getByTestId('copilot-composer-send'));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledOnce());
    const defaultApi = apiJsonMock.getMockImplementation();
    apiJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/copilot/turns'))
        return {
          session_id: 's-idle-boundary',
          turns: [],
          active_runs: [
            {
              run_id: 'run-original',
              session_id: 's-idle-boundary',
              status: 'running',
              events_url: '/api/jobs/copilot_run/run-original/events',
            },
          ],
        };
      return defaultApi?.(url, init);
    });
    sessionsQueryState.data.server_time = new Date(FROZEN_NOW.getTime() + 1).toISOString();
    await reopen(view);
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(2));
    expect(createPostCalls()).toHaveLength(0);
    expect(apiFetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(apiFetchMock.mock.calls[0]?.[1]?.body).session_id).toBe('s-idle-boundary');
  });
});
