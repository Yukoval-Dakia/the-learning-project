# YUK-1111 — schema producer audit reconciliation

The main branch and locale PR #1521 both failed the schema gate on 65 exemptions
that expired on 2026-09-30. This change removes 61 obsolete exemptions after
checking their production producers. No application/schema behavior changes.

| Group | Removed | Production evidence |
| --- | ---: | --- |
| learning_session | 3 | session lifecycle writes summary_md, started_at, ended_at |
| event | 9 | src/kernel/events/events.ts prepareEventInsert + values(rows); dispatch_seq sequence default |
| item_calibration | 3 | src/server/projections/item_calibration.ts set object + insert/upsert |
| subject_trait_journal | 3 | src/server/subjects/trait-write.ts create/revise/rollback provenance |
| event_subscription_checkpoint | 10 | src/server/event-subscriptions/runtime.ts bootstrap/claim/progress raw SQL |
| event_subscription_delivery | 17 | same runtime insert-select and update paths; discovered_at defaultNow |
| event_subscription_effect | 16 | src/capabilities/notes/server/mastery-refine-effect.ts typed insert/update |

The scanner now recognizes direct execute(sql template) INSERT and UPDATE
statements, and generated sequence/time defaults. It excludes tests and rehearsal
from the new SQL evidence. It ignores source comments, string literals, unused SQL,
value expressions, nested reads, and dynamic identifiers. Static literal defaults
remain insufficient evidence. Tests include mutations of real dispatcher/schema
sources and table-identity negatives. This is intentionally a bounded scanner,
not a SQL interpreter or a whole-program data-flow proof.

Four genuine reserved fields retain individually reviewed, dated exceptions until
2026-10-10 under YUK-1113: answer.vision_extracted, mastery_state.calibration_residual,
mastery_state.fluency_illusion_flag, event_subscription_checkpoint.paused_at. The
last had an incorrect “raw SQL writer” rationale: no production pause writer
exists. B1 residual/fluency semantics require the intended producer and consumer;
no fake null writers, field repurposing, or destructive schema deletion is used.
These four capabilities are not delivered by this change. The expiry gate stays
strict and will fail again after that date if unresolved.

Known pre-existing limit, captured as YUK-1114: the original Drizzle scanner also
counts fixtures/rehearsal and cannot resolve several object builders. Event and
item calibration producers above were manually verified in production source;
removing their exemptions does not claim the scanner proves that data flow.
Production-only scanning with bounded builder resolution is separate follow-up.

Validation: 45 scoped scanner tests passed; schema audit covers 882 fields with
zero unallowed stubs and no hygiene issues. Typecheck, lint ratchet (299 warnings,
0 infos; baseline 305), build and all documented pre-PR audits passed. Independent
review found no P0/P1. Full tests run only in exact-head GitHub CI; pending at
authoring time. No deployment or paid calls.

## Additional dependency gate blocker (YUK-1115)

Exact-head CI 37105750829 passed schema, static, all unit/DB shards, migration and
build, but then failed dependency audit on eight high advisories: seven Axios
(<1.20.0) and one Braces (<=3.0.3). Both were pre-existing Mem0 transitive paths.
Axios is constrained to the published fixed 1.20.0 release. The advised Braces
3.0.4 is not published (registry latest is 3.0.3), so no fictitious version is used.

The sole production path to Braces was mem0ai -> @types/jest -> expect ->
jest-message-util -> micromatch -> braces. Mem0 incorrectly declares its test types
as a required peer. No installed Mem0 runtime JS or declaration files import Jest;
this repository uses Vitest. A parent/version-specific pnpm override removes that
unused peer and its dependency tree. Mem0's runtime dependencies and existing
atomic/fail-closed patch are preserved. `pnpm why braces` is empty; Axios resolves
to 1.20.0. Production audit now passes with 0 high/critical (18 low/moderate remain).

Advisory review 4172134135 restates the existing fixture-evidence limitation.
It is tracked in YUK-1114 and classified non-blocking for this diff: those same
fields were already exempt from writer checks before this change; the parser
behavior is not newly weakened. The current production writers were verified.
A future deletion can still be missed by the old scanner, so this change does not
claim production-only proof. The limitation is retained as actionable follow-up.

Dependency follow-up validation: 51 Mem0 scoped unit tests, typecheck, lint ratchet
(299 warnings), and production build passed. Exact-head CI will rerun after push.
