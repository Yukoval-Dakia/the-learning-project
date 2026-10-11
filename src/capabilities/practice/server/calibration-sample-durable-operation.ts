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
// Part 2 (2026-10-11 continuation) adds the frozen-workset / staged-resume
// seams: per-item effect identity strictly separated from scheduler delivery
// identity, and a gated staged executor over a PROVISIONAL durable-effect
// port. The port is the explicit lane-B dependency — it has NO implementation
// here and NO production caller; see the Part 2 section comment.

import { z } from 'zod';
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
// keeps Part 1 behavior verbatim and the DBOS candidate stays gate-only held
// (paid-refusal protection preserved).
// This seam is not live admission and must not be presented as one.
//
// CORE RELEASE (received 2026-10-11 from the feature owner; single file
// `judge-calibration-sample-core.ts`, minimal behavior-equivalent extraction):
//   • `selectJudgeCalibrationCandidates(db, cfg, now): Promise<JudgeCandidate[]>`
//     — the MF4 selection block, moved verbatim; freezing reuses THIS math.
//   • `rejudgeSingleCalibrationCandidate(db, cfg, candidate, opts): Promise<JudgeCalibrationSingleRejudge>`
//     — provider EXECUTION only (no observation write); skip faces are
//     classified outcomes, failures throw to the caller's isolation catch.
//   • `applyJudgeCalibrationRejudgeSample(db, cfg, rejudged, laneSnapshots, now): Promise<'written'|'duplicate'>`
//     — domain APPLY only (no provider call); reports the MF8 unique conflict honestly.
//   • `readCalibrationLaneSnapshots(): JudgeCalibrationLaneSnapshots`
//   • `freezeCalibrationWorkSetFromCandidates(db, candidates)`
//     — captures exact question/profile/answer inputs and reports unprepared candidates.
// `buildCalibrationStagedCoreSeams` below wires these as the REAL staged
// seams (composed rejudge is never used as receipt recovery: execution and
// apply remain separate calls).
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
//   • record timestamps retain the workset anchor. Receipts separately save
//     the execution clock and lane snapshots before invoking the judge.
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

export type CalibrationStagedEffectStage =
  | 'intent'
  | 'sent_unknown'
  | 'skipped'
  | 'completed'
  | 'applied';

/** One append-only durable row. `receipt` is present exactly when the stage
 * is `completed` or `applied`, EXCEPT that a `sent_unknown` row MAY carry the
 * original mismatching receipt as adjudication evidence (preserved, never
 * reused). `application` is present exactly when `applied`; `classification`
 * exactly when `skipped`. All are immutable once written. `recordedAt` is
 * always the freezing workset's anchor — never a fresh clock. */
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

/** Workset preparation time. Execution records its own send-start timestamp;
 * recovery receives the original anchor and reads sample time from the receipt. */
export interface CalibrationStagedSeamContext {
  readonly anchor: Date;
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
 * a failure or throw leaves the record `completed` — recoverable on a later
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
  const cfg = { ...gate.cfg };
  const workSetId = computeCalibrationWorkSetId({ anchor: input.workSet.anchor, cfg });
  const seamCtx: CalibrationStagedSeamContext = { anchor: input.workSet.anchor };
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
  const recoveredEntities = new Map<string, string>();
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
        { anchor: new Date(record.recordedAt) },
      );
      if (application.write !== 'written') continue;
      await append({ ...record, stage: 'applied', application });
      appliedFromReceipt.add(record.effectId);
      recoveredEntities.set(record.entityKey, record.effectId);
    } catch {
      // stays completed — a later tick retries the APPLICATION only
    }
  }

  // Entity-level blockers: any open (intent / sent-unknown) effect, a
  // mismatched receipt awaiting adjudication, OR a completed-pending-apply
  // effect (its paid outcome is not applied yet — a new revision must not
  // RE-BUY the same entity before the standing receipt is applied) blocks NEW
  // effects for the same business entity — across revisions, across ticks.
  // Only APPLIED history does not block.
  const blockedEntityKeys = new Set<string>();
  for (const record of latest.values()) {
    if (
      record.stage === 'intent' ||
      record.stage === 'sent_unknown' ||
      record.stage === 'completed' ||
      receiptMismatch.has(record.effectId)
    ) {
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
      execution = await input.executeItem(item, coords.identity, seamCtx);
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
      // outcome — durable unresolved obligation, never an auto-resend. The
      // ORIGINAL mismatching receipt is PRESERVED on the sent_unknown row as
      // adjudication evidence (it must not be silently discarded).
      await append({
        effectId: coords.effectId,
        entityKey: coords.entityKey,
        identity: coords.identity,
        stage: 'sent_unknown',
        receipt,
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
      const application = await input.applyReceipt(receipt, coords.identity, seamCtx);
      if (application.write !== 'written') return { kind: 'completed_apply_pending' };
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
    let effectId = computeCalibrationEffectId(identity);
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
      const recoveredEffectId = recoveredEntities.get(entityKey);
      if (recoveredEffectId !== undefined) {
        effectId = recoveredEffectId;
        kind = 'applied_from_receipt';
      } else if (record !== undefined) {
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

/** The REAL staged seams over the released core extraction. Execution and
 * apply stay separate calls — a combined rejudge is never used as receipt
 * recovery. Lazy core import keeps unit tests (which inject their own seams)
 * from loading the reconstruction chain. NOT a production caller: admission
 * stays parent-owned behind the lane-B handoff; the DBOS candidate's
 * paid-refusal protection is unchanged. */
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

export async function buildCalibrationStagedCoreSeams(
  db: Db,
  cfg: JudgeCalibrationConfig,
  sampleDeps: JudgeCalibrationSampleDeps = {},
): Promise<CalibrationStagedCoreSeams> {
  const executionConfig = { ...cfg };
  const core = await import('./judge-calibration-sample-core');
  const judgeFn = sampleDeps.judgeFn ?? (await import('./judge/question-contract')).judgeAnswer;
  const runTaskInner = sampleDeps.runTaskInner ?? core.makeJudgeCalibrationRunner(db);
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
      const outcome = await core.judgeCalibrationPreparedFace(
        executionConfig,
        { ...frozen, studentImageRefs: [...frozen.studentImageRefs] },
        { db, judgeFn, runTaskInner },
      );
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
    applyReceipt: async (receipt, identity) => {
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
      const written = await core.applyJudgeCalibrationRejudgeSample(
        db,
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
