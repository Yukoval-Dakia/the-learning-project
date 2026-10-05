// @vitest-environment jsdom
// YUK-1094 — 错题录入的附件上传与提交竞态：pickAttachment 是异步的，上传未落定就点「提交错题」
// 会让 POST /api/mistakes 带着旧（空）evidence 发出，刚选的图静默丢掉。本测试钉住：
//   1) 上传在途时提交入口 disable（在途计数 > 0）；
//   2) 上传 settle 后恢复可提交；
//   3) 提交取到含刚上传 asset 的**最新** evidence（prompt_image_refs）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RecordPage from './RecordPage';

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  uploadAsset: vi.fn(),
}));

vi.mock('@/ui/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/ui/lib/api')>();
  return { ...actual, apiJson: mocks.apiJson };
});

vi.mock('@/ui/lib/assets', async (importActual) => {
  const actual = await importActual<typeof import('@/ui/lib/assets')>();
  return { ...actual, uploadAsset: mocks.uploadAsset };
});

function renderRecordPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordPage navigate={vi.fn()} getQuery={() => null} setQuery={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/knowledge')) {
      return { rows: [{ id: 'kn_1', name: '导数', effective_domain: 'math' }] };
    }
    if (url.startsWith('/api/ingestion')) return { rows: [] };
    if (url === '/api/mistakes') {
      return { question_id: 'q1', mistake_id: 'm1', record_id: 'r1' };
    }
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RecordPage 附件上传 gating (YUK-1094)', () => {
  it('disables 提交错题 while an upload is in flight, then posts the fresh evidence ref', async () => {
    let settleUpload!: (asset: { id: string; mime_type: string }) => void;
    mocks.uploadAsset.mockImplementation(
      () =>
        new Promise<{ id: string; mime_type: string }>((resolve) => {
          settleUpload = resolve;
        }),
    );
    const user = userEvent.setup();
    const { container } = renderRecordPage();

    await user.type(screen.getByLabelText('题面（必填）'), '求 f(x)=x^2 的导数');
    await user.type(screen.getByLabelText('错答（必填）'), 'x');
    await user.click(await screen.findByRole('button', { name: '导数' }));
    // 表单已可提交（三个必填项齐备），先坐实基线。
    expect((screen.getByRole('button', { name: '提交错题' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    // 打开题面附件选择器（设置 attachTarget），再走隐藏 input。
    await user.click(screen.getByRole('button', { name: '给题面附图' }));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['bytes'], 'work.png', { type: 'image/png' }));

    // 上传在途 → 禁用，避免带着旧 evidence 提交。
    expect((screen.getByRole('button', { name: '提交错题' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      settleUpload({ id: 'asset_1', mime_type: 'image/png' });
    });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '提交错题' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    await user.click(screen.getByRole('button', { name: '提交错题' }));
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith(
        '/api/mistakes',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = mocks.apiJson.mock.calls.find((c) => c[0] === '/api/mistakes');
    if (!call) throw new Error('missing /api/mistakes call');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.prompt_image_refs).toEqual(['asset_1']);
  });
});
