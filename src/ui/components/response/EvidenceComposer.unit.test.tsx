// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UploadedAsset } from '@/ui/lib/assets';

import { EvidenceComposer } from './EvidenceComposer';

afterEach(cleanup);

describe('EvidenceComposer', () => {
  it('preserves text and adds uploaded evidence with MIME-derived kind and group binding', async () => {
    const onTextChange = vi.fn();
    const onAttachmentsChange = vi.fn();
    const upload = vi.fn().mockResolvedValue({ id: 'asset-image', mime_type: 'image/png' });
    render(
      <EvidenceComposer
        text="原始回答"
        onTextChange={onTextChange}
        attachments={[]}
        onAttachmentsChange={onAttachmentsChange}
        upload={upload}
      />,
    );
    expect((screen.getByRole('textbox', { name: '作答' }) as HTMLTextAreaElement).value).toBe(
      '原始回答',
    );
    fireEvent.change(screen.getByLabelText('添加附件'), {
      target: { files: [new File(['image bytes'], 'worksheet.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledTimes(1));
    expect(onAttachmentsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        asset_id: 'asset-image',
        kind: 'image',
        label: 'worksheet.png',
        slot_ids: null,
      }),
    ]);
  });

  it('does not discard successful uploads when another file in the batch fails', async () => {
    const onAttachmentsChange = vi.fn();
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ id: 'good', mime_type: 'image/jpeg' })
      .mockRejectedValueOnce(new Error('upload failed'));
    render(
      <EvidenceComposer
        text=""
        onTextChange={vi.fn()}
        attachments={[]}
        onAttachmentsChange={onAttachmentsChange}
        upload={upload}
      />,
    );
    fireEvent.change(screen.getByLabelText('添加附件'), {
      target: {
        files: [
          new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
          new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('部分附件上传失败'),
    );
    expect(onAttachmentsChange).toHaveBeenCalledWith([
      expect.objectContaining({ asset_id: 'good', kind: 'image' }),
    ]);
  });

  // YUK-1094 — 上传中状态必须上报宿主：宿主拿它把提交入口并入 upload-pending，
  // 否则分片上传还没落定就能提交，刚选的附件会被静默丢掉。true 与 false 各一次，
  // 且时点在批次 settle 前后。
  it('reports upload-pending to the host around the upload batch (YUK-1094)', async () => {
    const onUploadingChange = vi.fn();
    let settle!: (asset: UploadedAsset) => void;
    const upload = vi.fn(
      () =>
        new Promise<UploadedAsset>((resolve) => {
          settle = resolve;
        }),
    );
    render(
      <EvidenceComposer
        text=""
        onTextChange={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
        upload={upload}
        onUploadingChange={onUploadingChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('添加附件'), {
      target: { files: [new File(['bytes'], 'work.png', { type: 'image/png' })] },
    });

    expect(onUploadingChange).toHaveBeenNthCalledWith(1, true);
    // The in-flight state is also visible on the add button.
    expect((screen.getByRole('button', { name: '上传中…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      settle({ id: 'asset_1', mime_type: 'image/png' } as UploadedAsset);
    });
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false));
  });
});
