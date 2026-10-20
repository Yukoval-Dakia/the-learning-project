// Can this evidence separate a held misconception from a skill gap?
// Sister of reconcile.ts, and not inside it. Reconcile imports scoring and typed-state.
// This file imports scoring only. Neither file imports the other.
// Counts, two- or three-value reads, and enums only. No fitted parameter.
// The thresholds below are owner operating points, not values fitted to a learner.
// Writes nothing. Does not touch mastery, FSRS, or difficulty. Reading baseline probability is allowed.
// With the hard-confirm flag off, decideDissociation cannot return HARD_CONFIRM.
// A probe separates the misconception from the baseline, not from a rival misconception.
// Without a rival-separating probe the verdict stops at EMERGING.
// Uses the single-probe skill score. The window mean is deferred and not migrated yet (ADR-0046).
// A soft-to-hard label still needs a fresh owner confirmation. The nightly pass never infers it.

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/public';
import {
  PREDICTION_SCORE_ACTION,
  PROBE_RESULT_ACTION,
  PROBE_RESULT_PROJECTED_ACTION,
} from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { scorePrediction } from '@/server/conjectures/scoring';

/**
 * A probe is crucial evidence only when prediction and baseline differ by at least this much.
 * Otherwise the outcome cannot separate a held misconception from a skill gap.
 * 0.2 matches the proper-distractor separation in Köhn, Chiu, and Wang. Owner-tunable, not fitted.
 */
export const DELTA_SEP = 0.2;

/**
 * An error counts toward a held misconception only at or above this mastery.
 * Below it, the error is a skill gap. A null baseline is unknown, not high. Owner-tunable.
 */
export const HELD_M_MASTERY_BAND = 0.6;

/**
 * Distinct (question, session, judge run) tuples required before a label can be minted.
 * Reruns of one judging run collapse, so one noisy judge cannot force it.
 * Same floor as recurrence. A count, not a Kish effective sample size. Owner-tunable.
 */
export const N_DEDUP_FLOOR = 2;

/**
 * Distinct contexts required. One context is a transient bug, not a stable misconception (VanLehn).
 * Owner-tunable.
 */
export const CONTEXT_SPREAD_FLOOR = 2;

/** Display band only. Not a second forgetting schedule. Owner-tunable. */
export const RECENCY_ACTIVE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

/** Bounds each SQL IN list. A long nightly history must not plan one unbounded clause. Owner-tunable. */
export const MAX_ACCOUNTABILITY_IDS_PER_QUERY = 500;

/**
 * Ontological causes are archived as dormant, not deleted. A cure is not something this system can record (Shtulman).
 * Procedural causes can be resolved. Only `concept` is ontological across the live subject profiles.
 * Every other cause defaults to resolved. Read at display time. No column. Owner-tunable.
 */
export const DORMANT_CAUSE_CATEGORIES: ReadonlySet<string> = new Set(['concept']);

/** One scored observation, mapped from a prediction_score event. */
export interface DissociationRecord {
  scoreEventId: string;
  conjectureEventId: string;
  probeResultEventId: string;
  questionId: string;
  /** Second dedup dimension. UTC day when the event carries no window. */
  sessionWindow: string;
  /** Third dedup dimension. Reruns of one judging run collapse. */
  judgeRunId: string;
  /** Context class for the stability floor. A question id is not a context. */
  contextKey: string;
  /** Null means unknown, not low mastery. */
  baselineP: number | null;
  predictedP: number;
  /** 1 when the answer is correct. */
  outcome: 0 | 1;
  /** True only when the probe isolates this misconception. */
  discriminating: boolean;
  /** The response matched a distractor or rubric facet. Unexpectedly wrong is not enough. */
  mDiagnostic: boolean;
  resolution: 'evidence_for' | 'confirmed' | 'retired';
  /** Accountability streaks stay ordered by this, not by batch time. */
  scoredAt: Date;
  /** Confirmation time when a later recurrence confirms sequence 1. Otherwise the score time. */
  judgedAt: Date;
}

/** Counts and booleans. The only input decideDissociation is allowed to see. */
export interface DissociationEvidence {
  /** Distinct (question, session, judge run) tuples after reruns collapse. */
  nDedup: number;
  contextSpread: number;
  /** Confirmed observations that also passed the crucial gate. */
  crucialConfirmedCount: number;
  /** Retired observations after the latest crucial confirmation. A falsification counter. */
  retiredSinceLastCrucial: number;
  /** Mastery was high and the response was diagnostic. Both are required. */
  hasDiscriminatingContext: boolean;
  /** Drives the display recency band. Null when there is no discriminating activation. */
  lastDiscriminatingActivation: Date | null;
}

/**
 * Held misconception, not a skill gap, only when mastery is high and the response is diagnostic.
 * Mastery alone would treat a high-mastery slip as a misconception. A null baseline is not high.
 */
export function isDiscriminatingContext(r: {
  baselineP: number | null;
  mDiagnostic: boolean;
}): boolean {
  return r.baselineP !== null && r.baselineP >= HELD_M_MASTERY_BAND && r.mDiagnostic;
}

/**
 * Crucial only when the probe discriminates, prediction and baseline differ by DELTA_SEP,
 * and this probe beat the baseline. Uses the single-probe skill score. The window mean is deferred, not migrated yet.
 * A null baseline cannot separate.
 */
export function isCrucial(r: {
  discriminating: boolean;
  predictedP: number;
  baselineP: number | null;
  outcome: 0 | 1;
}): boolean {
  if (!r.discriminating) return false;
  if (r.baselineP === null) return false;
  if (Math.abs(r.predictedP - r.baselineP) < DELTA_SEP) return false;
  const { skillScorePoint } = scorePrediction(r.predictedP, r.baselineP, r.outcome);
  return skillScorePoint > 0;
}

/** Collapses reruns of one judging run onto one independence unit. */
function dedupKey(r: DissociationRecord): string {
  return `${r.questionId}::${r.sessionWindow}::${r.judgeRunId}`;
}

/**
 * Counts only. A new crucial confirmation resets the retirement counter.
 * Sorted by judgedAt so "since the last crucial confirmation" is defined.
 */
export function summarizeDissociation(records: DissociationRecord[]): DissociationEvidence {
  const sorted = [...records].sort((a, b) => a.judgedAt.getTime() - b.judgedAt.getTime());
  const dedup = new Set<string>();
  const contexts = new Set<string>();
  let crucialConfirmedCount = 0;
  let retiredSinceLastCrucial = 0;
  let hasDiscriminatingContext = false;
  let lastDiscriminatingActivation: Date | null = null;

  for (const r of sorted) {
    dedup.add(dedupKey(r));
    if (isDiscriminatingContext(r)) {
      hasDiscriminatingContext = true;
      contexts.add(r.contextKey);
      lastDiscriminatingActivation = r.judgedAt;
    }
    if (r.resolution === 'confirmed' && isCrucial(r)) {
      crucialConfirmedCount += 1;
      retiredSinceLastCrucial = 0;
    } else if (r.resolution === 'retired') {
      retiredSinceLastCrucial += 1;
    }
  }

  return {
    nDedup: dedup.size,
    contextSpread: contexts.size,
    crucialConfirmedCount,
    retiredSinceLastCrucial,
    hasDiscriminatingContext,
    lastDiscriminatingActivation,
  };
}

/**
 * HARD_CONFIRM licenses a soft-to-hard upgrade. The nightly ranker passes a false owner
 * confirmation, so it can observe EMERGING and cannot mint the hard label.
 * EMERGING means the base gates passed and the flag, the rival probe, or a fresh confirmation is missing.
 * INSUFFICIENT means the evidence did not clear the threshold.
 */
export type DissociationVerdict = 'HARD_CONFIRM' | 'EMERGING' | 'INSUFFICIENT';

export interface DecideDissociationOpts {
  /** Off makes HARD_CONFIRM unreachable, whatever the evidence says. */
  hardConfirmEnabled: boolean;
  /** A probe in the pool separates this misconception from a rival one. */
  hasRivalProbe: boolean;
  /** The owner just confirmed the upgrade. Never inferred. */
  ownerFreshlyConfirmed: boolean;
}

/**
 * Base gates first. HARD_CONFIRM also needs the flag, a rival-separating probe, and a fresh
 * owner confirmation. Any one missing stops at EMERGING. Flag off cannot return HARD_CONFIRM.
 */
export function decideDissociation(
  ev: DissociationEvidence,
  opts: DecideDissociationOpts,
): DissociationVerdict {
  const gatesMet =
    ev.hasDiscriminatingContext &&
    ev.crucialConfirmedCount >= 1 &&
    ev.retiredSinceLastCrucial === 0 &&
    ev.nDedup >= N_DEDUP_FLOOR &&
    ev.contextSpread >= CONTEXT_SPREAD_FLOOR;
  if (!gatesMet) return 'INSUFFICIENT';

  if (opts.hardConfirmEnabled && opts.hasRivalProbe && opts.ownerFreshlyConfirmed) {
    return 'HARD_CONFIRM';
  }
  return 'EMERGING';
}

/** Display band from the last discriminating activation. Not stored, and not a forgetting schedule. */
export function recencyBand(
  lastDiscriminatingActivation: Date | null,
  now: Date,
): 'active' | 'quiet' {
  if (!lastDiscriminatingActivation) return 'quiet';
  return now.getTime() - lastDiscriminatingActivation.getTime() <= RECENCY_ACTIVE_WINDOW_MS
    ? 'active'
    : 'quiet';
}

/** Procedural and unknown causes resolve. Ontological causes go dormant. Derived from the category alone. */
export function resolutionClass(causeCategory: string): 'resolved' | 'dormant' {
  return DORMANT_CAUSE_CATEGORIES.has(causeCategory) ? 'dormant' : 'resolved';
}

/** UTC day, used only when the event carries no session window. */
function utcDayWindow(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Map one prediction_score payload, or return null when a scoring fact is unsound.
 * Discrimination facts come from the probe result. Copies on the score cannot mint them.
 */
function predictionScoreToRecord(
  eventId: string,
  createdAt: Date,
  payload: Record<string, unknown> | null,
  source: ProbeResultSource,
  authoritativeDiscriminating: boolean,
): DissociationRecord | null {
  if (!payload) return null;
  const predictedP = payload.predicted_p;
  const baselineP = payload.baseline_p;
  const outcome = payload.outcome;
  const resolution = payload.resolution;
  if (typeof predictedP !== 'number' || !Number.isFinite(predictedP)) return null;
  // Drop the record. Reconcile always writes a probability in [0, 1], so a null here is drift,
  // not a cold start. Keeping it would inflate nDedup with a row that can never be crucial.
  // The nullable field is only so the gates treat a missing baseline as "not high".
  if (typeof baselineP !== 'number' || !Number.isFinite(baselineP)) return null;
  if (outcome !== 0 && outcome !== 1) return null;
  if (resolution !== 'evidence_for' && resolution !== 'confirmed' && resolution !== 'retired') {
    return null;
  }

  const probeResultId = payload.probe_result_event_id;
  const conjectureEventId = payload.conjecture_event_id;
  if (typeof probeResultId !== 'string' || probeResultId.length === 0) return null;
  if (typeof conjectureEventId !== 'string' || conjectureEventId.length === 0) return null;
  const questionId = source.questionId;
  const sourcePayload = source.payload;
  const contextRaw = sourcePayload?.context;
  const knowledgeId = payload.knowledge_id;
  const contextKey =
    typeof contextRaw === 'string' && contextRaw.length > 0
      ? contextRaw
      : typeof knowledgeId === 'string' && knowledgeId.length > 0
        ? knowledgeId
        : probeResultId;
  const sessionRaw = sourcePayload?.session_window;
  const sessionWindow =
    typeof sessionRaw === 'string' && sessionRaw.length > 0 ? sessionRaw : utcDayWindow(createdAt);
  const judgeRaw = sourcePayload?.judge_run_id;
  const judgeRunId = typeof judgeRaw === 'string' && judgeRaw.length > 0 ? judgeRaw : probeResultId;

  return {
    scoreEventId: eventId,
    conjectureEventId,
    probeResultEventId: probeResultId,
    questionId,
    sessionWindow,
    judgeRunId,
    contextKey,
    baselineP,
    predictedP,
    outcome,
    // The proposal owns this fact. A conflicting copy on the score is rejected before this mapper.
    discriminating: authoritativeDiscriminating,
    mDiagnostic: sourcePayload?.m_diagnostic === true,
    resolution,
    scoredAt: createdAt,
    judgedAt: createdAt,
  };
}

/** Identity a conjecture proposal asserts. Cause and KC together, not the proposal id. */
interface ConjectureIdentity {
  cause_category: string;
  knowledge_id: string;
  predictedP: number;
  baselinePAtInduction: number;
  discriminating: boolean;
}

export interface ConjectureIdentityTarget {
  key: string;
  causeCategory: string;
  knowledgeId: string;
}

interface ProbeResultSource {
  questionId: string;
  createdAt: Date;
  causedByEventId: string | null;
  payload: Record<string, unknown> | null;
}

function normalizedIdSet(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    return null;
  }
  return [...new Set(value as string[])].sort();
}

function anchorMatchesProbeResult(
  anchorPayload: Record<string, unknown> | null,
  source: ProbeResultSource | undefined,
): boolean {
  if (!source) return false;
  const conjectureEventId = anchorPayload?.conjecture_event_id;
  if (
    typeof conjectureEventId !== 'string' ||
    source.causedByEventId !== conjectureEventId ||
    source.payload?.conjecture_event_id !== conjectureEventId ||
    source.payload?.outcome !== anchorPayload?.outcome ||
    source.payload?.resolution !== anchorPayload?.resolution
  ) {
    return false;
  }
  const anchorQuestionId = anchorPayload?.probe_question_id;
  if (anchorQuestionId !== undefined && anchorQuestionId !== source.questionId) return false;
  const anchorLineage = normalizedIdSet(anchorPayload?.independent_probe_question_ids);
  const sourceLineage = normalizedIdSet(source.payload?.independent_probe_question_ids);
  return (
    anchorLineage !== null &&
    sourceLineage !== null &&
    anchorLineage.length === sourceLineage.length &&
    anchorLineage.every((id, index) => id === sourceLineage[index])
  );
}

function conjectureIdentityKey(causeCategory: string, knowledgeId: string): string {
  return `${causeCategory}\u0000${knowledgeId}`;
}

function boundedChunks<T>(values: readonly T[]): T[][] {
  const size = Math.max(1, MAX_ACCOUNTABILITY_IDS_PER_QUERY);
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Read identity and the immutable scoring facts from each proposal. Writes nothing.
 * Copies on a score anchor are accepted only after they match these values.
 */
async function loadIdentityByConjectureId(
  db: Db,
  conjectureEventIds: Set<string>,
): Promise<Map<string, ConjectureIdentity>> {
  const out = new Map<string, ConjectureIdentity>();
  if (conjectureEventIds.size === 0) return out;
  const rowChunks = await Promise.all(
    boundedChunks([...conjectureEventIds]).map((chunk) =>
      db
        .select({ id: event.id, payload: event.payload })
        .from(event)
        .where(inArray(event.id, chunk)),
    ),
  );
  const rows = rowChunks.flat();
  for (const r of rows) {
    const identity = extractConjectureIdentity(r.payload as Record<string, unknown> | null);
    if (identity !== null) out.set(r.id, identity);
  }
  return out;
}

/** Null when the proposal is not a conjecture or a scoring fact is unsound. Copies are not a source. */
function extractConjectureIdentity(
  payload: Record<string, unknown> | null,
): ConjectureIdentity | null {
  const aiProposal = (
    payload as { ai_proposal?: { kind?: unknown; proposed_change?: unknown } } | null
  )?.ai_proposal;
  if (!aiProposal || aiProposal.kind !== 'conjecture') return null;
  const change = aiProposal.proposed_change as {
    cause_category?: unknown;
    knowledge_id?: unknown;
    predicted_p?: unknown;
    baseline_p_at_induction?: unknown;
    discriminating?: unknown;
  } | null;
  const cause = change?.cause_category;
  const kc = change?.knowledge_id;
  const predictedP = change?.predicted_p;
  const baselinePAtInduction = change?.baseline_p_at_induction;
  const discriminating = change?.discriminating;
  if (typeof cause !== 'string' || cause.length === 0) return null;
  if (typeof kc !== 'string' || kc.length === 0) return null;
  if (
    typeof predictedP !== 'number' ||
    !Number.isFinite(predictedP) ||
    predictedP < 0 ||
    predictedP > 1
  ) {
    return null;
  }
  if (
    typeof baselinePAtInduction !== 'number' ||
    !Number.isFinite(baselinePAtInduction) ||
    baselinePAtInduction < 0 ||
    baselinePAtInduction > 1
  ) {
    return null;
  }
  if (typeof discriminating !== 'boolean') return null;
  return {
    cause_category: cause,
    knowledge_id: kc,
    predictedP,
    baselinePAtInduction,
    discriminating,
  };
}

/**
 * Read rows for each requested (cause, knowledge) identity. Writes nothing.
 * The proposal is the identity, on both axes. A score whose payload KC disagrees with its proposal
 * matches neither pool. Scores from another cause or KC stay out, or two single-context rivals
 * could fake a two-context spread.
 * A later proposal for the same cause and KC is the same misconception, so its scores accrue.
 * A terminal score-free projection can confirm the sequence-1 score. It does not invent a second score.
 */
export async function gatherDissociationRecordsByIdentity(
  db: Db,
  targets: readonly ConjectureIdentityTarget[],
): Promise<Map<string, DissociationRecord[]>> {
  // Every requested key stays in the map. A bad duplicate gets an empty bucket and a warning,
  // so callers can tell "inadmissible" from "not requested".
  const out = new Map<string, DissociationRecord[]>();
  const targetKeyByIdentity = new Map<string, string>();
  const identityByTargetKey = new Map<string, string>();
  for (const target of targets) {
    if (!out.has(target.key)) out.set(target.key, []);
    const identity = conjectureIdentityKey(target.causeCategory, target.knowledgeId);
    const priorKey = targetKeyByIdentity.get(identity);
    if (priorKey !== undefined && priorKey !== target.key) {
      console.warn(
        '[accountability] skipping duplicate conjecture identity target',
        target.causeCategory,
        target.knowledgeId,
        target.key,
      );
      continue;
    }
    const priorIdentity = identityByTargetKey.get(target.key);
    if (priorIdentity !== undefined && priorIdentity !== identity) {
      console.warn(
        '[accountability] skipping target key mapped to multiple identities',
        target.key,
      );
      continue;
    }
    targetKeyByIdentity.set(identity, target.key);
    identityByTargetKey.set(target.key, identity);
  }
  if (targets.length === 0) return out;
  const knowledgeIds = [...new Set(targets.map((target) => target.knowledgeId))];
  const scoreChunks = await Promise.all(
    boundedChunks(knowledgeIds).map((chunk) =>
      db
        .select({
          id: event.id,
          action: event.action,
          payload: event.payload,
          created_at: event.created_at,
        })
        .from(event)
        .where(
          and(
            inArray(event.action, [PREDICTION_SCORE_ACTION, PROBE_RESULT_PROJECTED_ACTION]),
            sql`${event.payload}->>'knowledge_id' IN (${sql.join(
              chunk.map((knowledgeId) => sql`${knowledgeId}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(event.created_at, event.id),
    ),
  );
  // One owner's history, folded in time order after the bounded queries.
  // A multi-owner cohort needs per-owner cursors. Truncating this list would change streaks.
  const rows: Array<{ id: string; action: string; payload: unknown; created_at: Date }> =
    scoreChunks.flat();
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
  const anchorCorrectionChunks = await Promise.all(
    boundedChunks(rows.map((row) => row.id)).map((chunk) => getCorrectionStatuses(db, chunk)),
  );
  const anchorCorrectionStatuses = new Map(
    anchorCorrectionChunks.flatMap((statusMap) => [...statusMap.entries()]),
  );
  const probeResultEventIds = [
    ...new Set(
      rows.flatMap((row) => {
        const probeResultEventId = (row.payload as Record<string, unknown> | null)
          ?.probe_result_event_id;
        return typeof probeResultEventId === 'string' ? [probeResultEventId] : [];
      }),
    ),
  ];
  const probeResultChunks = boundedChunks(probeResultEventIds);
  const [statusChunks, sourceTimeChunks] = await Promise.all([
    Promise.all(
      probeResultChunks.map((chunk) =>
        getEffectiveProbeResultStatuses(db, chunk, { validateDirectChain: true }),
      ),
    ),
    Promise.all(
      probeResultChunks.map((chunk) =>
        db
          .select({
            id: event.id,
            question_id: event.subject_id,
            caused_by_event_id: event.caused_by_event_id,
            payload: event.payload,
            created_at: event.created_at,
          })
          .from(event)
          .where(
            and(
              eq(event.action, PROBE_RESULT_ACTION),
              eq(event.subject_kind, 'question'),
              inArray(event.id, chunk),
            ),
          ),
      ),
    ),
  ]);
  const scoreStatuses = new Map(statusChunks.flatMap((statusMap) => [...statusMap.entries()]));
  const sourceById = new Map(
    sourceTimeChunks.flatMap((chunk) =>
      chunk.map(
        (row) =>
          [
            row.id,
            {
              questionId: row.question_id,
              createdAt: row.created_at,
              causedByEventId: row.caused_by_event_id,
              payload: row.payload as Record<string, unknown> | null,
            },
          ] as const,
      ),
    ),
  );

  // Identity comes from the proposal. A score is kept only when that identity was requested.
  const conjectureEventIds = new Set<string>();
  for (const r of rows) {
    const cid = (r.payload as { conjecture_event_id?: unknown } | null)?.conjecture_event_id;
    if (typeof cid === 'string' && cid.length > 0) conjectureEventIds.add(cid);
  }
  const identityByConjectureId = await loadIdentityByConjectureId(db, conjectureEventIds);

  // Sequence 2 has no probability of its own. Fold its confirmation onto the sequence-1 score.
  const confirmationTimeByConjectureAndQuestion = new Map<string, Map<string, Date>>();
  for (const r of rows) {
    if (r.action !== PROBE_RESULT_PROJECTED_ACTION) continue;
    if (anchorCorrectionStatuses.get(r.id)?.state !== 'active') continue;
    const payload = r.payload as Record<string, unknown> | null;
    const probeResultEventId = payload?.probe_result_event_id;
    const source =
      typeof probeResultEventId === 'string' ? sourceById.get(probeResultEventId) : undefined;
    if (
      typeof probeResultEventId !== 'string' ||
      !source ||
      scoreStatuses.get(probeResultEventId) !== 'active' ||
      !anchorMatchesProbeResult(payload, source) ||
      payload?.resolution !== 'confirmed'
    ) {
      continue;
    }
    const conjectureEventId = payload?.conjecture_event_id;
    const knowledgeId = payload?.knowledge_id;
    if (typeof conjectureEventId !== 'string' || typeof knowledgeId !== 'string') continue;
    const identity = identityByConjectureId.get(conjectureEventId);
    if (
      !identity ||
      identity.knowledge_id !== knowledgeId ||
      !targetKeyByIdentity.has(
        conjectureIdentityKey(identity.cause_category, identity.knowledge_id),
      )
    ) {
      continue;
    }
    const independentQuestionIds = payload.independent_probe_question_ids;
    if (!Array.isArray(independentQuestionIds)) continue;
    const validIds = independentQuestionIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (new Set(validIds).size < 2) continue;
    const confirmationTime = source.createdAt;
    const confirmationTimes =
      confirmationTimeByConjectureAndQuestion.get(conjectureEventId) ?? new Map<string, Date>();
    for (const questionId of validIds) {
      const prior = confirmationTimes.get(questionId);
      if (!prior || confirmationTime.getTime() > prior.getTime()) {
        confirmationTimes.set(questionId, confirmationTime);
      }
    }
    confirmationTimeByConjectureAndQuestion.set(conjectureEventId, confirmationTimes);
  }

  for (const r of rows) {
    if (r.action !== PREDICTION_SCORE_ACTION) continue;
    if (anchorCorrectionStatuses.get(r.id)?.state !== 'active') continue;
    const payload = r.payload as Record<string, unknown> | null;
    const probeResultEventId = payload?.probe_result_event_id;
    const sourceStatus =
      typeof probeResultEventId === 'string' ? scoreStatuses.get(probeResultEventId) : undefined;
    // No source probe result means later corrections cannot be folded. Keep the audit row. Drop the evidence.
    if (
      typeof probeResultEventId !== 'string' ||
      sourceStatus !== 'active' ||
      !anchorMatchesProbeResult(payload, sourceById.get(probeResultEventId))
    ) {
      continue;
    }
    const cid = payload?.conjecture_event_id;
    const identity = typeof cid === 'string' ? (identityByConjectureId.get(cid) ?? null) : null;
    // Drop when the proposal is missing, or when payload and proposal disagree.
    // A mismatched KC matches neither pool. Do not trust the score payload's own knowledge id.
    const payloadKnowledgeId = payload?.knowledge_id;
    if (
      identity === null ||
      typeof payloadKnowledgeId !== 'string' ||
      payloadKnowledgeId !== identity.knowledge_id ||
      payload?.predicted_p !== identity.predictedP ||
      payload?.baseline_p !== identity.baselinePAtInduction ||
      (payload?.discriminating !== undefined && payload.discriminating !== identity.discriminating)
    ) {
      continue;
    }
    const targetKey = targetKeyByIdentity.get(
      conjectureIdentityKey(identity.cause_category, identity.knowledge_id),
    );
    if (!targetKey) continue;
    const source = sourceById.get(probeResultEventId);
    if (!source) continue;
    const parsed = predictionScoreToRecord(
      r.id,
      // Prefer the probe time. Legacy anchors stored the nightly batch clock, and rewriting them is not allowed.
      source.createdAt,
      payload,
      source,
      identity.discriminating,
    );
    if (parsed) {
      const confirmationTime =
        parsed.resolution === 'evidence_for'
          ? confirmationTimeByConjectureAndQuestion
              .get(parsed.conjectureEventId)
              ?.get(parsed.questionId)
          : undefined;
      const confirmed = confirmationTime
        ? { ...parsed, resolution: 'confirmed' as const, judgedAt: confirmationTime }
        : parsed;
      const bucket = out.get(targetKey);
      if (bucket) {
        bucket.push(confirmed);
      } else {
        console.warn('[accountability] missing initialized result bucket', targetKey);
      }
    }
  }
  return out;
}

export async function gatherDissociationEvidence(
  db: Db,
  params: { knowledgeId: string; causeCategory: string },
): Promise<DissociationEvidence> {
  const key = conjectureIdentityKey(params.causeCategory, params.knowledgeId);
  const records = await gatherDissociationRecordsByIdentity(db, [
    {
      key,
      knowledgeId: params.knowledgeId,
      causeCategory: params.causeCategory,
    },
  ]);
  return summarizeDissociation(records.get(key) ?? []);
}
