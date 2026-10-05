# YUK-979 — Memory failure truth from rollout acceptance

The authorized YUK-887 Memory crash acceptance failed before its intended success
checkpoint. This is a discovered implementation defect, not a completed rollout.

At 2026-09-07T17:11:18Z, real text-embedding-v4 returned HTTP200 with 101 input
tokens. The canary's local input-byte cap rejected the subsequent LLM request with
429 before sending it upstream. Mem0 3.0.13 swallowed the error and returned an
empty result; opaque attempt `17ad2633-bc79-4bd2-b2a0-5f25b0433470` was recorded
as succeeded. A deliberately held completion advisory lock prevented a misleading
ingest_completed event; the isolated process was stopped, with zero stored memories.

- Isolated DB: `loom_memory_887_actual_v2`, never production `loom`.
- Source: `canary_887_memory_crash_20260908_v1`.
- Operation: `75fd2f3a-a9c8-8ccd-9121-a271df1a47eb`.
- Runtime image: `106ac7ff`; source revision: `8f3785ea` (delivery notes only).
- Executed worker bundle SHA256: `25855e67f0c7598d653c2497e4f78e16fcd244b8d2e7451abebd25e9077a3be1`.
- Controller SHA256: `9c7ee2dbd4e1b5a858b1da4faa675fc3a2ee312cd4d8cc1ac0867824ec458a40`.
- Private result JSON SHA256: `65c35fda38d4378405fe126946c025074ed323641094fc48c213e4ebd9f38417`.
- Embedding input/output digests: `6e264b15bc85546251dab0ecf1818fdf30eae6ee54c9e61a1c4c1aaa9240d051` /
  `7e327439247523192dd3e2c50e976001f235819e5441beb948fc97b20903bbca`.

The full $1 conservative reserve remains consumed, not asserted as an invoice.
The transferred Notes/Memory allowance has $2 left; the original $10 reserve is
unchanged. No further paid call was made while fixing the defect. The preceding
container-to-host health probe failed because the controller used a synchronous
child wait; it was fixed before any provider call and cost zero.

## Correction boundary

A narrow pinned SDK patch restores failure propagation and strict existing output
schema validation in both exports. Legitimate empty extraction remains success.
Primary PGVector inserts become atomic, because partial event-id rows would make
the existing no-reburn recovery mistake incomplete output for completed work.
Batch embedding compatibility remains; history/entity enrichment stay advisory.
There is no new runtime framework or provider configuration change.

Eight real-SDK local-HTTP failure cases were RED; after patching, all 12 SDK unit
cases pass. Four DB cases pass: both PGVector exports reject partial batches with
zero rows; ingestion writes failed attempt/no completion and same-event redelivery
makes no new HTTP calls; schema-valid empty output completes and replays freely.
Final local coverage: 63 unit / 20 DB, typecheck, lint, build and architecture
gates pass. Independent initial review PASS, including 12 SDK unit cases and an
offline frozen install. PR1364 exact `32d0effbb6c6f5496101899fe7ec0c013dec2c6b`
passed every job in CI34147920619 and merged at 17:44:51Z as
`61421a4e6d61e0ad96c26c158a68956708f745ad`.

An early test used the SDK's default SQLite vector path. Its sole synthetic row
`99b2a979-cf66-4010-b95e-c064cfc153d5` (created17:15:58Z) was verified by exact text,
timestamp and payload, backed up, then deleted; other data was preserved. The test
now explicitly uses `dbPath: ':memory:'`. Backup is retained in the private
local-production evidence directory; this is not a production PG mutation.

## Mac deployment and real recovery

At 17:45Z app/worker were deployed from clean runtime `93df0528`, image SHA256
`8e041719edcac70aaea03ce54abbb4645dbef0422f5fa2191581a11b7c87619d`.
The exact CI head differs only in a handoff blank line. Both roles are healthy,
with zero restarts; original PG container/volume/start time are unchanged.
Migration added no rows, seven LearningItems passed readiness, legacy guard clear.
Production stays at 424 events / 258 tasks / 4 provider attempts, with no pending
jobs. Health/auth checks returned 200/401/200. The extra event over the earlier
423 snapshot is a prior browser brief_seen read mark, not a Memory canary write.
Rollback removes `runtime-979-image.override.yml` and returns runtime106ac7ff;
no schema rollback or legacy cron recreation is required. No NAS/tunnel changes.

A free **full shipped worker** against an isolated DB and local HTTP fixture
recorded failed attempt/no completion. Early-start SIGTERM exiting137 versus
ready-state stop exiting0 is separately captured as deferred YUK980; no production
data-loss claim and no fix for that startup window in this patch.

Memory real-provider canary v3 passed against `loom_memory_887_actual_v3`:

- Source `canary_887_memory_crash_20260908_v3`.
- One GLM5.2 call: HTTP200/stop, 7887 input + 1377 output tokens; two DashScope
  text-embedding-v4 calls: HTTP200, 101 + 60 input tokens.
- Two correct preference memories persisted; attempt
  `c3c82baa-9b19-43e4-b181-233f578dd36e` succeeded before completion was unlocked.
- Actual SIGKILL exit137, then a new process completed the same physical job
  `fa10bfb2-2847-4e7d-ae37-c722a621f4a3` through exact event lookup: identical two
  memories, unchanged attempt, exactly one completion, **zero replay HTTP calls**.
- Boundary: actual SDK/PG/component-handler worker bundle, not full shipped-worker
  recovery. Explicit boss.fail after confirmed death expedites redelivery; this
  does not prove automatic one-hour lease expiry. All canary containers are stopped.
- Free size preflight measured ~35.7KB; v3 cap64KB, at most one LLM/four embedding,
  max4096 output tokens. No raw provider reasoning or credentials persisted.

Private `memory-887-actual-v3.json` SHA256:
`080c71f26cbfa3ede497bb6304fb911c9efeb8df6cacb62f6c7c71065f1e7e4b`.
Worker bundle SHA256: `13b1d5d2cc84ea0b55b6d9a269374551d6ab02a236db2e39c8aa0a06f791b5dd`;
controller SHA256: `7b83c8c847e60a894658efd819243cb4975c67fd9f74dd146d219e4b9f6b4d10`.
The artifact retains per-request input/output digests and usage, not raw CoT.
The additional full $1 reserve remains consumed: transferred $3 allowance now has
**$1 remaining**, after the prior failed $1 reserve. These are not invoices.
YUK887 stays open for Notes and other explicitly named actual-output gaps.
