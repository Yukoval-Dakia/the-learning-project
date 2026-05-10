import { z } from 'zod';
import { BBox } from '../../../src/core/schema';
import { QuestionBlockRole, VisualComplexity } from '../../../src/core/schema/business';

const VisionBlockSchema = z.object({
  extracted_prompt_md: z.string().min(1).max(5000),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().nullable(),
  page_index: z.number().int().min(0),
  bbox: BBox,
  role: QuestionBlockRole,
  visual_complexity: VisualComplexity,
  extraction_confidence: z.number().min(0).max(1),
  knowledge_hint: z.string().nullable(),
});

const VisionOutputSchema = z.object({
  blocks: z.array(VisionBlockSchema).min(1).max(20),
});

export type VisionOutput = z.infer<typeof VisionOutputSchema>;
export type VisionBlock = z.infer<typeof VisionBlockSchema>;

export function parseVisionOutput(text: string): VisionOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start)
    throw new Error('parseVisionOutput: no JSON object found');
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseVisionOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return VisionOutputSchema.parse(json);
}

export interface RunVisionExtractParams {
  assetId: string;
  mimeType: string;
  imageBytes: ArrayBuffer;
  pageIndex: number;
  runTaskFn: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  env: unknown;
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
    { env: params.env },
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
