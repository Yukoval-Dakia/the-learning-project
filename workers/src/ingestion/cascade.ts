import { ZodError } from 'zod';
import { recognizeDocument as defaultRecognize, type TencentOCRRegion } from './ocr_tencent';
import { parseVisionOutput, type VisionBlock } from './vision';

function isEmptyBlocksError(err: unknown): boolean {
  // parseVisionOutput uses zod schema with `blocks: array(...).min(1)`.
  // When the model returns `{"blocks":[]}` we get a ZodError whose ONLY issue is
  // a too_small at path ["blocks"]. That's a successful model call with no blocks,
  // not a real failure. Anything else (path inside blocks[i], wrong types, etc.) is
  // a real malformation and should propagate as `reason` in tier_log.
  if (!(err instanceof ZodError)) return false;
  if (err.issues.length !== 1) return false;
  const [issue] = err.issues;
  return (
    issue.code === 'too_small' &&
    issue.path.length === 1 &&
    issue.path[0] === 'blocks'
  );
}

export interface NormalizedBlock {
  extracted_prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string | null;
  page_index: number;
  bbox: { x: number; y: number; width: number; height: number };
  role: 'prompt' | 'answer_area' | 'continuation';
  visual_complexity: 'low' | 'medium' | 'high';
  extraction_confidence: number;
  knowledge_hint: string | null;
}

export interface TierLogEntry {
  tier: 1 | 2 | 3 | 4;
  model: string;
  blocks_count: number;
  confidence_avg: number | null;
  took_ms: number;
  reason?: string;
}

export interface CascadeResult {
  blocks: NormalizedBlock[];
  tier_log: TierLogEntry[];
  final_status: 'extracted' | 'failed';
}

export interface CascadeDeps {
  recognizeDocument: typeof defaultRecognize;
  runTaskFn: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  imageDimensions: { width: number; height: number };
  now: () => number; // returns millis
}

export interface RunOCRCascadeArgs {
  imageBytes: ArrayBuffer;
  mimeType: string;
  pageIndex: number;
  env: {
    TENCENT_SECRET_ID: string;
    TENCENT_SECRET_KEY: string;
    TENCENT_OCR_REGION: string;
  };
  deps: CascadeDeps;
}

const TIER1_CONF_THRESHOLD = 0.6;

function regionsToBlocks(regions: TencentOCRRegion[], pageIndex: number): NormalizedBlock[] {
  return regions.map((r) => ({
    extracted_prompt_md: r.text,
    reference_md: null,
    wrong_answer_md: r.type === 'answer' ? r.text : null,
    page_index: pageIndex,
    bbox: r.bbox,
    role: r.type === 'answer' ? 'answer_area' : 'prompt',
    visual_complexity: 'medium', // Tencent doesn't expose complexity; default medium
    extraction_confidence: r.confidence,
    knowledge_hint: null,
  }));
}

function visionBlocksToNormalized(parsed: VisionBlock[], pageIndex: number): NormalizedBlock[] {
  return parsed.map((b) => ({
    extracted_prompt_md: b.extracted_prompt_md,
    reference_md: b.reference_md,
    wrong_answer_md: b.wrong_answer_md,
    page_index: pageIndex,
    bbox: b.bbox,
    role: b.role,
    visual_complexity: b.visual_complexity,
    extraction_confidence: b.extraction_confidence,
    knowledge_hint: b.knowledge_hint,
  }));
}

function averageConf(blocks: NormalizedBlock[]): number | null {
  if (blocks.length === 0) return null;
  return blocks.reduce((s, b) => s + b.extraction_confidence, 0) / blocks.length;
}

export async function runOCRCascade(args: RunOCRCascadeArgs): Promise<CascadeResult> {
  const tierLog: TierLogEntry[] = [];

  // ---------- Tier 1: Tencent ----------
  const tier1Start = args.deps.now();
  let tier1Blocks: NormalizedBlock[] = [];
  let tier1Avg: number | null = null;
  let tier1Reason: string | undefined;
  // tier1Model starts as edu paper; mutated to general_accurate inside the else
  // branch when edu returns 0 regions. If a call throws, this records whichever
  // model was last attempted (edu if edu threw; general if general threw mid-fallback).
  let tier1Model = 'tencent_edu_paper';

  try {
    const eduOut = await args.deps.recognizeDocument(
      args.imageBytes,
      args.mimeType,
      args.pageIndex,
      args.env,
      { action: 'EduPaperOCR', imageDimensions: args.deps.imageDimensions },
    );
    if (eduOut.regions.length > 0) {
      tier1Blocks = regionsToBlocks(eduOut.regions, args.pageIndex);
      tier1Avg =
        eduOut.regions.reduce((s, r) => s + r.confidence, 0) / eduOut.regions.length;
    } else {
      // Fallback within Tier 1 — try general OCR before escalating.
      tier1Model = 'tencent_general_accurate';
      const genOut = await args.deps.recognizeDocument(
        args.imageBytes,
        args.mimeType,
        args.pageIndex,
        args.env,
        { action: 'GeneralAccurateOCR', imageDimensions: args.deps.imageDimensions },
      );
      tier1Blocks = regionsToBlocks(genOut.regions, args.pageIndex);
      tier1Avg =
        genOut.regions.length > 0
          ? genOut.regions.reduce((s, r) => s + r.confidence, 0) / genOut.regions.length
          : null;
    }
  } catch (err) {
    tier1Reason = err instanceof Error ? err.message : String(err);
    tier1Blocks = [];
    tier1Avg = null;
  }

  tierLog.push({
    tier: 1,
    model: tier1Model,
    blocks_count: tier1Blocks.length,
    confidence_avg: tier1Avg,
    took_ms: args.deps.now() - tier1Start,
    reason: tier1Reason,
  });

  if (tier1Blocks.length > 0 && tier1Avg !== null && tier1Avg >= TIER1_CONF_THRESHOLD) {
    return { blocks: tier1Blocks, tier_log: tierLog, final_status: 'extracted' };
  }

  // ---------- Tier 2: haiku VisionExtractTask ----------
  const tier2Start = args.deps.now();
  let tier2Blocks: NormalizedBlock[] = [];
  let tier2Reason: string | undefined;
  try {
    const result = await args.deps.runTaskFn(
      'VisionExtractTask',
      {
        text: `Extract question blocks from page_index=${args.pageIndex}. Return strict JSON only.`,
        images: [{ data: args.imageBytes, mediaType: args.mimeType }],
      },
      { env: args.env },
    );
    const parsed = parseVisionOutput(result.text);
    tier2Blocks = visionBlocksToNormalized(parsed.blocks, args.pageIndex);
  } catch (err) {
    if (!isEmptyBlocksError(err)) {
      tier2Reason = err instanceof Error ? err.message : String(err);
    }
    tier2Blocks = [];
  }
  tierLog.push({
    tier: 2,
    model: 'claude-haiku-4-5',
    blocks_count: tier2Blocks.length,
    confidence_avg: averageConf(tier2Blocks),
    took_ms: args.deps.now() - tier2Start,
    reason: tier2Reason,
  });
  if (tier2Blocks.length > 0) {
    return { blocks: tier2Blocks, tier_log: tierLog, final_status: 'extracted' };
  }

  // ---------- Tier 3: sonnet VisionExtractTaskHeavy ----------
  const tier3Start = args.deps.now();
  let tier3Blocks: NormalizedBlock[] = [];
  let tier3Reason: string | undefined;
  try {
    const result = await args.deps.runTaskFn(
      'VisionExtractTaskHeavy',
      {
        text: `Extract question blocks from page_index=${args.pageIndex}. Return strict JSON only.`,
        images: [{ data: args.imageBytes, mediaType: args.mimeType }],
      },
      { env: args.env },
    );
    const parsed = parseVisionOutput(result.text);
    tier3Blocks = visionBlocksToNormalized(parsed.blocks, args.pageIndex);
  } catch (err) {
    if (!isEmptyBlocksError(err)) {
      tier3Reason = err instanceof Error ? err.message : String(err);
    }
    tier3Blocks = [];
  }
  tierLog.push({
    tier: 3,
    model: 'claude-sonnet-4-6',
    blocks_count: tier3Blocks.length,
    confidence_avg: averageConf(tier3Blocks),
    took_ms: args.deps.now() - tier3Start,
    reason: tier3Reason,
  });
  if (tier3Blocks.length > 0) {
    return { blocks: tier3Blocks, tier_log: tierLog, final_status: 'extracted' };
  }

  // ---------- Tier 4 stub: manual at review page ----------
  // We don't call anything — we just return failed; client falls back to "+ add empty block".
  return { blocks: [], tier_log: tierLog, final_status: 'failed' };
}
