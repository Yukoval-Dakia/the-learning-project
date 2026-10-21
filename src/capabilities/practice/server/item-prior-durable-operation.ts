// item_prior_backfill operation consumed by the retained pg-boss handler. The unregistered
// DBOS candidate only reads it; the explicit versioned path uses the real paid-effect
// adapter. Rep identity is question revision + input digest + rep index. Staged reps resume
// without provider calls; an unknown paid outcome stays held across deliveries.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ItemPriorPaidEffectAdapter } from '@/capabilities/practice/server/item-prior-paid-effect-adapter';
import { aggregateItemPriorDrafts, parseItemPriorDraft } from '@/core/item-prior-estimation';
import { canonicalHash } from '@/core/migration/canonical';
import { computePaidEffectInputDigest } from '@/core/migration/paid-effect-protocol';
import type { ItemPriorDraftT } from '@/core/schema/item_prior';
import type { Db, Tx } from '@/db/client';
import { item_calibration, knowledge, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import type { SubjectProfile } from '@/subjects/profile';
import { MAX_REPS } from './item-prior-limits';
import { resolveSubjectProfileForKnowledgeIds } from './knowledge-runtime';
import {
  type PracticeTaskCallCtx,
  type PracticeTaskRunFn,
  makePracticeTaskRunFn,
} from './task-runtime';

// 冷启锚方法开关：'feature'（默认，ItemPriorTask feature→b，source=
// 'llm_prior'）| 'llasa'（ItemPriorLlasaTask 学生模拟反推 b，source=
// 'llm_prior_llasa'）。opt-in——默认路径（含输入形状）零变更。
export type ItemPriorMethod = 'feature' | 'llasa';

export type ItemPriorCandidateFrozen = Pick<
  typeof question.$inferSelect,
  'id' | 'kind' | 'prompt_md' | 'reference_md' | 'choices_md' | 'knowledge_ids'
>;

/** Normalized execution parameters; the retained handler owns job data parsing. */
export interface ItemPriorExecutionParams {
  method: ItemPriorMethod;
  reps: number;
}

export interface ItemPriorBackfillResult {
  /** 本轮挑出的待标定题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功写入 calibration row 的题数。 */
  calibrated: number;
  /** 单题 LLM/parse 失败被跳过的题数（不阻断其余题）。 */
  skipped_failed: number;
}

export const DEFAULT_MAX_PER_RUN = 25;

// reps 生产默认 3（owner 2026-09-24 拍板启用；median SD 0.361→
// 0.173，≈+$0.0004/题）。上限防 job data 把付费乘数打爆（reps 把每题 LLM
// 成本 ×N，9 已远超实用值 3）。
export const DEFAULT_REPS = 3;
export { MAX_REPS } from './item-prior-limits';

export function normalizeReps(raw: unknown): number {
  // 缺失/非正整数 → 生产默认（nightly cron 不带 job data → 3 reps）；
  // 显式 1 是合法 opt-out（落在下方范围分支返回）。
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return DEFAULT_REPS;
  if (raw > MAX_REPS) {
    console.warn('[item_prior_backfill] reps clamped', { requested: raw, max: MAX_REPS });
    return MAX_REPS;
  }
  return raw;
}

export function normalizeMethod(raw: unknown): ItemPriorMethod {
  return raw === 'llasa' ? 'llasa' : 'feature';
}

/** Pre-LLM read; errors propagate. Preserve the original unordered, capped query. */
export async function selectItemPriorCandidates(
  db: Db | Tx,
  maxPerRun: number,
): Promise<ItemPriorCandidateFrozen[]> {
  return db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM item_calibration ic
        WHERE ic.question_id = ${question.id} AND ic.track = 'hard'
      )`,
    )
    .limit(maxPerRun);
}

/** 为候选并集一次性解析 knowledge 名（原 union 读，逐字节不变）。 */
export async function resolveItemPriorKnowledgeNames(
  db: Db | Tx,
  candidates: readonly ItemPriorCandidateFrozen[],
): Promise<Map<string, string>> {
  const allKnowledgeIds = Array.from(new Set(candidates.flatMap((c) => c.knowledge_ids ?? [])));
  const nameById = new Map<string, string>();
  if (allKnowledgeIds.length > 0) {
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, allKnowledgeIds));
    for (const r of rows) nameById.set(r.id, r.name);
  }
  return nameById;
}

// ─── — per-rep preparation seam ────────────────────────────────────

export type ItemPriorTaskName = 'ItemPriorTask' | 'ItemPriorLlasaTask';

/**
 * Frozen per-rep unit of paid work. Deliberately excludes scheduler delivery
 * identity (dagRunId / runDate / nodeId): the same question prepared on a later
 * nightly delivery yields the same rep identities, so staged reps resume
 * instead of re-sending, while a changed question or changed input yields new
 * identities. The adapter binds row revision, input digest and rep count into
 * one frozen workset revision so an old unknown gates changed work.
 */
export interface ItemPriorRepIdentity {
  readonly questionId: string;
  /** Digest of the frozen candidate row; changes when the question is edited. */
  readonly questionRevision: string;
  readonly method: ItemPriorMethod;
  /** Digest of the exact rendered task input (shape, knowledge context, profile). */
  readonly inputDigest: string;
  readonly repIndex: number;
}

/** Deterministic preparation result; the input of every later seam. */
export interface ItemPriorPreparedWork {
  readonly candidate: ItemPriorCandidateFrozen;
  readonly method: ItemPriorMethod;
  readonly taskName: ItemPriorTaskName;
  readonly input: unknown;
  readonly subjectProfile: SubjectProfile;
  readonly questionRevision: string;
  readonly inputDigest: string;
  /** Intended rep units: feature → params.reps (default 3), llasa → 1. */
  readonly repCount: number;
}

/**
 * Preparation seam — no provider calls, no writes. Same step order as the
 * retained path: knowledge context → subject profile → method-specific input
 * shape (feature keeps its three fields, so its digest matches the bytes the
 * retained path has always sent).
 */
export async function prepareItemPriorWork(
  db: Db | Tx,
  candidate: ItemPriorCandidateFrozen,
  nameById: ReadonlyMap<string, string>,
  params: ItemPriorExecutionParams,
): Promise<ItemPriorPreparedWork> {
  const knowledgeContext = (candidate.knowledge_ids ?? [])
    .map((id) => ({ name: nameById.get(id) }))
    .filter((kc): kc is { name: string } => typeof kc.name === 'string');
  // Resolve the subject profile for the prompt rendering (cause taxonomy /
  // language style). Falls back to default profile when unlabeled.
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(
    db,
    candidate.knowledge_ids ?? [],
  );
  // llasa 输入带 reference_md/choices_md（模拟学生作答需要选项、
  // 判对错需要参考答案）；feature 输入保持原有三个字段，输入 hash 不变。
  const input =
    params.method === 'llasa'
      ? {
          prompt_md: candidate.prompt_md,
          kind: candidate.kind,
          knowledge_context: knowledgeContext,
          reference_md: candidate.reference_md,
          choices_md: candidate.choices_md,
        }
      : {
          prompt_md: candidate.prompt_md,
          kind: candidate.kind,
          knowledge_context: knowledgeContext,
        };
  const taskName: ItemPriorTaskName =
    params.method === 'llasa' ? 'ItemPriorLlasaTask' : 'ItemPriorTask';
  return {
    candidate,
    method: params.method,
    taskName,
    input,
    subjectProfile,
    questionRevision: canonicalHash({ tag: 'item-prior-question-revision-v1', candidate }),
    inputDigest: computePaidEffectInputDigest(
      itemPriorPreparedInput({ taskName, input, subjectProfile }),
    ),
    repCount: params.method === 'llasa' ? 1 : params.reps,
  };
}

/** Exact frozen arguments passed to the task runner, including its profile context. */
export function itemPriorPreparedInput(
  work: Pick<ItemPriorPreparedWork, 'taskName' | 'input' | 'subjectProfile'>,
) {
  return {
    version: 1,
    taskName: work.taskName,
    input: work.input,
    ctx: { subjectProfile: work.subjectProfile },
  };
}

/** Stable identity of one intended rep within the prepared work. */
export function itemPriorRepIdentity(
  work: ItemPriorPreparedWork,
  repIndex: number,
): ItemPriorRepIdentity {
  if (!Number.isInteger(repIndex) || repIndex < 0 || repIndex >= work.repCount) {
    throw new RangeError(
      `itemPriorRepIdentity: repIndex ${repIndex} outside 0..${work.repCount - 1}`,
    );
  }
  return {
    questionId: work.candidate.id,
    questionRevision: work.questionRevision,
    method: work.method,
    inputDigest: work.inputDigest,
    repIndex,
  };
}

/**
 * retained feature sampler over the prepared work: reps=1 退化为单次
 * 调用（与原路径逐字节等价，输入形状/hash 不变）；reps>1 连跑 N 次，逐 rep
 * catch 丢弃失败（LLM/parse 错只记 warn 不炸题），成功 drafts 走 median 聚合。
 * 全部失败 → aggregateItemPriorRepDrafts throw → 调用方按单题失败处理。
 */
async function runRetainedFeatureReps(
  runTaskFn: PracticeTaskRunFn,
  work: ItemPriorPreparedWork,
): Promise<ItemPriorDraftT> {
  const ctx: PracticeTaskCallCtx = { subjectProfile: work.subjectProfile };
  if (work.repCount <= 1) {
    const runResult = await runTaskFn('ItemPriorTask', work.input, ctx);
    return parseItemPriorDraft('feature', runResult.text);
  }
  const drafts: ItemPriorDraftT[] = [];
  for (let r = 0; r < work.repCount; r++) {
    try {
      const runResult = await runTaskFn('ItemPriorTask', work.input, ctx);
      drafts.push(parseItemPriorDraft('feature', runResult.text));
    } catch (repErr) {
      console.warn('[item_prior_backfill] rep dropped from median', { rep: r, err: repErr });
    }
  }
  return aggregateItemPriorDrafts('feature', drafts, work.repCount);
}

/**
 * 单题付费执行（retained 路径）。语义与原循环体逐条对应：knowledge context
 * 组装、subject profile 解析、 双方法输入形状（llasa 带
 * reference_md/choices_md；feature 三字段不变）、 reps 采样。返回待写
 * draft 与 source。throw 不区分 provider 未调用、已付费或结果未知；retained
 * caller 继续 catch+skip，staged 执行不经过本函数。
 */
export async function calibrateItemPriorQuestion(
  db: Db | Tx,
  runTaskFn: PracticeTaskRunFn,
  candidate: ItemPriorCandidateFrozen,
  nameById: ReadonlyMap<string, string>,
  params: ItemPriorExecutionParams,
): Promise<{ draft: ItemPriorDraftT; source: string }> {
  const work = await prepareItemPriorWork(db, candidate, nameById, params);
  // feature 路径：reps=1 单次调用（原语义），reps>1 N 次采样
  // median 聚合；llasa 保持单次调用不动，parse 错误照常向上传播。
  const draft =
    work.method === 'llasa'
      ? parseItemPriorDraft(
          'llasa',
          (
            await runTaskFn('ItemPriorLlasaTask', work.input, {
              subjectProfile: work.subjectProfile,
            })
          ).text,
        )
      : await runRetainedFeatureReps(runTaskFn, work);
  return { draft, source: work.method === 'llasa' ? 'llm_prior_llasa' : 'llm_prior' };
}

/**
 * Retained domain write: applyItemPrior uses onConflictDoNothing(question_id).
 * A hard row alone does not bind a paid attempt, DAG member or submitted draft.
 */
export async function commitItemPriorCalibration(
  db: Db | Tx,
  candidate: ItemPriorCandidateFrozen,
  draft: ItemPriorDraftT,
  source: string,
): Promise<void> {
  await applyItemPrior(db, { questionId: candidate.id, draft, source });
}

/** Immutable completed result payload stored by the shared paid-effect owner. */
export const itemPriorOutputReceiptSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('output'),
  outputText: z.string(),
});

export type ItemPriorRepReceipt =
  | z.infer<typeof itemPriorOutputReceiptSchema>
  | { readonly kind: 'unknown'; readonly reason: string };

// ─── — staged per-rep execution / parse / aggregate / application ───

// Parent-review 2026-10-11: durable unknowns are NOT ordinary failures. A
// store/receipt/application error at or after a paid send must propagate (or
// surface as an explicitly held, store-backed state) so the obligation stays
// visible to later reconciliation; it must never be swallowed into a generic
// per-item skip or a completed member result.

/** Reservation or immutable-result validation failed before any send this run. */
export class ItemPriorDurableStoreError extends Error {
  readonly code = 'ITEM_PRIOR_DURABLE_STORE';

  constructor(
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'ItemPriorDurableStoreError';
  }
}

/**
 * A paid effect was dispatched (or its output received) but the receipt could
 * not be confirmed persisted. The outcome AND the receipt state are both
 * unresolved; the obligation stays open for reconciliation. Never isolatable.
 */
export class ItemPriorReceiptPersistenceError extends Error {
  readonly code = 'ITEM_PRIOR_RECEIPT_PERSISTENCE';

  constructor(
    message: string,
    readonly reason?: unknown,
    readonly identity?: ItemPriorRepIdentity,
  ) {
    super(message);
    this.name = 'ItemPriorReceiptPersistenceError';
  }
}

/**
 * Application write/read-back failed after every rep resolved. All paid
 * effects are already receipted, so a later delivery replays them for free,
 * but the application outcome itself is unknown and must stay visible.
 */
export class ItemPriorApplicationError extends Error {
  readonly code = 'ITEM_PRIOR_APPLICATION';

  constructor(
    message: string,
    readonly reason?: unknown,
    readonly questionId?: string,
  ) {
    super(message);
    this.name = 'ItemPriorApplicationError';
  }
}

/** Outcome of one rep after this seam is done with it. */
export type ItemPriorRepOutcome =
  /** Completed response parsed into a draft (receipt recorded). */
  | { readonly state: 'draft'; readonly draft: ItemPriorDraftT }
  /** Completed response that failed the parse barrier — known outcome, no draft. */
  | { readonly state: 'dropped' }
  /** Unknown paid outcome — durable held obligation; never an auto-retry. */
  | { readonly state: 'held' }
  /** No send admission in this run; may be readonly terminal-job recovery of an absent effect. */
  | { readonly state: 'pending' };

export type ItemPriorStagedStatus = 'ready' | 'held' | 'incomplete' | 'no-anchor';

export interface ItemPriorStagedItem {
  readonly questionId: string;
  readonly questionRevision: string;
  readonly inputDigest: string;
  readonly method: ItemPriorMethod;
  /** Index-aligned with the intended rep units (ascending rep order). */
  readonly repOutcomes: readonly ItemPriorRepOutcome[];
  readonly status: ItemPriorStagedStatus;
  readonly draft?: ItemPriorDraftT;
  readonly source: string;
  readonly heldReps: readonly number[];
  readonly pendingReps: readonly number[];
}

export interface ItemPriorRepExecutionDeps {
  readonly effects: Pick<ItemPriorPaidEffectAdapter, 'reserveRep' | 'completeRep'>;
  readonly runTaskFn: PracticeTaskRunFn;
}

/** Deterministic parse seam over a completed receipt's immutable text. */
export function parseStagedItemPriorOutput(
  method: ItemPriorMethod,
  outputText: string,
): ItemPriorRepOutcome {
  try {
    const draft = parseItemPriorDraft(method, outputText);
    return { state: 'draft', draft };
  } catch {
    // Completed output failing the parse barrier is a known outcome with no
    // draft — the retained path drops such reps from the median the same way.
    return { state: 'dropped' };
  }
}

/** Reserve through the real store before every physical send. A receipt is replayed for free. */
export async function executeItemPriorRep(
  work: ItemPriorPreparedWork,
  repIndex: number,
  deps: ItemPriorRepExecutionDeps,
): Promise<ItemPriorRepOutcome> {
  const identity = itemPriorRepIdentity(work, repIndex);
  let reservation: Awaited<ReturnType<ItemPriorPaidEffectAdapter['reserveRep']>>;
  try {
    reservation = await deps.effects.reserveRep(work, repIndex);
    if (reservation.kind === 'completed') {
      const receipt = itemPriorOutputReceiptSchema.parse(reservation.result);
      return parseStagedItemPriorOutput(work.method, receipt.outputText);
    }
  } catch (err) {
    throw new ItemPriorDurableStoreError(
      `reserveRep failed for question ${identity.questionId} rep ${repIndex}; obligations unreadable or dispatch fenced`,
      err,
    );
  }
  if (reservation.kind === 'held') return { state: 'held' };
  if (reservation.kind === 'recovery-only') return { state: 'pending' };

  let outputText: string;
  try {
    const taskName = work.taskName;
    const runResult = await deps.runTaskFn(taskName, work.input, {
      subjectProfile: work.subjectProfile,
    });
    outputText = runResult.text;
  } catch (err) {
    try {
      await deps.effects.completeRep(reservation, {
        kind: 'unknown',
        reason: err instanceof Error ? err.message : String(err),
      });
    } catch (receiptErr) {
      throw new ItemPriorReceiptPersistenceError(
        `send failed and unknown persistence failed for question ${identity.questionId} rep ${repIndex}`,
        receiptErr,
        identity,
      );
    }
    return { state: 'held' };
  }
  try {
    await deps.effects.completeRep(reservation, { version: 1, kind: 'output', outputText });
  } catch (err) {
    throw new ItemPriorReceiptPersistenceError(
      `output received but receipt persistence unconfirmed for question ${identity.questionId} rep ${repIndex}`,
      err,
      identity,
    );
  }
  return parseStagedItemPriorOutput(work.method, outputText);
}

/**
 * Aggregate seam: settle staged outcomes into the item status. held blocks
 * application and outranks pending; with every rep resolved, surviving drafts
 * take the retained median (feature) or the single LLaSA draft, and an empty
 * survivor set settles `no-anchor` without a write.
 */
export function settleItemPriorStagedItem(
  work: ItemPriorPreparedWork,
  outcomes: readonly ItemPriorRepOutcome[],
): ItemPriorStagedItem {
  if (outcomes.length !== work.repCount) {
    throw new Error(
      `settleItemPriorStagedItem: expected ${work.repCount} outcomes, got ${outcomes.length}`,
    );
  }
  const heldReps = outcomes.flatMap((o, i) => (o.state === 'held' ? [i] : []));
  const pendingReps = outcomes.flatMap((o, i) => (o.state === 'pending' ? [i] : []));
  const base = {
    questionId: work.candidate.id,
    questionRevision: work.questionRevision,
    inputDigest: work.inputDigest,
    method: work.method,
    repOutcomes: outcomes,
    source: work.method === 'llasa' ? 'llm_prior_llasa' : 'llm_prior',
    heldReps,
    pendingReps,
  };
  if (heldReps.length > 0) return { ...base, status: 'held' };
  if (pendingReps.length > 0) return { ...base, status: 'incomplete' };
  const drafts = outcomes.flatMap((o) => (o.state === 'draft' ? [o.draft] : []));
  if (drafts.length === 0) return { ...base, status: 'no-anchor' };
  // Feature: same median aggregation as the retained path (attempted = the
  // intended rep count); a single surviving rep or LLaSA stays byte-identical
  // to the retained draft (no provenance suffix).
  const draft = aggregateItemPriorDrafts(work.method, drafts, work.repCount);
  return { ...base, status: 'ready', draft };
}

/**
 * Staged execution of one item's intended reps, ascending rep order. Resolved
 * reps are replayed from shared receipts without provider calls; application is the
 * caller's decision and only valid once every rep resolved.
 */
export async function runItemPriorItemRepStages(
  work: ItemPriorPreparedWork,
  deps: ItemPriorRepExecutionDeps,
): Promise<ItemPriorStagedItem> {
  const outcomes: ItemPriorRepOutcome[] = [];
  for (let repIndex = 0; repIndex < work.repCount; repIndex++) {
    const outcome = await executeItemPriorRep(work, repIndex, deps);
    outcomes.push(outcome);
    if (outcome.state === 'held') {
      // Do not mint later sibling sends over an unresolved effect, including on a later night.
      while (outcomes.length < work.repCount) outcomes.push({ state: 'pending' });
      break;
    }
  }
  return settleItemPriorStagedItem(work, outcomes);
}

/** Persisted hard-track columns the application seam compares against. */
export interface ItemPriorApplicationRowSnapshot {
  readonly b: number | null;
  readonly bAnchor: number | null;
  readonly confidence: number | null;
  readonly source: string | null;
}

export type ItemPriorApplicationVerification =
  /** Domain row matches at application time; a validated terminal receipt preserves this historical disposition. */
  | { readonly status: 'matched' }
  /** A different hard row already exists; this attempt's draft was NOT persisted. */
  | { readonly status: 'superseded'; readonly existing: ItemPriorApplicationRowSnapshot }
  /** Staged item is not ready — nothing to apply. */
  | { readonly status: 'not-applicable' };

/**
 * float4-storage equality (R1 P1 fix). `item_calibration.b/b_anchor/
 * confidence` are PG `real` (float4, ~7 significant digits): a legal
 * even-count median like (0.1+0.2)/2 or a high-precision LLM value
 * round-trips shortened, so strict double equality would misreport a freshly
 * applied anchor as superseded. Compare at the stored representation —
 * Math.fround (float32) on both sides — never a broad epsilon, which would
 * mask a genuinely different anchor. null / NaN never match a finite value.
 */
function float4Equals(stored: number | null, intended: number): boolean {
  if (stored === null || !Number.isFinite(stored) || !Number.isFinite(intended)) {
    return false;
  }
  return Math.fround(stored) === Math.fround(intended);
}

function stagedRowMatches(
  row: ItemPriorApplicationRowSnapshot,
  staged: ItemPriorStagedItem,
): boolean {
  const draft = staged.draft;
  return (
    draft !== undefined &&
    float4Equals(row.b, draft.b_logit) &&
    float4Equals(row.bAnchor, draft.b_logit) &&
    float4Equals(row.confidence, draft.confidence) &&
    row.source === staged.source
  );
}

async function readItemPriorHardRow(
  db: Db | Tx,
  questionId: string,
): Promise<ItemPriorApplicationRowSnapshot | null> {
  const [row] = await db
    .select({
      b: item_calibration.b,
      bAnchor: item_calibration.b_anchor,
      confidence: item_calibration.confidence,
      source: item_calibration.source,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')));
  return row ?? null;
}

/**
 * Application seam with real verification (parent review 2026-10-11):
 * `applyItemPrior` is conflict-ignoring and returns void, so a bare `true`
 * proved nothing. This seam reads the hard row back and compares it against
 * the staged draft — numeric columns at their float4 stored representation
 * (`Math.fround` on both sides; PG `real` legally shortens medians), `source`
 * exactly:
 *
 * - existing row already matching → `matched` (idempotent replay of the same
 * staged result);
 * - existing row differing → `superseded`: another writer's anchor holds and
 * is never overwritten — this attempt's draft was not persisted;
 * - no row → write once via the retained writer, then re-read; a missing or
 * differing row after a successful write escalates to `superseded` /
 * `ItemPriorApplicationError`.
 *
 * `matched` proves the domain state equals this staged draft. It never proves
 * causal authorship. The adapter separately binds this disposition to the exact
 * immutable paid results with transactional application receipts; this readback
 * alone never settles paid effects.
 *
 * Write/read-back failures throw `ItemPriorApplicationError`: all reps are
 * already receipted, so a later delivery replays them for free, but the
 * application outcome itself is unknown and must stay visible.
 */
export async function commitItemPriorStagedCalibration(
  db: Db | Tx,
  staged: ItemPriorStagedItem,
): Promise<ItemPriorApplicationVerification> {
  if (staged.status !== 'ready' || !staged.draft) return { status: 'not-applicable' };
  const readBack = async (): Promise<ItemPriorApplicationRowSnapshot | null> => {
    try {
      return await readItemPriorHardRow(db, staged.questionId);
    } catch (err) {
      throw new ItemPriorApplicationError(
        `hard-row read-back failed for question ${staged.questionId}; application outcome unknown`,
        err,
        staged.questionId,
      );
    }
  };

  const existing = await readBack();
  if (existing) {
    return stagedRowMatches(existing, staged)
      ? { status: 'matched' }
      : { status: 'superseded', existing };
  }

  try {
    await applyItemPrior(db, {
      questionId: staged.questionId,
      draft: staged.draft,
      source: staged.source,
    });
  } catch (err) {
    throw new ItemPriorApplicationError(
      `applyItemPrior failed for question ${staged.questionId}; application outcome unknown`,
      err,
      staged.questionId,
    );
  }

  const after = await readBack();
  if (!after) {
    throw new ItemPriorApplicationError(
      `write returned success but no hard row is readable for question ${staged.questionId}`,
      undefined,
      staged.questionId,
    );
  }
  return stagedRowMatches(after, staged)
    ? { status: 'matched' }
    : { status: 'superseded', existing: after };
}

/**
 * 原组合（pg-boss 路径语义保持）：候选 SELECT（throw 冒泡）→ union 读
 * knowledge 名 → 循环 per-question try/catch（单题失败跳过不阻断）→ 计数返回。
 */
export async function runItemPriorBackfillOperation(
  db: Db,
  deps: {
    method: ItemPriorMethod;
    reps: number;
    maxPerRun?: number;
    runTaskFn?: PracticeTaskRunFn;
  },
): Promise<ItemPriorBackfillResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const result: ItemPriorBackfillResult = { considered: 0, calibrated: 0, skipped_failed: 0 };

  const candidates = await selectItemPriorCandidates(db, maxPerRun);
  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  const runTaskFn = deps.runTaskFn ?? makePracticeTaskRunFn(db);
  const nameById = await resolveItemPriorKnowledgeNames(db, candidates);

  for (const c of candidates) {
    try {
      const { draft, source } = await calibrateItemPriorQuestion(db, runTaskFn, c, nameById, {
        method: deps.method,
        reps: deps.reps,
      });
      await commitItemPriorCalibration(db, c, draft, source);
      result.calibrated++;
    } catch (err) {
      // One bad question must not block the rest. Logged + counted; the next run
      // re-picks it (the candidate SELECT still matches — no row was written).
      console.error('[item_prior_backfill] question calibration failed', {
        questionId: c.id,
        err,
      });
      result.skipped_failed++;
    }
  }

  return result;
}
