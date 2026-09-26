// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({
  fetchAssetObject: vi.fn(),
  peekAssetObject: vi.fn(),
}));
vi.mock('@/ui/lib/assets', () => assets);

import { AssetEvidencePreview } from './AssetEvidencePreview';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AssetEvidencePreview', () => {
  it('renders a fetched image and exposes an accessible expand action', async () => {
    assets.peekAssetObject.mockReturnValue(null);
    assets.fetchAssetObject.mockResolvedValue({ url: 'blob:image', mimeType: 'image/png' });
    const onExpand = vi.fn();
    render(
      <AssetEvidencePreview assetId="asset-1" label="手写解答" variant="thumb" onExpand={onExpand} />,
    );
    screen.getByText('加载附件…');
    const zoom = await screen.findByRole('button', { name: '放大查看手写解答' });
    expect(zoom.querySelector('img')?.getAttribute('src')).toBe('blob:image');
    zoom.click();
    expect(onExpand).toHaveBeenCalledWith('asset-1');
  });

  it('degrades failed reads honestly instead of fabricating a preview', async () => {
    assets.peekAssetObject.mockReturnValue(null);
    assets.fetchAssetObject.mockRejectedValue(new Error('unauthorized'));
    render(<AssetEvidencePreview assetId="asset-2" label="材料" />);
    expect(await screen.findByText('附件加载失败')).toBeTruthy();
  });
});
