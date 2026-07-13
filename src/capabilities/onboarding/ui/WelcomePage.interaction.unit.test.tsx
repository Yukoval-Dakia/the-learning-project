// @vitest-environment jsdom
// YUK-601 PR7 收尾 — CreateSubjectChip 状态壳的 jsdom/RTL 交互测试（review-763
// P3-4 承诺的载体：blur containment / 吞-click 防护 / Esc / mutation 生命周期
// 是 owner review 两度点名的高危交互，SSR 覆盖不到）。fetch 全程 mock（201
// thin-create payload）；token 走 jsdom localStorage。

import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WelcomePage from './WelcomePage';

// fetch 按 method 分流：useSubjects 的 GET /api/subjects 也走同一 fetch——
// 只对 POST /api/admin/subjects 计数断言。
function mockFetch(postResponse: () => Response) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return postResponse();
    }
    return Response.json({ subjects: [] });
  });
  return { fn, posts };
}

function createdResponse(id = 'subj_new1') {
  return Response.json(
    {
      id,
      displayName: '化学',
      isGeneralFallback: true,
      revision: 0,
      seedRootId: `seed:${id}:root`,
    },
    { status: 201 },
  );
}

function renderWelcome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WelcomePage navigate={() => {}} />
    </QueryClientProvider>,
  );
}

// jsdom（v29，本仓 devDep）在 vitest 默认 origin 下不挂 localStorage——注入内存
// 实现（api.ts 的 getInternalToken 只用 getItem/setItem/removeItem）。
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
  });
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
});
afterEach(() => {
  cleanup(); // globals:false → RTL 不自动 cleanup，双 render 会撞重复元素。
  vi.unstubAllGlobals();
});

describe('CreateSubjectChip — 交互（jsdom）', () => {
  it('点确认按钮提交成功（blur 先于 click 不吞提交）→ 表单收起', async () => {
    const { fn, posts } = mockFetch(createdResponse);
    vi.stubGlobal('fetch', fn);
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByRole('button', { name: '+ 新科目' }));
    const input = screen.getByLabelText('新科目名');
    await user.type(input, '化学');
    // userEvent.click 会先把焦点移出 input（触发容器 onBlur 路径）再点击——
    // 正是「blur 吞 click」防护要保住的路径。
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ url: '/api/admin/subjects', body: { displayName: '化学' } });
    // 成功后表单收起、chip 复位。
    expect(await screen.findByRole('button', { name: '+ 新科目' })).toBeDefined();
    expect(screen.queryByLabelText('新科目名')).toBeNull();
  });

  it('Esc 收起且不发请求；焦点移到表单外收起', async () => {
    const { fn, posts } = mockFetch(createdResponse);
    vi.stubGlobal('fetch', fn);
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByRole('button', { name: '+ 新科目' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('新科目名')).toBeNull();

    await user.click(screen.getByRole('button', { name: '+ 新科目' }));
    // tab 出整个表单容器（input → 创建按钮 → 容器外）→ 收起。
    await user.tab();
    await user.tab();
    expect(screen.queryByLabelText('新科目名')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('422 撞名：server 文案直出、表单保持展开可改名', async () => {
    const { fn } = mockFetch(() =>
      Response.json(
        { error: "display name '语文' collides with builtin subject 'yuwen'" },
        { status: 422 },
      ),
    );
    vi.stubGlobal('fetch', fn);
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByRole('button', { name: '+ 新科目' }));
    await user.type(screen.getByLabelText('新科目名'), '语文');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByText(/collides with builtin subject/)).toBeDefined();
    expect(screen.getByLabelText('新科目名')).toBeDefined();
  });
});

describe('WelcomePage — 选择状态语义', () => {
  it('announces the selected stage and pace through aria-pressed', async () => {
    const { fn } = mockFetch(createdResponse);
    vi.stubGlobal('fetch', fn);
    renderWelcome();

    const medium = screen.getByRole('button', { name: /适中/ });
    expect(medium.getAttribute('aria-pressed')).toBe('true');

    const highSchool = screen.getByRole('button', { name: '高中' });
    expect(highSchool.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(highSchool);
    expect(highSchool.getAttribute('aria-pressed')).toBe('true');

    const light = screen.getByRole('button', { name: /轻.*10 分钟/ });
    await userEvent.click(light);
    expect(light.getAttribute('aria-pressed')).toBe('true');
    expect(medium.getAttribute('aria-pressed')).toBe('false');
  });
});
