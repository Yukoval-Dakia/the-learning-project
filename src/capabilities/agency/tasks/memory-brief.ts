// YUK-879 — MemoryBriefTask contract, owned by the agency capability
// (Station 2A / YUK-185 / ADR-0017 lineage). The writer-side prose schema +
// strict parser moved here from src/server/memory/brief-writer.ts (the
// invocation site keeps its per-scope sweep and imports these via the agency
// public surface). 1B/I-4 naming note survives: this is the WRITER-side output
// shape, not the reader-facing memory brief. YUK-1621: window bucketing and
// evidence ids are server-owned; the model writes prose only.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
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
    // YUK-189: 120s (was 60s). The real-LLM demo (scripts/demo-flywheel.ts) hit
    // the 60s budget on the `global` scope (full event set on the slow mimo
    // endpoint: subject:yuwen finished 59s, global aborted at 60s). The nightly
    // brief sweep can afford the longer budget; the per-message Copilot path does
    // not call this task. maxIterations stays 1 (single structured-output call).
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 120_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // CUT: this string IS the runtime prompt. MemoryBriefTask is subject-NEUTRAL
    // (the per-scope `template` carries the angle and is passed in the INPUT, not
    // baked here), so it joins the subject-neutral pass-through `case` group in
    // getTaskSystemPrompt (task-prompts.ts) — there is NO per-profile
    // buildMemoryBriefPrompt builder. This is the SoT prompt, NOT a deprecated
    // fallback. Promote OUT of the pass-through into a profile builder only when a
    // subject demands a coaching voice (OF-2, the same path CoachTask would take).
    prompt: {
      kind: 'inline',
      text: 'You write a durable memory brief for one learning scope, as strict JSON only.\n\nINPUT: you are given `scope_key`, a `template` (the angle to summarize — follow its framing), three precomputed `windows` (`recent_week`, `recent_months`, `long_term`), and `facts` (durable `memory` strings). Each window contains `evidence_ids` and a newest-first list of `events` (each with `action`, `subject_kind`, `subject_id`, an `outcome` (success / failure / partial, or absent when the action carries none — use it to judge weakness vs. progress), and a COMPACT `payload` projection of `{ excerpt? }` — never a raw blob). The host has already partitioned every event by its age from the real clock; do NOT re-bucket events.\n\nWRITE ONE MARKDOWN SUMMARY PER WINDOW:\n- `recent_week_md` — what the learner is doing right now (use the week window).\n- `recent_months_md` — the current arc / direction (use the months window).\n- `long_term_md` — enduring strengths, preferences, recurring weak spots; durable `facts` may also inform this window.\nIf a window has no events, write a short "no recent signal" line; do not fabricate.\n\nWrite observations and concrete next prompts only. Do not restate evidence ids or raw event payloads.\n\nLENGTH: keep each window to a few tight sentences or bullets; this is a glanceable brief, not a transcript.\n\nOUTPUT: strict JSON only, exactly these 3 keys, nothing else: `recent_week_md`, `recent_months_md`, `long_term_md`.',
    },
  },
  outputSchema: BriefDraftOutputSchema,
  parseText: parseBriefDraftOutput,
} satisfies TaskSpec<unknown, BriefDraftOutput>;
