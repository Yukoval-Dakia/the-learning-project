// YUK-102 / Foundation D M2 — moved to Copilot by YUK-892 (F4.0).
//
// Read tool for the Dreaming-maintained memory brief (global or subject
// scope). Copilot owns the memory-brief reader; the brief row itself is
// written by the Dreaming nightly job.

import { memory_brief_note } from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

const MemoryBriefInputSchema = z.object({
  scopeKey: z.string().optional(),
  includeEvidence: z.boolean().optional(),
});

export const MEMORY_BRIEF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const MemoryBriefFreshnessSchema = z.object({
  state: z.enum(['fresh', 'stale', 'missing']),
  /** Age of refreshed_at at read time; null when the row/timestamp is absent. */
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
      // P5.3 (YUK-183) — additive-optional evidence-decay freshness score for
      // long_term_md. null = unjudgeable. Advisory render-annotation signal only;
      // not evidence-gated (a scalar score is not provenance). Spec §7.2.
      long_term_freshness_score: z.number().nullable().optional(),
      refreshed_at: z.string().nullable(),
      source_event_id: z.string().nullable(),
      version: z.number().int(),
    })
    .nullable(),
  // YUK-378 — explicit reader-side signal. Dreaming/Coach must not silently
  // treat a previous-night or never-built brief as current context.
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

// Exported alongside the tool so the Copilot Drawer summary
// (Wave 5 / T-D3/B) can read the memory_brief_note row directly without
// mirroring the SQL or going through the MCP bridge. No event side effects.
export async function executeMemoryBrief(
  ctx: ToolContext,
  raw: MemoryBriefInput,
  now: () => Date = () => new Date(),
): Promise<MemoryBriefOutput> {
  const input = MemoryBriefInputSchema.parse(raw);
  const scopeKey = input.scopeKey ?? 'global';
  const [note] = await ctx.db
    .select()
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, scopeKey))
    .limit(1);
  if (!note) {
    return MemoryBriefOutputSchema.parse({
      note: null,
      freshness: {
        state: 'missing',
        age_ms: null,
        stale_after_ms: MEMORY_BRIEF_STALE_AFTER_MS,
      },
    });
  }
  const ageMs = note.refreshed_at
    ? Math.max(0, now().getTime() - note.refreshed_at.getTime())
    : null;
  return MemoryBriefOutputSchema.parse({
    note: {
      id: note.id,
      scope_key: note.scope_key,
      subject_id: note.subject_id ?? null,
      recent_week_md: note.recent_week_md,
      recent_months_md: note.recent_months_md,
      long_term_md: note.long_term_md,
      long_term_freshness_score: note.long_term_freshness_score ?? null, // P5.3 (§7.2)
      refreshed_at: iso(note.refreshed_at),
      source_event_id: note.source_event_id ?? null,
      version: note.version,
    },
    freshness: {
      state:
        ageMs === null || ageMs >= MEMORY_BRIEF_STALE_AFTER_MS
          ? ('stale' as const)
          : ('fresh' as const),
      age_ms: ageMs,
      stale_after_ms: MEMORY_BRIEF_STALE_AFTER_MS,
    },
    ...(input.includeEvidence
      ? {
          evidence: {
            recent_week_ids: note.recent_week_evidence_ids ?? [],
            recent_months_ids: note.recent_months_evidence_ids ?? [],
            long_term_ids: note.long_term_evidence_ids ?? [],
          },
        }
      : {}),
  });
}

export const queryMemoryBriefTool: DomainTool<MemoryBriefInput, MemoryBriefOutput> = {
  name: 'query_memory_brief',
  description:
    'Read the Dreaming-maintained memory brief for global or subject scope. Treat freshness=stale/missing as low-confidence context and verify against source tools; optional evidence ids are available.',
  effect: 'read',
  inputSchema: MemoryBriefInputSchema,
  outputSchema: MemoryBriefOutputSchema,
  costClass: 'local',
  execute: executeMemoryBrief,
  summarize(input, output) {
    return output.note
      ? `memory brief · ${input.scopeKey ?? 'global'} · v${output.note.version} · ${output.freshness.state}`
      : `memory brief · ${input.scopeKey ?? 'global'} · ${output.freshness.state}`;
  },
  mirrorEvent: 'when_user_visible',
};
