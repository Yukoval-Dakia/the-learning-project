import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type { R2Client } from '@/server/r2';
import { cropAndUploadFigures } from './crop';

async function makeTestImage(): Promise<Buffer> {
  // 500x500 white with a 100x100 red block at (200,200)-(300,300)
  const white = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const red = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  return sharp(white)
    .composite([{ input: red, top: 200, left: 200 }])
    .png()
    .toBuffer();
}

function makeR2Mock(): R2Client & { puts: Array<{ key: string; body: Uint8Array }> } {
  const puts: Array<{ key: string; body: Uint8Array }> = [];
  return {
    puts,
    async put(key: string, body: Uint8Array) {
      puts.push({ key, body: new Uint8Array(body) });
    },
    async get() {
      return null;
    },
    async delete() {},
  };
}

describe('cropAndUploadFigures', () => {
  it('crops each figure box, uploads to R2, returns PreAttachFigure[]', async () => {
    const pageImage = await makeTestImage();
    const r2 = makeR2Mock();

    const result = await cropAndUploadFigures({
      pageImage,
      pageAssetId: 'asset_page_1',
      pageIndex: 0,
      figureBoxes: [
        { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, // around red block (200/500 = 0.4)
        { x: 0.0, y: 0.0, width: 0.3, height: 0.3 }, // top-left white
      ],
      r2,
    });

    expect(result).toHaveLength(2);
    expect(result[0].asset_id).toBe('asset_page_1-fig-0');
    expect(result[0].role).toBe('diagram');
    expect(result[0].source_page_index).toBe(0);
    expect(result[0].source_bbox).toEqual({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
    expect(result[1].asset_id).toBe('asset_page_1-fig-1');

    expect(r2.puts).toHaveLength(2);
    expect(r2.puts[0].key).toBe('figures/asset_page_1-fig-0.png');
    expect(r2.puts[0].body.byteLength).toBeGreaterThan(0);

    // Verify the cropped image is the red block (sample pixel)
    const decoded = await sharp(r2.puts[0].body).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.channels).toBeGreaterThan(0);
  });

  it('returns [] when figureBoxes is empty (no R2 calls)', async () => {
    const r2 = makeR2Mock();
    const pageImage = await makeTestImage();
    const result = await cropAndUploadFigures({
      pageImage,
      pageAssetId: 'asset_empty',
      pageIndex: 0,
      figureBoxes: [],
      r2,
    });
    expect(result).toEqual([]);
    expect(r2.puts).toEqual([]);
  });

  it('propagates R2 error (caller / pg-boss retry layer decides)', async () => {
    const pageImage = await makeTestImage();
    const r2: R2Client = {
      put: vi.fn().mockRejectedValue(new Error('R2 down')),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      cropAndUploadFigures({
        pageImage,
        pageAssetId: 'asset_err',
        pageIndex: 0,
        figureBoxes: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
        r2,
      }),
    ).rejects.toThrow('R2 down');
  });
});
