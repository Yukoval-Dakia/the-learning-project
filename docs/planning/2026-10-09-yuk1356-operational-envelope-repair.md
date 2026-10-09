# YUK-1356 operational receipt envelope repair

The parent observed the original strict receipt case pass on `71bd476225b0f4b704132bf74278c0de84be6d1b`, then the first reconcile case fail at the canonical event write. The original logs are preserved in `/tmp/yuk1356-parent-repaired-db/{first-case.log,repair-regressions.log}` and copied into `/tmp/yuk1356-envelope-repair/`.

`writeJudgeReceipt` parses the domain receipt, then passes it to `writeEvent`. The kernel's `prepareEventInsert` projects a null cause as `undefined` before calling `parseEvent`. Family transition and reconcile schemas required literal null; disposition and ownership schemas also rejected undefined. The dedicated branch therefore failed and the reserved-action fallback rejected the write. The parent log records this exact stack. Kernel writes and reads retain their existing projections.

## Representation and scope

Only `src/core/schema/event/judge-operational-events.ts` changes in production. Null, undefined and omitted causes parse to null for transition, reconcile, disposition and ownership receipts. Transition and reconcile still reject every nonnull cause. The six execution and delivery actions retain their required nonempty causal ID without normalization. Disposition and ownership retain their existing nullable-ID domain.

Absent task and cost fields also parse to null. Their schemas remain null-only and their inferred properties stay optional for existing typed writers. Placing the null default inside the optional wrapper provides that compatibility in the installed Zod implementation. The tests verify its actual parsed output.

The parsed input, kernel-shaped projection and stored nullable row now have the same canonical hash. A supplied cause remains part of identity; normalization never removes it. Payload schemas, reserved actions, the global event union, fallback, kernel, database schema and receipt writer remain unchanged.

The new schema unit file covers all ten actions and both native and legacy disposition/ownership payloads. It calls the real `parseEvent` with the exact `prepareEventInsert` projection, compares parsed identities and hashes, exercises null/undefined/omitted fields, rejects missing or malformed run causes and nonnull transition/reconcile causes, and retains task/cost/outcome and strict payload rejection. Fixtures include nested admission and ownership evidence, multiple original members and recovery deliveries, cursor state and digests of long structured input.

No DB fixture change is needed: the original failing `repairs lost initial ack by exact lookup without refund, new identity or notification authority` case already exercises this receipt through actual `writeEvent`. That case and the original strict receipt case are preserved for parent execution.

## Author evidence and parent acceptance

This is a bounded implementation repair before the parent's remaining R2, not an independent review round. The first author run reproduced 20 failures and 21 passes across the new 41 unit cases. The repaired run passes all 48 focused units across the new schema suite and the existing operational-state suite. The initial typecheck caught task/cost property compatibility and fixture narrowing issues; its failure log remains sealed alongside subsequent final checks.

All checks use `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin` first in PATH. Exact commands, timestamps, exits, final source/diff/log hashes and fixed build copies are delivered in `/tmp/yuk1356-envelope-repair/HANDOFF.md` and its manifests. Emitted service and migration entrypoints are never executed by this writer.

Final author gates pass: 48 scoped units, `pnpm typecheck`, full `pnpm lint` with 287 existing warnings, full `pnpm build` and `git diff --check`. The successful final build follows the final schema change. All intermediate failure logs are retained.

The requested source base is `71bd476225b0f4b704132bf74278c0de84be6d1b`. Before the input snapshot, the parent committed its five documentation/board/evidence files as `29d5dc0826cc4e35f8fdd082839c321c12f62831`; production and test sources still match the requested base. That parent checkpoint is preserved and is the repair commit's parent. The writer owns only the schema, its new unit file and this document. Parent documentation and staging are preserved.

DB, process, migration, provider, browser and operational acceptance are UNRUN by this writer. Existing prepared DB cases remain UNRUN here. The parent owns the original reconcile rerun, broader suites, tracker, PLAN, remember files and the sole remaining R2. No P1 is declared resolved and no full migration pass is claimed. No new separately actionable issue was established outside this parent-assigned failure; tracker operations remain parent-owned.
