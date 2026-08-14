import {
  type VisionBlock,
  type VisionOutput,
  parseVisionOutput,
} from '@/capabilities/ingestion/tasks/vision';

export { parseVisionOutput, type VisionBlock, type VisionOutput };

export interface RunVisionExtractParams {
  assetId: string;
  mimeType: string;
  imageBytes: ArrayBuffer;
  pageIndex: number;
  runTaskFn: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
}

export interface ExtractedForAsset {
  asset_id: string;
  blocks: Array<VisionBlock & { _input_page_index: number }>;
}

export async function runVisionExtract(params: RunVisionExtractParams): Promise<ExtractedForAsset> {
  const result = await params.runTaskFn(
    'VisionExtractTask',
    {
      text: `Extract question blocks from page_index=${params.pageIndex}. Return strict JSON only.`,
      images: [{ data: params.imageBytes, mediaType: params.mimeType }],
    },
    {},
  );
  const parsed = parseVisionOutput(result.text);
  return {
    asset_id: params.assetId,
    blocks: parsed.blocks.map((b) => ({
      ...b,
      page_index: params.pageIndex,
      _input_page_index: params.pageIndex,
    })),
  };
}
