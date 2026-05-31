# Station 2A — Brief-writer wiring (T-37) — Design Spec

- **Linear:** YUK-185
- **Date:** 2026-06-01
- **Author:** architect
- **Status:** draft (not committed)
- **Depends on:** P5.2 brief regen pipeline (already merged), P5.3 freshness scorer (`brief-freshness.ts`)

---

## Problem

The memory-brief regen pipeline is fully plumbed but headless. `regenerateMemoryBrief`
(`src/server/memory/brief.ts:240`) takes an injected `generate: GenerateBrief`
(`brief.ts:46-51`) and on completion writes a `memory_brief_note` row with a P5.3
freshness score (`brief.ts:280-298`). But the terminal value is never wired:
`registerMemoryHandlers` is called with **no deps** at `src/server/boss/handlers.ts:50`
(`await registerMemoryHandlers(boss, db);`), so `deps.generateBrief` is `undefined`
and falls back to `defaultGenerateBrief` (`triggers.ts:329-331`), which throws
`'memory brief LLM generator is not configured'`. There is **no `memory_brief` task
kind in the registry** either — the generator does not exist anywhere.

Consequence: `memory_brief_note` is always empty, so `query_memory_brief`
(`context-readers.ts:1084`, tool `:1198`) always returns `{ note: null }`, the Copilot
global-brief slot is dark, and the P5.3 `long_term_freshness_score` never computes on
real data. Layer-8 (durable cross-session memory surfaced as a brief) is unvalidated.

## Goal

Implement a real `generateBrief: GenerateBrief` backed by a new registered AI task,
and inject it at `handlers.ts:50`, so the existing regen pipeline produces
`memory_brief_note` rows. Validate the prod-path shape against the Station-1 synthetic
seed: `query_memory_brief` returns non-empty for a synthetic subject scope + `global`,
and `long_term_freshness_score` computes from real input event ids.

**Reuse-first (CLAUDE.md anti-over-engineering):** do NOT hand-roll an LLM loop. Reuse
the AI task/runner (`runTask`) + the GoalScopeTask structured-JSON + Zod-parse pattern
(`goals/scope.ts`) verbatim. The writer is a single structured-output call, no tool loop.

---

## Decisions

### D1 — New AI task: `MemoryBriefTask`

Register one new task kind, `MemoryBriefTask`, in `src/ai/registry.ts`. It is a single
structured-JSON call (no tool loop), the same archetype as `GoalScopeTask`
(`registry.ts:472-485`). Registry entry:

```ts
MemoryBriefTask: {
  kind: 'MemoryBriefTask',
  description:
    'Station 2A (YUK-185, T-37) — per-scope memory brief writer. Input = scopeKey + template + capped events[] (newest-first, ≤50) + facts[]. Output = strict JSON BriefDraft: 3 time-window markdown summaries (recent_week / recent_months / long_term) + 3 paired evidence_id arrays (subset of input event ids). Single structured-output call (no tool loop), mimo-v2.5-pro text. Drives memory_brief_note rows.',
  defaultProvider: 'xiaomi',
  defaultModel: 'mimo-v2.5-pro',
  fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
  budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
  needsToolCall: false,
  isMultimodal: false,
  allowedTools: [],
  // CUT: this string IS the runtime prompt (subject-neutral pass-through, see
  // Prompt design + getTaskSystemPrompt switch :526-532). NOT a deprecated
  // fallback — there is no per-profile builder for this task.
  systemPrompt: '<full MemoryBriefTask system prompt — see "Prompt design" below>',
},
```

`TaskKind` (`registry.ts:508`) picks it up automatically. The provider/model match the
project's structured-task convention (xiaomi/mimo, text reasoning). `needsToolCall: false`
+ `allowedTools: []` keeps it on the no-tool `runTask` path — correct because the writer
gets all signal in its input; it never reads the DB itself.

**Prompt routing (subject-neutral pass-through, no builder):** the brief is
subject-NEUTRAL — the per-scope `template` carries the angle and is passed in the
*input*, not baked into the system prompt. So we do NOT add a per-profile
`buildMemoryBriefPrompt(profile)` builder. Instead, the registry `systemPrompt` string
IS the runtime prompt (see Prompt design), and we add `MemoryBriefTask` to the existing
subject-neutral pass-through `case` group in `getTaskSystemPrompt`
(`task-prompts.ts:526-532`, the group `VisionExtractTask` / `ReviewIntentTask` /
`DreamingTask` / `CoachTask` / `CopilotTask` use → `return tasks[task].systemPrompt`).
This deletes the builder function AND the "deprecated fallback string" awkwardness
(the string is no longer a fallback — it is the SoT for this task). The `assertNever`
exhaustive switch (`task-prompts.ts:534`) still forces the case to be wired — omitting
it is a compile error. Subject-specific coaching voice is deferred (OF-2): promote
`MemoryBriefTask` OUT of the pass-through group into a profile builder only when a
subject actually demands it (the same path `CoachTask` would take). See Prompt design
below.

### D2 — Windowing: the WRITER partitions by age, host does not

`regenerateMemoryBrief` hands the writer ONE flat `events` array
(`loadEventsFromDb`, `brief.ts:85-102`) — newest-first, capped at 50, **not** split by
age. `now` is not even passed to `generate`. The output shape
(`BriefDraft`, `brief.ts:37-44`) is the only place the 3 windows exist, and the host
re-derives nothing — `...draft` spreads in verbatim (`brief.ts:284`). Therefore:

- **The writer owns the time-window split.** It buckets the input events by
  `created_at` age into recent_week (≤ ~7d), recent_months (~7d–3mo), long_term (> ~3mo
  or durable/stable signals), writes the 3 markdown summaries, and emits one evidence-id
  array per window.
- Cutoffs are the writer's interpretation, but anchored on a REAL clock. **3A:** the
  orchestrator stamps the real `now` (`new Date().toISOString()`) into the writer input
  as an `now` field (additive — `GenerateBrief`'s signature is unchanged; the orchestrator
  builds the input). The prompt instructs the writer to bucket each event's `created_at`
  age relative to THIS `now`, NOT relative to the newest-event position. This matters on
  dormant scopes: if the newest event is 5 months old, a newest-event anchor would collapse
  every event into `recent_week` and the prose would read "current" while the host freshness
  score — computed off the REAL `now` (`brief.ts:252,273-277`) — correctly reads "stale",
  a prose/score divergence. Anchoring both on the same real clock removes the divergence.
  The host still never validates the buckets themselves.

### D3 — evidence_ids per window = ids of the events placed in that window

Each `*_evidence_ids[i]` MUST be the `id` of an input `BriefEvent` the writer placed in
that window. Subset is not host-enforced (`resolveEvidenceTimestamps`, `brief.ts:204-238`
resolves off-subset ids via one batched query and drops the still-unresolved to
`created_at: null`), but it is the contract and breaking it degrades scoring silently.

**Defensive filter (copy GoalScopeTask `scope.ts:90-92`):** after parse, intersect each
window's `evidence_ids` against the set of input event ids and drop anything not present.
This is the "never trust the LLM's ids" guard. It guarantees the stored arrays are a true
subset, so P5.3 scoring resolves every id in-memory with zero extra queries.

**Why this matters for P5.3:** `long_term_evidence_ids` is the SoT id set the freshness
score runs over (`brief.ts:264-278`). The host de-dups for scoring only
(`scoringEvidenceIds = [...new Set(...)]`, `:272`) and stores the array as-is. Unresolvable
ids drop from the mean → a paragraph cited only by bad ids scores `null` ("unjudgeable",
`BriefRow` comment `:57-59`). The filter + the subset prompt keep the score meaningful.

`source_event_id` (`:286`, newest input event) and `latest_evidence_at` (`:259-262`) are
derived from the INPUT events, independent of the writer's id choices — no extra contract.

### D4 — Injection at handlers.ts:50 (replace throwing default)

Author `buildBriefGenerator(): GenerateBrief` (a closure over the orchestrator below) and
pass it as a dep. The threading is already complete — only the call site changes:

```ts
// src/server/boss/handlers.ts (~:49-50)
// T-37 / YUK-185: inject real brief writer; was throwing defaultGenerateBrief.
// I-1: also fix the stale `YUK-37` comment on the line above the call
// (handlers.ts:49) — this wiring is YUK-185 / T-37, not YUK-37.
await registerMemoryHandlers(boss, db, { generateBrief: buildBriefGenerator({ db }) });
```

`registerMemoryHandlers` (`triggers.ts:333-341`) already accepts
`deps.generateBrief?: GenerateBrief` and threads it through
`buildMemoryBriefRegenHandler` (`triggers.ts:354`) into `regenerateMemoryBrief`'s
`generate` (`triggers.ts:200-218`). No change downstream of the call site.

**Worker env:** the regen handler runs ONLY in the pg-boss worker process
(`scripts/worker.ts:21` → `registerHandlers` → `registerMemoryHandlers`), never in the
Next app. So the worker container needs the provider key in its env: **`XIAOMI_API_KEY`**
(mimo, resolved at `providers.ts:72-110`; `runner.ts:222-236` translates it into
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` for the SDK subprocess) plus `DATABASE_URL`
(already present). `resolveTaskProvider` throws if the key is unset. This is a
docs/deploy note, not code — call it out in the PR + worker compose env.

### D5 — Budget: cost is bounded STRUCTURALLY, not capped (I-2)

There is **no enforced cost budget**. The registry `maxCost` is INACTIVE (declarative
metadata only, per T-PD4 @ 2026-05-29 — `registry.ts:16-24`); the runner enforces ONLY
`maxIterations` (→ SDK `maxTurns`) and `timeout` (→ abort). So the writer's cost is bounded
*structurally* and *logged post-hoc*, not capped:

- **Structural bounds:** ≤50 events input (`maxEventsPerBrief: 50`, applied upstream in
  `loadEventsFromDb`, `brief.ts:93` — the writer never sees >50), a single turn
  (`maxIterations: 1`), the 60s `timeout`, the I-3 per-event payload projection (caps input
  tokens), and the sweep fan-out cap (`maxSubjectsPerRun: 12` + the always-enqueued `global`).
- **Post-hoc logging, NOT a cap:** `runTask` calls `writeCostLedger` (`runner.ts:360`), so
  every run's `cost_usd` is recorded — but nothing rejects or aborts a run on cost.

`maxSubjectsPerRun: 12` is a sweep-orchestration cap the writer never touches directly. The
writer produces all 3 windows from at most those 50 newest-first rows; it enforces no
per-window sub-caps. P5.1 policy is satisfied by the structural bounds + the single
registered task budget — no extra knob, and no cost gate to add (none exists yet anywhere).

### D6 — Test seam: NO live LLM, inject runTaskFn

The orchestrator takes `runTaskFn: TaskTextRunFn` (`@/server/ai/provenance`) as the LLM
seam (Pattern A, `scope.ts:34,83-87`). For the prod call site, `buildBriefGenerator`
wires a `defaultRunTaskFn` that lazy-imports the real `runTask` (Pattern B, mirror
`knowledge_propose_nightly.ts` / `knowledge_edge_propose_nightly.ts:82-90`). Tests inject
a stub returning `{ text: JSON.stringify(<valid BriefDraft>) }` directly — the real
`runTask` is never imported, no `ANTHROPIC_API_KEY` needed. A "no live LLM" guard throws
on any `kind !== 'MemoryBriefTask'` (Pattern C, `e2e.smoke.test.ts`). Logging
(started/finished/cost) happens automatically inside `runTask` — the handler never calls
`log.ts` directly (evidence-first preserved, §AI log below).

### D7 — Validation: drive regen directly on the synthetic seed (do NOT extend --observe in this station)

The Station-1 seed + `--observe` (`seed-synthetic.ts:835`) does NOT touch briefs today
(`runStubbedNightly:848-870` only drives edge-propose). Adding a brief-regen leg to
`--observe` is scope creep for a wiring station and risks coupling the validation harness
to the writer. **Decision:** validation lives in a DB test that (a) runs against seeded
events and (b) drives a regen via the direct entry. Optionally a thin one-off script.
This keeps `--observe` unchanged. (If product later wants `--observe` to show a brief, that
is a follow-up — see Out-of-scope / Open forks.)

### D8 — F-1: the regen-handler loop catches per scope (the graceful posture lives HERE)

The Goal's "fails gracefully (log + leave old brief)" is NOT free today: the writer throws
loud (intentional, OF-3 closed), `regenerateMemoryBrief` does not wrap `generate`
(`brief.ts:258`), and `resolveTaskProvider` throws BEFORE `runTask`'s try (`providers.ts:88`)
— so a missing `XIAOMI_API_KEY` or any LLM throw propagates UNHANDLED into pg-boss → reject →
retry (~2x) → silent nightly failure. **Decision:** add one per-scope try/catch INSIDE
`buildMemoryBriefRegenHandler`'s for-loop (`triggers.ts:157-219`), mirroring
`knowledge_propose_nightly.ts:96-99`: log + `continue`. One scope's throw becomes a logged
skip; the old brief row is left intact (the upsert is only reached on success); no
unhandled rejection, no retry storm. This REQUIRES the small `triggers.ts` edit above — the
original "no triggers.ts change" claim is corrected to "one defensive try/catch added to the
regen handler loop". See Mechanism for the exact snippet.

### D9 — F-2: boot-time WARN if `XIAOMI_API_KEY` is unset

The regen handler runs only in the worker process. A missing `XIAOMI_API_KEY` is otherwise
discovered the hard way — 3 AM by 3 AM, one logged-skip per scope per night (D8). **Decision:**
add a one-shot boot WARN in `registerMemoryHandlers` (`triggers.ts`, ~:341 — worker-only, since
`scripts/worker.ts:21` → `registerHandlers` → `registerMemoryHandlers`, never the Next app):

```ts
// src/server/memory/triggers.ts — top of registerMemoryHandlers, after generateBrief resolve
// F-2 (YUK-185): the brief regen handler calls the LLM via runTask, which needs XIAOMI_API_KEY
// (resolveTaskProvider throws otherwise, providers.ts:88). Surface a missing key at BOOT, not
// per-scope at 3 AM. One-shot WARN; not fatal (other memory handlers — ingest/outbox — still run).
if (!process.env.XIAOMI_API_KEY) {
  console.warn('[memory] XIAOMI_API_KEY unset — memory brief regen will fail (logged-skip per scope, F-1/D8)');
}
```

(Placed in `registerMemoryHandlers` rather than `scripts/worker.ts` so the warn travels with
the handler that needs the key and stays out of the Next app boot path.)

---

## Mechanism

New file `src/server/memory/brief-writer.ts` — the orchestrator + the generator closure.
Mirrors `goals/scope.ts` exactly.

```ts
// src/server/memory/brief-writer.ts
import { z } from 'zod';
import type { Db } from '@/db/client';
import type { TaskTextRunFn, TaskRunCtx } from '@/server/ai/provenance';
import { KNOWLEDGE_EXCERPT_MAX } from '@/server/ai/tools/budgets'; // I-3 — payload excerpt cap
import type { BriefDraft, BriefEvent, BriefFact, GenerateBrief } from './brief';

// ── Writer output schema = BriefDraft (brief.ts:37-44). See "Output schema" below. ──
// 1B/I-4: named `BriefDraftOutputSchema` (NOT `MemoryBriefOutputSchema`) — the
// latter is ALREADY taken by the read-side {note, evidence} schema in
// context-readers.ts:1051. Two same-named, structurally-different symbols would
// be a footgun; this writer-side shape is the 6-field BriefDraft.
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

export function parseBriefDraftOutput(text: string): BriefDraftOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseBriefDraftOutput: no JSON object found in text');
  }
  return BriefDraftOutputSchema.parse(JSON.parse(text.slice(start, end + 1)));
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
// the 60s timeout for zero brief benefit. Keep ONLY action/outcome + one short
// text excerpt; never serialize the raw blob.
function projectEventPayload(payload: unknown): { outcome?: string; excerpt?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const p = payload as Record<string, unknown>;
  const out: { outcome?: string; excerpt?: string } = {};
  if (typeof p.outcome === 'string') out.outcome = p.outcome;
  // pick the most brief-useful text field present, truncate hard
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
export async function runBriefWriter(params: {
  runTaskFn: TaskTextRunFn;
  scopeKey: string;
  template: string;
  events: BriefEvent[];
  facts: BriefFact[];
  now: string; // 3A: real-clock ISO anchor for the 7d/3mo/long_term buckets
  ctx?: Partial<TaskRunCtx>; // db/env passthrough; subjectProfile optional
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
export function buildBriefGenerator(deps: { db: Db; runTaskFn?: TaskTextRunFn } ): GenerateBrief {
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

async function defaultRunTaskFn(kind, input, ctx) {
  const { runTask } = await import('@/server/ai/runner');
  return runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
}
```

> Failure posture (F-1, decision — was OF-3 fork, now CLOSED): the writer/closure
> stays LOUD — it does NOT swallow-to-empty inside the generator, because an empty
> `BriefDraft` would persist a misleadingly "blank" brief row over a good one. The
> graceful "log + leave old brief" behavior the Goal claims is delivered ONE LAYER UP
> by the per-scope try/catch added to the regen handler loop (see "F-1 — regen handler
> defensive catch" below + D8). So: writer throws → handler-loop catch logs it + `continue`s
> → the old `memory_brief_note` row is left intact → no unhandled rejection, no pg-boss
> retry storm. There is no in-generator `writeRetryableAiFailureLedger` (that pattern is
> for the proposal path; here the logged skip in the handler is the whole posture).

The `handlers.ts:50` change passes `buildBriefGenerator({ db })` (D4).

### Anchored change list

| File | Change |
|---|---|
| `src/ai/registry.ts` (~:486, before `TaggingTask`) | add `MemoryBriefTask` entry (D1) |
| `src/server/memory/brief-writer.ts` (new) | schema + `parse` + `runBriefWriter` + `buildBriefGenerator` (Mechanism) |
| `src/server/boss/handlers.ts:49-50` | inject generator + fix stale `YUK-37` comment → `YUK-185` (D4, I-1) |
| `src/server/memory/triggers.ts:157-219` | ONE per-scope try/catch in the regen-handler loop: log + `continue` on throw (F-1, D8) |
| `src/server/memory/triggers.ts` (`registerMemoryHandlers`, ~:341) | boot-time WARN if `XIAOMI_API_KEY` unset (F-2) |
| `src/ai/task-prompts.ts` (switch :526-532) | add `MemoryBriefTask` to the subject-neutral pass-through `case` group — NO builder (CUT) |
| worker compose env (docs/PR note) | ensure `XIAOMI_API_KEY` present in worker container (D4) |

**`triggers.ts` change (F-1 — small but REQUIRED):** the original spec claimed
"no `triggers.ts` change". That is FALSE for safety: `buildMemoryBriefRegenHandler`'s
for-loop (`triggers.ts:157-219`) has NO try/catch, and `regenerateMemoryBrief`
(`brief.ts:258`) does not wrap `params.generate`, and `resolveTaskProvider` throws
BEFORE `runTask`'s own try (`providers.ts:88`). So a missing `XIAOMI_API_KEY` (or any
LLM/provider throw) propagates UNHANDLED all the way to pg-boss, which rejects the job,
retries (~2x), and fails every night silently. Add ONE defensive try/catch INSIDE the
regen-handler loop (mirror `knowledge_propose_nightly.ts:96-99`) so one scope's throw
becomes a logged skip + `continue`, never an unhandled rejection:

```ts
// src/server/memory/triggers.ts — inside buildMemoryBriefRegenHandler's `for (const job of jobs)`
// F-1 (YUK-185): one scope's LLM/provider throw (e.g. resolveTaskProvider throwing on a
// missing XIAOMI_API_KEY, providers.ts:88) must NOT reject the pg-boss job and trigger a
// nightly retry storm. Catch per scope, log, leave the old brief row intact, continue.
// Mirrors knowledge_propose_nightly.ts:96-99 (per-job try/catch).
try {
  // ... existing per-scope body: subject-prefix branch + global branch,
  //     the subjectScopeHasNewEvidence / scopeHasNewEvidence guards, and the
  //     regenerateMemoryBrief(...) calls all move INSIDE this try ...
} catch (err) {
  console.error(`[memory_brief_regen] scope ${scopeKey} failed; leaving prior brief`, err);
  continue;
}
```

`brief.ts` needs NO change — leaving the throw to propagate to this catch is exactly the
desired flow (the old row is never overwritten because the upsert is only reached on
success).

---

## Prompt design (registry `systemPrompt`, pass-through — no builder)

This text IS the `MemoryBriefTask` registry `systemPrompt` (CUT — there is no
`buildMemoryBriefPrompt`; `getTaskSystemPrompt` returns `tasks['MemoryBriefTask'].systemPrompt`
via the pass-through `case` group, `task-prompts.ts:526-532`). It instructs (strict JSON, no
markdown fence — the brace-slice tolerates fences):

1. **Role + input contract.** "You write a durable memory brief for one scope. You are
   given `scope_key`, an `now` (ISO timestamp = the current moment, your age anchor), a
   `template` (the angle to summarize), a newest-first list of up to 50 `events` (each with
   `id`, `action`, `subject_kind`, `subject_id`, `created_at` ISO, and a COMPACT `payload`
   projection of `{ outcome?, excerpt? }` — I-3, never a raw blob), and `facts` (durable
   `memory` strings). Follow the `template`'s framing."
2. **Three time windows (D2 / 3A).** "Anchor all ages on the input `now` (NOT the newest
   event). Compute each event's age = `now - created_at`. Partition events into three
   windows by that age and write one markdown summary per window:
   - `recent_week_md` — events within ~7 days: what the learner is doing right now.
   - `recent_months_md` — events ~7 days to ~3 months old: the current arc/direction.
   - `long_term_md` — events older than ~3 months OR stable/durable signals & facts:
     enduring strengths, preferences, recurring weak spots.
   If a window has no events, write a short 'no recent signal' line; do not fabricate."
3. **Evidence ids (D3, subset).** "For each window, emit the matching `*_evidence_ids`
   array containing ONLY the `id`s of input events you placed in that window. Do not invent
   ids. Do not cite facts as evidence ids. Ids must be a subset of the given event `id`s."
4. **Length.** "Keep each window to a few tight sentences or bullets; this is a glanceable
   brief, not a transcript." (No hard token cap — cost is bounded structurally + logged
   post-hoc, not capped, D5; brevity is prompt-guided.)
5. **Output JSON only**, exactly the 6 `BriefDraft` keys, nothing else.

The per-scope `template` (`BRIEF_TEMPLATES`, `brief.ts:8-19`) is passed in the input
(resolved by the host via `prefixForScope`, `brief.ts:253,68-75`) — the writer never picks
the template. The 5 templates (global / subject / topic / mistake_cluster /
meta:orchestrator_self) thus reuse one prompt.

---

## Output schema (BriefDraft Zod)

`BriefDraftOutputSchema` (above — 1B/I-4: NOT `MemoryBriefOutputSchema`, which is the
read-side `{note, evidence}` schema already exported from `context-readers.ts:1051`) is
structurally `BriefDraft` (`brief.ts:37-44`): 3 markdown strings + 3 string arrays, all
defaulted so a partial model response parses rather than throws (the host tolerates empty
windows). The orchestrator returns exactly the 6 fields after the D3 filter;
`regenerateMemoryBrief` spreads them in via `...draft` (`brief.ts:284`) and computes
everything else (`id`, freshness score, `source_event_id`, counts, timestamps) itself.

- **`z.string().min(1)` on each id element (1A/2A):** intentional tightening — rejects
  empty-string ids at parse time. The D3 subset filter drops them regardless (an empty id
  is never in the input-id Set), so this is belt-and-suspenders, not load-bearing.
- **Residual risk (1A/2A — name it, accept it for a wiring station):** only the LONG-TERM
  window's id *placement* feeds a host-validated number (the P5.3 freshness score over
  `long_term_evidence_ids`). The host does NOT validate WHICH window an id was placed in —
  it trusts the writer's bucketing. So a long-term-durable event the writer misfiles OUT of
  `long_term_evidence_ids` (or a recent event it misfiles INTO it) skews the freshness
  score. The D3 subset filter guarantees ids are real; it does NOT guarantee correct
  placement. Acceptable for Station 2A (wiring); revisit if the freshness score becomes a
  gate rather than an advisory annotation.

---

## Test plan (stubbed, no live LLM)

DB-config test `src/server/memory/brief-writer.test.ts` (touches `regenerateMemoryBrief`'s
DB write + freshness scoring):

1. **Parse/filter unit (can be unit-config):** `parseBriefDraftOutput` on a valid blob →
   6 fields; brace-slice tolerates a fenced blob; `runBriefWriter` with a stub returning ids
   not in the input → those ids are dropped (D3 filter); facts are passed but never appear
   in evidence arrays. Add a **cold-scope case (4A):** `runBriefWriter` with `events: []`
   returns the all-empty draft WITHOUT invoking `runTaskFn` (assert the stub is never
   called) — proves the 0-event short-circuit skips the paid LLM call.
2. **End-to-end stub through regen (DB-config):** seed a handful of `event` rows on one
   scope, call `regenerateMemoryBrief({ db, scopeKey, searchFacts, generate: buildBriefGenerator({ db, runTaskFn: stub }) })`
   where `stub` returns a canned `BriefDraft` citing real seeded event ids in
   `long_term_evidence_ids`. (`buildBriefGenerator` stamps `now` into the writer input
   itself, 3A — the stub can assert the input carries an ISO `now` field.) Assert: a
   `memory_brief_note` row is written, the 3 windows match the stub, and
   `long_term_freshness_score` is a number in (0,1] (resolved from real ids via the
   in-memory path, `brief.ts:213-214`).
3. **Freshness null path:** stub cites only ids NOT in the input → after the filter the
   long-term array is empty → score is `null` (unjudgeable). Confirms the filter + scorer
   interplay.
4. **No-live-LLM guard:** stub throws on any `kind !== 'MemoryBriefTask'` (Pattern C) —
   proves the runner is never reached.

Place tests touching `testDb`/`memory_brief_note` in the **DB vitest config**
(`vitest.db.config.ts`), per the partition rule. The parse/filter-only cases may be
unit-config if fully synchronous and DB-free.

---

## Validation on synthetic seed

Goal: observe the slot light up with the prod-path shape on the Station-1 seed.

1. Run `pnpm seed-synthetic` (or the seed entry) to populate `event` rows on
   `subject:synthetic:wenyan:root` (attempt/judge/review) + FSRS + proposals. This makes
   the subject active for `listActiveSubjectsSinceRefresh` and satisfies
   `subjectScopeHasNewEvidence` (`triggers.ts:199`).
2. Drive a regen **directly** (no cron) — the surgical entry (`brief.ts:240`).
   **4B (illustrative — exact shapes):** `regenerateMemoryBrief.loadEvents` is
   `(scopeKey: string) => Promise<BriefEvent[]>` (NOT a zero-arg thunk) and `.now` is
   `() => Date` (NOT a `Date`); `loadSubjectBriefEvents(db, subjectId, opts)` takes
   `opts: { lookbackDays?, now? }` (both optional). Correct forms:
   - subject:
     ```ts
     const now = new Date();
     await regenerateMemoryBrief({
       db,
       scopeKey: 'subject:synthetic:wenyan:root',
       loadEvents: (scopeKey) =>
         loadSubjectBriefEvents(db, scopeKey.slice('subject:'.length), { lookbackDays: 30, now }),
       searchFacts,
       generate: buildBriefGenerator({ db }),
       now: () => now,
     });
     ```
   - global: `regenerateMemoryBrief({ db, scopeKey: 'global', searchFacts, generate: buildBriefGenerator({ db }) })` — `global` has no prior row so `scopeHasNewEvidence` (`brief.ts:168-187`) returns true and the first regen runs. (For a fresh DB with 0 global-tagged events, the 4A cold-scope guard makes this write an all-empty row without an LLM call.)
   Use the real `buildBriefGenerator({ db })` (live LLM, worker env) for a true end-to-end
   smoke, OR the stubbed generator for a deterministic CI assertion (preferred for the gate).
   The DB test (Test plan §2) is the real gate, so these direct-drive snippets are
   illustrative; the gate does not depend on them compiling verbatim.
3. **Read/verify** via `executeMemoryBrief` (`context-readers.ts:1084`, tool
   `query_memory_brief` `:1198`): call with `{ scopeKey: 'subject:synthetic:wenyan:root', includeEvidence: true }`
   then `{ scopeKey: 'global', includeEvidence: true }`. Assert `note` is non-null with
   `recent_week_md` / `recent_months_md` / `long_term_md`, `version`, `refreshed_at`, and
   `long_term_freshness_score`; with `includeEvidence` the `*_ids` arrays are present.

`--observe` is **not** extended (D7). The DB test (Test plan §2) is the durable gate; the
direct-drive script is an optional manual smoke.

---

## AI log / trace (evidence-first preserved)

No new logging code. The brief-writer run logs like every other task because it goes
through `runTask`, which calls `writeAiTaskRunStarted` (`runner.ts:288`),
`writeCostLedger` (`:360`), `writeAiTaskRunFinished` (`:382`) and returns
`task_run_id` + `cost_usd` in `RunTaskResult`. The orchestrator must not call `log.ts`
directly. (Unlike `goals/scope.ts`, there is no `writeAiProposal` here — the brief is not a
proposal; the persisted artifact is the `memory_brief_note` row, which is itself the
reversible, traceable evidence: it is re-derived on every regen and carries
`source_event_id` + `refreshed_at`.) `task_run_id` ties the row's regen to the AI run log
for traceability; carry it onto the row if a cheap seam exists, otherwise the run log alone
suffices for Station 2A.

---

## Gate

Before PR: `pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`,
`pnpm audit:profile`, `pnpm test`, `pnpm build`. The new DB test runs under `pnpm test:db`.
No schema change (the `memory_brief_note` table + columns already exist from P5.2/P5.3), so
`audit:schema` should be unaffected — confirm no new allowlist entry is needed. The CUT
pass-through case is enforced by `assertNever` (`task-prompts.ts:534`) — `typecheck` fails if
`MemoryBriefTask` is left unwired. F-1's handler-loop catch + F-2's boot WARN are covered by
`typecheck`/`lint`; no extra gate step.

## Acceptance

- AC-1: `MemoryBriefTask` registered (`registry.ts`) + added to the subject-neutral
  pass-through `case` group in `getTaskSystemPrompt` (`task-prompts.ts:526-532`) — NO
  `buildMemoryBriefPrompt` builder (CUT); `TaskKind` includes it.
- AC-2: `runBriefWriter` + `buildBriefGenerator` exist; the writer output schema is
  `BriefDraftOutputSchema` (1B — not the colliding `MemoryBriefOutputSchema`); output is a
  `BriefDraft` whose evidence arrays are a true subset of input event ids (D3 filter); the
  writer input carries an ISO `now` (3A) and a truncated/projected `payload` per event (I-3).
- AC-3: `handlers.ts:50` injects `{ generateBrief: buildBriefGenerator({ db }) }`; the
  throwing `defaultGenerateBrief` is no longer reached in prod.
- AC-4: DB test: a stubbed regen writes a `memory_brief_note` row with the 3 windows and a
  numeric `long_term_freshness_score` from real ids; the null-score path is covered; the
  stub throws on any non-`MemoryBriefTask` kind (no live LLM).
- AC-5: On the synthetic seed, `query_memory_brief` returns non-null for the synthetic
  subject scope + `global` after a regen.
- AC-6: AI run logging is produced via `runTask` (no direct `log.ts` calls in the writer).
- AC-7: F-1 — `buildMemoryBriefRegenHandler`'s loop wraps each scope in try/catch
  (`triggers.ts:157-219`); a `generate` throw is logged + `continue`d, the old brief row is
  left intact, and the pg-boss job does NOT reject (no retry storm).
- AC-8: F-2 — a missing `XIAOMI_API_KEY` produces one boot-time WARN in
  `registerMemoryHandlers`; 4A — a 0-event scope writes an all-empty row WITHOUT an LLM call
  (the stubbed `runTaskFn` is never invoked for `events: []`).

## Out-of-scope

- D1 goal-create trigger that enqueues a brief regen on goal materialization — that is
  **Station 2B**.
- Any UI for the brief (the Copilot global-brief slot rendering / freshness "may be dated"
  annotation) — the slot lights up via `query_memory_brief`; surfacing it is separate.
- Real ingestion of `facts` from Mem0 — `searchFacts` defaults to `[]` (`brief.ts:257`);
  this station passes whatever the existing seam provides and does not build fact ingest.
- Topic / mistake_cluster / meta:orchestrator_self regen triggers — the writer supports
  all 5 templates, but only subject + global are validated here (those the seed produces).
- Extending `seed-synthetic.ts --observe` to drive a brief regen (D7).

## Open product forks (genuine)

- **OF-1 (model/route):** `mimo-v2.5-pro` (text reasoning) is the default chosen to match
  GoalScopeTask. If brief summaries want a cheaper/faster model, switch `defaultModel` to
  `mimo-v2.5` (already the fallback). Low-stakes; default stands unless product objects.
- **OF-2 (brief tone):** the prompt is terse/glanceable and subject-neutral (per-scope
  `template` carries the angle), and `MemoryBriefTask` lives in the subject-neutral
  pass-through `case` group (CUT). If product later wants the brief to adopt a subject's
  coaching voice (like CoachTask), PROMOTE `MemoryBriefTask` out of the pass-through group
  into a `buildMemoryBriefPrompt(profile)` builder (the same path CoachTask would take) —
  deferred until a subject demands it.
- **OF-3 (failure posture) — CLOSED to a decision (F-1 / D8):** the writer/generator stays
  LOUD (re-throws; never persists a blank row), and the graceful "log + leave old brief"
  behavior is delivered by the per-scope try/catch in the regen-handler loop (D8). This is
  no longer an open fork — the loud-throw + handler-loop-skip split is the decided posture
  for Station 2A. (If product later wants an explicit failure ledger entry per skip, add
  `writeRetryableAiFailureLedger` inside the handler catch — additive, not required.)
