import { describe, expect, it, vi } from 'vitest';
import { parseVisionOutput, runVisionExtract } from './vision';

const oneBlockJson =
  '{"blocks":[{"extracted_prompt_md":"题1","reference_md":"a1","wrong_answer_md":null,"page_index":0,"bbox":{"x":0.1,"y":0.1,"width":0.5,"height":0.3},"role":"prompt","visual_complexity":"low","extraction_confidence":0.9,"knowledge_hint":"虚词"}]}';

describe('parseVisionOutput', () => {
  it('parses well-formed JSON', () => {
    const out = parseVisionOutput(oneBlockJson);
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].extracted_prompt_md).toBe('题1');
    expect(out.blocks[0].bbox.x).toBe(0.1);
  });

  it('extracts JSON from prose', () => {
    const out = parseVisionOutput(`识别如下：\n${oneBlockJson}\n以上。`);
    expect(out.blocks).toHaveLength(1);
  });

  it('throws on non-JSON', () => {
    expect(() => parseVisionOutput('not json')).toThrow();
  });

  it('throws on bbox out of [0,1]', () => {
    const text = '{"blocks":[{"extracted_prompt_md":"x","reference_md":null,"wrong_answer_md":null,"page_index":0,"bbox":{"x":1.5,"y":0,"width":1,"height":1},"role":"prompt","visual_complexity":"low","extraction_confidence":0.5,"knowledge_hint":null}]}';
    expect(() => parseVisionOutput(text)).toThrow();
  });

  it('throws on confidence > 1', () => {
    const text = '{"blocks":[{"extracted_prompt_md":"x","reference_md":null,"wrong_answer_md":null,"page_index":0,"bbox":{"x":0,"y":0,"width":1,"height":1},"role":"prompt","visual_complexity":"low","extraction_confidence":2,"knowledge_hint":null}]}';
    expect(() => parseVisionOutput(text)).toThrow();
  });

  it('throws on invalid role', () => {
    const text = '{"blocks":[{"extracted_prompt_md":"x","reference_md":null,"wrong_answer_md":null,"page_index":0,"bbox":{"x":0,"y":0,"width":1,"height":1},"role":"bogus","visual_complexity":"low","extraction_confidence":0.5,"knowledge_hint":null}]}';
    expect(() => parseVisionOutput(text)).toThrow();
  });
});

describe('runVisionExtract', () => {
  it('passes image bytes as multimodal input and overrides pageIndex', async () => {
    const runTaskFn = vi.fn(async () => ({ text: oneBlockJson }));
    const out = await runVisionExtract({
      assetId: 'asset_1',
      mimeType: 'image/png',
      imageBytes: new Uint8Array([1, 2, 3]).buffer,
      pageIndex: 3,
      env: { DB: {} } as never,
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledWith(
      'VisionExtractTask',
      expect.objectContaining({
        text: expect.stringContaining('page_index=3'),
        images: expect.arrayContaining([
          expect.objectContaining({ mediaType: 'image/png' }),
        ]),
      }),
      expect.objectContaining({ env: expect.anything() }),
    );
    expect(out.asset_id).toBe('asset_1');
    expect(out.blocks[0].page_index).toBe(3);
  });
});
