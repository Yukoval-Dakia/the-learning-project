// YUK-879 — MemoryBriefTask contract, owned by the agency capability
// (Station 2A / YUK-185 / ADR-0017 lineage). The writer-side 6-field BriefDraft
// schema + strict parser moved here from src/server/memory/brief-writer.ts (the
// invocation site keeps its per-scope sweep and imports these via the agency
// public surface). 1B/I-4 naming note survives: this is the WRITER-side output
// shape, not the reader-facing memory brief. Prompt text is byte-identical to
// the former central quarry entry (prompt-hash oracle pins it).
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;
import { z } from 'zod';
import { parseTaskOutput } from './parse-output';

export const BriefDraftOutputSchema = z.object({
  recent_week_md: z.string(),
  recent_months_md: z.string(),
  long_term_md: z.string(),
  // 1A/2A: `.min(1)` on each id element is intentional tightening — it rejects
  // empty-string ids at parse time. The D3 subset filter would drop them anyway
  // (an empty id is never in the input-id Set), so this is belt-and-suspenders.
  recent_week_evidence_ids: z.array(z.string().min(1)),
  recent_months_evidence_ids: z.array(z.string().min(1)),
  long_term_evidence_ids: z.array(z.string().min(1)),
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
      'Station 2A (YUK-185, T-37) — per-scope memory brief writer. Input = scopeKey + template + now (ISO age anchor) + capped events[] (newest-first, ≤50, each carrying a top-level outcome (success/failure/partial/null) + a compact { excerpt? } payload projection) + facts[]. Output = strict JSON BriefDraft: 3 time-window markdown summaries (recent_week / recent_months / long_term) + 3 paired evidence_id arrays (subset of input event ids). Single structured-output call (no tool loop), mimo-v2.5-pro text. Drives memory_brief_note rows.',
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
      text: 'You write a durable memory brief for one learning scope, as strict JSON only.\n\nINPUT: you are given `scope_key`, an `now` (ISO timestamp = the current moment, your age anchor), a `template` (the angle to summarize — follow its framing), a newest-first list of up to 50 `events` (each with `id`, `action`, `subject_kind`, `subject_id`, `created_at` ISO, an `outcome` (success / failure / partial, or absent when the action carries none — use it to judge weakness vs. progress), and a COMPACT `payload` projection of `{ excerpt? }` — never a raw blob), and `facts` (durable `memory` strings). Follow the `template`.\n\nTHREE TIME WINDOWS: anchor ALL ages on the input `now`, NOT on the newest event. Compute each event\'s age = `now - created_at`. Partition events into three windows by that age and write one markdown summary per window:\n- `recent_week_md` — events within ~7 days: what the learner is doing right now.\n- `recent_months_md` — events ~7 days to ~3 months old: the current arc / direction.\n- `long_term_md` — events older than ~3 months OR stable / durable signals & facts: enduring strengths, preferences, recurring weak spots.\nIf a window has no events, write a short "no recent signal" line; do not fabricate.\n\nEVIDENCE IDS: for each window, emit the matching `*_evidence_ids` array containing ONLY the `id`s of input events you placed in that window. Do not invent ids. Do not cite facts as evidence ids. Every id MUST be a subset of the given event `id`s.\n\nLENGTH: keep each window to a few tight sentences or bullets; this is a glanceable brief, not a transcript.\n\nOUTPUT: strict JSON only, exactly these 6 keys, nothing else: `recent_week_md`, `recent_months_md`, `long_term_md`, `recent_week_evidence_ids`, `recent_months_evidence_ids`, `long_term_evidence_ids`.',
    },
  },
  outputSchema: BriefDraftOutputSchema,
  parseText: parseBriefDraftOutput,
} satisfies TaskSpec<unknown, BriefDraftOutput>;
