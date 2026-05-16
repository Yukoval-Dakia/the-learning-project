# Phase 1c.1 Step 6 — API routes rewrite (mistakes-over-events + new /api/events + /api/knowledge/edges)

> Step 6 ("API routes 重写 — `/api/mistakes` 保 URL, body 走 event 流") expansion. Parent plan §Step 6.
>
> **Prerequisites**: Step 4 (`getFailureAttempts`, `getEventById`, `writeEvent`) and Step 5 (`Ingestion.*` namespace) both merged or on phase1c1-step5-prep branch.
>
> **Scope**: External `/api/mistakes/*` URLs preserved (user-facing semantics stable). Internals re-implement over event stream using Step 4 helpers. **Add** raw `/api/events/*` routes (for EventChain primitives — v2.1 UI prereq). **Add** `/api/knowledge/edges/*` CRUD routes (per banner — moved from Step 7).

---

## Per-route mapping

### `app/api/mistakes/route.ts` (existing — POST only currently)

**POST**: keep current Step 4 behavior (dual-write: mistake row + attempt event + chained judge event). No changes in Step 6 — the legacy mistake row write stays until Step 9.

**Add GET**: list failure attempts as mistake-shape JSON.
```ts
GET /api/mistakes?limit=N&since=ISO&question_id=X
→ { rows: Array<{ id, question_id, prompt_md, wrong_answer_md, knowledge_ids, cause, created_at }> }
```
- Implementation: call `getFailureAttempts({ limit, since: since ? new Date(since) : undefined, questionIds: question_id ? [question_id] : undefined })`
- Join `question` table for `prompt_md` (excerpt 200 chars; matches `recent` route convention)
- `cause` shape: legacy mistake-shape `{ primary_category, user_notes }` — derive from judge event's `payload.cause.primary_category` and `payload.cause.analysis_md` (note: `user_notes` no longer in Lane B contract; map to null OR omit; spec says **map to null** for backward shape preservation)
- `created_at` returned as Unix seconds (matches `recent` route)

### `app/api/mistakes/recent/route.ts`

Rewrite GET to use `getFailureAttempts` instead of `db.select().from(mistake)`. Output shape unchanged.

```ts
GET /api/mistakes/recent?limit=N
→ { rows: Array<{ id, question_id, prompt_md, wrong_answer_md, knowledge_ids, cause, created_at }> }
```

Implementation:
```ts
const limit = parseLimit(url, default=20, max=100);
const fails = await getFailureAttempts(db, { limit });
// Need question prompt_md → batch SELECT from question, then map
const questionIds = [...new Set(fails.map((f) => f.question_id))];
const questions = await db.select({...}).from(question).where(inArray(question.id, questionIds));
const promptByQid = new Map(questions.map((q) => [q.id, q.prompt_md]));
return { rows: fails.map((f) => ({
  id: f.attempt_event_id,
  question_id: f.question_id,
  prompt_md: (promptByQid.get(f.question_id) ?? '').slice(0, 200),
  wrong_answer_md: (f.answer_md ?? '').slice(0, 200),
  knowledge_ids: f.referenced_knowledge_ids,
  cause: f.judge ? { primary_category: f.judge.cause.primary_category, user_notes: null } : null,
  created_at: Math.floor(f.created_at.getTime() / 1000),
})) };
```

### New: `app/api/events/route.ts` (GET)

Raw event log filter API for EventChain UI primitive.

```ts
GET /api/events?action=X&subject_kind=Y&actor_kind=Z&actor_ref=R&limit=N&since=ISO
→ { rows: Array<KnownEventT> }
```
- All filters optional; AND combined
- `limit`: default 50, max 200
- `since`: filter `created_at >= since`
- Returns raw Event shape (Lane B `KnownEventT`). The wire JSON IS the parseEvent-valid shape — client can `parseEvent` to validate.
- New helper in `src/server/events/queries.ts`: `getEvents(db, filter)` (add to Step 4's module per single-owner). Reuses `parseEvent` for output validation.

### New: `app/api/events/[id]/route.ts` (GET)

Single event + its caused_by chain (forward + backward).

```ts
GET /api/events/:id
→ {
  event: KnownEventT,
  chain: {
    caused_by: KnownEventT | null,      // event.caused_by_event_id resolved
    caused_events: Array<KnownEventT>,  // events with caused_by_event_id = :id
  }
}
```

Implementation: `getEventById` (Step 4) + reverse lookup `event WHERE caused_by_event_id = :id` (already supported by index).

### New: `app/api/knowledge/edges/route.ts` (GET + POST)

Knowledge mesh CRUD (per ADR-0010 + banner Step 7 → moved to Step 6).

```ts
GET /api/knowledge/edges?from=K&to=K&relation_type=T
→ { rows: Array<{ id, from_knowledge_id, to_knowledge_id, relation_type, weight, created_by, created_at }> }

POST /api/knowledge/edges
  body: { from_knowledge_id, to_knowledge_id, relation_type, weight?, created_by? }
  → 201 { id }
  → 400 if invalid relation_type
  → 404 if from/to knowledge_id not found
  → 409 if duplicate (UNIQUE(from, to, relation_type) per ADR-0010)
```

`relation_type` must be one of 5 enums (`prerequisite | related_to | contrasts_with | applied_in | derived_from`) or `experimental:*` namespace. Validate with `RelationTypeSchema` from Lane B `event/blocks.ts`.

Single-owner per ADR-0005: writes go through a new `src/server/knowledge/edges.ts` module:
```ts
export async function createKnowledgeEdge(db, { from_knowledge_id, to_knowledge_id, relation_type, weight?, created_by? }): Promise<string>
export async function listKnowledgeEdges(db, filter): Promise<KnowledgeEdge[]>
```

---

## New helpers in existing modules

### `src/server/events/queries.ts` (Step 4 module — extend)

Add:
```ts
export async function getEvents(db, filter): Promise<KnownEventT[]>
export async function getEventChain(db, id): Promise<{ caused_by: KnownEventT | null; caused_events: KnownEventT[] }>
```

### New: `src/server/knowledge/edges.ts`

Single-owner writer for `knowledge_edge` table. Mirrors `src/server/session/` pattern (per ADR-0005).

---

## TDD substep breakdown

Pattern: red → fail → green → pass → commit. 8 substeps.

### 6.A — `getEvents` + `getEventChain` helpers in queries.ts

- 6.A.1 (red): test `getEvents(db, { action: 'attempt', limit: 5 })` returns 5 events ordered desc; `getEventChain(db, attemptId)` returns `{ caused_by: null, caused_events: [judge1] }`
- 6.A.5 (commit): `feat(1c.1 Step 6): events queries — getEvents filter + getEventChain helpers`

### 6.B — `app/api/events/route.ts` GET

- 6.B.1 (red): integration test calling the route with various filter combos
- 6.B.5 (commit): `feat(1c.1 Step 6): GET /api/events — raw event log filter API`

### 6.C — `app/api/events/[id]/route.ts` GET

- 6.C.1 (red): integration test for chain navigation
- 6.C.5 (commit): `feat(1c.1 Step 6): GET /api/events/[id] — single event + caused_by chain`

### 6.D — `src/server/knowledge/edges.ts` + `app/api/knowledge/edges/route.ts` GET

- 6.D.1 (red): unit + route test — listKnowledgeEdges with filters; GET returns rows
- 6.D.5 (commit): `feat(1c.1 Step 6): knowledge edges — list module + GET route`

### 6.E — POST `/api/knowledge/edges`

- 6.E.1 (red): valid create (201), invalid relation_type (400), unknown from/to (404), duplicate (409)
- 6.E.5 (commit): `feat(1c.1 Step 6): POST /api/knowledge/edges — create with single-owner module`

### 6.F — Rewrite `/api/mistakes/recent` GET

- 6.F.1 (red): test that returns rows projected from event stream, shape identical to legacy mistake-shape
- 6.F.5 (commit): `refactor(1c.1 Step 6): /api/mistakes/recent reads from event stream via getFailureAttempts`

### 6.G — Add `/api/mistakes` GET

- 6.G.1 (red): test the new GET (with filters)
- 6.G.5 (commit): `feat(1c.1 Step 6): GET /api/mistakes — list failure attempts projected from event stream`

### 6.H — Integration: route contract back-compat

- 6.H.1 (red): test that legacy clients seeing mistake-shape JSON from rewritten routes get same field names / types as before Step 6
- 6.H.5 (commit): `test(1c.1 Step 6): integration — /api/mistakes shape back-compat over event stream`

---

## Locked contract

- **Existing URLs stable**: `/api/mistakes`, `/api/mistakes/recent` URL + response JSON shape unchanged from client's perspective
- **`cause.user_notes` → null**: Lane B `CauseSchema` dropped `user_notes`; preserved field in API output as `null` for shape compatibility. Document inline.
- **New event-flavored routes return raw KnownEvent shapes** (parseable by client `parseEvent`). NOT mistake-shape projections — those live on `/api/mistakes/*`.
- **`/api/knowledge/edges` writes go through `src/server/knowledge/edges.ts`** (single-owner per ADR-0005). No direct `db.insert(knowledge_edge)` in routes.
- **Validation barrier**: every POST body parses via Zod (`RelationTypeSchema` for edges). Errors → 400 with `errorResponse`.
- **Internal token middleware** (`middleware.ts` x-internal-token) applies to all new `/api/*` routes — already configured globally.
- 8 commits, conventional format. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

## Subagent prompt

```markdown
You are executing Phase 1c.1 Step 6 of the-learning-project. Worktree-isolated.

## BOOTSTRAP

```bash
git fetch origin
git merge origin/phase1c1-step6-prep --ff-only
```

Verify: `ls docs/superpowers/plans/2026-05-16-phase1c1-step6-api-routes.md`, `ls src/server/session/index.ts`, `grep "getFailureAttempts" src/server/events/queries.ts`.

If anything missing, STOP and report.

## Authoritative spec

`docs/superpowers/plans/2026-05-16-phase1c1-step6-api-routes.md` — read in full. Per-route mapping + TDD breakdown supersede parent plan.

## Required reading

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-05-16-phase1c1-step6-api-routes.md` (authoritative)
3. `docs/adr/0005-ingestion-session-single-owner.md` — single-owner invariant
4. `docs/adr/0010-knowledge-mesh.md` — relation_type enums + UNIQUE(from, to, relation_type)
5. `docs/adr/0011-tool-use-and-edge-event-paths.md` — KnownEvent extensions
6. `src/db/schema.ts` — `event`, `knowledge_edge` columns
7. `src/core/schema/event/index.ts` — `parseEvent`, `Event` type
8. `src/core/schema/event/blocks.ts` — `RelationTypeSchema`
9. `src/server/events/queries.ts` — Step 4 module to extend (add getEvents + getEventChain)
10. `src/server/session/` — Step 5 single-owner module pattern (mirror for `src/server/knowledge/edges.ts`)
11. Existing routes: `app/api/mistakes/route.ts` + `app/api/mistakes/recent/route.ts` + `app/api/knowledge/route.ts` (style reference)
12. `middleware.ts` — x-internal-token enforcement (your new routes auto-inherit)

## Locked contract

- **Existing `/api/mistakes/*` URLs + JSON shape stable**. `cause.user_notes` → `null` in output (Lane B dropped this field; preserved as null for back-compat).
- **`src/server/knowledge/edges.ts` is single-owner** for `knowledge_edge` writes (per ADR-0005). New module — mirror `src/server/session/` style.
- **All event INSERTs continue to go through `writeEvent`** (Step 4). New routes that need to write events MUST call `writeEvent`; never `db.insert(event)` directly.
- **POST validation barrier**: every body parses via Zod. Use `RelationTypeSchema` for edges; Zod error → 400 via `errorResponse`.
- 8 separate commits, conventional `feat|refactor|test(1c.1 Step 6): ...`. Each ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## Implementation guidance

- **`getEvents(db, filter)` parses output via parseEvent** before returning — guards against schema drift on the way OUT (Step 4 only guards INWARD writes).
- **`getEventChain(db, id)` two-query approach**: SELECT the focal event, get its `caused_by_event_id`, SELECT that one (if non-null) + SELECT reverse `WHERE caused_by_event_id = :id`. Use Step 4 `getEventById`.
- **Knowledge edges UNIQUE(from, to, relation_type) violation** → catch pg error code `23505` → return 409 with stable error code. Use Drizzle's `try/catch` around `.insert().onConflictDoNothing()` returning empty + diff-check, OR catch raw error.
- **`/api/mistakes` GET projection**: reuse `getFailureAttempts` exactly (no new SQL); fetch question rows separately via `inArray` for prompt_md (matches `recent` route convention).
- **Route file style**: follow existing routes' shape — `export const runtime = 'nodejs'`, `try/catch` with `errorResponse(err)`, Zod parse + safeParse pattern.
- **Test pattern**: existing route tests use `import { GET, POST } from './route'` + construct `Request` objects manually. Mirror that.

## Out of scope (DO NOT TOUCH)

- DB schema (Lane A locked)
- Lane B Zod
- AI prompts (Step 7)
- Anything in `src/server/session/` (Step 5 done)
- Removing legacy `mistake` table writes from POST `/api/mistakes` (Step 9)
- DROP TABLE migrations (Step 9)

## Verification gates

- `pnpm typecheck` green
- `pnpm test src/server/events/queries.test.ts` green (extended for getEvents + getEventChain)
- `pnpm test src/server/knowledge/edges.test.ts` green
- `pnpm test app/api/events/` green
- `pnpm test app/api/knowledge/edges/` green
- `pnpm test app/api/mistakes/` green (existing + new)
- `pnpm test` full suite green (582 baseline)
- `pnpm lint` no new errors
- `pnpm audit:schema` green
- 8 commits, conventional format

## Return (under 800 words)

1. Branch name
2. 8 commit hashes + subjects
3. Verification gate final lines
4. Sample JSON: a `GET /api/events?action=attempt&limit=2` response paste
5. Sample JSON: a `GET /api/knowledge/edges?from=k1` response paste
6. Edge cases (bullets)
7. Out-of-scope discoveries
8. Outstanding risks for Step 7/8/9
```

---

## Risk register

- **`cause.user_notes` shape drift**: clients seeing `null` instead of the legacy string value might break UI rendering. Acceptable — Lane B intentionally dropped this field; product accepts the data loss.
- **`getEvents` validation cost**: parsing every event through `parseEvent` adds latency. For typical limits (≤200) it's negligible; if filter returns large sets, consider streaming or skip parse with an unsafe variant. Defer optimization.
- **`/api/knowledge/edges` POST race**: two clients creating same (from, to, relation_type) concurrently → UNIQUE violation → 409. Acceptable; document. No retry logic in Phase 1c.1.
- **EventChain UI prereq incompleteness**: `/api/events/[id]` returns shallow chain (1 hop). Deeper traversal (e.g., full causal tree) is a v2.1 design decision; out of scope here.

---

## Next-step planning

Step 7 (AI prompts + registry + Attribution Zod cleanup) drafted after Step 6 lands. Step 7 will remove the `ai_analysis_md` Zod bridge from `src/server/knowledge/attribute.ts` (Step 4 added it) once AttributionTask prompt is rewritten to emit `analysis_md` natively.
