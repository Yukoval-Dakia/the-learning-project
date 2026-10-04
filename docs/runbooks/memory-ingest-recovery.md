# Single-event memory ingest recovery

YUK-1060 supplies an operator tool for a stalled `add_started` marker. It does
not authorize use against production or disposition of YUK-1042's eight
historical events. This change was tested with isolated Postgres and mocked
Mem0 only; no historical event was replayed.

`observe` treats a reconcile enqueue returning `null` without exact job
readback as an advisory skip. It records `reconcile_observe_skipped` with
`level: warn` and returns normally. This is not a queue receipt. The original
payload and singleton/retry settings remain unchanged. `write`, `recover`,
and `drain` still fail closed. Send failures, readback failures, and wrong
non-null acknowledgments also fail unless exact readback proves queue receipt.

## Inspect

Use the intended environment's existing credential and DATABASE_URL bindings.
Privately verify the target before running; never paste credentials into a
command or report. Help does not load environment files, DB, pg-boss, or Mem0:

```sh
pnpm exec tsx scripts/memory-ingest-recovery.ts --help
pnpm exec tsx scripts/memory-ingest-recovery.ts list --limit 50
```

`list` is read-only. It scans markers at least 120 seconds old (longer than
the handler's 65-second deadline), skips completed ingestion, and reports
source IDs, marker times, the current expected fence and known live attempts.
It never exports source text. Follow `nextAfterId` with `--after` even if a
page's candidate list is empty; completed markers still consume the page.
Listing is observational: authorization rechecks state under the source lock.

## Authorize and replay one event

After checking the ambiguous earlier provider evidence and obtaining the
required operational approval for that target/event, generate a request UUID
and supply every field below. Keep the request and arguments for retries:

```sh
pnpm exec tsx scripts/memory-ingest-recovery.ts replay \
  --event SOURCE_EVENT_ID \
  --request REQUEST_UUID \
  --expected-fence FENCE_FROM_LIST \
  --operator OPERATOR_NAME \
  --reason 'Evidence reviewed and reason to accept an ambiguous earlier add' \
  --allow-paid-replay
```

Only an existing user-originated event with a stalled marker is eligible.
The command appends `operator_replay_authorized`; this logically supersedes
the fence for this invocation without deleting any record. Reusing a request
with changed arguments or another source is rejected. A stale expected fence,
recent marker, completed source, or known live reserved attempt blocks a new
authorization. All timestamps/liveness checks use the database clock.

Replay runs the ordinary one-event ingest handler synchronously. Exact Mem0
event lookup comes first and can resolve a lost result without another add.
If lookup is empty, the grant's deterministic operation identity goes through
the existing admission and provider-start reservation. The callback checks the
current grant and writes its single `operator_add_started` marker immediately
before the SDK call. Duplicate calls for the same grant cannot pay twice;
normal worker retries never discover grants. The original completion and
reconcile-intent protocol remains in force.

The explicit paid authorization covers this ordinary pipeline: an inferred
add or edited-conjecture embedding may be followed by brief/reconcile jobs,
which can incur further cost. A previous ambiguous add may have succeeded even
if the exact lookup remains empty. There is no batch replay or automatic
clearing, and lease expiry is not proof that the earlier call did not happen.

## Failures and evidence

Retry with the same request and arguments after a transient pre-start failure.
If a provider start was reserved, including a crash before the operator marker
write, the same grant stays fenced: only exact lookup can recover it without
new authorization. To deliberately accept another ambiguous replay, inspect
the source again and use a new request plus its current fence. A newer grant
also fences a delayed older callback. Never delete the original marker or
provider attempt to unblock a retry.

Authorization and operator-start records use the existing append-only v1
handoff action, are system-originated, and carry `ingest_at` so they cannot
recursively enter extraction. Provider attempts retain reservation/terminal
evidence; ordinary ingestion retains its completion/intents/dispatch records.
No new table, HTTP route, queue or cron is introduced. The CLI closes its DB
and pg-boss clients on completion or error.
