# Runtime schema initialization cycle — YUK-1482

Stage: 第一天能用. Contract: the registered synchronous public-export cycle
must not re-enter item-prior runtime schema construction through a shared
failure-attempt reader. Base checked live: `8fb160ed517c85a56cabbebfe1f1a19f137e4639`.

## Scope and ownership

The registered path on that base is:

```text
item-prior-durable-operation → knowledge-runtime → knowledge/public
  → kernel/read-models/failure-attempts → practice/public
  → item-prior-paid-effect-adapter → item-prior-durable-operation
```

`EffectiveTruth`, `activeEffectiveTruth` and `getEffectiveTruths` already belong
to `kernel/events`. The shared failure reader now imports them through that
existing public entry. Its function bodies are byte-identical. Practice keeps
its compatibility exports; their outdated ownership comment is corrected.
No operation, request/application schema, receipt check, transaction, lock,
constant, API or data behavior changes. `MAX_REPS = 9` remains in the existing
zero-dependency `item-prior-limits.ts` leaf.

The [local value-import trace](evidence/yuk1482-runtime-schema-cycle/import-graph.json)
confirms all six original edges at the fixed base and removes exactly the
failure-reader → practice-public edge. The reader's current transitive local
synchronous closure contains 72 files and no `src/capabilities/` or
`src/server/` modules. It therefore cannot re-enter the item-prior runtime
through this reader. Type-only and dynamic imports are excluded explicitly.
The wider catalogued capability SCC remains outside this task; no claim of
eliminating all public-export cycles or the 428 existing dependency edges is made.

Reproduce the bounded source trace from the repository root with:

```sh
node docs/planning/evidence/yuk1482-runtime-schema-cycle/trace.cjs
```

## Runtime evidence

The original schema-capture defect had already been repaired in PR1698 by
moving the limit into its pure leaf. YUK-1482 removes the remaining registered
dependency cycle; it does not relabel that earlier repair as new work.

In a separate detached checkout of historical product commit
`0b45c22f246ecb1f611abb73325b47bbe38471eb`, the current base's unchanged
`item-prior-import-order.unit.test.ts` was copied in and selected by a temporary
Vitest config. Only the three `operation entry` cases were executed. All three
reproduced the original failure: dispatch parsing and compatible historical
application replay hit Zod's `undefined.toString()`, and an incompatible
application yielded that TypeError instead of the application conflict.
The other nine cases were skipped deliberately. An initial attempt using the
old unit include list found no tests; that tooling log is retained separately.

On this branch, the unchanged existing test passed **12/12** across operation,
adapter, family and public entry orders: valid/bounded reps, compatible
immutable history replay and the wrapped incompatible-application conflict.
Its throwing global DB guard was retained. No provider was invoked, and no
database service or private data was accessed. No new tests or test matrix were
added. These offline checks do not claim PostgreSQL transaction acceptance.

[Checks and file/log hashes](evidence/yuk1482-runtime-schema-cycle/checks.json)
bind the unchanged test, operation, adapter and limit sources. Compressed
historical/current logs are in the same evidence directory.

Local `pnpm typecheck`, `pnpm lint` (172 existing warnings, no errors),
`pnpm build`, `pnpm audit:capability-boundaries` and
`pnpm audit:architecture-deepening` passed. Dependency counts remain
**428 / 0 / 48**; no audit, baseline or allowlist changed. Node 24.19.0 and
pnpm 11.25.0 used the environment's preinstalled dependencies with
`--config.verify-deps-before-run=false` on each invocation, including nested
build commands. The initial automatic-install directory failure and unsuccessful
environment-option attempt are retained separately from the passing check logs.

## Delivery handoff

Branch: `fix/yuk-1482-runtime-schema-cycle`. Deliver as a draft PR; no merge or
deployment is authorized in this lane. Exact-head CI and review results belong
to that PR's delivery record.

PR1703 owns overlapping `PLAN.md` and `.remember/now.md` edits. This lane leaves
both files to the parent coordinator and supplies this separate handoff for
their update. Its two product paths do not overlap PR1703's changed files.

Linear capture: the original ticket and its comments, branch search and related
PR search were checked before implementation. No duplicate active repair or
new actionable follow-up was found. YUK-1482 stays open for parent review/merge;
the already catalogued wider SCC remains outside this bounded fix.
