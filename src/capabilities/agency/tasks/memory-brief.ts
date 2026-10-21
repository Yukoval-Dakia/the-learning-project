// MemoryBriefTask output shape: the WRITER-side brief draft, not the
// reader-facing memory brief. Window bucketing and evidence ids are server-owned;
// the model writes prose only.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

import { z } from 'zod';
import { parseTaskOutput } from './parse-output';

export const BriefDraftOutputSchema = z.object({
  recent_week_md: z.string(),
  recent_months_md: z.string(),
  long_term_md: z.string(),
});
export type BriefDraftOutput = z.infer<typeof BriefDraftOutputSchema>;

export function parseBriefDraftOutput(text: string): BriefDraftOutput {
  return parseTaskOutput(text, 'MemoryBriefTask', BriefDraftOutputSchema);
}

export const memoryBriefTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'MemoryBriefTask',
    description:
      'Station 2A (YUK-185, T-37) — per-scope memory brief writer. Input = scopeKey + template + three server-bucketed windows (recent_week / recent_months / long_term; each with evidence_ids + newest-first capped events[], every event carrying a top-level outcome (success/failure/partial/null) + a compact { excerpt? } payload projection) + facts[]. Output = strict JSON with 3 markdown summaries. Evidence ids are assembled server-side from the same input events; the model writes prose only. Single structured-output call (no tool loop), registry-default text model. Drives memory_brief_note rows.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // Measured: a real-LLM run finished subject:yuwen at 59s and aborted the
    // global scope at the old 60s cap. Single structured-output call; the
    // per-message Copilot path does not use this task.
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 120_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // This string IS the runtime prompt. MemoryBriefTask is subject-NEUTRAL (the
    // per-scope `template` carries the angle and arrives in the INPUT), with no
    // per-profile builder.
    prompt: {
      kind: 'inline',
      text: 'You write a durable memory brief for one learning scope, as strict JSON only.\n\nINPUT: you are given `scope_key`, a `template` (the angle to summarize — follow its framing), three precomputed `windows` (`recent_week`, `recent_months`, `long_term`), and `facts` (durable `memory` strings). Each window contains `evidence_ids` and a newest-first list of `events` (each with `action`, `subject_kind`, `subject_id`, an `outcome` (success / failure / partial, or absent when the action carries none — use it to judge weakness vs. progress), and a COMPACT `payload` projection of `{ excerpt? }` — never a raw blob). The host has already partitioned every event by its age from the real clock; do NOT re-bucket events.\n\nWRITE ONE MARKDOWN SUMMARY PER WINDOW:\n- `recent_week_md` — what the learner is doing right now (use the week window).\n- `recent_months_md` — the current arc / direction (use the months window).\n- `long_term_md` — enduring strengths, preferences, recurring weak spots; durable `facts` may also inform this window.\nIf a window has no events, write a short "no recent signal" line; do not fabricate.\n\nWrite observations and concrete next prompts only. Do not restate evidence ids or raw event payloads.\n\nLENGTH: keep each window to a few tight sentences or bullets; this is a glanceable brief, not a transcript.\n\nOUTPUT: strict JSON only, exactly these 3 keys, nothing else: `recent_week_md`, `recent_months_md`, `long_term_md`.',
    },
  },
  outputSchema: BriefDraftOutputSchema,
  parseText: parseBriefDraftOutput,
} satisfies TaskSpec<unknown, BriefDraftOutput>;
