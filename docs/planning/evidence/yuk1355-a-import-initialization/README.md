# YUK-1355 A schema initialization repair

Base: `0b45c22f246ecb1f611abb73325b47bbe38471eb`. Sole writer in parent B. This is implementation of the DB08 failure, with offline verification only. No further correctness review, DB, testcontainers, Docker, runtime service, provider, SQL lock, PR, push or Linear operation was performed.

## Proven product cause

The real integration test imports the operation before the adapter/family. Its synchronous value-import cycle is:

`item-prior-durable-operation → knowledge-runtime → knowledge/public → kernel/read-models/failure-attempts → practice/public → item-prior-paid-effect-adapter → item-prior-durable-operation`.

Exact source paths and import lines are in `import-paths.json`; `import-paths.cjs` reproduces the source trace against the immutable base. The task runner itself uses dynamic imports; it is not the synchronous cycle edge here.

The offline regression loads that real module graph, replacing only the global DB client with a throwing guard. Historical application checks substitute only a read-chain/transaction control fake, keeping the real shared-store snapshot conversion, adapter schemas, immutable receipt validation and error wrapper. No provider function is invoked.

Before the repair, operation-first fails all three checks while adapter-, family- and public-first pass (9/12). Diagnostic output proves that the eventual exported `MAX_REPS` is **9**, but the already-created dispatch schema's `less_than` check holds **undefined**. Expanding `ItemPriorApplicationError.reason` proves the same Zod locale `.toString()` TypeError originates at `applicationSchema.parse()` in `validateItemPriorAppliedApplication`. The strict incompatible-application assertion also receives this TypeError instead of `PaidEffectApplicationConflictError`. This is a production schema initialization defect, not a fixture-only explanation.

## Narrow repair and ownership

- `item-prior-limits.ts` owns the unchanged `MAX_REPS = 9` declaration with zero runtime dependencies. Both operation and adapter import it directly. The operation reexports the same public constant, so existing callers and signatures remain compatible. Both eagerly constructed request/application schemas now receive the initialized limit. No schema constraints or receipt validators changed.
- `executeItemPriorRep` binds `work.taskName` immediately before the same runner call, inside the same try block. The census can resolve that typed identifier. Arguments, read count, guards and error handling stay equivalent.
- Operation unit tests already used a read-chain fake. Their table/column identities are now explicit offline tokens. Every original test invocation remains unchanged.
- The family test uses real Drizzle/Postgres imports. The complete file moved from `item-prior-family.unit.test.ts` to `item-prior-family.db.test.ts`, and its six cases moved to the DB partition. Its only content change is the annotation category described below. No assertion or fixture was removed or softened. The new real-entry regression belongs in the unit partition.
- Test-policy accepts `data`, not `durability`, as an invariant category. The 25 affected A test annotations now say `@invariant data`; protected outcomes and failure conditions are unchanged. This includes three new regression annotations, 12 operation-unit annotations, one moved family annotation and nine existing integration annotations. No auditor, assertion or baseline was changed.

The preexisting catalogued public-module SCC remains. The repair removes the eager limit's dependency on it; it does not hide the cycle with lazy facade exports or claim a broader architecture cleanup.

## Evidence and checks

`checks.json` records commands/results and SHA-256 receipts for compressed logs. Under Node **24.19.0** / pnpm **11.13.1**:

- A scoped units: **32/32**, including the four real entry orders × three invariants (**12/12**).
- Shared/Notes/C scoped units: **55/55**.
- Typecheck, lint and build: **PASS**. Lint reports 172 existing warnings, no errors; build retains existing bundle warnings.
- Capability boundaries: exact **428/0/48**. Architecture deepening, task census, test partition and test-policy: **PASS**. No baseline, auditor or allowlist edits.
- AST preservation: **492/493 identical**, **493/493 equivalent**. The moved limit is identical. The sole changed function is equivalent after an exact structural reversal of the census binding; no other body content is normalized. All **46** preexisting A unit/family/integration test invocations are identical. Family and integration file bytes differ only by the exact invariant-category replacement; protected shared/C/schema/production-family/job blobs are unchanged from the base.

`compare-ast.cjs`, `ast-before.json` and `ast-comparison.json` make this check reproducible. The prior 335/491/C evidence directories were not changed. Initial config/helper failures are retained as tooling receipts, separate from the successful checks.

## Parent's remaining DB window

DB08 remains the latest real-DB evidence: **28 = 10 PASS + 18 FAIL**. The original `/tmp/yuk1355-consumer-parent-db-08/db.log` remains unchanged, SHA-256 `d44cd41a58bac4ea9a7edacbb2460f3dfd581846ec1f187e8d7397fab2a8264b`; its compressed byte-exact copy is `db08-original.log.gz`.

The 18 exact red names are preserved in `db08-cases.json`. They comprise three wrapped historical application failures, one wrapped incompatible-application assertion, and 14 direct dispatch-schema failures (LLaSA; six terminal-job absent/pending cases; three cached admission/replay cases; two receipt recovery cases; two PostgreSQL job-row ordering cases). **All 18 are UNRUN on the repaired head**, as are the six cases newly assigned to the DB partition. Their real transaction/row-lock behavior is not inferred from offline success.

Focused command for the parent's next authorized DB window, using the same DB config as DB08:

```sh
PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH \
pnpm --config.verify-deps-before-run=false vitest run --config vitest.db.config.ts \
  tests/integration/item-prior-durable-member.db.test.ts \
  src/server/durable/item-prior-family.db.test.ts
```

This command was recorded, not executed. Parent owns DB acceptance and any resulting follow-up; no new review or tracker workflow was opened.
