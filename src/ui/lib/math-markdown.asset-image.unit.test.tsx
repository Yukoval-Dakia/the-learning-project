// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useAssetUrl } = vi.hoisted(() => ({ useAssetUrl: vi.fn() }));
vi.mock('./assets', () => ({ useAssetUrl }));

import { MathMarkdown, assetIdFromContentUrl } from './math-markdown';

afterEach(() => {
  cleanup();
  useAssetUrl.mockReset();
});

describe('MathMarkdown protected asset images', () => {
  it('parses only the canonical asset-content route', () => {
    expect(assetIdFromContentUrl('/api/assets/asset%20one/content')).toBe('asset one');
    expect(assetIdFromContentUrl('https://example.test/image.png')).toBeNull();
    expect(assetIdFromContentUrl('/api/assets/x')).toBeNull();
  });

  it('renders the authenticated blob URL instead of issuing a raw protected img request', () => {
    useAssetUrl.mockReturnValue({ url: 'blob:loom-asset', loading: false, error: null });

    render(<MathMarkdown>{'![函数图](/api/assets/asset-42/content)'}</MathMarkdown>);

    expect(useAssetUrl).toHaveBeenCalledWith('asset-42');
    const image = screen.getByRole('img', { name: '函数图' });
    expect(image.getAttribute('src')).toBe('blob:loom-asset');
    expect(image.getAttribute('src')).not.toBe('/api/assets/asset-42/content');
  });
});
