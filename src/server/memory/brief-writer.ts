import { allowsDerivation } from '@/core/schema/derivation-policy';
// The brief generate-writer. Single structured-output call: server-bucket events →
// runTask('MemoryBriefTask') → parse → assemble evidence ids from the same buckets.
// No tool loop and no proposal write. Logging, cost ledger, and the LLM loop live in
// runTask. The writer throws on failure; the regen handler owns the graceful
// per-scope skip that leaves the prior brief intact.

// The writer-side output contract is owned by the agency task spec; consume it
// through the agency public entrypoint.
import { BriefDraftOutputSchema, parseBriefDraftOutput } from '@/capabilities/agency/public';

export { BriefDraftOutputSchema, parseBriefDraftOutput };

import type { Db } from '@/db/client';
import { KNOWLEDGE_EXCERPT_MAX } from '@/kernel/tools/budgets'; // I-3 — payload excerpt cap
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import type { BriefDraft, BriefEvent, BriefFact, GenerateBrief } from './brief';

// Writer output schema: the three prose fields only. Evidence ids are server-owned
// and never parsed from model output. All keys are required: a dropped section must
// fail parse rather than overwrite a good prior brief with an empty draft. Empty
// strings stay valid because an empty window is legitimate.
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

// Project each event's unbounded payload to the fields a glanceable brief needs,
// truncating free text. 50 raw payloads would blow the input token budget and the
// timeout for no brief benefit. `outcome` is a top-level column, not read here.
function projectEventPayload(payload: unknown): { excerpt?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const p = payload as Record<string, unknown>;
  const out: { excerpt?: string } = {};
  // Event text lives in different fields by action (review replies in
  // user_response_md, captures in summary_md, notes in content_md). Without these
  // alternatives those events project as empty. Pick the most useful and truncate.
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

// Fixed windows keep replay deterministic across time zones and calendar months.
// Future timestamps (clock skew) stay in the week bucket.
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

// The injectable orchestrator: real-clock now + events + facts → BriefDraft.
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

  // Cold scope: nothing to summarize, so return an empty draft without paying for
  // an LLM call. regenerateMemoryBrief still writes the deterministic empty row.
  if (events.length === 0) return makeEmptyDraft();

  // The host owns window boundaries and evidence ids. Anchor on the real now so
  // prose aligns with the host freshness score on dormant scopes.
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

// Production factory: binds the DB-backed runner once. GenerateBrief carries no
// `now`, so the factory stamps a real-clock bucket anchor.
export function buildBriefGenerator(deps: { db: Db; runTaskFn?: TaskTextRunFn }): GenerateBrief {
  const runTaskFn: TaskTextRunFn = deps.runTaskFn ?? makeRunTaskFn(deps.db);
  return async ({ scopeKey, template, events, facts }) =>
    runBriefWriter({
      runTaskFn,
      scopeKey,
      template,
      events,
      facts,
      now: new Date().toISOString(),
    });
}
