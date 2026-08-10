# Memory server module

- `client.ts` owns the supported Mem0 boundary. Event recovery must use exact
  `getAll({filters:{user_id:'self', event_id}})` parsing and must fail closed on incomplete results.
- `memory-reconcile-handoff*.ts` owns Memory's append-only event v1 handoff. Keep external Mem0 and
  pg-boss calls outside DB transactions; DB transactions own only markers/intents/completions.
- No table, generic handoff core, or new cron: recovery is the second isolated leg of the hourly
  `memory_ingest_outbox_recover` floor.
- Modes are strict: `observe` default, `write`, `recover`, `drain`. Roll forward
  `observe -> write -> recover`; roll back `recover -> drain -> observe`.
- One source event maps to one deterministic `memory_reconcile` job preserving the existing payload
  and singleton/retry options. Exact lookup precedes opaque lifecycle acquire and fenced provider
  start reservation; only then may the post-reserve callback write `add_started`, immediately before
  the Mem0 SDK call. A reserved start or started marker forbids any later paid add fallback. Lookup
  resolution does not require a paid-start marker; provider-result resolution does.
- Recovery persists strict append-only v1 `recovery_cursor` events. Scan deterministically after the
  cursor by `(dispatch_seq,id)`, carrying bigint `dispatch_seq` across the JS boundary as a
  canonical decimal string. Wrap once without crossing the starting cursor, and preserve the
  200-scanned/50-success budget even when candidate dispatch fails.
