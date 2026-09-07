# YUK-887 — Mac-local state cutover evidence

Owner authorized direct **Mac-local production** operations on 2026-09-07. NAS is not in scope.
This is a partial local rollout record, not completion of the full architecture goal or YUK-887's
entire provider/crash-recovery matrix.

## Target and recovery

- Code baseline: `55aaac30fa82a1a5107524f13a11f3c2f6150083` (merged main).
- Existing project/container: `the-learning-project` / `the-learning-project-postgres-1`.
- Existing data volume: `the-learning-project_pgdata`; host DB: `127.0.0.1:5433/loom`.
- OrbStack was stopped; after starting it, only the existing Postgres container ran. No API/worker writers were active.
- Private backup/evidence directory: `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU`.
  Raw learner data and goldens remain outside Git.
- `loom-before.dump` SHA256: `13310b8c88e1d03b5bbc71f9b0ea2b67a55e68f1cf40788936def75054a3a040`.
  Full restore into isolated `loom_refactor_verify_sjuacu` succeeded, not just archive listing.
- `mem0-before.tar` SHA256: `67e3c5e3bd5a5b7f142ea83c101a65367ea5e377fd42ee364671187a0974dd82`.
  This is a read-only backup of the existing `the-learning-project_mem0data` volume.

## Before-rebuild evidence

The restored DB applied the existing migration runner, hydrated its subject registry, then ran
the existing B3 gate per FK cluster. Every cluster returned GO: pre-rebuild audit clean,
rebuild succeeded, and exact live row sets survived with no deletions or resurrections.
No allowlist was used. Retained goldens for all eight kinds passed their birth re-audit.

| Kind | Existing rows | Genesis added | Mac writer policy |
| --- | ---: | ---: | --- |
| knowledge | 12 | 9 | Existing ON |
| knowledge_edge | 0 | 0 | Existing ON |
| goal | 0 | 0 | Enable with this cutover |
| mistake_variant | 0 | 0 | Enable with this cutover |
| learning_item | 7 | 0 | Enable after artifact |
| artifact | 8 | 0 | Existing ON |
| question_block | 0 | 0 | Existing ON |
| item_calibration | 22 | 22 | Scheme A remains OFF |

Empty goal/variant/question-block data is not a populated production canary. The existing
per-entity B3/backfill/golden database suites supply non-empty and failure-path coverage;
their 36 cases passed. Another 77 learning-intent/import/rejudge/flywheel/proposal lifecycle
DB cases passed. These are local tests with model stubs, not new actual-model quality evidence.

## Direct live changes and checks

- Applied migrations 0094–0100: migration count 94 → 101. No table/column/data deletion.
- Both rehearsal and live seed/reconcile output: 0 new knowledge roots / 3 existing;
  0 new subjects / 0 new traits / 8 builtin trait upgrades / 16 up-to-date / 0 preserved-owner-edit skips.
- Live genesis backfill added exactly 9 knowledge + 22 item-calibration events; repeating added zero.
- Knowledge/item/artifact rows remained 12/7/8. Events grew 391 → 422; pending memory outbox stayed zero.
- Hydrated, read-only live projection audit: all eight kinds clean, zero allowed drift.
- B3/rebuild was **not** run against live. Only additive migration/trait reconciliation and genesis writes were applied.
- Newly installed legacy operation/subagent/continuation tables contain zero rows. This point-in-time
  observation alone does not certify a deployed full retry-window drain.
- Existing failed memory ingestion and its DLQ row were preserved; no manual redrive or paid call.

## Deployment and rollback boundary

Build uses a clean `git archive` of the baseline, excluding local credentials and acceptance scratch
data. Runtime image is revision-tagged `the-learning-project-app:55aaac30`.
Rendered compose was checked with explicit `-p the-learning-project`, existing external volumes
and network, and `postgres:5432/loom` in both API and worker. Default worktree-derived project names
are unsafe here. API has `RW_WORKER=0`; the separate worker owns jobs. No public tunnel is started.

The tracked Mac override sets the three additional writer flags consistently in both roles.
Rollback those flags together; if artifact must also roll back, turn learning_item OFF first.
Additive schema and genesis events are retained. Restoring the full DB backup is a separate
stop-writers recovery action, not an automatic overwrite of later learner activity.

## Completed local deployment

PR #1354 exact `0ed35fd37f84071753b42da045aa84ac334a20a4` passed all required CI jobs
in run `34108722202` and independent safety review. It merged as
`a12667507ece418e37f311a8a2e2f8936f3d1df4`; only compose configuration and evidence changed,
so the clean runtime code remains the baseline above. Local typecheck, lint and build passed.

- Image ID: `sha256:00e6595f0d590c18a0c7ecd02fa7f08c857c4fa87942665cf985260a1048cbfd`.
- Existing mem0 volume initialized after backup, then worker started before API. Both run
  healthy as non-root `node`, with zero restarts; existing Postgres was not recreated.
- API listens on `127.0.0.1:8787`; `RW_WORKER=0`. No cloudflared service was started.
- Both roles report knowledge/edge, goal, variant, learning_item, artifact and question_block
  writers ON, with item_calibration OFF.
- Post-start hydrated read-only audit again returned zero drift/allowances across all eight kinds.
- Browser authentication, visible Copilot drawer, refresh/reopen and settled summary rendered
  successfully, with no page errors. Private screenshot: `copilot-live-settled.png` in the evidence directory.
  No chat message was sent; this is not new model-output or crash-recovery acceptance.
- `ai_task_runs=258` and `provider_attempt=4` remained unchanged after startup/browser checks.
  The suspected seven historical verification recoveries were disproven by the actual dispatch
  predicates (pending=0, synthesize=0). The owner's recovery-specific additional $3 is unused.

The GitHub integration auto-completed YUK-887 at merge; it was restored to In Progress because
its broader provider/crash matrix remains incomplete. YUK-973 owns physical retirement of the
three dual-writer implementations; enabled deployment flags alone do not complete that work.
