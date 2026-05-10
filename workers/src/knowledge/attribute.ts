import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { CauseCategory } from '../../../src/core/schema/business';

const AttributionOutputSchema = z.object({
  primary_category: CauseCategory,
  secondary_categories: z.array(CauseCategory).default([]),
  ai_analysis_md: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});

export type AttributionOutput = z.infer<typeof AttributionOutputSchema>;

export function parseAttributionOutput(text: string): AttributionOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseAttributionOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseAttributionOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return AttributionOutputSchema.parse(json);
}

export interface AttributionInput {
  prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string;
  knowledge_context: Array<{ id: string; name: string; effective_domain: string | null }>;
}

export interface RunAttributionAndWriteParams {
  db: D1Database;
  mistakeId: string;
  expectedVersion: number;
  input: AttributionInput;
  runTaskFn: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  env?: unknown;
}

export async function runAttributionAndWrite(params: RunAttributionAndWriteParams): Promise<void> {
  try {
    const result = await params.runTaskFn('AttributionTask', params.input, { env: params.env });
    const parsed = parseAttributionOutput(result.text);
    const causeJson = JSON.stringify({
      primary_category: parsed.primary_category,
      secondary_categories: parsed.secondary_categories,
      ai_analysis_md: parsed.ai_analysis_md,
      confidence: parsed.confidence,
      user_edited: false,
    });
    const now = Math.floor(Date.now() / 1000);
    const update = await params.db
      .prepare(
        `update mistake set cause = ?, updated_at = ?, version = version + 1
         where id = ? and version = ? and cause is null`,
      )
      .bind(causeJson, now, params.mistakeId, params.expectedVersion)
      .run();
    const changes = (update as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (changes !== 1) {
      console.warn(
        `runAttributionAndWrite: skipped (cause already set or version mismatch) for ${params.mistakeId}`,
      );
    }
  } catch (err) {
    console.error('runAttributionAndWrite: failed', err);
  }
}
