// Direct (non-tool) memory-brief read for Copilot's own surfaces (today summary,
// demos). The read semantics — scope row + purpose-current gate + freshness —
// are owned by agency and reached through the kernel `read-models/memory-brief`
// port; this adapter only maps the result onto Copilot's output shape.

import { z } from 'zod';
import { readMemoryBrief } from '@/kernel/read-models/memory-brief';
import type { ToolContext } from '@/kernel/tools/types';

const MemoryBriefInputSchema = z.object({
  scopeKey: z.string().optional(),
  includeEvidence: z.boolean().optional(),
});

const MemoryBriefFreshnessSchema = z.object({
  state: z.enum(['fresh', 'stale', 'missing']),
  /** Age of refreshed_at; null when the row/timestamp is absent. */
  age_ms: z.number().int().nonnegative().nullable(),
  stale_after_ms: z.number().int().positive(),
});

const MemoryBriefOutputSchema = z.object({
  note: z
    .object({
      id: z.string(),
      scope_key: z.string(),
      subject_id: z.string().nullable(),
      recent_week_md: z.string(),
      recent_months_md: z.string(),
      long_term_md: z.string(),
      // Optional freshness score for long_term_md; null = unjudgeable. Advisory
      // render annotation only, not evidence-gated (a score is not provenance).
      long_term_freshness_score: z.number().nullable().optional(),
      refreshed_at: z.string().nullable(),
      source_event_id: z.string().nullable(),
      version: z.number().int(),
    })
    .nullable(),
  // Reader-side signal: a previous-night or never-built brief must not read as
  // current context.
  freshness: MemoryBriefFreshnessSchema,
  evidence: z
    .object({
      recent_week_ids: z.array(z.string()),
      recent_months_ids: z.array(z.string()),
      long_term_ids: z.array(z.string()),
    })
    .optional(),
});

type MemoryBriefInput = z.infer<typeof MemoryBriefInputSchema>;
type MemoryBriefOutput = z.infer<typeof MemoryBriefOutputSchema>;

// Exported for direct callers (e.g. the Copilot Drawer summary); no event side effects.
export async function executeMemoryBrief(
  ctx: ToolContext,
  raw: MemoryBriefInput,
  now: () => Date = () => new Date(),
): Promise<MemoryBriefOutput> {
  const input = MemoryBriefInputSchema.parse(raw);
  const scope = input.scopeKey ?? 'global';
  const read = await readMemoryBrief(ctx.db, scope === 'global' ? 'global:digest' : scope, now());
  return MemoryBriefOutputSchema.parse({
    note: read.note
      ? {
          id: read.note.id,
          scope_key: read.note.scope_key,
          subject_id: read.note.subject_id,
          recent_week_md: read.note.recent_week_md,
          recent_months_md: read.note.recent_months_md,
          long_term_md: read.note.long_term_md,
          long_term_freshness_score: read.note.long_term_freshness_score,
          refreshed_at: read.note.refreshed_at ? read.note.refreshed_at.toISOString() : null,
          source_event_id: read.note.source_event_id,
          version: read.note.version,
        }
      : null,
    freshness: read.freshness,
    ...(input.includeEvidence && read.note
      ? {
          evidence: {
            recent_week_ids: read.note.recent_week_evidence_ids,
            recent_months_ids: read.note.recent_months_evidence_ids,
            long_term_ids: read.note.long_term_evidence_ids,
          },
        }
      : {}),
  });
}
