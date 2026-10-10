import { createId } from '@paralleldrive/cuid2';
import {
  type VisionBlock,
  type VisionOutput,
  parseVisionOutput,
} from '@/capabilities/ingestion/tasks/vision';
import type { StructuredQuestionT } from '@/core/schema/structured_question';

export { type VisionBlock, type VisionOutput, parseVisionOutput };

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

/** The page index is assigned by runVisionExtract from the supplied image. */
export function visionBlockToStructured(b: VisionBlock): StructuredQuestionT {
  const origin = b.reference_origin ?? 'unknown';
  return {
    id: createId(),
    role: 'standalone',
    prompt_text: b.extracted_prompt_md,
    page_index: b.page_index,
    answers: origin === 'printed' && b.reference_md ? [b.reference_md] : undefined,
    source: 'vision_rescue',
    extraction_evidence: {
      reference_extraction: { origin, page_index: b.page_index },
      ...(b.wrong_answer_md
        ? {
            handwriting: [
              {
                text: b.wrong_answer_md,
                bbox: { x: 0, y: 0, width: 0, height: 0 },
              },
            ],
          }
        : {}),
    },
  };
}
