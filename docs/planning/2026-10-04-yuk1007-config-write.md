# YUK-1007 — atomic configuration writes and resets

The settings backend now supports PATCH `/api/admin/config` with a nonempty
`changes` array of `{action: "set", key, value}` or `{action: "clear", key}`, and
POST `/api/admin/config/reset` with a nonempty `keys` array. Both accept an optional
note and use the existing internal-token middleware. The actor is fixed to
`panel:admin`; credentials and arbitrary provider URL/key bindings are outside the
registered config keyspace.

A single transaction holds the epoch row lock, applies every mutation, appends
per-key journal revisions, then validates the final native provider/model pairs.
Any invalid pair rolls back the whole batch. Global reset revalidates task pairs
previously hidden by the pin. Reset deletes current values but preserves journal
history and monotonic revisions. Duplicate keys and unknown/unwired task/lane
scopes are rejected, including prototype property names. Existing set/clear service
contracts delegate to the same transaction.

The API composition root injects a narrow writer through observability/public;
no new capability-to-server import edge is introduced. An uninjected writer
returns 503. Success reports committed_epoch and snapshot_epoch separately;
snapshot_current only means this process observed that epoch or a newer one.
It is not a worker acknowledgement, a promise that no later writer superseded the
value, or a claim that an env-pinned value changed. Hydration failure preserves
the prior snapshot while reporting the committed write honestly.

Configured timeouts must be positive and below the shared one-hour stuck-run
threshold. The same schema rejects old invalid rows during hydration, and the
budget reader checks caller overrides/defaults before execution. The sweeper's
threshold and settlement semantics remain unchanged. Existing registry and durable
budgets remain valid. Vision lane pairs also validate image capability.

Validation starts with 11 real-Postgres regressions that fail on the base revision:
unsafe timeouts, historical oversized budgets, unknown/unwired/prototype keys,
duplicate writes, and global reset exposing a foreign task model. Service,
HTTP, startup, budget/runner and sweeper regressions pass: 314 unit / 10 files and
158 Postgres / 8 files (19 HTTP cases included), typecheck, lint (299 existing
warnings), build and all ten required audits. Independent initial review found
no P0/P1. One inherited P2 remains in YUK-1007: scoped lane/rejudge model-only
writes can skip default-provider validation; this patch does not claim to fix it.
Exact-head CI and the final-push advisory window remain delivery gates.
No UI code, production deployment or paid requests. Existing read-face P2s remain
in YUK-1007. The owner requested prioritizing the main product line over further
dependency upgrades; pi1.0.2 was delivered separately in #1534.
