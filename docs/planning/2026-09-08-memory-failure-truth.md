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
Review, full gates and deployment are still pending.

An early test used the SDK's default SQLite vector path. Its sole synthetic row
`99b2a979-cf66-4010-b95e-c064cfc153d5` (created17:15:58Z) was verified by exact text,
timestamp and payload, backed up, then deleted; other data was preserved. The test
now explicitly uses `dbPath: ':memory:'`. Backup is retained in the private
local-production evidence directory; this is not a production PG mutation.
