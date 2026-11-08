# Agency memory pipeline

- The platform adapter `src/server/ai/mem0/client.ts` owns the supported Mem0 boundary.
  One process shares one Memory per database and model. PGVector schema DDL takes
  the session lock `mem0:pgvector-init` and retries a `pg_type` name collision once.
  A failed fact search stays a failure; brief regen and practice selection catch it
  at their own boundary.
  Exact event lookup precedes opaque lifecycle acquire and fenced provider start reservation;
  only the post-reserve callback may write `add_started`, immediately before the SDK call.
  A reserved start or started marker forbids any later paid add fallback.
- `memory-reconcile-handoff*.ts` retains append-only ingest markers and their historical IDs.
  Preserve the event action, ID prefix and hash inputs: stored rows prevent duplicate paid adds.
  Provider-result completion requires a started marker; exact-lookup completion does not.
  Historical handoff kinds and completion intent digests remain readable.
- Keep external Mem0 calls outside DB transactions. The hourly outbox recovery floor
  isolates ingest and purpose recovery; brief sweep and regeneration retain their schedules.
- `scripts/memory-ingest-recovery.ts` is the explicit single-event operator exception to a stalled
  paid-start fence. Preserve original markers/attempts, append a request-id/CAS authorization, and
  give that grant its own deterministic operation anchor. Ordinary worker retries must never
  discover or consume grants. Verify the latest grant under the source lock in the post-reserve
  callback; reject known live attempts before authorizing a new grant. No automatic/batch replay.
