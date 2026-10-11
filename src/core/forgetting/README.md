# Pure forgetting candidate

Implements the binding YUK-1470 `history-kernel-logistic-v1` spec at
`tlp-audit-artifacts/yuk1388/feature-acceptance/20261011/fsrs-candidate/math/`.
The copied `numeric-oracle.fixture.json` is the research lane's independent
70-digit Decimal fixture, not learner data or a fitted parameter bundle.

The entrypoint is `index.ts`. All functions use supplied time and facts. There is
no I/O, clock, randomness, model call, persistence, settlement or app consumer.
The pure core does not select the product engine. All six dynamics constants, eight mapping constants and four
schedule values are explicitly registered as engineering assumptions. Outputs
are uncalibrated scores with no estimated interval, never correctness probabilities.

## Contract

- Parse branded primitives with the exported Zod schemas. `MemoryStateSchema`
  validates persisted shape; public numerical functions also check numbers,
  versions, receipt identity and projection consistency.
- `adaptEvidence` merges score leaves into one observation per skill. It preserves
  missing guess/confidence modifiers as mapping notes, records judge revision,
  excludes unsupported judgments and retains unattributed scoring. The v2 mapping also admits `self_report` at engineering weight 0.1 with `independent=false`; unknown help remains excluded. Original
  evidence, help/confidence/guess/duration snapshots and process refs remain
  caller-owned immutable facts; the adapter never rewrites them.
- `evolve` appends one already resolved effective observation to a global or
  matching context projection. It requires a matching previous input digest and
  strictly increasing order key, with nondecreasing occurrence time. An exact
  current receipt retry returns `duplicate`. Conflicts and older inputs require
  replay. `lastApplied` retains one normalized input for duplicate verification;
  it is not another event history.
- `retention` reads now and caller-ordered future offsets without changing state.
  Context reads shrink rather than add global and context evidence. A historical
  read cannot acquire future evidence by requesting future offsets.
- `due` finds the first score crossing at or after asOf, using the supplied horizon
  capped at 365 fixed days. It returns the right side within one second and checks
  the rounded integer-millisecond result. `beyond_horizon` means no crossing in
  the checked interval, not no finite mathematical crossing.
- `replay` starts cold and consumes caller-resolved effective facts in stable key
  order, filtering occurrence time and recorded knowledge sequence. The resolver
  owns judgment authority, withdrawal selection and revision selection. Supplied
  digest receipts must describe the selected history after both cutoffs. If
  filtering creates a gap in a precomputed receipt chain, replay explicitly
  returns `rebuild_required`; the caller must regenerate canonical fact receipts
  for that selected history. No float-output digests are manufactured here.
- `fallbackSchedule` has no state/model dependency. `arrange` preserves modelDue
  while applying completion cooldown and explicit user dates. Stable sorting uses
  due time then skill ID. `applyUserCorrection` keeps the effective owner's
  assertion and conflicting evidence separate from memory, with an optional
  deterministic check. Only the caller's explicit correction resolver can remove
  or replace that overlay.

## Spec resolutions

1. The spec does not choose the application's epoch domain. This module accepts
   safe integer milliseconds within ECMAScript's Date range, including pre-epoch
   dates. Differences must also be safe integers. Fractional-millisecond offsets
   are rejected rather than silently rounded.
2. The spec leaves the concrete order-key version/encoding to the resolver. This
   module registers `effective-order-lexicographic-v1`; keys must encode occurrence
   time, stable source order, and immutable attempt tie-break in byte-sortable
   order. Comparison uses JavaScript lexicographic comparison, so callers must use
   ASCII keys. It does not infer real ordering or normalize context tags.
3. State uses explicit `schemaVersion=memory-kernel-state-v1`, a total event count,
   and the last normalized observation in addition to the minimal signature
   sketch. These support version admission, numeric-count limits and exact retry
   verification. The effective-order high watermark is `through`; recorded
   knowledge cutoff belongs to the caller's sealed replay/prediction metadata.
4. Digests remain opaque caller-supplied canonical fact identifiers. The core
   checks the receipt chain and exact current observation, but cannot certify
   that an external digest actually hashes the claimed historical facts. Older
   duplicate validation requires the caller's effective history or a full replay.
5. Missing parameter/view payloads produce unknown reads. When no version tuple
   can be decoded, retention's envelope carries this validator's expected
   registered versions; its unknown points are not a claim that those parameters
   were applied. Fallback does not read that envelope.

The suite checks the independent 25-review/180-day numerical oracle, monotonic
reads, context shrinkage, first success/failure, same-time brushing, partial scores,
correction/withdrawal replay, cutoff leakage, duplicate/conflict behavior,
missing inputs, invalid numbers, numeric limits, due horizons and fallback.
It also protects against the DAS3H window-expiry increase and HLR post-practice
certainty counterexamples. Fixed gains, two decay scales, difficulty-blind failure
penalties and engineering weights remain model limitations. Passing these tests
proves numerical behavior only, not predictive accuracy or learning benefit.
