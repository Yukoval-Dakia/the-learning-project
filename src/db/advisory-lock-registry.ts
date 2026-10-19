/**
 * Advisory-lock ownership registry (YUK-1577).
 *
 * This module is the single descriptive source of truth for every Postgres advisory-lock
 * family observed in production code: key template, encoding, scope, acquisition sites,
 * documented ordering edges, and release/timeout semantics. It is deliberately NOT a lock
 * framework — it issues no SQL and owns no acquisition path. Its live consumers:
 *
 *   1. `LEARNING_STATE_WRITE_LOCK` — the global learning-write lock key G is OWNED here and
 *      re-exported by `@/db/learning-state-lock` for compatibility.
 *   2. `withinSessionAdvisoryLock` (`@/db/session-advisory-lock`) fail-closed admission: a
 *      session-level lock descriptor must match a registered `sessionMatch` family before any
 *      connection is reserved, so an unregistered key surfaces as a coding error instead of an
 *      invisible fifth locking protocol.
 *
 * Evidence discipline: `sites` lists the production acquisition site(s) (path:line). `after`
 * lists ONLY ordering edges directly observed in code — a lock that is always taken first
 * (or alone) has no edges, and disjoint families never claim an order. Where the only
 * evidence is a same-transaction call sequence, the edge is stated as observed, not as a
 * global invariant. See docs/architecture/advisory-locks.md for the full narrative proof.
 *
 * Scope vocabulary: `transaction` = pg_advisory_xact_lock (auto-release at tx end);
 * `session` = pg_advisory_lock / pg_try_advisory_lock on a pinned connection (explicit
 * unlock + release); `session+transaction` = the same key pair is taken in BOTH modes by
 * different layers (e.g. an outer session lock wrapping inner xact acquisitions of the same
 * key, which is self-reentrant within that backend).
 */

export type AdvisoryLockScope = 'transaction' | 'session' | 'session+transaction';

export type AdvisoryLockEncoding =
  /** Single int4: pg_advisory_xact_lock(hashtext(<key>)). */
  | 'hashtext'
  /** Int4 pair: pg_advisory_xact_lock(hashtext(<ns>), hashtext(<key>)). */
  | 'hashtext-pair'
  /** Int8: pg_advisory_xact_lock(hashtextextended(<key>, salt)). */
  | 'hashtextextended'
  /** Bare int4 constant: pg_advisory_xact_lock(<int>). */
  | 'int-literal'
  /** Bare int4 pair: pg_advisory_xact_lock(<int>, <int>). */
  | 'int-pair-literal';

export type AdvisoryLockAcquireMode =
  /** Blocking transaction-scoped acquire. */
  | 'xact-blocking'
  /** Non-blocking transaction-scoped acquire (checked boolean). */
  | 'xact-try'
  /** Session-scoped single try on a pinned connection. */
  | 'session-try'
  /** Session-scoped try with deadline-bounded retry on a pinned connection. */
  | 'session-try-until-deadline';

export interface SessionAdvisoryLockMatch {
  /** When set, the descriptor's `namespace` must equal this. */
  readonly namespace?: string;
  /** When set, the descriptor's `key` must start with this prefix. */
  readonly keyPrefix?: string;
  /** When set, the descriptor's `key` must equal this exactly. */
  readonly keyEquals?: string;
}

export interface AdvisoryLockFamily {
  /** Canonical family name — used by `after` edges and the architecture doc. */
  readonly family: string;
  /** SQL-side key template; `<…>` marks caller-supplied segments. */
  readonly keyTemplate: string;
  readonly encoding: AdvisoryLockEncoding;
  /** Salt argument for `hashtextextended` encodings. */
  readonly hashSalt?: number;
  readonly scope: AdvisoryLockScope;
  readonly acquire: AdvisoryLockAcquireMode;
  /** Production acquisition evidence as `path:line` (tests excluded by definition). */
  readonly sites: readonly string[];
  /** Families this lock is observed acquired strictly AFTER, same critical section. */
  readonly after?: readonly string[];
  /** Admission matcher for session-scoped families (fail-closed helper lookup). */
  readonly sessionMatch?: SessionAdvisoryLockMatch;
  /** Release / timeout / failure-ownership semantics as implemented. */
  readonly release: string;
}

/**
 * Global learning-state write lock G. Every material_fsrs_state / mastery_state mutation
 * serializes on it before any row access. Owned here; re-exported by learning-state-lock.ts.
 */
export const LEARNING_STATE_WRITE_LOCK = 'learning-state:write';

/**
 * The complete observed inventory. Denominator rule: one record per distinct key
 * template/namespace, merged where sites share a key (e.g. `fsrs:<kind>:<id>` covers both
 * `fsrs:knowledge:*` and `fsrs:question:*`; `assessment-evaluation-group` covers its xact
 * pair, session pair, and the migration-0114 trigger).
 */
export const ADVISORY_LOCK_REGISTRY: readonly AdvisoryLockFamily[] = [
  // ─── Learning-state core (G + per-subject namespaces) ───────────────────────
  {
    family: 'learning-state:write',
    keyTemplate: LEARNING_STATE_WRITE_LOCK,
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/db/learning-state-lock.ts:10'],
    release:
      'tx-end. withLearningStateLock opens a real tx for Db handles and runs inline for Tx; ' +
      're-entrant within a transaction.',
  },
  {
    family: 'fsrs-subject',
    keyTemplate: 'fsrs:<kind>:<id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/mastery/state.ts:1067',
      'src/server/fsrs/state.ts:255',
      'src/server/assessment/settle.ts:1055',
      'src/server/revert/cascade-revert.ts:748',
      'src/server/advisory-locks.ts:33 (acquireSortedAdvisoryLocks)',
    ],
    after: ['learning-state:write', 'assessment-evaluation-group'],
    release:
      'tx-end; acquired in sorted string order per call set (consistent-lock-ordering ' +
      'doctrine). `fsrs:knowledge:*` shared by grading + merge-retire paths.',
  },
  {
    family: 'mastery-ability-global',
    keyTemplate: 'mastery:ability_global:<domain>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/mastery/state.ts:1369', 'src/server/revert/cascade-revert.ts:749'],
    after: ['fsrs-subject', 'learning-state:write'],
    release: 'tx-end; acquired in sorted domain order after the per-KC locks.',
  },
  {
    family: 'kc-typed',
    keyTemplate: 'kc_typed:<subject_kind>:<id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/conjectures/typed-state.ts:103',
      'src/server/conjectures/typed-state.ts:164',
      'src/server/conjectures/typed-state.ts:224',
    ],
    release: 'tx-end; sorted acquire on merge-retire; independent of mastery namespaces.',
  },
  {
    family: 'axis-state',
    keyTemplate: 'axis_state:<subject_kind>:<id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/calibration/axis-writer.ts:122',
      'src/server/calibration/axis-writer.ts:170',
    ],
    release: 'tx-end; sorted acquire on merge-retire; independent namespace.',
  },
  {
    family: 'knowledge-edge',
    keyTemplate: 'knowledge_edge:<id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/knowledge/server/edge-topology-write.ts:119',
      'src/capabilities/knowledge/server/proposals.ts:440',
      'src/capabilities/knowledge/server/proposals.ts:522',
    ],
    after: ['learning-state:write'],
    release:
      'tx-end; sorted pair acquire. Merge accept path orders: event row FOR UPDATE → G → ' +
      'knowledge rows FOR UPDATE → knowledge_edge sorted.',
  },
  {
    family: 'knowledge-create',
    keyTemplate: 'knowledge:create:<id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/knowledge/server/node-creation.ts:25'],
    release: 'tx-end.',
  },
  // ─── Assessment / evaluation group ─────────────────────────────────────────
  {
    family: 'assessment-evaluation-group',
    keyTemplate: "('assessment-evaluation-group', <evaluation_group_id>)",
    encoding: 'hashtext-pair',
    scope: 'session+transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/assessment/activate.ts:235',
      'src/server/assessment/settle.ts:1854',
      'src/capabilities/practice/server/assessment/submit.ts:355',
      'src/capabilities/practice/server/assessment/appeal.ts:41',
      'src/capabilities/practice/server/judge/evaluate-submission.ts:411',
      'src/capabilities/practice/server/judge/evaluate-submission.ts:785 (session mode)',
      'src/capabilities/practice/server/failure-learning-attribution.ts:285',
      'src/capabilities/practice/server/failure-learning-variant.ts:289',
      'src/capabilities/practice/server/review-operation.ts:421',
      'drizzle/0114_yuk1091_evaluation_group_seal.sql:9 (trigger)',
    ],
    after: ['learning-state:write', 'assessment-appeal-claim', 'assessment-review-answer'],
    sessionMatch: { namespace: 'assessment-evaluation-group' },
    release:
      'tx-end for xact mode; explicit pg_advisory_unlock + connection release for session ' +
      'mode (30s deadline in evaluate-submission). Same key pair in both modes — a backend ' +
      'holding the session lock self-acquires the xact lock re-entrantly; cross-backend the ' +
      'two modes conflict as one key.',
  },
  {
    family: 'assessment-attempt-claim',
    keyTemplate: 'evt_assessment_<submission_id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/practice/server/assessment/attempt.ts:184',
      'src/capabilities/ingestion/server/assessment-capture.ts:460 (via recordFormalAttemptCapture)',
      'src/capabilities/practice/server/assessment/paper-attempt.ts:122 (via recordFormalAttemptCapture)',
      'src/capabilities/practice/server/assessment/durable-attempt.ts:137 (via recordFormalAttemptCapture)',
    ],
    after: ['learning-state:write', 'paper-native-issuance'],
    release: 'tx-end; first-write-wins idempotent participation anchor.',
  },
  {
    family: 'assessment-appeal-claim',
    keyTemplate: 'evt_native_appeal_<hash> | evt_native_resolution_<hash> | hte(<appeal.id>, 0)',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/practice/server/assessment/appeal.ts:24',
      'src/capabilities/practice/server/assessment/appeal.ts:78',
      'src/capabilities/practice/jobs/rejudge.ts:45',
    ],
    release:
      'tx-end. rejudge.ts uses hashtextextended(<appeal.id>,0) — a distinct int8 keyspace ' +
      'entry in the same claim family.',
  },
  {
    family: 'assessment-review-answer',
    keyTemplate: 'review-answer:<evaluation_group_id>:<idempotency_key>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/review-operation.ts:399'],
    release: 'tx-end; same tx then takes the evaluation-group lock at :421.',
  },
  {
    family: 'question-request-claim',
    keyTemplate: '<request_id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/questions/submit-question.ts:607',
      'src/server/questions/edit-question.ts:584',
      'src/capabilities/practice/server/tools/submit-question.ts:282',
    ],
    release: 'tx-end; serializes request_id claim + receipt row check.',
  },
  {
    family: 'paper-native-issuance',
    keyTemplate: 'paper-native:<issuance_id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/assessment/paper-attempt.ts:87'],
    release:
      'tx-end. Observed order in paper-attempt: learning_session row FOR UPDATE → ' +
      'paper-native lock → recordFormalAttemptCapture claim.',
  },
  {
    family: 'paper-review-session',
    keyTemplate: 'paper-review-session:<paperId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/api/paper-session-create.ts:27'],
    release: 'tx-end.',
  },
  // ─── Proposals / conjectures / interventions ───────────────────────────────
  {
    family: 'proposal-decision',
    keyTemplate: 'proposal_decision:<proposalId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/proposals/applier-helpers.ts:20 (acquireProposalDecisionLock)',
      'src/capabilities/practice/server/tools/write-quiz.ts:261 (sorted batch)',
      'src/capabilities/agency/server/conjecture/probe-lifecycle.ts:796+ (via acquireProposalDecisionLock)',
    ],
    after: ['write-quiz', 'conjecture-fold'],
    release: 'tx-end.',
  },
  {
    family: 'proposal-signal',
    keyTemplate: '<kind>:<cooldown_key>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/kernel/proposals/signals.ts:33'],
    release:
      'tx-end; withProposalSignalLock opens an explicit tx when handed a bare Db so the ' +
      'lock and the rebuild upsert share one commit boundary.',
  },
  {
    family: 'write-quiz',
    keyTemplate: 'write_quiz:<taskRunId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/tools/write-quiz.ts:240'],
    release:
      'tx-end. Documented order: write_quiz advisory → proposal_decision (sorted) → ' +
      'question rows.',
  },
  {
    family: 'misconception',
    keyTemplate: 'misc:<misconceptionId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/agency/server/misconception-promote.ts:130',
      'src/capabilities/agency/server/misconception-promote.ts:245',
    ],
    release: 'tx-end; independent namespace.',
  },
  {
    family: 'intervention-instance',
    keyTemplate: 'intervention:<interventionId>:<version>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/agency/server/intervention/store.ts:352',
      'src/capabilities/agency/server/intervention/store.ts:597',
      'src/capabilities/agency/server/intervention/store.ts:757',
      'src/capabilities/agency/server/intervention/reconcile.ts:109',
    ],
    after: ['learning-state:write'],
    release: 'tx-end; taken inside withLearningStateLock in store.ts.',
  },
  {
    family: 'intervention-corrections-all',
    keyTemplate: 'intervention:corrections:all',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/kernel/events/events.ts:342',
      'src/capabilities/agency/server/intervention/probe-result-subscription.ts:115',
      'src/capabilities/agency/server/intervention/reconcile.ts:212',
      'src/capabilities/agency/server/intervention/store.ts:372',
      'src/capabilities/agency/server/intervention/store.ts:557',
    ],
    after: ['intervention-instance'],
    release: 'tx-end; serializes any correction insert with activation reads.',
  },
  {
    family: 'intervention-source',
    keyTemplate: 'intervention:source:<sourceEventId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/kernel/events/events.ts:346',
      'src/capabilities/agency/server/intervention/probe-result-subscription.ts:118',
      'src/capabilities/agency/server/intervention/reconcile.ts:215',
      'src/capabilities/agency/server/intervention/store.ts:375',
      'src/capabilities/copilot/server/review-answer-consumer.ts:47',
    ],
    after: ['intervention-corrections-all'],
    release: 'tx-end; always taken after the global corrections lock where both appear.',
  },
  {
    family: 'intervention-deliver',
    keyTemplate: 'intervention:deliver:<questionId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/intervention-diagnostics.ts:411'],
    release:
      'tx-end; taken under SET LOCAL lock_timeout=5s before the stream:compose lock at :413.',
  },
  // ─── Practice stream ───────────────────────────────────────────────────────
  {
    family: 'stream-compose',
    keyTemplate: 'stream:compose:<date>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/practice/server/stream-store.ts:90 (lockDailyStreamPartition)',
      'src/capabilities/practice/server/stream-store.ts:659 (trimStoredPendingItemsToBudget)',
      'src/capabilities/practice/server/intervention-diagnostics.ts:413',
    ],
    after: ['intervention-deliver'],
    release:
      'tx-end. Inside singleFlightCompose it is taken twice (probe + finalize txs) while the ' +
      'session-scoped stream-compose-paid lock is held — session lock serializes the expensive ' +
      'span, xact lock remains the row-partition ordering boundary vs reRank/intervention.',
  },
  {
    family: 'stream-session-partition',
    keyTemplate: 'stream:session:<sessionId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/practice/server/stream-store.ts:521 (materializeKnowledgeScopedSession)',
      'src/capabilities/practice/server/stream-store.ts:1145 (reRankAfterAnswer)',
    ],
    after: ['stream-scope'],
    release:
      'tx-end. Same streamPartitionLockKey helper emits this key when sessionId is present ' +
      '— it is the per-session physical partition of stream-compose.',
  },
  {
    family: 'stream-scope',
    keyTemplate: 'stream:scope:<date>:<knowledgeId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/stream-store.ts:509'],
    release: 'tx-end; scope-identity lock, taken before the session-partition lock.',
  },
  {
    family: 'stream-compose-paid',
    keyTemplate: 'stream:compose-paid:<date>',
    encoding: 'hashtext',
    scope: 'session',
    acquire: 'session-try-until-deadline',
    sites: [
      'src/capabilities/practice/server/compose-paid-work-lock.ts:13',
      'src/db/session-advisory-lock.ts (withinSessionAdvisoryLock mechanism)',
    ],
    sessionMatch: { keyPrefix: 'stream:compose-paid:' },
    release:
      'explicit pg_advisory_unlock + reserved.release() in finally; deadline default 30s ' +
      '(DEFAULT_COMPOSE_LOCK_WAIT_MS) → busy() ApiError 503. A failed try-lock releases its ' +
      'pool slot before 25ms backoff so unrelated queries progress.',
  },
  // ─── Durable family control plane ──────────────────────────────────────────
  {
    family: 'producer-fence-install',
    keyTemplate: 'pgboss:producer-fence:install:v1',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/durable/producer-fence-lock.ts:7',
      'src/server/durable/judge-family.ts:42 (via helper)',
      'src/server/durable/prune-family.ts:33 (via helper)',
      'src/server/durable/review-orphan-family.ts:336 (via helper)',
      'src/server/durable/session-orphan-backend.ts:336 (via helper)',
    ],
    release: 'tx-end; first lock in every family install/switch transaction.',
  },
  {
    family: 'judge-family-control',
    keyTemplate: '(1356, 1)',
    encoding: 'int-pair-literal',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/durable/judge-family.ts:43'],
    after: ['producer-fence-install'],
    release: 'tx-end.',
  },
  {
    family: 'judge-family-reconcile',
    keyTemplate: '(1356, 2)',
    encoding: 'int-pair-literal',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/jobs/judge_pending_reconcile.ts:61'],
    release: 'tx-end.',
  },
  {
    family: 'judge-obligation-claim',
    keyTemplate: '<obligation.task_id>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/durable/judge-family.ts:103'],
    release: 'tx-end.',
  },
  {
    family: 'judge-run-claim',
    keyTemplate: '<runId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/durable/judge-family.ts:443',
      'src/capabilities/practice/server/judge-operational.ts:58',
    ],
    release: 'tx-end.',
  },
  {
    family: 'judge-recorded-claim',
    keyTemplate: '<claimId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/judge/recorded-model-executor.ts:54'],
    release: 'tx-end.',
  },
  {
    family: 'prune-family-control',
    keyTemplate: '(1355, 1)',
    encoding: 'int-pair-literal',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/durable/prune-family.ts:34'],
    after: ['producer-fence-install'],
    release: 'tx-end.',
  },
  {
    family: 'review-orphan-control',
    keyTemplate: '(1393, 1)',
    encoding: 'int-pair-literal',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/durable/review-orphan-family.ts:337'],
    after: ['producer-fence-install'],
    release:
      'tx-end. Phase reads additionally take review_orphan_control FOR SHARE (row lock) ' +
      'before the tick advisory in admit/recover paths.',
  },
  {
    family: 'review-orphan-tick',
    keyTemplate: 'hte(<tickId>, 1393)',
    encoding: 'hashtextextended',
    hashSalt: 1393,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/durable/review-orphan-family.ts:133',
      'src/server/durable/review-orphan-family.ts:218',
      'src/server/durable/review-orphan-family.ts:461',
    ],
    release: 'tx-end; taken after the control-row FOR SHARE phase read.',
  },
  {
    family: 'session-orphan-install',
    keyTemplate: 'session-orphan:v1:install',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/durable/session-orphan-backend.ts:338'],
    after: ['producer-fence-install'],
    release: 'tx-end.',
  },
  {
    family: 'session-orphan-tick',
    keyTemplate: 'session-orphan:v1:<family>:<tickId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/durable/session-orphan-family.ts:191 (lockSessionOrphanTick)'],
    release:
      'tx-end; always after lockSessionOrphanControl (session_orphan_control FOR SHARE ' +
      'row lock).',
  },
  {
    family: 'paid-effect-control',
    keyTemplate: 'paid-effect:control:v1:<family>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/db/paid-effect-control.ts:27 (lockPaidEffectControlFamily)',
      'src/capabilities/practice/server/admission/resolved-repair.ts:145 (via helper)',
    ],
    release:
      'tx-end. Pinned order inside paid-effect claim: family-control advisory → identity ' +
      'row FOR UPDATE → entity advisory → control row.',
  },
  {
    family: 'paid-effect-gate',
    keyTemplate: 'paid-effect:gate:v1:<family>:<entityId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/db/paid-effect-store.ts:169 (lockEntityGate)'],
    after: ['paid-effect-control'],
    release: 'tx-end; third in the pinned claim order (after the identity row lock).',
  },
  // ─── Provider attempt lane (src/server/ai — read-only reference) ───────────
  {
    family: 'provider-attempt-operation-kind',
    keyTemplate: 'provider-attempt-operation-kind:<operationId>:<provider>:<lane>:<operationKind>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/ai/provider-attempt-lifecycle.ts:163'],
    release: 'tx-end; operation-kind fence mode only.',
  },
  {
    family: 'provider-attempt',
    keyTemplate: 'provider-attempt:<attemptId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/ai/provider-attempt-lifecycle.ts:184',
      'src/server/ai/provider-attempt-lifecycle.ts:189',
      'src/server/ai/provider-attempt-lifecycle.ts:583',
      'src/server/ai/provider-attempt-lifecycle.ts:622',
      'src/server/ai/provider-attempt-lifecycle.ts:693',
    ],
    after: ['provider-attempt-operation-kind'],
    release:
      'tx-end; under the fence path, candidate ids are sorted before acquire ' +
      '(provider-attempt-lifecycle.ts:175-185).',
  },
  {
    family: 'provider-attempt-lane',
    keyTemplate: 'provider-attempt-lane:<lane>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/ai/provider-attempt-lifecycle.ts:530',
      'src/server/ai/provider-attempt-lifecycle.ts:696',
    ],
    after: ['provider-attempt'],
    release: 'tx-end.',
  },
  {
    family: 'provider-session-admission',
    keyTemplate: 'provider-session-admission:<laneId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-try',
    sites: ['src/server/ai/provider-session-admission.ts:458'],
    release:
      'tx-end. pg_try_advisory_xact_lock under a computed lock_timeout (≤250ms ceiling); ' +
      'miss → lock_busy outcome, never blocks.',
  },
  // ─── Ingestion ─────────────────────────────────────────────────────────────
  {
    family: 'ingestion-ask',
    keyTemplate: 'ingestion-ask:<sessionId>:<item_id> | ingestion-ask:<askId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/ingestion/server/agent/asks.ts:184',
      'src/capabilities/ingestion/server/agent/asks.ts:287',
    ],
    release: 'tx-end; two key shapes in one namespace (per-item ask and per-ask answer).',
  },
  {
    family: 'ingestion-agent-run',
    keyTemplate: 'ingestion-agent-run:<sessionId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/ingestion/server/agent/ledger.ts:231'],
    release: 'tx-end; durable per-session mutual exclusion for segment writes.',
  },
  {
    family: 'ingestion-operation',
    keyTemplate: 'ingestion-operation:<sessionId>:<idempotency_key>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/ingestion/server/operation-store.ts:99'],
    release: 'tx-end; atomic reserve of the operation handle.',
  },
  {
    family: 'ingestion-operation-dispatch',
    keyTemplate: "('ingestion-operation-dispatch', <operationId>)",
    encoding: 'hashtext-pair',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/ingestion/server/operation-store.ts:189'],
    release: 'tx-end.',
  },
  {
    family: 'ingestion-import-settlement',
    keyTemplate: "('ingestion-import-settlement', <operationId>)",
    encoding: 'hashtext-pair',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/ingestion/server/import-completion.ts:582'],
    release: 'tx-end.',
  },
  {
    family: 'ingestion-paper',
    keyTemplate: 'ingestion_paper:<sessionId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/ingestion/server/make-paper.ts:178'],
    release: 'tx-end; session-keyed idempotency for paper creation.',
  },
  {
    family: 'image-candidate-accept',
    keyTemplate: 'image_candidate_accept:<proposalId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/ingestion/server/image-candidate-accept.ts:489',
      'src/capabilities/ingestion/server/image-candidate-accept.ts:914',
    ],
    release: 'tx-end; serializes proposal-accept claim + rate re-check.',
  },
  {
    family: 'image-asset-storage',
    keyTemplate: '<storageKey>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/ingestion/server/persist-image-asset.ts:37'],
    release: 'tx-end; per-asset owner-mutation protocol.',
  },
  {
    family: 'ingest-source-dedup',
    keyTemplate: 'ingest-source:<source>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/question-supply/ingest-dedup.ts:202'],
    release: 'tx-end.',
  },
  // ─── Notes / memory / copilot ──────────────────────────────────────────────
  {
    family: 'note-refine-trigger',
    keyTemplate: 'note_refine:<kind>:<artifactId>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/notes/server/note-refine-triggers.ts:102'],
    release: 'tx-end; serializes trigger job claim per (kind, artifact).',
  },
  {
    family: 'note-refine-effect',
    keyTemplate: 'note_refine:effect:<attemptEventId>:<artifactId>:mastery_change',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/notes/server/mastery-refine-effect.ts:56'],
    release: 'tx-end; causal dedupe check before the product lock.',
  },
  {
    family: 'note-refine-product',
    keyTemplate: 'note_refine:product:<artifactId>:mastery_change',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/notes/server/mastery-refine-effect.ts:73'],
    after: ['note-refine-effect'],
    release: 'tx-end; debounce/decide under the product lock after the causal lock.',
  },
  {
    family: 'note-handoff-complete',
    keyTemplate: 'notes:handoff-complete:<completionId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/notes/server/note-handoff.ts:210'],
    release: 'tx-end.',
  },
  {
    family: 'artifact-presence',
    keyTemplate: 'hte(<artifactId>, 0)',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/artifacts/presence/pg.ts:53',
      'src/capabilities/notes/server/hub-sync-reconciliation.ts:416',
      'src/capabilities/notes/server/hub-sync-reconciliation.ts:932',
    ],
    release:
      'tx-end; SHARED per-artifact key between editing-presence store and hub-sync ' +
      'finalization/repair — the same keyspace coordinates both writers.',
  },
  {
    family: 'copilot-chat-idempotency',
    keyTemplate: 'copilot-chat:<idempotencyKey>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/copilot/server/durable-dispatch.ts:197'],
    release: 'tx-end.',
  },
  {
    family: 'copilot-session-queue',
    keyTemplate: "('copilot-session-queue', <sessionId>)",
    encoding: 'hashtext-pair',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/copilot/server/durable-dispatch.ts:365'],
    release: 'tx-end.',
  },
  {
    family: 'copilot-run-dispatch',
    keyTemplate: "('copilot-run-dispatch', <runId>)",
    encoding: 'hashtext-pair',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/copilot/server/durable-dispatch.ts:519'],
    release: 'tx-end; wraps accepted→pg-boss dispatch + failure compensation.',
  },
  {
    family: 'copilot-execution-settlement',
    keyTemplate: "('copilot-execution-settlement', <runId>)",
    encoding: 'hashtext-pair',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/copilot/server/copilot-run-coordination.ts:14'],
    release: 'tx-end.',
  },
  {
    family: 'copilot-revert',
    keyTemplate: 'copilot_revert:<checkpointEventId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/copilot/api/revert-checkpoint.ts:35'],
    release: 'tx-end.',
  },
  {
    family: 'copilot-session-selection',
    keyTemplate: 'copilot:session-selection',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/session/conversation.ts:123'],
    release: 'tx-end; singleton selection lock, sole owner of the key.',
  },
  // ─── Agency / misc singletons ──────────────────────────────────────────────
  {
    family: 'research-meeting-execution',
    keyTemplate: 'research_meeting_execution:<executionId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/agency/jobs/research_meeting_nightly.ts:258'],
    release: 'tx-end; outer tx owns only the lock, inner txs do the work.',
  },
  {
    family: 'probe-serve-cap',
    keyTemplate: '4064403',
    encoding: 'int-literal',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/agency/server/conjecture/probe-lifecycle.ts:186',
      'src/capabilities/agency/server/conjecture/probe-lifecycle.ts:241',
    ],
    release: 'tx-end; global cap serialization for concurrent probe serves.',
  },
  {
    family: 'probe-question',
    keyTemplate: 'hte(<probeQuestionId>, 0)',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/agency/server/conjecture/probe-lifecycle.ts:544',
      'src/capabilities/agency/server/conjecture/probe-lifecycle.ts:631',
      'src/capabilities/agency/server/conjecture/probe-lifecycle.ts:675',
    ],
    release: 'tx-end; per-probe claim/answer/release-judge serialization.',
  },
  {
    family: 'conjecture-fold',
    keyTemplate: 'hte(<conjectureEventId>, 1)',
    encoding: 'hashtextextended',
    hashSalt: 1,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/agency/server/conjecture/probe-lifecycle.ts:796'],
    after: ['probe-question'],
    release:
      'tx-end; salt=1 keeps it disjoint from the per-question lock; taken before ' +
      'acquireProposalDecisionLock in answerProbe.',
  },
  {
    family: 'probe-result-claim',
    keyTemplate: 'hte(<probeResultEventId>, 0)',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/shell/server/teaching-brief-ack.ts:162'],
    release: 'tx-end; per-target first-write serialization for teaching-brief ack.',
  },
  {
    family: 'family-calibration',
    keyTemplate: 'family_calibration:<familyKey>',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/mastery/personalized-difficulty.ts:306'],
    release: 'tx-end.',
  },
  {
    family: 'contract-epoch-transition',
    keyTemplate: 'contract-epoch:transition',
    encoding: 'hashtext',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/contract-epoch/epoch.ts:193'],
    release: 'tx-end; serializes concurrent epoch migrators (max(seq) re-read inside).',
  },
  {
    family: 'subject-control-plane',
    keyTemplate: '597001',
    encoding: 'int-literal',
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/subjects/control-plane-lock.ts:16 (acquireControlPlaneLockSql)',
      'drizzle schema contract: src/db/schema.ts:4036 (protocol comment)',
    ],
    release: 'tx-end; every subject control-plane write tx takes it first (v3.2 §3.1).',
  },
  // ─── Serving / placement / memory stores ──────────────────────────────────
  {
    family: 'serving-command',
    keyTemplate: 'yuk1514:serving:<eventId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/capabilities/practice/server/serving-actions.ts:708'],
    release:
      'tx-end; per-Idempotency-Key command claim; the tx then takes lockAdmissionGroup ' +
      'row locks (question root → lifecycle).',
  },
  {
    family: 'placement-supply',
    keyTemplate: 'placement-supply:v1:<knowledgeId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/capabilities/practice/server/question-supply/placement-supply-lock.ts:13',
      'src/capabilities/practice/jobs/quiz_verify.ts:928 (paired admission, via helper)',
      'src/capabilities/practice/jobs/source_verify.ts:1167 (paired admission, via helper)',
    ],
    release: 'tx-end; per-KC supply scope serialization.',
  },
  {
    family: 'memory-ingest',
    keyTemplate: 'memory:ingest:<sourceId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/memory/memory-reconcile-handoff-store.ts:94',
      'src/server/memory/memory-reconcile-handoff-store.ts:161',
      'src/server/memory/memory-ingest-recovery-store.ts:39',
    ],
    release: 'tx-end.',
  },
  {
    family: 'memory-dispatch',
    keyTemplate: 'memory:dispatch:<sourceEventId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: [
      'src/server/memory/memory-reconcile-handoff-store.ts:237',
      'src/server/memory/memory-reconcile-handoff-store.ts:266',
    ],
    release: 'tx-end.',
  },
  {
    family: 'memory-operator-request',
    keyTemplate: 'memory:operator-request:<requestId>',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['src/server/memory/memory-ingest-recovery-store.ts:144'],
    release: 'tx-end.',
  },
  // ─── Session-scoped singletons outside the helper ──────────────────────────
  {
    family: 'model-slice-admission',
    keyTemplate: 'model-slice-admission:<sliceId>',
    encoding: 'hashtext',
    scope: 'session',
    acquire: 'session-try',
    sites: ['src/capabilities/practice/jobs/model_slice_admission_run.ts:211-223'],
    sessionMatch: { keyPrefix: 'model-slice-admission:' },
    release:
      'explicit pg_advisory_unlock on the pinned reserved connection (catch + log on ' +
      'failure); miss → { outcome: lock_busy }, never blocks.',
  },
  {
    family: 'migration-apply-fence',
    keyTemplate: 'yuk1050:migration-apply',
    encoding: 'hashtext',
    scope: 'session',
    acquire: 'session-try',
    sites: [
      'scripts/migration-apply.ts:314-320',
      'src/server/rehearsal/orchestrate.ts:479 (same literal)',
    ],
    sessionMatch: { keyEquals: 'yuk1050:migration-apply' },
    release:
      'explicit pg_advisory_unlock after apply; single-writer fence for migration apply ' +
      'and its rehearsal.',
  },
  // ─── Ops scripts ───────────────────────────────────────────────────────────
  {
    family: 'yuk1406-repair-operation',
    keyTemplate: 'yuk1406_select_display_label_repair',
    encoding: 'hashtextextended',
    hashSalt: 0,
    scope: 'transaction',
    acquire: 'xact-blocking',
    sites: ['scripts/yuk1406-repair-select-display.ts:1078'],
    release:
      'tx-end; operation-scoped first lock in the repair CLI transaction (serializes ' +
      'concurrent applies; joins no other lock graph).',
  },
];

const sessionFamilies = ADVISORY_LOCK_REGISTRY.filter((f) => f.sessionMatch !== undefined);

function sessionDescriptorMatches(
  lock: { key: string; namespace?: string },
  match: SessionAdvisoryLockMatch,
): boolean {
  if (match.namespace !== undefined && lock.namespace !== match.namespace) return false;
  if (match.namespace === undefined && lock.namespace !== undefined) return false;
  if (match.keyEquals !== undefined && lock.key !== match.keyEquals) return false;
  if (match.keyPrefix !== undefined && !lock.key.startsWith(match.keyPrefix)) return false;
  return true;
}

/** Registered session-advisory family for a concrete `{ key, namespace? }` descriptor. */
export function findSessionAdvisoryLockFamily(lock: {
  key: string;
  namespace?: string;
}): AdvisoryLockFamily | undefined {
  return sessionFamilies.find(
    (f) => f.sessionMatch !== undefined && sessionDescriptorMatches(lock, f.sessionMatch),
  );
}

/**
 * Fail-closed admission for the session-lock helper: every session-level lock descriptor
 * must be a registered family. Called by `withinSessionAdvisoryLock` BEFORE any connection
 * is reserved — a miss is a coding error (an unregistered fifth locking protocol), not
 * contention, so it throws immediately rather than flowing through `busy()`.
 */
export function requireSessionAdvisoryLockFamily(lock: {
  key: string;
  namespace?: string;
}): AdvisoryLockFamily {
  const family = findSessionAdvisoryLockFamily(lock);
  if (family === undefined) {
    throw new Error(
      `unregistered session advisory lock: namespace=${String(lock.namespace)} key=${lock.key}. ` +
        'Register the family in src/db/advisory-lock-registry.ts.',
    );
  }
  return family;
}
