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
// resume/apply seams (2026-10-11 continuation).
//
// DELIVERY ≠ EFFECT. `CalibrationSampleTickSource` (Part 1) is scheduler
// DELIVERY identity: which pg-boss job / DBOS workflow delivered the tick.
// Nothing below takes it as input. Effect identity is the durable paid
// effect's own coordinates — entity (which judge event), workset revision
// (which frozen scheduled workset), model (which second lane), input digest
// (which immutable re-judge input face) — so the same effect redelivered under
// any tick keeps one identity, and any changed coordinate is a NEW effect that
// must not silently inherit the old one's receipts.
//
// LANE B DEPENDENCY (explicit, unresolved): `CalibrationStagedExecutionPort`
// is the consumer-side seam for the shared durable paid-effect store owned by
// lane B (`tlp-migration-receipt-reference`, task
// migration-shared-durable-effects-implementation-20261011). It is PROVISIONAL
// until the parent relays lane B's fixed typed protocol, at which point this
// interface is replaced/aliased to it. There is NO implementation of the port
// in this lane, no claim/fence/store code, and no production caller of the
// staged executor: the retained pg-boss handler keeps Part 1 behavior
// verbatim, and the DBOS candidate stays gate-only held. This seam is not live
// admission and must not be presented as one.
//
// CORE RELEASE REQUEST (parent action, not done here — the core is readonly
// for this lane): `judge-calibration-sample-core.ts` should export its
// selection block (currently runJudgeCalibrationSample lines ~275–341:
// window query → effective-verdict walk → action-filtered dedup → shuffle →
// batchMax slice) as e.g. `selectJudgeCalibrationCandidates(db, cfg, now)`,
// and expose the per-candidate re-judge loop body as a per-item function over
// one frozen candidate. Reason: freezing the workset and executing per-item
// MUST reuse the core's exact selection/domain math (no duplicated
// selection/median/domain policy in this lane), and the staged `executeItem`
// seam needs the core's real per-item re-judge + observation write as its only
// real implementation. Until that release, `executeItem` has NO default — a
// missing executor is a compile-time absence, never a manufactured
// always-success adapter.
//
// Resume semantics implemented here (shared invariants, parent plan):
//   • intent is persisted BEFORE the physical send; the exact immutable
//     receipt follows; application follows the receipt.
//   • unknown send/result outcomes are durable unresolved obligations — never
//     resent automatically, including under a later tick/workset that
//     re-selects the same entity (entity-key blocking), and never inferred
//     complete from a step checkpoint or a domain row.
//   • replay of a completed receipt compares its immutable identity echo
//     before reuse; a mismatched receipt is held, not reused, not resent.
//   • records are append-only; a changed revision never erases historical
//     obligations — they keep appearing in every report until discharged.
//   • no clock freshening: every record carries the frozen workset anchor, and
//     this code never reads a wall clock.
// ═══════════════════════════════════════════════════════════════════════════

/** Family discriminator mirrored from src/server/durable/calibration-sample-family.ts
 * (the capability must not import the server adapter; both literals must stay equal). */
const CALIBRATION_SAMPLE_EFFECT_FAMILY = 'judge_calibration_sample';

/** A frozen scheduled workset: the tick anchor clock plus the exact config the
 * gate approved when the workset was frozen. The anchor is the ONLY clock in
 * Part 2 — resumes never refresh it. */
export interface CalibrationWorkSetDescriptor {
  readonly anchor: Date;
  readonly cfg: JudgeCalibrationConfig;
}

/** Workset revision identity: anchor + config digest. Two different scheduled
 * deliveries of the same anchor+config freeze the SAME workset. */
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
 * time. Produced by the (parent-released) core selection seam; the payloads
 * are kept so the future per-item executor feeds the SAME face on resume. */
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

/** Effect-side identity of ONE durable calibration re-judge. Deliberately
 * excludes scheduler delivery identity (jobId / workflowId / scheduledAt as
 * delivery): those fields appear nowhere in this type or its digest. */
export interface CalibrationEffectIdentity {
  readonly family: typeof CALIBRATION_SAMPLE_EFFECT_FAMILY;
  /** business entity: the effective judge event being re-judged. */
  readonly judgeEventId: string;
  /** workset revision: which frozen scheduled workset this effect belongs to. */
  readonly workSetId: string;
  /** the pinned second lane that will execute the re-judge. */
  readonly provider: string;
  readonly model: string;
  /** digest over the frozen re-judge input face. */
  readonly inputDigest: string;
}

export function computeCalibrationEffectIdentity(input: {
  workSetId: string;
  item: CalibrationWorkSetItem;
  cfg: JudgeCalibrationConfig;
}): CalibrationEffectIdentity {
  return {
    family: CALIBRATION_SAMPLE_EFFECT_FAMILY,
    judgeEventId: input.item.judgeEventId,
    workSetId: input.workSetId,
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

export type CalibrationStagedEffectStage = 'intent' | 'sent_unknown' | 'completed' | 'applied';

/** One append-only durable row. `receipt` is present exactly when the stage is
 * `completed` or `applied` and is immutable once written. `recordedAt` is
 * always the freezing workset's anchor — never a fresh clock. */
export interface CalibrationStagedEffectRecord {
  readonly effectId: string;
  readonly entityKey: string;
  readonly identity: CalibrationEffectIdentity;
  readonly stage: CalibrationStagedEffectStage;
  readonly receipt: CalibrationItemReceipt | null;
  readonly recordedAt: string;
}

/** PROVISIONAL lane-B dependency (see the Part 2 header). The real durable
 * paid-effect store owned by lane B implements load/append; this lane only
 * consumes. Rows are immutable and append-only — this module never mutates,
 * rewrites or deletes a row, and never infers completion from row existence. */
export interface CalibrationStagedExecutionPort {
  /** The family's FULL durable record stream in append (chronological) order,
   * across ALL workset revisions — resume must see old obligations. */
  loadFamilyRecords(): Promise<readonly CalibrationStagedEffectRecord[]>;
  /** Append one immutable row. Store errors propagate (loud), never swallowed. */
  appendRecord(record: CalibrationStagedEffectRecord): Promise<void>;
}

/** The per-item physical send. The ONLY real future implementation is the
 * parent-released core per-item seam; there is deliberately NO default. */
export type ExecuteCalibrationItemFn = (
  item: CalibrationWorkSetItem,
  identity: CalibrationEffectIdentity,
) => Promise<CalibrationItemReceipt>;

export type CalibrationItemDispositionKind =
  | 'applied_fresh'
  | 'applied_from_receipt'
  | 'applied_replay'
  | 'held_unknown_send'
  | 'held_receipt_mismatch'
  | 'held_blocked_by_open_obligation'
  | 'held_duplicate_in_workset';

export interface CalibrationStagedItemDisposition {
  readonly judgeEventId: string;
  readonly effectId: string;
  readonly kind: CalibrationItemDispositionKind;
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

export interface CalibrationStagedExecutionCounts {
  appliedFresh: number;
  appliedFromReceipt: number;
  appliedReplay: number;
  heldUnknownSend: number;
  heldReceiptMismatch: number;
  heldBlockedByOpenObligation: number;
  heldDuplicateInWorkset: number;
}

export interface CalibrationStagedExecutionReport {
  readonly workSetId: string;
  readonly anchor: string;
  readonly dispositions: readonly CalibrationStagedItemDisposition[];
  readonly counts: CalibrationStagedExecutionCounts;
  readonly openObligations: readonly CalibrationOpenObligation[];
}

const DISPOSITION_COUNT_FIELD = {
  applied_fresh: 'appliedFresh',
  applied_from_receipt: 'appliedFromReceipt',
  applied_replay: 'appliedReplay',
  held_unknown_send: 'heldUnknownSend',
  held_receipt_mismatch: 'heldReceiptMismatch',
  held_blocked_by_open_obligation: 'heldBlockedByOpenObligation',
  held_duplicate_in_workset: 'heldDuplicateInWorkset',
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
}

export type CalibrationStagedOperationOutcome =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'staged'; report: CalibrationStagedExecutionReport };

/** Gated staged resume/apply execution. Same kill switch and bare second-lane
 * pre-flight as the retained path (default OFF ⇒ zero port calls, zero sends).
 * Not wired to any backend: the DBOS candidate stays held until the parent
 * relays lane B's fixed protocol and releases the core seams. */
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
    heldUnknownSend: 0,
    heldReceiptMismatch: 0,
    heldBlockedByOpenObligation: 0,
    heldDuplicateInWorkset: 0,
  };
  const dispositions: CalibrationStagedItemDisposition[] = [];

  // Phase R1 — finish pending applications for ANY revision: a `completed`
  // row is a paid effect whose receipt exists; applying it never touches the
  // provider. A receipt whose identity echo does not match its stored identity
  // is held, never reused.
  const appliedFromReceipt = new Set<string>();
  const receiptMismatch = new Set<string>();
  for (const record of [...latest.values()]) {
    if (record.stage !== 'completed') continue;
    if (receiptEchoMatches(record.receipt, record.identity)) {
      await append({ ...record, stage: 'applied', recordedAt });
      appliedFromReceipt.add(record.effectId);
    } else {
      receiptMismatch.add(record.effectId);
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

  // Phase R2 — plan the frozen items.
  const seenEntityKeys = new Set<string>();
  for (const item of input.workSet.items) {
    const identity = computeCalibrationEffectIdentity({ workSetId, item, cfg });
    const effectId = computeCalibrationEffectId(identity);
    const entityKey = computeCalibrationEntityKey(item.judgeEventId);

    let kind: CalibrationItemDispositionKind;
    if (seenEntityKeys.has(entityKey)) {
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
        } else {
          kind = 'held_unknown_send';
        }
      } else if (blockedEntityKeys.has(entityKey)) {
        kind = 'held_blocked_by_open_obligation';
      } else {
        // Persist intent BEFORE the physical send — the obligation exists
        // before anything can fail invisibly.
        await append({ effectId, entityKey, identity, stage: 'intent', receipt: null, recordedAt });
        try {
          const receipt = await input.executeItem(item, identity);
          if (!receiptEchoMatches(receipt, identity)) {
            // The send happened but the receipt does not prove THIS effect's
            // outcome — durable unresolved obligation, never an auto-resend.
            await append({
              effectId,
              entityKey,
              identity,
              stage: 'sent_unknown',
              receipt: null,
              recordedAt,
            });
            kind = 'held_unknown_send';
          } else {
            await append({
              effectId,
              entityKey,
              identity,
              stage: 'completed',
              receipt,
              recordedAt,
            });
            await append({ effectId, entityKey, identity, stage: 'applied', receipt, recordedAt });
            kind = 'applied_fresh';
          }
        } catch {
          // After a persisted intent, a failed or unknowable send can never be
          // proven un-sent — record the unresolved obligation and keep going
          // (per-item isolation preserved).
          await append({
            effectId,
            entityKey,
            identity,
            stage: 'sent_unknown',
            receipt: null,
            recordedAt,
          });
          kind = 'held_unknown_send';
        }
      }
    }
    dispositions.push({ judgeEventId: item.judgeEventId, effectId, kind });
    counts[DISPOSITION_COUNT_FIELD[kind]] += 1;
  }

  // Phase R3 — unresolved obligations, including those frozen under OTHER
  // workset revisions: a changed revision must never erase them.
  const openObligations: CalibrationOpenObligation[] = [];
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
    }
  }

  return {
    kind: 'staged',
    report: { workSetId, anchor: recordedAt, dispositions, counts, openObligations },
  };
}
