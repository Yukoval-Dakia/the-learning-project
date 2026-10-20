import { allowsDerivation } from '@/core/schema/derivation-policy';
// Station 2A (YUK-185, T-37) — the brief generate-writer.
//
// Implements the `GenerateBrief` terminal that the P5.2 regen pipeline
// (`regenerateMemoryBrief`, brief.ts:240) has always taken as an injected dep
// but never had wired (handlers.ts called `registerMemoryHandlers` with no
// deps → the throwing `defaultGenerateBrief`). This is a single
// structured-output AI call, the same archetype as GoalScopeTask
// (`goals/scope.ts`): server-bucket events → runTask('MemoryBriefTask', …) →
// brace-slice + Zod-parse → assemble evidence ids from the same buckets. No
// tool loop, no proposal write.
//
// Reuse-first: the LLM loop, logging, and cost
// ledger all live inside `runTask`; this file never hand-rolls them. The writer
// stays LOUD on failure (re-throws); the graceful "log + leave old brief" posture
// is delivered one layer up by the per-scope try/catch in the regen-handler loop
// (triggers.ts, F-1 / D8).

// YUK-879 — the MemoryBriefTask writer-side output contract moved to the agency
// TaskSpec module; consume it through the agency public entrypoint.
import { BriefDraftOutputSchema, parseBriefDraftOutput } from '@/capabilities/agency/public';

export { BriefDraftOutputSchema, parseBriefDraftOutput };

import type { Db } from '@/db/client';
import { KNOWLEDGE_EXCERPT_MAX } from '@/kernel/tools/budgets'; // I-3 — payload excerpt cap
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import type { BriefDraft, BriefEvent, BriefFact, GenerateBrief } from './brief';

// ── Writer output schema = BriefDraft prose (brief.ts:60-67). ──
// 1B/I-4: named `BriefDraftOutputSchema` (NOT `MemoryBriefOutputSchema`) — the
// latter is ALREADY taken by the read-side {note, evidence} schema in
// context-readers.ts:1051. Two same-named, structurally-different symbols would
// be a footgun; this writer-side shape is the 3 prose fields. The three
// evidence-id arrays are server-owned and never parsed from model output.
//
// PR #232 review (FIX #3) — all 3 keys are REQUIRED (no `.default(...)`). A
// transient structured-output degradation that DROPS a section must FAIL parse
// (throw in parseBriefDraftOutput → propagate → caught by the F-1 per-scope
// try/catch in triggers.ts → prior brief left intact) rather than silently parse
// into an all-empty draft and let regenerateMemoryBrief upsert ''/[] over a good
// prior brief. The md fields stay `z.string()` so an EMPTY-STRING VALUE is still
// allowed (a present-but-empty window is legitimate); only a MISSING KEY throws.
// The cold-scope early-return builds its empty draft directly and never goes
// through this parser, so it is unaffected.
// PR #232 review (FIX #5) — a FRESH empty draft per call. A shared module-level
// singleton would hand every cold-scope caller the SAME `[]` array instances;
// any downstream in-place mutation of an evidence array would then pollute every
// other brief. This factory guarantees each cold-scope return owns its own
// arrays. (Cheap — cold scopes do not pay an LLM round-trip anyway.)
function makeEmptyDraft(): BriefDraft {
  return {
    recent_week_md: '',
    recent_months_md: '',
    long_term_md: '',
    recent_week_evidence_ids: [],
    recent_months_evidence_ids: [],
    long_term_evidence_ids: [],
  };
}

// I-3: project each event's unbounded jsonb `payload` down to the handful of
// fields a glanceable brief needs, truncating any free text to the existing
// excerpt cap (KNOWLEDGE_EXCERPT_MAX = 180, budgets.ts). 50 events x raw payload
// (full prompt/answer/judge-reasoning blobs) would blow the input token count +
// the 60s timeout for zero brief benefit. Keep ONLY outcome + one short text
// excerpt; never serialize the raw blob.
function projectEventPayload(payload: unknown): { excerpt?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const p = payload as Record<string, unknown>;
  const out: { excerpt?: string } = {};
  // PR #232 review (FIX #1) — `outcome` is NO LONGER read from the payload: it is
  // a top-level event column threaded through BriefEvent and projected directly
  // by runBriefWriter. This projector only extracts the one short text excerpt.
  //
  // PR #232 review (FIX #2) — `review` events hold their text in
  // `payload.user_response_md` and `experimental:record_capture` in
  // `payload.summary_md` (notes use `content_md`). Without these in the
  // priority list, review replies + record captures were projected as EMPTY
  // payloads and the writer never saw their content. Pick the most brief-useful
  // text field present, truncate hard.
  const text =
    (typeof p.summary === 'string' && p.summary) ||
    (typeof p.summary_md === 'string' && p.summary_md) ||
    (typeof p.text_md === 'string' && p.text_md) ||
    (typeof p.answer_md === 'string' && p.answer_md) ||
    (typeof p.user_response_md === 'string' && p.user_response_md) ||
    (typeof p.content_md === 'string' && p.content_md) ||
    (typeof p.prompt_md === 'string' && p.prompt_md) ||
    '';
  if (text) out.excerpt = text.slice(0, KNOWLEDGE_EXCERPT_MAX);
  return out;
}

const RECENT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

type BriefWindowKey = 'recent_week' | 'recent_months' | 'long_term';

// Fixed 90-day month window keeps replay deterministic across time zones and
// calendar months. Future timestamps (clock skew) stay in the week window.
function bucketEventsByAge(events: BriefEvent[], now: Date): Record<BriefWindowKey, BriefEvent[]> {
  const buckets: Record<BriefWindowKey, BriefEvent[]> = {
    recent_week: [],
    recent_months: [],
    long_term: [],
  };
  for (const event of events) {
    const age = now.getTime() - event.created_at.getTime();
    if (age <= RECENT_WEEK_MS) buckets.recent_week.push(event);
    else if (age <= RECENT_MONTHS_MS) buckets.recent_months.push(event);
    else buckets.long_term.push(event);
  }
  return buckets;
}

function projectEvent(event: BriefEvent) {
  return {
    action: event.action,
    subject_kind: event.subject_kind,
    subject_id: event.subject_id,
    outcome: event.outcome ?? undefined,
    payload: projectEventPayload(event.payload),
  };
}

// The injectable orchestrator: now+events+facts+template+scopeKey -> BriefDraft.
// Mirrors runGoalScopeAndWrite's shape (scope.ts) minus the proposal write.
export async function runBriefWriter(params: {
  runTaskFn: TaskTextRunFn;
  scopeKey: string;
  template: string;
  events: BriefEvent[];
  facts: BriefFact[];
  now: string; // real-clock ISO anchor for the server-owned 7d/90d buckets
  ctx?: import('@/server/ai/runner-fn').RunTaskCallCtx;
}): Promise<BriefDraft> {
  const { runTaskFn, scopeKey, template, facts, now } = params;
  const events = params.events.filter((event) => allowsDerivation(event.payload));

  // 4A: cold-scope short-circuit. A 0-event scope (e.g. the first `global`
  // regen on a fresh DB) has nothing to summarize — return an all-empty draft
  // WITHOUT paying for an LLM round-trip. regenerateMemoryBrief still writes the
  // row deterministically (empty windows, null freshness score). Saves the
  // wasted paid call on every cold scope.
  if (events.length === 0) return makeEmptyDraft();

  // YUK-1621 — the host owns window boundaries and evidence ids. Anchoring on
  // the real `now` keeps prose aligned with the host freshness score on dormant
  // scopes. I-3: each `payload` is truncated/projected (no raw jsonb blob bloat).
  const buckets = bucketEventsByAge(events, new Date(now));
  const windowInput = (key: BriefWindowKey) => ({
    evidence_ids: buckets[key].map((event) => event.id),
    events: buckets[key].map(projectEvent),
  });
  const input = {
    scope_key: scopeKey,
    template,
    windows: {
      recent_week: windowInput('recent_week'),
      recent_months: windowInput('recent_months'),
      long_term: windowInput('long_term'),
    },
    facts: facts.map((f) => ({ id: f.id, memory: f.memory })),
  };

  const result = await runTaskFn('MemoryBriefTask', input, params.ctx ?? {});
  const parsed = parseBriefDraftOutput(result.text);

  return {
    recent_week_md: parsed.recent_week_md,
    recent_months_md: parsed.recent_months_md,
    long_term_md: parsed.long_term_md,
    recent_week_evidence_ids: buckets.recent_week.map((event) => event.id),
    recent_months_evidence_ids: buckets.recent_months.map((event) => event.id),
    long_term_evidence_ids: buckets.long_term.map((event) => event.id),
  };
}

// Production factory: binds the DB-backed runner once; injected test runners remain untouched.
//
// GenerateBrief's signature (brief.ts:69-74) carries NO `now`, so the factory
// stamps a real-clock ISO anchor for the server-owned bucket split. If a future
// change threads the host `now` through GenerateBrief, prefer that.
export function buildBriefGenerator(deps: { db: Db; runTaskFn?: TaskTextRunFn }): GenerateBrief {
  const runTaskFn: TaskTextRunFn = deps.runTaskFn ?? makeRunTaskFn(deps.db);
  return async ({ scopeKey, template, events, facts }) =>
    runBriefWriter({
      runTaskFn,
      scopeKey,
      template,
      events,
      facts,
      now: new Date().toISOString(), // 3A — real-clock bucket anchor
    });
}
