// Station 2A (YUK-185, T-37) — the brief generate-writer.
//
// Implements the `GenerateBrief` terminal that the P5.2 regen pipeline
// (`regenerateMemoryBrief`, brief.ts:240) has always taken as an injected dep
// but never had wired (handlers.ts called `registerMemoryHandlers` with no
// deps → the throwing `defaultGenerateBrief`). This is a single
// structured-output AI call, the same archetype as GoalScopeTask
// (`goals/scope.ts`): build input → runTask('MemoryBriefTask', …) → brace-slice
// + Zod-parse → defensive id-subset filter. No tool loop, no proposal write.
//
// Reuse-first (CLAUDE.md anti-over-engineering): the LLM loop, logging, and cost
// ledger all live inside `runTask`; this file never hand-rolls them. The writer
// stays LOUD on failure (re-throws); the graceful "log + leave old brief" posture
// is delivered one layer up by the per-scope try/catch in the regen-handler loop
// (triggers.ts, F-1 / D8).

import { z } from 'zod';

import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { KNOWLEDGE_EXCERPT_MAX } from '@/server/ai/tools/budgets'; // I-3 — payload excerpt cap
import type { BriefDraft, BriefEvent, BriefFact, GenerateBrief } from './brief';

// ── Writer output schema = BriefDraft (brief.ts:37-44). ──
// 1B/I-4: named `BriefDraftOutputSchema` (NOT `MemoryBriefOutputSchema`) — the
// latter is ALREADY taken by the read-side {note, evidence} schema in
// context-readers.ts:1051. Two same-named, structurally-different symbols would
// be a footgun; this writer-side shape is the 6-field BriefDraft. All fields are
// defaulted so a partial model response parses rather than throws (the host
// tolerates empty windows).
export const BriefDraftOutputSchema = z.object({
  recent_week_md: z.string().default(''),
  recent_months_md: z.string().default(''),
  long_term_md: z.string().default(''),
  // 1A/2A: `.min(1)` on each id element is intentional tightening — it rejects
  // empty-string ids at parse time. The D3 subset filter would drop them anyway
  // (an empty id is never in the input-id Set), so this is belt-and-suspenders.
  recent_week_evidence_ids: z.array(z.string().min(1)).default([]),
  recent_months_evidence_ids: z.array(z.string().min(1)).default([]),
  long_term_evidence_ids: z.array(z.string().min(1)).default([]),
});
export type BriefDraftOutput = z.infer<typeof BriefDraftOutputSchema>;

// Brace-slice + Zod-parse — mirror parseGoalScopeOutput (scope.ts:125-139). The
// slice tolerates a ```json fence (the indexOf('{')..lastIndexOf('}') window
// skips the fence markers).
export function parseBriefDraftOutput(text: string): BriefDraftOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseBriefDraftOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseBriefDraftOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return BriefDraftOutputSchema.parse(json);
}

const EMPTY_DRAFT: BriefDraft = {
  recent_week_md: '',
  recent_months_md: '',
  long_term_md: '',
  recent_week_evidence_ids: [],
  recent_months_evidence_ids: [],
  long_term_evidence_ids: [],
};

// I-3: project each event's unbounded jsonb `payload` down to the handful of
// fields a glanceable brief needs, truncating any free text to the existing
// excerpt cap (KNOWLEDGE_EXCERPT_MAX = 180, budgets.ts). 50 events x raw payload
// (full prompt/answer/judge-reasoning blobs) would blow the input token count +
// the 60s timeout for zero brief benefit. Keep ONLY outcome + one short text
// excerpt; never serialize the raw blob.
function projectEventPayload(payload: unknown): { outcome?: string; excerpt?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const p = payload as Record<string, unknown>;
  const out: { outcome?: string; excerpt?: string } = {};
  if (typeof p.outcome === 'string') out.outcome = p.outcome;
  // Pick the most brief-useful text field present, truncate hard.
  const text =
    (typeof p.summary === 'string' && p.summary) ||
    (typeof p.text_md === 'string' && p.text_md) ||
    (typeof p.answer_md === 'string' && p.answer_md) ||
    (typeof p.prompt_md === 'string' && p.prompt_md) ||
    '';
  if (text) out.excerpt = text.slice(0, KNOWLEDGE_EXCERPT_MAX);
  return out;
}

// The injectable orchestrator: now+events+facts+template+scopeKey -> BriefDraft.
// Mirrors runGoalScopeAndWrite's shape (scope.ts) minus the proposal write.
export async function runBriefWriter(params: {
  runTaskFn: TaskTextRunFn;
  scopeKey: string;
  template: string;
  events: BriefEvent[];
  facts: BriefFact[];
  now: string; // 3A: real-clock ISO anchor for the 7d/3mo/long_term buckets
  // db/env passthrough handed to runTaskFn; the third arg of TaskTextRunFn is
  // `unknown`, so we keep this loose (no exported TaskRunCtx to lean on).
  ctx?: { db?: Db; env?: unknown };
}): Promise<BriefDraft> {
  const { runTaskFn, scopeKey, template, events, facts, now } = params;

  // 4A: cold-scope short-circuit. A 0-event scope (e.g. the first `global`
  // regen on a fresh DB) has nothing to summarize — return an all-empty draft
  // WITHOUT paying for an LLM round-trip. regenerateMemoryBrief still writes the
  // row deterministically (empty windows, null freshness score). Saves the
  // wasted paid call on every cold scope.
  if (events.length === 0) return { ...EMPTY_DRAFT };

  // Project the input down to what the writer needs:
  //  - 3A: `now` (real-clock ISO) so the model anchors the age windows on the
  //    true clock, NOT the newest-event position. On a dormant scope (newest
  //    event months old) a newest-event anchor would collapse everything into
  //    recent_week and the prose would say "current" while the host freshness
  //    score (which uses the REAL now at brief.ts:252,273-277) reads "stale" —
  //    prose/score divergence. Anchoring on the real `now` keeps buckets correct.
  //  - I-3: each `payload` truncated/projected (no raw jsonb blob bloat).
  const input = {
    scope_key: scopeKey,
    now, // 3A — bucket anchor
    template,
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      subject_kind: e.subject_kind,
      subject_id: e.subject_id,
      created_at: e.created_at.toISOString(),
      payload: projectEventPayload(e.payload), // I-3 — capped projection, not raw blob
    })),
    facts: facts.map((f) => ({ id: f.id, memory: f.memory })),
  };

  const result = await runTaskFn('MemoryBriefTask', input, params.ctx ?? {});
  const parsed = parseBriefDraftOutput(result.text);

  // D3 defensive filter — keep only ids that exist in the input events
  // (mirror scope.ts:90-92). Guarantees stored evidence arrays are a true
  // subset; P5.3 scoring then resolves every id in-memory (brief.ts:213-214).
  const validIds = new Set(events.map((e) => e.id));
  const keep = (ids: string[]) => ids.filter((id) => validIds.has(id));

  return {
    recent_week_md: parsed.recent_week_md,
    recent_months_md: parsed.recent_months_md,
    long_term_md: parsed.long_term_md,
    recent_week_evidence_ids: keep(parsed.recent_week_evidence_ids),
    recent_months_evidence_ids: keep(parsed.recent_months_evidence_ids),
    long_term_evidence_ids: keep(parsed.long_term_evidence_ids),
  };
}

// Prod factory: builds the GenerateBrief closure injected at handlers.ts:50.
// Lazy-imports the real runTask (Pattern B) so tests never reach the SDK.
//
// 3A note: GenerateBrief's signature (brief.ts:46-51) carries NO `now`, and
// regenerateMemoryBrief computes its own `now` at brief.ts:252 but does not
// forward it to `generate`. Rather than change the GenerateBrief contract, the
// orchestrator stamps `new Date().toISOString()` into the WRITER INPUT here —
// additive to the projection runBriefWriter builds. (If a future change threads
// the host `now` through GenerateBrief, prefer that; for this station the
// fresh-clock stamp is within milliseconds of brief.ts:252 and is sufficient.)
export function buildBriefGenerator(deps: { db: Db; runTaskFn?: TaskTextRunFn }): GenerateBrief {
  const runTaskFn: TaskTextRunFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async ({ scopeKey, template, events, facts }) =>
    runBriefWriter({
      runTaskFn,
      scopeKey,
      template,
      events,
      facts,
      now: new Date().toISOString(), // 3A — real-clock bucket anchor
      ctx: { db: deps.db },
    });
}

// Pattern B (mirror knowledge_propose_nightly.ts:104-112): lazy-import the real
// runner so tests that inject a stub never pull the AI SDK / ANTHROPIC_API_KEY.
async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): ReturnType<TaskTextRunFn> {
  const { runTask } = await import('@/server/ai/runner');
  return runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
}
