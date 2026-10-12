import { z } from 'zod';
import { BBox, FigureRef, StructuredQuestion } from './structured_question';

export const DocxSourcePackage = z.object({
  version: z.literal(1),
  input_sha256: z.string(),
  files: z.array(
    z.object({
      asset_id: z.string(),
      name: z.string(),
      role: z.enum(['original', 'converter', 'markdown', 'pdf', 'page', 'media', 'layout']),
      sha256: z.string(),
      mime: z.string(),
      format: z.string().optional(),
      page_index: z.number().int().nonnegative().optional(),
    }),
  ),
});
export type DocxSourcePackageT = z.infer<typeof DocxSourcePackage>;

export const DocxAgentQuestion = z.object({
  key: z.string().min(1).max(100),
  structured: StructuredQuestion,
  page_spans: z.array(z.object({ page_index: z.number().int().nonnegative(), bbox: BBox })).min(1),
  figures: z.array(FigureRef.omit({ last_reassigned_at: true })),
  unresolved: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
});
const Coverage = z.object({
  asset_id: z.string(),
  question_keys: z.array(z.string()),
  disposition: z.enum(['question_material', 'non_question_material', 'unresolved']),
  reason: z.string().min(1),
});
export const DocxAgentState = z.object({
  revision: z.number().int().nonnegative(),
  questions: z.array(DocxAgentQuestion),
  retired: z.array(DocxAgentQuestion),
  coverage: z.array(Coverage),
  seen_images: z.array(z.string()),
  text_ranges: z.array(z.tuple([z.number(), z.number()])),
  sealed: z.boolean(),
  task_run_id: z.string().nullable(),
  blocks: z.array(z.object({ key: z.string(), block_id: z.string(), version: z.number() })),
});
export type DocxAgentStateT = z.infer<typeof DocxAgentState>;
export const emptyDocxAgentState = (): DocxAgentStateT => ({
  revision: 0,
  questions: [],
  retired: [],
  coverage: [],
  seen_images: [],
  text_ranges: [],
  sealed: false,
  task_run_id: null,
  blocks: [],
});
export const DocxReadInput = z.object({
  action: z.enum(['list', 'text', 'image']),
  asset_id: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().min(1).max(12000).optional(),
  region: BBox.optional(),
});
export const DocxDraftInput = z.object({
  action: z.enum(['inspect', 'upsert', 'check', 'commit']),
  expected_revision: z.number().int().nonnegative().optional(),
  questions: z.array(DocxAgentQuestion).max(200).optional(),
  coverage: z.array(Coverage).optional(),
});
export const DocxToolOutput = z.record(z.string(), z.unknown());
export type DocxReadInputT = z.infer<typeof DocxReadInput>;
export type DocxDraftInputT = z.infer<typeof DocxDraftInput>;
