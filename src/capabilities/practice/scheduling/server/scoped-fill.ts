// 知识点专练只补今日会话的空位，已落下的行不重排。
// 排序用 collectCandidateSignals 已经算好的信息分（诊断分，否则现行的点 MFI 或冷启 KLP），
// 与每日编排的取分一致。已接受变式先于干预诊断，两者都先于题库其余题。
// 近 3 天仍有效的答对不进候选：原作答/复习看事件 outcome，原生作答看既有判读。

import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { event, mistake_variant } from '@/db/schema';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import {
  LEARNER_ANSWER_ACTIONS,
  loadNativeAttemptOutcomes,
} from '@/kernel/read-models/learner-activity';
import {
  type CandidateInput,
  type CollectedSignal,
  collectCandidateSignals,
} from './candidate-signals';
import { rotationClassForKind } from './variant-rotation';

const RECENT_CORRECT_MS = 3 * 24 * 60 * 60 * 1000;
const NATIVE_ATTEMPT_ACTION = 'experimental:assessment_attempt';

/** 专练空位的优先档。数值越小越靠前。 */
const SCOPED_LEAD_RANK = {
  variant: 0,
  intervention: 1,
  pool: 2,
} as const;

type ScopedLead = keyof typeof SCOPED_LEAD_RANK;

export interface ScopedFillQuestion {
  id: string;
  kind: string;
  knowledgeIds: string[];
  difficulty: number;
  source: string;
}

export interface ScopedFillSelection {
  /** 本次可新放入的题，已按档位与信息分排好并截断。 */
  ids: string[];
  /** 本知识点上、近 3 天没答对、现在可以出的题数（含今日已经在会话里的）。 */
  servableCount: number;
}

interface RankedFill {
  id: string;
  lead: ScopedLead;
  fit: number;
}

function fitScore(signal: CollectedSignal | undefined): number {
  const score = signal?.diagnosticScore ?? signal?.mfiScore;
  return score ?? Number.NEGATIVE_INFINITY;
}

function compareScopedFill(a: RankedFill, b: RankedFill): number {
  const lead = SCOPED_LEAD_RANK[a.lead] - SCOPED_LEAD_RANK[b.lead];
  if (lead !== 0) return lead;
  if (a.fit !== b.fit) return b.fit - a.fit;
  return a.id.localeCompare(b.id);
}

function toCandidate(row: ScopedFillQuestion): CandidateInput {
  return {
    refKind: 'question',
    refId: row.id,
    role: 'diagnostic',
    kind: rotationClassForKind(row.kind) !== undefined ? row.kind : undefined,
    knowledgeIds: row.knowledgeIds,
    difficulty: row.difficulty,
    source: row.source,
  };
}

function leadFor(row: ScopedFillQuestion, variantIds: ReadonlySet<string>): ScopedLead {
  if (variantIds.has(row.id)) return 'variant';
  if (row.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) return 'intervention';
  return 'pool';
}

async function recentlyCorrectQuestionIds(
  db: Db | Tx,
  questionIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return new Set();
  const since = new Date(now.getTime() - RECENT_CORRECT_MS);
  const rows = await db
    .select({
      id: event.id,
      subjectId: event.subject_id,
      action: event.action,
      outcome: event.outcome,
    })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        eq(event.subject_kind, 'question'),
        inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
        inArray(event.subject_id, ids),
        gte(event.created_at, since),
      ),
    );
  const allowed = await allowedEventIds(
    db,
    rows.map((row) => row.id),
  );
  const correct = new Set<string>();
  const nativeIds: string[] = [];
  for (const row of rows) {
    if (!allowed.has(row.id)) continue;
    if (row.action === NATIVE_ATTEMPT_ACTION) nativeIds.push(row.id);
    else if (row.outcome === 'success') correct.add(row.subjectId);
  }
  if (nativeIds.length === 0) return correct;
  const outcomes = await loadNativeAttemptOutcomes(db, nativeIds);
  const subjectByEvent = new Map(rows.map((row) => [row.id, row.subjectId]));
  for (const [eventId, outcome] of outcomes) {
    if (outcome !== 'success') continue;
    const subjectId = subjectByEvent.get(eventId);
    if (subjectId) correct.add(subjectId);
  }
  return correct;
}

async function acceptedVariantIds(
  db: Db | Tx,
  questionIds: readonly string[],
): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set();
  const rows = await db
    .select({ id: mistake_variant.variant_question_id })
    .from(mistake_variant)
    .where(
      and(
        eq(mistake_variant.status, 'active'),
        isNotNull(mistake_variant.variant_question_id),
        inArray(mistake_variant.variant_question_id, [...questionIds]),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) if (row.id) ids.add(row.id);
  return ids;
}

export async function selectScopedKnowledgeFill(
  db: Db | Tx,
  input: {
    now: Date;
    questions: readonly ScopedFillQuestion[];
    admittedIds: ReadonlySet<string>;
    alreadyPlacedIds: ReadonlySet<string>;
    limit: number;
  },
): Promise<ScopedFillSelection> {
  const admitted = input.questions.filter((row) => input.admittedIds.has(row.id));
  const recent = await recentlyCorrectQuestionIds(
    db,
    admitted.map((row) => row.id),
    input.now,
  );
  const servable = admitted.filter((row) => !recent.has(row.id));
  const fresh = servable.filter((row) => !input.alreadyPlacedIds.has(row.id));
  if (fresh.length === 0 || input.limit <= 0) {
    return { ids: [], servableCount: servable.length };
  }
  const signals = await collectCandidateSignals(db, fresh.map(toCandidate));
  const variantIds = await acceptedVariantIds(
    db,
    fresh.map((row) => row.id),
  );
  const signalById = new Map(signals.map((signal) => [signal.refId, signal]));
  const ranked = fresh
    .map(
      (row): RankedFill => ({
        id: row.id,
        lead: leadFor(row, variantIds),
        fit: fitScore(signalById.get(row.id)),
      }),
    )
    .sort(compareScopedFill);
  return {
    ids: ranked.slice(0, input.limit).map((row) => row.id),
    servableCount: servable.length,
  };
}
