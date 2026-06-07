import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api layer BEFORE importing the module under test so apiFetch is a
// pure stub — no real fetch / token / network. Unit partition. vi.hoisted lets
// the mock factory (which is hoisted above the imports) reference apiFetch.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', () => ({ apiFetch }));

import { expandPdf, uploadAsset } from './assets';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('uploadAsset', () => {
  it('unwraps the route { asset: row } envelope so .id is defined (YUK-250 regression)', async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        asset: {
          id: 'asset_abc',
          storage_key: 'assets/deadbeef',
          mime_type: 'image/png',
          byte_size: 123,
          sha256: 'f'.repeat(64),
        },
      }),
    );

    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
    const result = await uploadAsset(file);

    expect(result.id).toBe('asset_abc');
    expect(result.id).toBeDefined();
    expect(result.mime_type).toBe('image/png');
    // Posted to /api/assets as multipart.
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/assets',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('expandPdf', () => {
  it('returns the flat { asset_ids, page_count } body (NOT wrapped in {asset})', async () => {
    apiFetch.mockResolvedValue(jsonResponse({ asset_ids: ['a1', 'a2', 'a3'], page_count: 3 }));

    const file = new File([new Uint8Array([1])], 'doc.pdf', { type: 'application/pdf' });
    const result = await expandPdf(file);

    expect(result.asset_ids).toEqual(['a1', 'a2', 'a3']);
    expect(result.page_count).toBe(3);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/ingestion/pdf',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
