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
//   3. The paid batch stays the retained core's job (lazy import preserved):
//      per-item isolation, MF8 unique-index duplicate mapping, run-summary
//      event. This module adds NO provider retries, fallbacks or new writes.
//
// A `dbos` source pins the cutoff clock and summary label to scheduledAt.
// This does not freeze candidate rows or prevent paid replay. The unregistered
// DBOS candidate evaluates only the gate until durable claims exist.
// A `pg-boss` source keeps sampleDeps.now (core default: new Date()) unchanged.
//
// The explicitly dispatched staged operation below consumes the fixed shared
// store. The retained handler and unregistered gate-only candidate still use
// Part 1; parent owns producer integration and runtime admission.

import { z } from 'zod';
import type { Provider } from '@/ai/registry';
import { getConfigFlag } from '@/core/config/store';
import { canonicalHash, stableStringify } from '@/core/migration/canonical';
import {
  type PaidEffectIdentity,
  type PaidEffectInput,
  PaidEffectProtocolError,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import type { PaidEffectSnapshot } from '@/db/paid-effect-store';
import { resolveTaskProvider } from '@/server/ai/providers';
import {
  JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV,
  readJudgeCalibrationConfig,
} from '../jobs/judge-calibration-config';
import {
  type CalibrationSampleDispatch,
  type CalibrationSendLease,
  admitCalibrationStoreDispatch,
  applyCalibrationStoreReceipt,
  calibrationSampleDispatchSchema,
  calibrationStoreApplicationSchema,
  markCalibrationStoreUnknown,
  prepareCalibrationStoreWorkSet,
  readCalibrationStoreObligations,
  readCalibrationStoredInput,
  recordCalibrationStoreResult,
  reserveCalibrationStoreEffect,
} from './calibration-sample-store';
import type {
  JudgeCalibrationConfig,
  JudgeCalibrationRejudgeFace,
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

// Frozen workset and shared-store consumer. Historical R1/R2 covered the
// frozen core faces; this integration requires its own later parent review.

/** Reviewed family discriminator, unchanged by shared-store integration. */
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

/** One frozen workset member: the FULL prepared input face captured at freeze
 * time (R1 P1b) — the exact runner inputs (question row, subject profile,
 * answer text/images), produced by the core freeze seam
 * (`freezeCalibrationWorkSetFromCandidates`). Execution consumes ONLY this
 * face and never re-reads the mutable business rows. */
export interface CalibrationWorkSetItem {
  readonly judgeEventId: string;
  readonly answerEventId: string;
  readonly questionId: string;
  readonly judgeRoute: string;
  readonly priorOutcome: JudgeCalibrationRejudgeFace['priorOutcome'];
  readonly answerMd: string;
  readonly studentImageRefs: readonly string[];
  /** the frozen question row (JSON shape of the DB row) — exact runner input. */
  readonly question: JudgeCalibrationRejudgeFace['question'];
  /** the frozen subject profile — exact runner input. */
  readonly subjectProfile: JudgeCalibrationRejudgeFace['subjectProfile'];
  /** judge-event created_at (ISO) — freeze metadata for candidate
   * reconstruction, deliberately NOT part of the input digest (the re-judge
   * input face does not depend on it, and it is immutable per event). */
  readonly judgeCreatedAt: string;
}

/** Digest over the FULL frozen re-judge input face (R1 P1b): question
 * content, subject profile, answer face, route and prior outcome. Key-order
 * insensitive (canonical serialization); any edit to the question/profile or
 * any face-field change is a different input, hence a different effect. */
export function computeCalibrationInputDigest(item: CalibrationWorkSetItem): string {
  return canonicalHash(calibrationInputFace(item));
}

function calibrationInputFace(item: CalibrationWorkSetItem) {
  return {
    answer_event_id: item.answerEventId,
    question_id: item.questionId,
    judge_route: item.judgeRoute,
    prior_outcome: item.priorOutcome,
    answer_md: item.answerMd,
    student_image_refs: item.studentImageRefs,
    question: item.question,
    subject_profile: item.subjectProfile,
  };
}

/** Freeze digest over the FULL ordered frozen workset — array order is part of
 * the freeze (selection order is a fact of the freeze). Binds the whole
 * workset and, through each item's input digest, every input in it. */
export function computeCalibrationFreezeDigest(items: readonly CalibrationWorkSetItem[]): string {
  return canonicalHash(
    items.map((item) => ({
      judgeEventId: item.judgeEventId,
      inputDigest: computeCalibrationInputDigest(item),
    })),
  );
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

/** Trusted evidence that the domain application of a receipt landed.
 * Produced ONLY by the apply seam. Only `written` discharges the obligation;
 * a unique conflict stays pending for immutable comparison/adjudication.
 * `write` is honest about what the domain layer proved: 'unique_duplicate'
 * means the MF8 partial-unique index rejected a second row — it does NOT
 * claim the pre-existing domain row matches this receipt. */
export interface CalibrationApplicationReceipt {
  /** stable reference to the applied domain effect (the observation action +
   * anchored judge event). */
  readonly domainRef: string;
  readonly write: 'written' | 'unique_duplicate';
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

/** Workset preparation time. Execution records its own send-start timestamp;
 * recovery receives the original anchor and reads sample time from the receipt. */
export interface CalibrationStagedSeamContext {
  readonly anchor: Date;
  readonly lease?: CalibrationSendLease;
  readonly transaction?: Tx;
}

/** The per-item execution seam: EITHER a clean skip classification (no
 * observation row, terminal for this effect) OR the sent effect's exact
 * immutable receipt. Throws on failure (the orchestrator records the unknown
 * obligation). The real implementation is the released core single-item seam
 * — see buildCalibrationStagedCoreSeams. */
export type ExecuteCalibrationItemFn = (
  item: CalibrationWorkSetItem,
  identity: CalibrationEffectIdentity,
  ctx: CalibrationStagedSeamContext,
) => Promise<CalibrationItemExecution>;

export type CalibrationItemExecution =
  | { kind: 'skipped'; classification: CalibrationItemSkipClassification }
  | { kind: 'sent'; receipt: CalibrationItemReceipt };

/** The REQUIRED domain-apply seam: apply an immutable receipt to the domain
 * and return trusted application evidence. ONLY its success marks `applied`;
 * a failure or throw leaves the shared row `receipt_ready` — recoverable on a later
 * tick with the provider NEVER re-invoked. Echo equality authorizes this
 * call; it is never itself the application. */
export type ApplyCalibrationReceiptFn = (
  receipt: CalibrationItemReceipt,
  identity: CalibrationEffectIdentity,
  ctx: CalibrationStagedSeamContext,
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
  readonly sharedIdentity: PaidEffectIdentity;
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
  readonly stored: PaidEffectSnapshot;
  readonly workSetId: string;
}

/** A `receipt_ready` row whose application has not succeeded yet — unfinished
 * business visible on every tick; recovery re-applies from the receipt
 * without touching the provider. */
export interface CalibrationPendingApplication {
  readonly stored: PaidEffectSnapshot;
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
  readonly database: Db;
  readonly dispatch: CalibrationSampleDispatch;
  readonly leaseExpiresAt: Date;
  readonly workSet: CalibrationStagedWorkSetInput;
  /** Test-only execution/application seams; the default binds the real core. */
  readonly seams?: CalibrationStagedCoreSeams;
}

export type CalibrationStagedOperationOutcome =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'staged'; report: CalibrationStagedExecutionReport };

const CalibrationEffectSchema = z.strictObject({
  family: z.literal(CALIBRATION_SAMPLE_EFFECT_FAMILY),
  judgeEventId: z.string().min(1),
  workSetId: z.string().min(1),
  freezeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const CalibrationConfigSchema = z.strictObject({
  rejudgeProvider: z.string().min(1),
  rejudgeModel: z.string().min(1),
  batchMax: z.number().int().positive(),
  windowDays: z.number().int().positive(),
});
const CalibrationPreparedInputSchema = z.object({
  answer_event_id: z.string().min(1),
  question_id: z.string().min(1),
  judge_route: z.string().min(1),
  prior_outcome: z.enum(['correct', 'partial', 'incorrect']),
  answer_md: z.string(),
  student_image_refs: z.array(z.string()),
  question: z.record(z.string(), z.unknown()),
  subject_profile: z.record(z.string(), z.unknown()),
});
const CalibrationFrozenIntentSchema = z.strictObject({
  version: z.literal(1),
  workSetId: z.string().min(1),
  freezeDigest: z.string(),
  anchor: z.iso.datetime(),
  config: CalibrationConfigSchema,
  effect: CalibrationEffectSchema,
  members: z.array(z.strictObject({ judgeEventId: z.string().min(1), inputDigest: z.string() })),
  prepared_input: CalibrationPreparedInputSchema,
});
const CalibrationStoredResultSchema = z.strictObject({
  version: z.literal(1),
  identity: paidEffectIdentitySchema,
  execution: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('sent'),
      receipt: z.strictObject({
        effect: CalibrationEffectSchema,
        outcome: z.record(z.string(), z.unknown()),
      }),
    }),
    z.strictObject({
      kind: z.literal('skipped'),
      classification: z.enum([
        'missing_answer_event',
        'missing_input',
        'missing_image_refs',
        'missing_question',
        'unsupported',
      ]),
    }),
  ]),
});
function calibrationStoreCoordinates(effect: CalibrationEffectIdentity) {
  return {
    family: effect.family,
    entityId: effect.judgeEventId,
    entityRevision: `${effect.workSetId}:freeze:${effect.freezeDigest}`,
    unit: `rejudge:${encodeURIComponent(effect.provider)}/${encodeURIComponent(effect.model)}`,
  };
}

/** The shared digest covers the full frozen envelope; the family digest still
 * identifies the unchanged prepared runner face. Delivery is excluded from both. */
export function buildCalibrationStoreInput(input: {
  item: CalibrationWorkSetItem;
  items: readonly CalibrationWorkSetItem[];
  anchor: Date;
  cfg: JudgeCalibrationConfig;
}): PaidEffectInput {
  const workSetId = computeCalibrationWorkSetId(input);
  const freezeDigest = computeCalibrationFreezeDigest(input.items);
  const effect = computeCalibrationEffectIdentity({ ...input, workSetId, freezeDigest });
  // Normalize DB Dates to the same JSON representation the reviewed family
  // digest uses. Shared canonicalization then rejects any remaining lossy value.
  const envelope: unknown = JSON.parse(
    stableStringify({
      version: 1,
      workSetId,
      freezeDigest,
      anchor: input.anchor.toISOString(),
      config: input.cfg,
      effect,
      members: input.items.map((item) => ({
        judgeEventId: item.judgeEventId,
        inputDigest: computeCalibrationInputDigest(item),
      })),
      prepared_input: calibrationInputFace(input.item),
    }),
  );
  CalibrationFrozenIntentSchema.parse(envelope);
  return { ...calibrationStoreCoordinates(effect), input: envelope };
}

function readFrozenCalibrationIntent(raw: unknown, identity: PaidEffectIdentity) {
  const frozen = CalibrationFrozenIntentSchema.parse(raw);
  if (
    !paidEffectJsonEquals(
      computePaidEffectIdentity({
        ...calibrationStoreCoordinates(frozen.effect),
        input: raw,
      }),
      identity,
    ) ||
    computeCalibrationWorkSetId({ anchor: new Date(frozen.anchor), cfg: frozen.config }) !==
      frozen.workSetId ||
    canonicalHash(frozen.members) !== frozen.freezeDigest ||
    frozen.effect.workSetId !== frozen.workSetId ||
    frozen.effect.freezeDigest !== frozen.freezeDigest ||
    frozen.effect.provider !== frozen.config.rejudgeProvider ||
    frozen.effect.model !== frozen.config.rejudgeModel ||
    canonicalHash(frozen.prepared_input) !== frozen.effect.inputDigest ||
    !frozen.members.some(
      (item) =>
        item.judgeEventId === frozen.effect.judgeEventId &&
        item.inputDigest === frozen.effect.inputDigest,
    )
  ) {
    throw new PaidEffectProtocolError('calibration stored input provenance mismatch');
  }
  return frozen;
}

function readStoredCalibrationResult(
  raw: unknown,
  identity: PaidEffectIdentity,
  frozenInput: unknown,
) {
  const frozen = readFrozenCalibrationIntent(frozenInput, identity);
  const result = CalibrationStoredResultSchema.parse(raw);
  if (!paidEffectJsonEquals(result.identity, identity)) {
    throw new PaidEffectProtocolError('calibration result shared identity mismatch');
  }
  if (result.execution.kind === 'sent') {
    const receipt = result.execution.receipt;
    const saved = CalibrationRecordedOutcome.parse(receipt.outcome);
    if (
      !receiptEchoMatches(receipt, frozen.effect) ||
      !paidEffectJsonEquals(saved.prepared_input, frozen.prepared_input) ||
      !paidEffectJsonEquals(saved.config, frozen.config) ||
      saved.workset_anchor !== frozen.anchor
    ) {
      throw new PaidEffectProtocolError('calibration receipt provenance mismatch');
    }
  }
  return { frozen, execution: result.execution };
}

/** Concrete shared-store consumer. No registration or default backend change.
 * The persisted original dispatch generation, not a consume-time control read,
 * fences every intent/claim. DBOS steps are never ownership evidence. */
export async function runCalibrationStagedOperation(
  deps: CalibrationSampleOperationDeps,
  input: CalibrationStagedExecutionInput,
): Promise<CalibrationStagedOperationOutcome> {
  const gate = await readCalibrationSampleGate(deps);
  if (gate.kind === 'disabled') return { kind: 'disabled', flagEnv: gate.flagEnv };
  const cfg = { ...gate.cfg };
  const dispatch = calibrationSampleDispatchSchema.parse(input.dispatch);
  const anchor = new Date(input.workSet.anchor);
  if (
    dispatch.scheduledAt !== anchor.toISOString() ||
    !Number.isFinite(input.leaseExpiresAt.getTime()) ||
    input.leaseExpiresAt <= new Date()
  ) {
    throw new PaidEffectProtocolError('calibration dispatch anchor/lease mismatch');
  }
  const items = structuredClone(input.workSet.items);
  const workSetId = computeCalibrationWorkSetId({ anchor, cfg });
  const freezeDigest = computeCalibrationFreezeDigest(items);
  const database = input.database;

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
  const recovered = new Map<
    string,
    {
      effect: CalibrationEffectIdentity;
      sharedIdentity: PaidEffectIdentity;
      classification?: CalibrationItemSkipClassification;
    }
  >();
  const mismatched = new Set<string>();
  const recoveryPending = new Set<string>();
  const key = (identity: PaidEffectIdentity) => computePaidEffectInputDigest(identity);

  await admitCalibrationStoreDispatch(database, dispatch);
  const seams =
    input.seams ?? (await buildCalibrationStagedCoreSeams(database, cfg, deps.sampleDeps));

  const applyKnown = async (identity: PaidEffectIdentity) =>
    applyCalibrationStoreReceipt(database, identity, async (transaction, raw, frozenInput) => {
      const saved = readStoredCalibrationResult(raw, identity, frozenInput);
      if (saved.execution.kind === 'skipped')
        return { write: 'skipped', classification: saved.execution.classification };
      const application = await seams.applyReceipt(saved.execution.receipt, saved.frozen.effect, {
        anchor: new Date(saved.frozen.anchor),
        transaction,
      });
      if (application.write !== 'written') {
        throw new PaidEffectProtocolError(
          'calibration unique duplicate requires immutable adjudication',
        );
      }
      return { domainRef: application.domainRef, write: 'written' };
    });

  // Recover actual receipt_ready rows across every revision before planning
  // this tick. A current workset cannot replace the T1 input/config/time.
  for (const row of await readCalibrationStoreObligations(database)) {
    if (row.state !== 'receipt_ready') continue;
    try {
      const frozenInput = await readCalibrationStoredInput(database, row.identity);
      const saved = readStoredCalibrationResult(row.result, row.identity, frozenInput);
      const result = await applyKnown(row.identity);
      if (result.kind === 'applied') {
        calibrationStoreApplicationSchema.parse(result.application);
        recovered.set(row.identity.entityId, {
          effect: saved.frozen.effect,
          sharedIdentity: row.identity,
          classification:
            saved.execution.kind === 'skipped' ? saved.execution.classification : undefined,
        });
      } else recoveryPending.add(key(row.identity));
    } catch {
      mismatched.add(key(row.identity));
    }
  }

  const plannedEntities = new Set<string>();
  const effects = items
    .filter((item) => {
      if (recovered.has(item.judgeEventId) || plannedEntities.has(item.judgeEventId)) return false;
      plannedEntities.add(item.judgeEventId);
      return true;
    })
    .map((item) => buildCalibrationStoreInput({ item, items, anchor, cfg }));
  const preparation = await prepareCalibrationStoreWorkSet(database, {
    workSetId,
    freezeDigest,
    effects,
    dispatch,
  });
  const freezeMismatch: CalibrationWorkSetFreezeMismatch | null =
    preparation.kind === 'freeze_mismatch'
      ? {
          workSetId,
          presentedFreezeDigest: freezeDigest,
          recordedFreezeDigests: preparation.recordedFreezeDigests,
        }
      : null;
  const seen = new Set<string>();
  for (const item of items) {
    const effectInput = buildCalibrationStoreInput({ item, items, anchor, cfg });
    let sharedIdentity = computePaidEffectIdentity(effectInput);
    const effect = computeCalibrationEffectIdentity({ item, cfg, workSetId, freezeDigest });
    let effectId = computeCalibrationEffectId(effect);
    let kind: CalibrationItemDispositionKind;
    let classification: CalibrationItemSkipClassification | undefined;
    if (freezeMismatch) kind = 'held_workset_freeze_mismatch';
    else if (seen.has(item.judgeEventId)) kind = 'held_duplicate_in_workset';
    else if (recovered.has(item.judgeEventId)) {
      const original = recovered.get(item.judgeEventId);
      if (!original) throw new PaidEffectProtocolError('calibration recovered identity missing');
      effectId = computeCalibrationEffectId(original.effect);
      sharedIdentity = original.sharedIdentity;
      classification = original.classification;
      kind = classification ? 'skipped' : 'applied_from_receipt';
    } else {
      seen.add(item.judgeEventId);
      const reservation = await reserveCalibrationStoreEffect(
        database,
        effectInput,
        dispatch,
        input.leaseExpiresAt,
      );
      if (reservation.kind === 'held') {
        kind = reservation.blockedBy ? 'held_blocked_by_open_obligation' : 'held_unknown_send';
      } else if (reservation.kind === 'completed' && mismatched.has(key(sharedIdentity))) {
        kind = 'held_receipt_mismatch';
      } else if (reservation.kind === 'completed' && recoveryPending.has(key(sharedIdentity))) {
        kind = 'completed_apply_pending';
      } else if (reservation.kind === 'completed') {
        try {
          const saved = readStoredCalibrationResult(
            reservation.result,
            reservation.identity,
            effectInput.input,
          );
          const result = await applyKnown(reservation.identity);
          kind =
            result.kind === 'pending'
              ? 'completed_apply_pending'
              : saved.execution.kind === 'skipped'
                ? 'skipped'
                : reservation.applied
                  ? 'applied_replay'
                  : 'applied_from_receipt';
          if (saved.execution.kind === 'skipped') classification = saved.execution.classification;
          if (result.kind === 'applied')
            calibrationStoreApplicationSchema.parse(result.application);
        } catch {
          mismatched.add(key(sharedIdentity));
          kind = 'held_receipt_mismatch';
        }
      } else {
        const lease: CalibrationSendLease = {
          identity: reservation.identity,
          delivery: dispatch.delivery,
          fence: reservation.fence,
          leaseExpiresAt: input.leaseExpiresAt,
        };
        let execution: CalibrationItemExecution | null = null;
        try {
          execution = await seams.executeItem(item, effect, { anchor, lease });
        } catch (error) {
          await markCalibrationStoreUnknown(
            database,
            lease,
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!execution) kind = 'held_unknown_send';
        else {
          // Even a mismatching receipt remains immutable evidence. Application
          // validation holds it in receipt_ready; it cannot trigger another send.
          await recordCalibrationStoreResult(database, lease, {
            version: 1,
            identity: reservation.identity,
            execution,
          });
          try {
            readStoredCalibrationResult(
              { version: 1, identity: reservation.identity, execution },
              reservation.identity,
              effectInput.input,
            );
            const result = await applyKnown(reservation.identity);
            kind =
              result.kind === 'pending'
                ? 'completed_apply_pending'
                : execution.kind === 'skipped'
                  ? 'skipped'
                  : 'applied_fresh';
            if (execution.kind === 'skipped') classification = execution.classification;
            if (result.kind === 'applied')
              calibrationStoreApplicationSchema.parse(result.application);
          } catch {
            mismatched.add(key(sharedIdentity));
            kind = 'held_receipt_mismatch';
          }
        }
      }
    }
    seen.add(item.judgeEventId);
    dispositions.push({
      judgeEventId: item.judgeEventId,
      effectId,
      sharedIdentity,
      kind,
      classification,
    });
    counts[DISPOSITION_COUNT_FIELD[kind]] += 1;
  }

  const openObligations: CalibrationOpenObligation[] = [];
  const pendingApplications: CalibrationPendingApplication[] = [];
  for (const row of await readCalibrationStoreObligations(database)) {
    const frozen = readFrozenCalibrationIntent(
      await readCalibrationStoredInput(database, row.identity),
      row.identity,
    );
    const obligation = {
      stored: row,
      effectId: computeCalibrationEffectId(frozen.effect),
      judgeEventId: row.identity.entityId,
      workSetId: frozen.workSetId,
    };
    if (row.state === 'receipt_ready' && !mismatched.has(key(row.identity)))
      pendingApplications.push(obligation);
    else
      openObligations.push({
        ...obligation,
        entityKey: computeCalibrationEntityKey(row.identity.entityId),
        stage:
          row.state === 'receipt_ready'
            ? 'receipt_mismatch'
            : row.state === 'pending'
              ? 'intent'
              : 'sent_unknown',
      });
  }
  return {
    kind: 'staged',
    report: {
      workSetId,
      freezeDigest,
      anchor: anchor.toISOString(),
      counts,
      dispositions,
      openObligations,
      pendingApplications,
      freezeMismatch,
    },
  };
}

/** The REAL staged seams over the released core extraction. Execution and
 * apply stay separate calls — a combined rejudge is never used as receipt
 * recovery. This binds the concrete store consumer's default execution and
 * application. Runtime admission and producer registration remain parent-owned;
 * the unregistered DBOS candidate still refuses paid execution. */
export interface CalibrationStagedCoreSeams {
  readonly executeItem: ExecuteCalibrationItemFn;
  readonly applyReceipt: ApplyCalibrationReceiptFn;
}

const CalibrationRecordedOutcome = z.object({
  version: z.literal(1),
  prepared_input: z.object({
    answer_event_id: z.string().min(1),
    question_id: z.string().min(1),
    judge_route: z.string().min(1),
    prior_outcome: z.enum(['correct', 'partial', 'incorrect']),
    answer_md: z.string(),
    student_image_refs: z.array(z.string()),
    question: z.record(z.string(), z.unknown()),
    subject_profile: z.record(z.string(), z.unknown()),
  }),
  config: z.object({
    rejudgeProvider: z.string().min(1),
    rejudgeModel: z.string().min(1),
    batchMax: z.number().int().positive(),
    windowDays: z.number().int().positive(),
  }),
  executed_at: z.iso.datetime(),
  workset_anchor: z.iso.datetime(),
  lane: z.object({
    visionJudgeProviderAtSample: z.string().nullable(),
    aiProviderOverrideAtSample: z.string().nullable(),
  }),
  rejudged: z.object({
    kind: z.literal('rejudged'),
    judgeEventId: z.string().min(1),
    questionId: z.string().min(1),
    answerEventId: z.string().min(1),
    priorOutcome: z.enum(['correct', 'partial', 'incorrect']),
    judgeRoute: z.string().min(1),
    isVision: z.boolean(),
    route: z.string().min(1),
    coarseOutcome: z.enum(['correct', 'partial', 'incorrect']),
    confidence: z.number().min(0).max(1),
    taskRunId: z.string().nullable(),
    rawText: z.string().nullable(),
  }),
});

function trackCalibrationRunnerFailure<Args extends unknown[], Result>(
  runner: (...args: Args) => Promise<Result>,
  rejected: (error: unknown) => void,
) {
  return async (...args: Args): Promise<Result> => {
    try {
      return await runner(...args);
    } catch (error) {
      rejected(error);
      throw error;
    }
  };
}

export async function buildCalibrationStagedCoreSeams(
  db: Db,
  cfg: JudgeCalibrationConfig,
  sampleDeps: JudgeCalibrationSampleDeps = {},
): Promise<CalibrationStagedCoreSeams> {
  const executionConfig = { ...cfg };
  const core = await import('./judge-calibration-sample-core');
  const judgeFn = sampleDeps.judgeFn ?? (await import('./judge/question-contract')).judgeAnswer;
  const injectedRunner = sampleDeps.runTaskInner;
  const executionClock = sampleDeps.now ?? (() => new Date());

  return {
    executeItem: async (item, identity, ctx) => {
      const frozen = structuredClone(item);
      if (
        identity.judgeEventId !== frozen.judgeEventId ||
        identity.inputDigest !== computeCalibrationInputDigest(frozen) ||
        identity.provider !== executionConfig.rejudgeProvider ||
        identity.model !== executionConfig.rejudgeModel ||
        identity.workSetId !==
          computeCalibrationWorkSetId({ anchor: ctx.anchor, cfg: executionConfig })
      ) {
        throw new Error('staged execution refused: frozen input/config does not match effect');
      }
      // Capture before the judge can await or mutate a config/profile registry.
      const preparedInput = structuredClone(calibrationInputFace(frozen));
      const effect = { ...identity };
      const worksetAnchor = ctx.anchor.toISOString();
      const lane = core.readCalibrationLaneSnapshots();
      const executedAt = executionClock().toISOString();
      // The retained semantic pipeline converts a runner rejection into an
      // unsupported verdict. That verdict cannot discharge a durable send
      // whose wire outcome is unknown. Preserve the actual rejection outside
      // the reviewed core, then let the store consumer fence it as unknown.
      const runnerFailure: { value: { error: unknown } | null } = { value: null };
      const rejected = (error: unknown) => {
        runnerFailure.value = { error };
      };
      const trackedRunner = injectedRunner
        ? trackCalibrationRunnerFailure(injectedRunner, rejected)
        : trackCalibrationRunnerFailure(core.makeJudgeCalibrationRunner(db), rejected);
      const outcome = await core.judgeCalibrationPreparedFace(
        executionConfig,
        { ...frozen, studentImageRefs: [...frozen.studentImageRefs] },
        { db, judgeFn, runTaskInner: trackedRunner },
      );
      if (runnerFailure.value) throw runnerFailure.value.error;
      if (outcome.kind !== 'rejudged') {
        return { kind: 'skipped', classification: outcome.kind };
      }
      return {
        kind: 'sent',
        receipt: {
          effect,
          outcome: {
            version: 1,
            prepared_input: preparedInput,
            config: { ...executionConfig },
            executed_at: executedAt,
            workset_anchor: worksetAnchor,
            lane,
            rejudged: outcome,
          },
        },
      };
    },
    applyReceipt: async (receipt, identity, ctx) => {
      if (!receiptEchoMatches(receipt, identity)) {
        throw new Error('apply refused: receipt identity mismatch');
      }
      const parsed = CalibrationRecordedOutcome.safeParse(receipt.outcome);
      if (!parsed.success) {
        throw new Error('apply refused: receipt is missing valid send-time facts');
      }
      const saved = parsed.data;
      const rejudged = saved.rejudged;
      if (
        saved.config.rejudgeProvider !== identity.provider ||
        saved.config.rejudgeModel !== identity.model ||
        computeCalibrationWorkSetId({
          anchor: new Date(saved.workset_anchor),
          cfg: saved.config,
        }) !== identity.workSetId ||
        canonicalHash(saved.prepared_input) !== identity.inputDigest ||
        rejudged.judgeEventId !== identity.judgeEventId ||
        rejudged.questionId !== saved.prepared_input.question_id ||
        rejudged.answerEventId !== saved.prepared_input.answer_event_id ||
        rejudged.judgeRoute !== saved.prepared_input.judge_route ||
        rejudged.priorOutcome !== saved.prepared_input.prior_outcome
      ) {
        throw new Error('apply refused: receipt input/config does not match effect');
      }
      // The reviewed core requires Db although it only uses query methods.
      // Attach its metadata-only $client field to the actual transaction;
      // all domain SQL still uses the transaction's session and savepoint.
      const applicationDb: Db = ctx.transaction
        ? Object.assign(ctx.transaction, { $client: db.$client })
        : db;
      const written = await core.applyJudgeCalibrationRejudgeSample(
        applicationDb,
        saved.config,
        rejudged,
        saved.lane,
        new Date(saved.executed_at),
      );
      return {
        domainRef: `${core.JUDGE_CALIBRATION_SAMPLE_ACTION}:${identity.judgeEventId}`,
        write: written === 'duplicate' ? 'unique_duplicate' : 'written',
      };
    },
  };
}
