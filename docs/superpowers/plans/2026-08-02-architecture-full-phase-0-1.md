# Architecture Deepening FULL — Phase 0/1 execution addendum

> **Authority**: owner 2026-08-02「直接启动 FULL」；Linear project
> `Architecture Deepening FULL — 语义、成本与运行所有权`。
> **Base**: `origin/main@19a97b893dfc9aae62701f00451010fd2be71c7b`.
> **Role**: this is a current-code execution addendum to
> `docs/superpowers/specs/2026-06-10-architecture-redesign-design.md`, not a second product vision.
> The governing decision is ADR-0051.

## Outcome

Move from access/composition seams to real product-operation ownership without changing the deployed
topology. Keep the Hono/Vite/Postgres/pg-boss modular monolith. First make architectural debt,
model-attempt economics, and provider capacity mechanically honest; then migrate one complete failure-
learning vertical and delete its central double track.

FULL is not complete when a new interface exists. It is complete only when the old implementation can be
deleted, product behavior is characterized, dependency debt falls, and no replacement quarry appears.

## Current-code baseline

The 2026-07 architecture closeout delivered useful seams:

- static capability composition and manifest-owned routes/jobs/tools;
- zero cross-capability deep imports; browser consumption through `ui-public`;
- live event subscriber and capability-owned proposal accept adapters;
- shared `AiRunLifecycle` and generated API client.

The remaining debt is semantic ownership, not missing directories. The Phase 0 AST scan uses one
semantic edge per distinct `(source file, resolved target module)`:

| Direction | Raw imports | Semantic edges | Ratchet bucket |
|---|---:|---:|---|
| capability → server | 568 | 538 | every owner → server top-module pair |
| server → capability, deep | 72 | 70 | every server top-module → capability pair |
| cross-capability, value | 74 | 63 | every capability owner pair + nontrivial SCC |

The cross-capability value graph currently has one nontrivial SCC:

```text
agency ↔ ingestion ↔ knowledge ↔ notes ↔ practice
```

The exact machine baseline is `scripts/capability-boundary-baseline.json`; human prose must not be used
to waive or silently update it.

## Locked decisions

1. A product operation is owned by a capability. Route, job, cron, tool, and model call are adapters or
   mechanisms, not competing owners.
2. The central AI runtime owns a model attempt: provider resolution, SDK translation, admission, budget,
   retry/cancel, usage/cost, and attempt logging. It does not own domain parse/commit/outbox success.
3. Capability-owned `TaskSpec<I, O>` is the target seam; the central task registry becomes a static
   composition projection during migration.
4. Cross-aggregate reads use public query ports. Writes use the owner use case or a durable fact event when
   fan-out/recovery justifies it. Shared table shapes are not a write contract.
5. No microservices, Redis, dynamic plugin system, generic workflow DSL, blanket repositories, or second
   provider abstraction without a second real wire protocol.
6. Pre-AI deterministic behavior, queue names, proposal approval, run logging, and provider routing do not
   regress during ownership moves.

## Dependency order

```text
YUK-840  Phase spec + dependency ratchets
   ↓
YUK-841  Authoritative model-attempt cost truth
   ↓
YUK-842  Cross-process provider-lane admission
   ↓
Phase 1  Practice-owned failure-learning vertical
   ↓
Phase 2  Durable handoff + first-class yield semantics
   ↓
Phase 3  Tool/event/proposal/task quarry recut by capability
   ↓
Phase 4  Exit audit and rollout evidence
```

These are deliberately serial around `src/db/schema.ts`, the AI runtime, task composition, and shared
manifests. `launch-phase` parallel implementation begins only when two lanes have disjoint files/schema and
an executable lane spec. Read-only review may still run in parallel.

**Owner execution override (2026-08-02): gate 不在本地跑。** Local commands below document targeted
author checks and deterministic baseline capture only. Full gate execution belongs exclusively to
exact-head GitHub CI; do not rerun the local pre-PR gate as a substitute.

## Phase 0 — Truth, contracts, ratchets

### F0-1 · YUK-840 — phase spec and architecture dependency ratchets

Files:

| File | Responsibility |
|---|---|
| `scripts/audit-capability-boundaries.ts` | Existing public seam audit plus AST dependency graph, exact ratchet comparison, JSON output, and canonical baseline print. |
| `scripts/capability-boundary-baseline.json` | About 140 owner-pair debt entries; never a per-import allowlist. |
| `scripts/audit-capability-boundaries.test.ts` | Type/value classification, normalization, regression/tightening, SCC, and existing seam tests. |
| `package.json` | Keep one CI audit entry; add a print-only snapshot command. |
| `docs/adr/0051-capability-owned-ai-product-operations.md` | Ownership and runtime decision. |
| this file | Executable Phase 0/1 dependency, file, deletion, and exit contract. |
| `docs/architecture.md` | Mark the registry as a migration projection and link current enforcement. |
| `PLAN.md`, `.remember/now.md` | Mirror the active line; keep displaced product P1 open, not canceled. |

Ratchet semantics:

- normalize aliases and relative imports to one resolved module;
- value dominates type when one file uses the same target both ways;
- `import type`, all-inline-type imports, and `TSImportType` do not add value edges;
- mixed, side-effect, literal dynamic imports, re-exported values, and `require()` are value edges;
- non-literal dynamic import/require fails closed;
- server imports of capability `public` / `ui-public` are reported but not counted as deep debt;
- current and baseline snapshots must match exactly. Growth is a regression; reduction requires the same
  change to tighten the baseline, leaving no headroom.

Known limit: one remove and one add inside the same owner-pair bucket can keep its count unchanged. Exact
file-level prevention would require the uneconomic per-import allowlist rejected for this phase; independent
diff review closes this residual risk.

Targeted author/CI command reference:

```bash
pnpm audit:capability-boundaries
pnpm audit:capability-boundaries -- --json
pnpm audit:capability-boundaries:snapshot
pnpm vitest run --config vitest.unit.config.ts scripts/audit-capability-boundaries.test.ts
```

Exit:

- current main matches the committed 538 / 70 / 63 debt baseline;
- tests catch a new/replaced owner-pair, a new deep reverse import, a new value return edge/SCC, and stale
  headroom after a deletion;
- original public/ui-public/browser behavior remains guarded;
- targeted characterization is present, independent review has no unresolved P0/P1, and exact-head GitHub
  CI is green; the full gate is not rerun locally;
- no production runtime behavior changes.

### F0-2 · YUK-841 — authoritative model-attempt cost truth

Implement one discriminated `AttemptCostTruth`:

```ts
type AttemptCostTruth =
  | { basis: 'reported'; amountUsd: number; ref: string }
  | { basis: 'estimated'; amountUsd: number; ref: string }
  | { basis: 'unknown'; amountUsd: null; ref: string };
```

Minimum contract:

- one attempt identity projects the same amount/basis/ref into runner result, `ai_task_runs`, and exactly one
  attempt ledger row;
- capture usage/cost from all SDK terminal results before success/failure classification, including
  `SDKResultError` and `success + is_error`;
- no-terminal attempts become explicit `unknown`, never free `$0`;
- unknown ledger cost is SQL `NULL`; historical rows remain `legacy` and are not back-inferred;
- terminal run update and attempt-ledger insert share a transaction;
- failures use real retryable/permanent outcome semantics; `error_retried` means an actual retry;
- read APIs add basis/ref and unknown counts; unknown is excluded from monetary sums. No UI change in this
  issue.

This phase does not calibrate real provider contracts, migrate every non-runner writer, or implement
provider admission. Real pricing evidence blocks “budget data is trustworthy” claims even after the
structure ships.

### F0-3 · YUK-842 — cross-process provider-lane admission

Use the existing Postgres/pg-boss shared plane. Admission wraps each central Claude Agent SDK
query/session after provider/lane resolution and before model-attempt execution:

- global active session-family/parallel-branch cap and bounded session-start-reservation rate by
  provider lane; one same-lane nested descendant chain may borrow its root slot to avoid self-deadlock;
- lease, timeout, stale recovery, and crash safety;
- explicit wait/acquire/release/timeout metrics linked to attempt identity;
- app routes and every worker queue that call the central model-attempt runtime share the same capacity;
- interaction with SDK retry and pg-boss redelivery is tested so hidden multiplicative retries are not
  introduced;
- production failure behavior is bounded and documented; no infinite upstream fail-open.

No Redis, new service, per-job semaphores, intelligent routing, or manifest field explosion.

The admitted unit is not a wire request: one `sdkQuery()` may contain several model turns, SDK-native
subagents, and the Claude CLI's bounded internal retries. Direct DashScope embeddings, Mem0 fan-out,
GLM/OCR clients, Tencent OCR, and support preflights do not yet use `AiRunLifecycle`; inventorying and
migrating those paths is YUK-845. Until then, this gate must not be reported as product-wide provider
HTTP capacity control.

### Phase 0 exit gate

Phase 1 cannot begin until:

- YUK-840/841/842 are merged and exact-head CI green;
- dependency and cost/admission contracts have independent reviews with no unresolved P0/P1;
- one actual provider observation proves cost basis and admission events are emitted; it need not prove a
  product quality improvement;
- rollback paths are written, and old app/worker behavior remains available by configuration where the
  runtime change is risky.

## Phase 1 — Practice-owned failure learning

### Current chain to preserve before moving

```text
failure attempt event
  ├─ practice/api/solve-submit.ts ─┐
  ├─ ingestion/api/import.ts      ├─ raw boss.send('attribution_followup')
  ├─ ingestion/api/mistakes.ts    ┤
  └─ ingestion/server/auto-enroll.ts ┘
        ↓
knowledge/jobs/attribution_followup.ts
        ↓ knowledge/server/attribute.ts → judge event
        ↓ best-effort boss.send('variant_gen')
server/boss/handlers/variant_gen.ts
        ↓ variant_question proposal + mistake_variant draft
```

The same domain behavior is also exposed through the centrally implemented `attribute_mistake` and
`propose_variant` tools in `src/server/ai/tools/proposal-tools.ts`.

Before movement, characterization DB tests must lock:

- happy path produces at most one attribution judge and one variant proposal;
- non-failure/inactive/missing attempt skips without an LLM call;
- retryable attribution rethrows before variant fan-out;
- permanent parse failure does not redeliver and burn another model attempt;
- replay does not duplicate judge, proposal, or in-flight variant;
- proposal remains pending for human acceptance.

### Target ownership and file map

`practice` owns the full failure-learning operation:

| Target | Responsibility |
|---|---|
| `src/capabilities/practice/server/failure-learning.ts` | Typed product operation and product outcome; no pg-boss types. |
| `src/capabilities/practice/tasks/attribution.ts` | Capability-owned attribution input/output/prompt/fallback contract. |
| `src/capabilities/practice/tasks/variant-gen.ts` | Capability-owned variant input/output/prompt/fallback contract. |
| `src/capabilities/practice/jobs/attribution_followup.ts` | Thin durable adapter; stable queue name. |
| `src/capabilities/practice/jobs/variant_gen.ts` | Thin durable adapter; stable queue name. |
| `src/capabilities/practice/tools/attribute-mistake.ts` | Thin operation adapter; existing name/effect/surface retained. |
| `src/capabilities/practice/tools/propose-variant.ts` | Thin operation adapter; existing name/effect/surface retained. |
| `src/capabilities/practice/manifest.ts` | Jobs/tools ownership and loaders. |
| `src/ai/registry.ts` | Static projection of capability-owned specs; no duplicate prompt/schema truth. |

`knowledge` provides a narrow public query for bounded knowledge context. It does not own the failure job or
write practice judge/proposal semantics.

### Required deletions

The Phase 1 merge must delete, not retain as compatibility doubles:

- `src/capabilities/knowledge/jobs/attribution_followup.ts`;
- the attribution job declaration from `src/capabilities/knowledge/manifest.ts`;
- `src/server/boss/handlers/variant_gen.ts` and its legacy registrar wiring;
- concrete `attribute_mistake` / `propose_variant` implementations and direct `runVariantGen` import from
  `src/server/ai/tools/proposal-tools.ts`;
- raw `boss.send('attribution_followup')` from the four producers, replaced by one practice-owned durable
  failure-attempt subscription/enqueue port;
- duplicate registry-owned prompt/output contract after the capability specs compose successfully.

Queue names and existing jobs in flight remain compatible. A wrapper that leaves the old handler/tool code
active fails this deletion gate.

### Phase 1 exit gate

- `attempt → judge → proposal` carries exact causal IDs; proposal `caused_by_event_id` points to the judge
  rather than inventing a new root;
- replay/redelivery is idempotent and does not increase the model-call upper bound;
- attribution transient failure creates no proposal; permanent parse failure does not retry;
- non-failure never triggers the operation; accepted proposal semantics remain unchanged;
- capability/external code contains no raw send for the two queue names outside the owner adapter;
- the relevant dependency buckets decrease and the baseline tightens in the same diff; no new SCC appears;
- old central implementation files/exports are gone;
- targeted characterization exists, independent review has no unresolved P0/P1, and exact-head GitHub CI
  runs the architecture audits, unit/DB tests, typecheck/lint/build gate successfully.

Completion of this one vertical proves the ownership seam with a real product operation. It does not prove
that all 49 tasks, all tool adapters, all handoffs, or every aggregate cycle have migrated.

## Later FULL phases (scope boundary, not yet executable lanes)

### Phase 2 · Runtime/job depth

- extract the mature intent → send → completion → recovery handoff as a deep module only after two real
  adopters; first repair `note_generate → note_verify` and memory reconcile;
- make `ok / idle / degraded / stalled` a typed job/product outcome and let DAG edges declare acceptance;
- unify SDK event adaptation once, with Promise/SSE/collecting as projections rather than three terminal
  interpreters.

### Phase 3 · Quarry recut

- migrate concrete DomainTool adapters by capability while retaining one central permission matrix;
- validate every `DomainTool.outputSchema` before logging/summarizing/returning;
- migrate event read models and proposal dismiss/retract lifecycle to owners after a second real operation;
- split task semantics by owner while preserving a static catalog interface.

### Phase 4 · Exit audit

Exit requires debt trends, product-operation success/cost truth, provider admission evidence, handoff recovery,
and real deletion. A green synthetic harness or a zero deep-import access audit alone cannot close FULL.

## Global out of scope

- UI work; no UI files are touched, so the UI design pre-flight is not triggered.
- multi-user/tenant schema and auth; YUK-767 remains the separate owner signal and review checklist.
- YUK-832–836 product-content repairs; they remain PARKED, not canceled or silently closed.
- new provider wire protocols, microservices, Redis, dynamic plugins, generic workflow engines, or blanket DB
  repositories.
- changing prompts, judge policy, FSRS, provider defaults, queue names, proposal approval, or deterministic
  pre-AI behavior merely to make the migration easier.
