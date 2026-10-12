# Staged family switch guard

The shared store at `403c7248682129722be0051b9fba5622540c71f3` passed
34 real PostgreSQL cases in DB05. That evidence remains unchanged.

Parent inspection of the new consumer integrations found that retained
`item_prior_backfill` and `judge_calibration_sample` handlers do not consume
persisted dispatch generations. An empty shared ledger therefore cannot prove
that changing their backend owner fences the retained driver.

The existing unsupported-family switch guard now includes both families alongside
`note_verify`. This refuses ownership changes in either direction and leaves
same-owner behavior unchanged. It does not change reservation, effect identity,
receipt comparison, unknown handling, lock order, or any runtime registration.
The guard can be removed per family only with the versioned producer/consumer,
legacy drain and cutover evidence. Default execution remains pg-boss.

Two new parameterized DB cases exercise the actual switch function: bootstrap
forward rejection leaves no control row; reverse rejection preserves the entire
existing control row; same-owner selection does not increase generation.
These new cases are prepared, not yet run. Next coordinated DB batch should
include them using test-name filter `refuses unintegrated family ownership`,
plus the separately fixed DAG and timed consumer cases. The other 34 shared
cases need not be mechanically repeated for this guard-only change.

Parent offline checks: protocol units 13/13 and typecheck passed. Logs use
`/tmp/yuk1355-switch-guard-parent-` prefixes. Independent adapter reviews remain
separate from this narrow parent integration fix; no third old-diff review is
requested.
