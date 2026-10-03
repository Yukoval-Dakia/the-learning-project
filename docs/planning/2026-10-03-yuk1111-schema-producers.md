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
