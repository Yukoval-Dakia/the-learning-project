// YUK-1355 — judge_calibration_sample durable operation boundary (timed-model
// group reference extraction).
//
// This module is the family-specific reusable execution boundary shared by the
// retained pg-boss handler (../jobs/judge_calibration_sample.ts — the real
// runtime consumer) and the bounded DBOS migration candidate
// (src/server/durable/calibration-sample-family.ts — NOT admitted runtime).
// It preserves the family contract verbatim:
//
//   1. Kill switch JUDGE_CALIBRATION_SAMPLING_ENABLED — default OFF, read
//      through the shared runtime-flag grammar on EVERY execution. Disabled
//      means zero spend, zero events; the cron stays registered.
//   2. MF3① batch-level bare provider pre-flight — resolveTaskProvider is
//      called OUTSIDE any swallowing try/catch (the reverse of
//      vision-judge-config.ts's degrade-to-undefined is deliberate: a dead
//      second lane must fail the WHOLE run loud, never silently re-route or
//      write observations). A throw here is a desired failure mode and is NOT
//      routed through the paid-batch error hook.
//   3. The paid batch stays the readonly core's job (lazy import preserved):
//      per-item isolation, MF8 unique-index duplicate mapping, run-summary
//      event. This module adds NO provider retries, fallbacks or new writes.
//
// A `dbos` source pins the cutoff clock and summary label to scheduledAt.
// This does not freeze candidate rows or prevent paid replay. The unregistered
// DBOS candidate evaluates only the gate until durable claims exist.
// A `pg-boss` source keeps sampleDeps.now (core default: new Date()) unchanged.
//
// Part 2 (2026-10-11 continuation) adds the frozen-workset / staged-resume
// seams: per-item effect identity strictly separated from scheduler delivery
// identity, and a gated staged executor over a PROVISIONAL durable-effect
// port. The port is the explicit lane-B dependency — it has NO implementation
// here and NO production caller; see the Part 2 section comment.

import type { Provider } from '@/ai/registry';
import { getConfigFlag } from '@/core/config/store';
import { canonicalHash, stableStringify } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import { resolveTaskProvider } from '@/server/ai/providers';
import {
  JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV,
  readJudgeCalibrationConfig,
} from '../jobs/judge-calibration-config';
import type {
  JudgeCalibrationConfig,
  JudgeCalibrationSampleDeps,
  JudgeCalibrationSampleResult,
} from './judge-calibration-sample-core';

/** Producer identity of one calibration tick. */
export type CalibrationSampleTickSource =
  | { kind: 'pg-boss'; jobId: string | null }
  | { kind: 'dbos'; workflowId: string; scheduledAt: Date };

/**
 * Execution seam — identical hooks to the retained handler's historical test
 * surface (config / resolveProviderFn / runSampleFn / sampleDeps), so every
 * existing injection keeps working against the extracted operation.
 */
export interface CalibrationSampleOperationDeps {
  /** test hook: replace the env-derived config. */
  config?: JudgeCalibrationConfig;
  /** test hook: replace the pre-flight resolver (default: REAL resolveTaskProvider).
   *  Returns void — the call exists solely for its throwing side-effect, and a
   *  sync signature keeps an async test double from turning the intended
   *  handler-visible throw into a dropped promise rejection (OCR review). */
  resolveProviderFn?: (
    kind: 'SemanticJudgeTask',
    override: { provider: Provider; model: string },
  ) => void;
  /** test hook: replace the sampling core (default: lazy-imported real core). */
  runSampleFn?: (
    db: Db,
    cfg: JudgeCalibrationConfig,
    deps?: JudgeCalibrationSampleDeps,
  ) => Promise<JudgeCalibrationSampleResult>;
  /** forwarded to the real core (db tests inject runTaskInner through here). */
  sampleDeps?: JudgeCalibrationSampleDeps;
}

/** Optional caller-side reporting hooks. Pure diagnostics; never swallow. */
export interface CalibrationSampleOperationHooks {
  onDisabled?(flagEnv: string | undefined): void;
  onSampled?(result: JudgeCalibrationSampleResult): void;
  /** Called ONLY for paid-batch failures, before the rethrow that preserves the
   *  backend-visible failure (pg-boss retry / DBOS workflow error). Pre-flight
   *  and gate failures bypass this hook — the original handler's distinction. */
  onPaidBatchError?(error: unknown): void;
}

export type CalibrationSampleGate =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'enabled'; cfg: JudgeCalibrationConfig };

export type CalibrationSampleOperationOutcome =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'sampled'; source: CalibrationSampleTickSource; result: JudgeCalibrationSampleResult };

/**
 * Phase 1 — replay-safe, zero spend. Kill switch, then config, then the bare
 * MF3① pre-flight whose throw IS the failure mode. Order matches the retained
 * handler exactly.
 */
export async function readCalibrationSampleGate(
  deps: CalibrationSampleOperationDeps = {},
): Promise<CalibrationSampleGate> {
  // Dark-ship gate: default OFF. Zero spend / zero events when disabled.
  if (!getConfigFlag(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV)) {
    return {
      kind: 'disabled',
      flagEnv: process.env[JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV],
    };
  }

  const cfg = deps.config ?? readJudgeCalibrationConfig();

  // MF3① — bare pre-flight; a throw here IS the desired failure mode.
  const resolveProviderFn = deps.resolveProviderFn ?? resolveTaskProvider;
  resolveProviderFn('SemanticJudgeTask', {
    provider: cfg.rejudgeProvider as Provider,
    model: cfg.rejudgeModel,
  });

  return { kind: 'enabled', cfg };
}

/**
 * Phase 2 — the paid batch. Lazy core import preserved (unit tests inject
 * runSampleFn and never load the reconstruction chain). Errors propagate to
 * the caller; this phase never catches.
 */
export async function runCalibrationSamplePaidBatch(
  db: Db,
  cfg: JudgeCalibrationConfig,
  deps: CalibrationSampleOperationDeps = {},
): Promise<JudgeCalibrationSampleResult> {
  const runSample =
    deps.runSampleFn ?? (await import('./judge-calibration-sample-core')).runJudgeCalibrationSample;
  return runSample(db, cfg, deps.sampleDeps);
}

/** dbos sources pin the batch clock to the scheduled tick; pg-boss passes through. */
function paidBatchDeps(
  source: CalibrationSampleTickSource,
  deps: CalibrationSampleOperationDeps,
): CalibrationSampleOperationDeps {
  if (source.kind !== 'dbos') return deps;
  return {
    ...deps,
    sampleDeps: { ...deps.sampleDeps, now: () => source.scheduledAt },
  };
}

/**
 * Bind typed gate dependencies on the capability side. The DBOS candidate
 * receives only readGate and has no paid execution port.
 */
export function buildCalibrationSampleOperationPort(deps: CalibrationSampleOperationDeps = {}) {
  return { readGate: () => readCalibrationSampleGate(deps) };
}

/**
 * Composite operation — the retained handler's whole body. Gate → paid batch,
 * with reporting hooks and error rethrow preserving the backend-visible
 * failure contract (pg-boss retry; replays land on the MF8 index).
 */
export async function runCalibrationSampleOperation(
  db: Db,
  source: CalibrationSampleTickSource,
  deps: CalibrationSampleOperationDeps = {},
  hooks: CalibrationSampleOperationHooks = {},
): Promise<CalibrationSampleOperationOutcome> {
  const gate = await readCalibrationSampleGate(deps);
  if (gate.kind === 'disabled') {
    await hooks.onDisabled?.(gate.flagEnv);
    return { kind: 'disabled', flagEnv: gate.flagEnv };
  }

  let result: JudgeCalibrationSampleResult;
  try {
    result = await runCalibrationSamplePaidBatch(db, gate.cfg, paidBatchDeps(source, deps));
    await hooks.onSampled?.(result);
  } catch (error) {
    await hooks.onPaidBatchError?.(error);
    throw error;
  }
  return { kind: 'sampled', source, result };
}

// ═══════════════════════════════════════════════════════════════════════════
// Part 2 — frozen scheduled workset, per-item effect identity, staged
// resume/apply seams (2026-10-11 fix round; supersedes f007ed528).
//
// f007ed528 was rejected by the parent as a safe stage implementation. Three
// defects are fixed here; the earlier commit must NOT be cited as having had a
// real domain apply or a no-double-send guarantee:
//   1. its intent append returned void, so two processes reading the same
//      empty history could both send — reservation is now an explicit
//      compare-and-set verdict on the port (`reserveIntent`), and a lost
//      reserve NEVER sends;
//   2. its completed→applied transition was a bare marker append — echo
//      equality proves receipt integrity, NOT that the domain effect landed.
//      Application is now a REQUIRED `applyReceipt` seam returning trusted
//      application evidence; only its success marks `applied`, and a failure
//      keeps the record `completed` (recoverable, provider never re-invoked);
//   3. its workset id bound anchor+cfg but not the frozen items — the effect
//      revision now carries a freeze digest over the full ordered workset
//      (each item bound by its input digest), and a replay presenting a
//      different freeze under the same workset id is REJECTED whole.
//
// DELIVERY ≠ EFFECT. `CalibrationSampleTickSource` (Part 1) is scheduler
// DELIVERY identity: which pg-boss job / DBOS workflow delivered the tick.
// Nothing below takes it as input. Effect identity is the durable paid
// effect's own coordinates — entity (which judge event), workset revision
// (scheduled id + freeze digest), model (which second lane), input digest
// (which immutable re-judge input face).
//
// LANE B DEPENDENCY (explicit, unresolved): this port is the consumer-side
// seam for the shared durable paid-effect store owned by lane B
// (`tlp-migration-receipt-reference`, task
// migration-shared-durable-effects-implementation-20261011), which is the
// SOLE implementer of the shared atomic reserve/claim/fence protocol. The
// atomicity REQUIRED of `reserveIntent` (exactly one concurrent winner per
// effectId) is a store guarantee this lane does not and must not implement.
// The interface is PROVISIONAL until the parent relays lane B's fixed typed
// protocol, at which point it is replaced/aliased to it. Until that handoff
// the staged executor has NO production caller: the retained pg-boss handler
// keeps Part 1 behavior verbatim and the DBOS candidate stays gate-only held.
// This seam is not live admission and must not be presented as one.
//
// Resume semantics implemented here (shared invariants, parent plan):
//   • the atomic reserve happens BEFORE the physical send; the exact
//     immutable receipt follows; application follows the receipt through the
//     required apply seam only.
//   • unknown send/result outcomes are durable unresolved obligations — never
//     resent automatically, including under a later tick/workset that
//     re-selects the same entity (entity-key blocking), and never inferred
//     complete from a step checkpoint or a domain row.
//   • replay of a completed receipt compares its immutable identity echo
//     before reuse; a mismatched receipt is held, not reused, not resent.
//     Echo equality authorizes the APPLY attempt — it is never itself the
//     domain application.
//   • records are append-only; a changed revision never erases historical
//     obligations — they keep appearing in every report until discharged.
//   • no clock freshening: every record carries the frozen workset anchor, and
//     this code never reads a wall clock.
// ═══════════════════════════════════════════════════════════════════════════

/** Family discriminator mirrored from src/server/durable/calibration-sample-family.ts
 * (the capability must not import the server adapter; both literals must stay equal). */
const CALIBRATION_SAMPLE_EFFECT_FAMILY = 'judge_calibration_sample';

/** Scheduling identity of a workset: which tick (anchor) under which config.
 * This alone is NOT the effect revision — it binds no items; the revision is
 * scheduling id + freeze digest (see `CalibrationEffectIdentity`). */
export interface CalibrationWorkSetDescriptor {
  readonly anchor: Date;
  readonly cfg: JudgeCalibrationConfig;
}

export function computeCalibrationWorkSetId(desc: CalibrationWorkSetDescriptor): string {
  return `${CALIBRATION_SAMPLE_EFFECT_FAMILY}:workset:v1:${desc.anchor.toISOString()}:${canonicalHash(
    {
      batchMax: desc.cfg.batchMax,
      windowDays: desc.cfg.windowDays,
      rejudgeProvider: desc.cfg.rejudgeProvider,
      rejudgeModel: desc.cfg.rejudgeModel,
    },
  )}`;
}

/** One frozen workset member: the immutable input face captured at freeze
 * time. Produced by the core selection seam (`selectJudgeCalibrationCandidates`,
 * released to this lane by the feature owner); the payloads are kept so the
 * per-item executor feeds the SAME face on resume. */
export interface CalibrationWorkSetItem {
  readonly judgeEventId: string;
  readonly answerEventId: string;
  readonly questionId: string;
  readonly judgeRoute: string;
  readonly priorOutcome: string;
  readonly judgePayload: Record<string, unknown> | null;
  readonly answerPayload: Record<string, unknown> | null;
}

/** Digest over the frozen re-judge input face. Key-order insensitive
 * (canonical serialization); any payload/route/outcome change is a different
 * input, hence a different effect. */
export function computeCalibrationInputDigest(item: CalibrationWorkSetItem): string {
  return canonicalHash({
    answer_event_id: item.answerEventId,
    question_id: item.questionId,
    judge_route: item.judgeRoute,
    prior_outcome: item.priorOutcome,
    judge_payload: item.judgePayload ?? null,
    answer_payload: item.answerPayload ?? null,
  });
}

/** Freeze digest over the FULL ordered frozen workset — array order is part of
 * the freeze (selection order is a fact of the freeze). Binds the whole
 * workset and, through each item's input digest, every input in it. */
export function computeCalibrationFreezeDigest(items: readonly CalibrationWorkSetItem[]): string {
  return canonicalHash(items.map((item) => computeCalibrationInputDigest(item)));
}

/** Effect-side identity of ONE durable calibration re-judge. Deliberately
 * excludes scheduler delivery identity (jobId / workflowId / scheduledAt as
 * delivery): those fields appear nowhere in this type or its digest. The
 * revision coordinate is `workSetId` + `freezeDigest` together — neither alone
 * pins which frozen inputs the effect was planned against. */
export interface CalibrationEffectIdentity {
  readonly family: typeof CALIBRATION_SAMPLE_EFFECT_FAMILY;
  /** business entity: the effective judge event being re-judged. */
  readonly judgeEventId: string;
  /** scheduling identity of the owning workset. */
  readonly workSetId: string;
  /** freeze digest of the owning workset (binds the full frozen item set). */
  readonly freezeDigest: string;
  /** the pinned second lane that will execute the re-judge. */
  readonly provider: string;
  readonly model: string;
  /** digest over the frozen re-judge input face. */
  readonly inputDigest: string;
}

export function computeCalibrationEffectIdentity(input: {
  workSetId: string;
  freezeDigest: string;
  item: CalibrationWorkSetItem;
  cfg: JudgeCalibrationConfig;
}): CalibrationEffectIdentity {
  return {
    family: CALIBRATION_SAMPLE_EFFECT_FAMILY,
    judgeEventId: input.item.judgeEventId,
    workSetId: input.workSetId,
    freezeDigest: input.freezeDigest,
    provider: input.cfg.rejudgeProvider,
    model: input.cfg.rejudgeModel,
    inputDigest: computeCalibrationInputDigest(input.item),
  };
}

/** Stable id of the durable effect — a pure function of the identity above
 * and of nothing else (no delivery, no wall clock, no store state). */
export function computeCalibrationEffectId(identity: CalibrationEffectIdentity): string {
  return canonicalHash(identity);
}

/** Entity-level resend blocker: the same business entity re-selected by a
 * LATER workset is still the same obligation while any of its effects is
 * open, regardless of revision. */
export function computeCalibrationEntityKey(judgeEventId: string): string {
  return `${CALIBRATION_SAMPLE_EFFECT_FAMILY}:entity:${judgeEventId}`;
}

/** The exact immutable receipt of one executed effect. `effect` is the
 * REQUIRED identity echo: replay compares it against the stored identity
 * before the receipt may be reused — a receipt that does not echo its effect
 * is held, never reused and never resent. */
export interface CalibrationItemReceipt {
  readonly effect: CalibrationEffectIdentity;
  readonly outcome: Record<string, unknown>;
}

/** Trusted evidence that the domain application of a receipt landed (e.g. the
 * written observation anchor). Produced ONLY by the apply seam; never
 * manufactured by this module. */
export interface CalibrationApplicationReceipt {
  /** stable reference to the applied domain effect (future default: the
   * observation action + anchored judge event). */
  readonly domainRef: string;
  /** true when the apply seam found the effect already applied (idempotent
   * replay through the domain layer's own dedup). */
  readonly idempotentReplay: boolean;
  readonly detail?: Record<string, unknown>;
}

/** Why an executed item produced no observation row. Mirrors the core's
 * per-item skip faces verbatim; `unsupported` is a PAID outcome that writes no
 * row by policy (MF3②), the rest are pre-send face reconstructions. */
export type CalibrationItemSkipClassification =
  | 'missing_answer_event'
  | 'missing_input'
  | 'missing_image_refs'
  | 'missing_question'
  | 'unsupported';

export type CalibrationStagedEffectStage =
  | 'intent'
  | 'sent_unknown'
  | 'skipped'
  | 'completed'
  | 'applied';

/** One append-only durable row. `receipt` is present exactly when the stage is
 * `completed` or `applied`; `application` exactly when `applied`;
 * `classification` exactly when `skipped`. All are immutable once written.
 * `recordedAt` is always the freezing workset's anchor — never a fresh clock. */
export interface CalibrationStagedEffectRecord {
  readonly effectId: string;
  readonly entityKey: string;
  readonly identity: CalibrationEffectIdentity;
  readonly stage: CalibrationStagedEffectStage;
  readonly receipt: CalibrationItemReceipt | null;
  readonly application: CalibrationApplicationReceipt | null;
  readonly classification: CalibrationItemSkipClassification | null;
  readonly recordedAt: string;
}

/** Verdict of the atomic intent reservation. `lost` means another process won
 * the compare-and-set for this exact effectId and owns the send. */
export type CalibrationReserveOutcome =
  | { status: 'reserved' }
  | { status: 'lost'; winner: CalibrationStagedEffectRecord };

/** PROVISIONAL lane-B dependency (see the Part 2 header). The real durable
 * paid-effect store owned by lane B implements this; this lane only consumes.
 * Rows are immutable and append-only — this module never mutates, rewrites or
 * deletes a row, and never infers completion from row existence. */
export interface CalibrationStagedExecutionPort {
  /** The family's FULL durable record stream in append (chronological) order,
   * across ALL workset revisions — resume must see old obligations. */
  loadFamilyRecords(): Promise<readonly CalibrationStagedEffectRecord[]>;
  /** Atomically reserve the intent to send one effect. MUST be a
   * compare-and-set in the real store: exactly ONE concurrent caller wins per
   * effectId; every other caller receives `lost` with the winning row. A
   * void-returning append is FORBIDDEN here — it would let two processes read
   * the same empty history and both send. Store errors propagate (loud). */
  reserveIntent(record: CalibrationStagedEffectRecord): Promise<CalibrationReserveOutcome>;
  /** Append one immutable OBSERVATION row (skip / receipt / application).
   * These rows make no claim of exclusivity — exclusivity lives only in
   * `reserveIntent`. */
  appendRecord(record: CalibrationStagedEffectRecord): Promise<void>;
}

/** The per-item execution seam: EITHER a clean skip classification (no
 * observation row, terminal for this effect) OR the sent effect's exact
 * immutable receipt. Throws on failure (the orchestrator records the unknown
 * obligation). The real implementation is the released core single-item seam. */
export type ExecuteCalibrationItemFn = (
  item: CalibrationWorkSetItem,
  identity: CalibrationEffectIdentity,
) => Promise<CalibrationItemExecution>;

export type CalibrationItemExecution =
  | { kind: 'skipped'; classification: CalibrationItemSkipClassification }
  | { kind: 'sent'; receipt: CalibrationItemReceipt };

/** The REQUIRED domain-apply seam: apply an immutable receipt to the domain
 * and return trusted application evidence. ONLY its success marks `applied`;
 * a failure or throw leaves the record `completed` — recoverable on a later
 * tick with the provider NEVER re-invoked. Echo equality authorizes this
 * call; it is never itself the application. */
export type ApplyCalibrationReceiptFn = (
  receipt: CalibrationItemReceipt,
  identity: CalibrationEffectIdentity,
) => Promise<CalibrationApplicationReceipt>;

export type CalibrationItemDispositionKind =
  | 'applied_fresh'
  | 'applied_from_receipt'
  | 'applied_replay'
  | 'completed_apply_pending'
  | 'skipped'
  | 'held_unknown_send'
  | 'held_receipt_mismatch'
  | 'held_blocked_by_open_obligation'
  | 'held_duplicate_in_workset'
  | 'held_workset_freeze_mismatch'
  | 'reserved_by_other_process';

export interface CalibrationStagedItemDisposition {
  readonly judgeEventId: string;
  readonly effectId: string;
  readonly kind: CalibrationItemDispositionKind;
  readonly classification?: CalibrationItemSkipClassification;
}

/** An unresolved obligation visible in the report — persists and appears on
 * EVERY tick until discharged, including obligations frozen under older
 * workset revisions. */
export interface CalibrationOpenObligation {
  readonly effectId: string;
  readonly entityKey: string;
  readonly judgeEventId: string;
  readonly stage: 'intent' | 'sent_unknown' | 'receipt_mismatch';
  readonly workSetId: string;
}

/** A `completed` record whose application has not succeeded yet — unfinished
 * business visible on every tick; recovery re-applies from the receipt
 * without touching the provider. */
export interface CalibrationPendingApplication {
  readonly effectId: string;
  readonly judgeEventId: string;
  readonly workSetId: string;
}

export interface CalibrationStagedExecutionCounts {
  appliedFresh: number;
  appliedFromReceipt: number;
  appliedReplay: number;
  completedApplyPending: number;
  skipped: number;
  heldUnknownSend: number;
  heldReceiptMismatch: number;
  heldBlockedByOpenObligation: number;
  heldDuplicateInWorkset: number;
  heldWorksetFreezeMismatch: number;
  reservedByOtherProcess: number;
}

export interface CalibrationWorkSetFreezeMismatch {
  readonly workSetId: string;
  readonly presentedFreezeDigest: string;
  readonly recordedFreezeDigests: readonly string[];
}

export interface CalibrationStagedExecutionReport {
  readonly workSetId: string;
  readonly freezeDigest: string;
  readonly anchor: string;
  readonly dispositions: readonly CalibrationStagedItemDisposition[];
  readonly counts: CalibrationStagedExecutionCounts;
  readonly openObligations: readonly CalibrationOpenObligation[];
  readonly pendingApplications: readonly CalibrationPendingApplication[];
  /** Present exactly when this workset id was replayed with a freeze digest
   * that diverges from its recorded history — the whole workset was rejected:
   * no reserve, no send, no append. */
  readonly freezeMismatch: CalibrationWorkSetFreezeMismatch | null;
}

const DISPOSITION_COUNT_FIELD = {
  applied_fresh: 'appliedFresh',
  applied_from_receipt: 'appliedFromReceipt',
  applied_replay: 'appliedReplay',
  completed_apply_pending: 'completedApplyPending',
  skipped: 'skipped',
  held_unknown_send: 'heldUnknownSend',
  held_receipt_mismatch: 'heldReceiptMismatch',
  held_blocked_by_open_obligation: 'heldBlockedByOpenObligation',
  held_duplicate_in_workset: 'heldDuplicateInWorkset',
  held_workset_freeze_mismatch: 'heldWorksetFreezeMismatch',
  reserved_by_other_process: 'reservedByOtherProcess',
} as const satisfies Record<CalibrationItemDispositionKind, keyof CalibrationStagedExecutionCounts>;

function receiptEchoMatches(
  receipt: CalibrationItemReceipt | null,
  identity: CalibrationEffectIdentity,
): boolean {
  if (receipt === null) return false;
  return stableStringify(receipt.effect) === stableStringify(identity);
}

/** Caller-side staged input. No cfg field on purpose: the gate-approved config
 * is the ONLY config the staged workset may execute under (the pinned second
 * lane cannot be swapped by the caller). */
export interface CalibrationStagedWorkSetInput {
  readonly anchor: Date;
  readonly items: readonly CalibrationWorkSetItem[];
}

export interface CalibrationStagedExecutionInput {
  readonly workSet: CalibrationStagedWorkSetInput;
  readonly port: CalibrationStagedExecutionPort;
  readonly executeItem: ExecuteCalibrationItemFn;
  readonly applyReceipt: ApplyCalibrationReceiptFn;
}

export type CalibrationStagedOperationOutcome =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'staged'; report: CalibrationStagedExecutionReport };

/** Gated staged resume/apply execution. Same kill switch and bare second-lane
 * pre-flight as the retained path (default OFF ⇒ zero port calls, zero sends).
 * Not wired to any backend: the DBOS candidate stays held until the parent
 * relays lane B's fixed protocol. */
export async function runCalibrationStagedOperation(
  deps: CalibrationSampleOperationDeps,
  input: CalibrationStagedExecutionInput,
): Promise<CalibrationStagedOperationOutcome> {
  const gate = await readCalibrationSampleGate(deps);
  if (gate.kind === 'disabled') {
    return { kind: 'disabled', flagEnv: gate.flagEnv };
  }
  const cfg = gate.cfg;
  const workSetId = computeCalibrationWorkSetId({ anchor: input.workSet.anchor, cfg });
  const freezeDigest = computeCalibrationFreezeDigest(input.workSet.items);
  const recordedAt = input.workSet.anchor.toISOString();

  // Latest row per effectId wins (append order = chronology); all rows stay in
  // the store untouched — nothing here rewrites history.
  const records = [...(await input.port.loadFamilyRecords())];
  const latest = new Map<string, CalibrationStagedEffectRecord>();
  for (const record of records) latest.set(record.effectId, record);

  const append = async (record: CalibrationStagedEffectRecord): Promise<void> => {
    await input.port.appendRecord(record);
    latest.set(record.effectId, record);
  };

  const counts: CalibrationStagedExecutionCounts = {
    appliedFresh: 0,
    appliedFromReceipt: 0,
    appliedReplay: 0,
    completedApplyPending: 0,
    skipped: 0,
    heldUnknownSend: 0,
    heldReceiptMismatch: 0,
    heldBlockedByOpenObligation: 0,
    heldDuplicateInWorkset: 0,
    heldWorksetFreezeMismatch: 0,
    reservedByOtherProcess: 0,
  };
  const dispositions: CalibrationStagedItemDisposition[] = [];

  // Phase R1 — finish pending applications for ANY revision: a `completed`
  // row is a paid effect whose receipt exists; applying it goes ONLY through
  // the required apply seam and never touches the provider. A receipt whose
  // identity echo does not match its stored identity is held, never reused.
  // An apply failure keeps the record completed (recoverable, no resend).
  const appliedFromReceipt = new Set<string>();
  const receiptMismatch = new Set<string>();
  for (const record of [...latest.values()]) {
    if (record.stage !== 'completed') continue;
    if (!receiptEchoMatches(record.receipt, record.identity)) {
      receiptMismatch.add(record.effectId);
      continue;
    }
    // echo equality authorizes the apply attempt — it is NOT the application
    try {
      const application = await input.applyReceipt(
        record.receipt as CalibrationItemReceipt,
        record.identity,
      );
      await append({ ...record, stage: 'applied', application, recordedAt });
      appliedFromReceipt.add(record.effectId);
    } catch {
      // stays completed — a later tick retries the APPLICATION only
    }
  }

  // Entity-level blockers: any open (intent / sent-unknown) effect, or a
  // mismatched receipt awaiting adjudication, blocks NEW effects for the same
  // business entity — across revisions, across ticks.
  const blockedEntityKeys = new Set<string>();
  for (const record of latest.values()) {
    if (record.stage === 'intent' || record.stage === 'sent_unknown') {
      blockedEntityKeys.add(record.entityKey);
    } else if (receiptMismatch.has(record.effectId)) {
      blockedEntityKeys.add(record.entityKey);
    }
  }

  // Freeze-mismatch rejection: the recorded freeze digests under this
  // workset id are the accepted freezes. A later replay presenting a digest
  // outside that set is corrupt — the WHOLE workset is rejected before any
  // reserve or send.
  const recordedFreezeDigests = [
    ...new Set(
      records
        .filter((record) => record.identity.workSetId === workSetId)
        .map((record) => record.identity.freezeDigest),
    ),
  ].sort();
  const freezeMismatch: CalibrationWorkSetFreezeMismatch | null =
    recordedFreezeDigests.length > 0 && !recordedFreezeDigests.includes(freezeDigest)
      ? { workSetId, presentedFreezeDigest: freezeDigest, recordedFreezeDigests }
      : null;

  /** Fresh-effect pipeline: atomic reserve → execute → receipt → apply. A
   * lost reserve sends and appends nothing (the winner's rows are the durable
   * truth); an unknowable send becomes a durable unknown obligation; a clean
   * skip is terminal; application happens ONLY through the required apply
   * seam, and its failure keeps the record completed (recoverable, provider
   * never re-invoked). */
  const runFreshCalibrationEffect = async (
    item: CalibrationWorkSetItem,
    coords: { effectId: string; entityKey: string; identity: CalibrationEffectIdentity },
  ): Promise<{
    kind: CalibrationItemDispositionKind;
    classification?: CalibrationItemSkipClassification;
  }> => {
    const reservation = await input.port.reserveIntent({
      effectId: coords.effectId,
      entityKey: coords.entityKey,
      identity: coords.identity,
      stage: 'intent',
      receipt: null,
      application: null,
      classification: null,
      recordedAt,
    });
    if (reservation.status === 'lost') return { kind: 'reserved_by_other_process' };
    let execution: CalibrationItemExecution;
    try {
      execution = await input.executeItem(item, coords.identity);
    } catch {
      // After a won reserve, a failed or unknowable send can never be proven
      // un-sent — record the unresolved obligation (per-item isolation kept:
      // the caller continues with the next item).
      await append({
        effectId: coords.effectId,
        entityKey: coords.entityKey,
        identity: coords.identity,
        stage: 'sent_unknown',
        receipt: null,
        application: null,
        classification: null,
        recordedAt,
      });
      return { kind: 'held_unknown_send' };
    }
    if (execution.kind === 'skipped') {
      // Terminal for this effect: no observation row, no apply (the
      // classification preserves WHY, including the paid-no-row `unsupported`
      // face).
      await append({
        effectId: coords.effectId,
        entityKey: coords.entityKey,
        identity: coords.identity,
        stage: 'skipped',
        receipt: null,
        application: null,
        classification: execution.classification,
        recordedAt,
      });
      return { kind: 'skipped', classification: execution.classification };
    }
    const receipt = execution.receipt;
    if (!receiptEchoMatches(receipt, coords.identity)) {
      // The send happened but the receipt does not prove THIS effect's
      // outcome — durable unresolved obligation, never an auto-resend.
      await append({
        effectId: coords.effectId,
        entityKey: coords.entityKey,
        identity: coords.identity,
        stage: 'sent_unknown',
        receipt: null,
        application: null,
        classification: null,
        recordedAt,
      });
      return { kind: 'held_unknown_send' };
    }
    await append({
      effectId: coords.effectId,
      entityKey: coords.entityKey,
      identity: coords.identity,
      stage: 'completed',
      receipt,
      application: null,
      classification: null,
      recordedAt,
    });
    try {
      const application = await input.applyReceipt(receipt, coords.identity);
      await append({
        effectId: coords.effectId,
        entityKey: coords.entityKey,
        identity: coords.identity,
        stage: 'applied',
        receipt,
        application,
        classification: null,
        recordedAt,
      });
      return { kind: 'applied_fresh' };
    } catch {
      // stays completed — application is recoverable, the provider is never
      // re-invoked for it
      return { kind: 'completed_apply_pending' };
    }
  };

  // Phase R2 — plan the frozen items.
  const seenEntityKeys = new Set<string>();
  for (const item of input.workSet.items) {
    const identity = computeCalibrationEffectIdentity({ workSetId, freezeDigest, item, cfg });
    const effectId = computeCalibrationEffectId(identity);
    const entityKey = computeCalibrationEntityKey(item.judgeEventId);

    let kind: CalibrationItemDispositionKind;
    let classification: CalibrationItemSkipClassification | undefined;
    if (freezeMismatch !== null) {
      kind = 'held_workset_freeze_mismatch';
    } else if (seenEntityKeys.has(entityKey)) {
      kind = 'held_duplicate_in_workset';
    } else {
      seenEntityKeys.add(entityKey);
      const record = latest.get(effectId);
      if (record !== undefined) {
        if (appliedFromReceipt.has(effectId)) {
          kind = 'applied_from_receipt';
        } else if (receiptMismatch.has(effectId)) {
          kind = 'held_receipt_mismatch';
        } else if (record.stage === 'applied') {
          kind = 'applied_replay';
        } else if (record.stage === 'completed') {
          // apply already attempted (and failed) in R1 — recoverable, no resend
          kind = 'completed_apply_pending';
        } else if (record.stage === 'skipped') {
          kind = 'skipped';
          classification = record.classification ?? undefined;
        } else {
          kind = 'held_unknown_send';
        }
      } else if (blockedEntityKeys.has(entityKey)) {
        kind = 'held_blocked_by_open_obligation';
      } else {
        const fresh = await runFreshCalibrationEffect(item, { effectId, entityKey, identity });
        kind = fresh.kind;
        classification = fresh.classification;
      }
    }
    dispositions.push({ judgeEventId: item.judgeEventId, effectId, kind, classification });
    counts[DISPOSITION_COUNT_FIELD[kind]] += 1;
  }

  // Phase R3 — unresolved obligations and pending applications, including
  // those frozen under OTHER workset revisions: a changed revision must never
  // erase them.
  const openObligations: CalibrationOpenObligation[] = [];
  const pendingApplications: CalibrationPendingApplication[] = [];
  for (const record of latest.values()) {
    if (record.stage === 'intent' || record.stage === 'sent_unknown') {
      openObligations.push({
        effectId: record.effectId,
        entityKey: record.entityKey,
        judgeEventId: record.identity.judgeEventId,
        stage: record.stage,
        workSetId: record.identity.workSetId,
      });
    } else if (receiptMismatch.has(record.effectId)) {
      openObligations.push({
        effectId: record.effectId,
        entityKey: record.entityKey,
        judgeEventId: record.identity.judgeEventId,
        stage: 'receipt_mismatch',
        workSetId: record.identity.workSetId,
      });
    } else if (record.stage === 'completed') {
      pendingApplications.push({
        effectId: record.effectId,
        judgeEventId: record.identity.judgeEventId,
        workSetId: record.identity.workSetId,
      });
    }
  }

  return {
    kind: 'staged',
    report: {
      workSetId,
      freezeDigest,
      anchor: recordedAt,
      dispositions,
      counts,
      openObligations,
      pendingApplications,
      freezeMismatch,
    },
  };
}
