// Assembles AttributionEvidence for one failure. Reads grading output, the
// admission solution prior, and history. Does not grade, admit, or settle.

import { and, asc, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import {
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import {
  getFailureAttemptForDerivationById,
  getFailureAttemptsForDerivation,
} from '@/kernel/read-models/failure-attempts';
import { getMasteryProjection, isObserved } from '@/kernel/read-models/mastery-projection';
import { readSolutionPriorForServer } from '../../question-bank/public';
import {
  type AttributionEvidence,
  type GradingEvidence,
  KNOWLEDGE_FAILURE_SCAN_LIMIT,
  KNOWLEDGE_FAILURE_WINDOW_DAYS,
  type KnowledgeFailureCount14d,
  type PrerequisiteMasteryEvidence,
  RECENT_SAME_QUESTION_ATTEMPTS,
  type RecentSameQuestionAttempt,
  behaviorFromAttemptPayload,
} from '../tasks/attribution-evidence';

const RECENT_ATTEMPT_OVERSAMPLE = 20;
const MAX_PITFALLS = 12;
const MAX_PREREQUISITES = 12;

export async function loadAttributionEvidence(
  db: Db | Tx,
  input: {
    attemptEventId: string;
    questionId: string;
    attemptPayload: Record<string, unknown>;
    knowledgeIds: readonly string[];
    gradingEvidence: GradingEvidence | null;
    revisionId: string | null;
    failedPartIds: readonly string[];
    now?: Date;
  },
): Promise<AttributionEvidence> {
  const now = input.now ?? new Date();
  const knowledgeIds = [...new Set(input.knowledgeIds.filter((id) => id.length > 0))];
  const [failedPartPitfalls, recentSameQuestion, failureCounts, prerequisiteMastery] =
    await Promise.all([
      loadFailedPartPitfalls(db, input.revisionId, input.failedPartIds),
      loadRecentSameQuestion(db, input.questionId, input.attemptEventId),
      loadKnowledgeFailureCounts(db, knowledgeIds, now),
      loadPrerequisiteMastery(db, knowledgeIds),
    ]);
  return {
    grading_evidence: input.gradingEvidence,
    behavior: behaviorFromAttemptPayload(input.attemptPayload),
    failed_part_pitfalls: failedPartPitfalls,
    recent_same_question: recentSameQuestion,
    knowledge_failure_counts_14d: failureCounts,
    prerequisite_mastery: prerequisiteMastery,
  };
}

async function loadFailedPartPitfalls(
  db: Db | Tx,
  revisionId: string | null,
  failedPartIds: readonly string[],
): Promise<AttributionEvidence['failed_part_pitfalls']> {
  const wanted = new Set(failedPartIds);
  if (revisionId == null || wanted.size === 0) return [];
  const priors = await readSolutionPriorForServer(db, { revisionId });
  const pitfalls: AttributionEvidence['failed_part_pitfalls'] = [];
  for (const row of priors) {
    if (!wanted.has(row.part_id)) continue;
    for (const pitfall of row.prior.pitfalls) {
      pitfalls.push({
        part_id: row.part_id,
        mechanism_md: pitfall.mechanism_md,
        trigger_md: pitfall.trigger_md,
      });
      if (pitfalls.length >= MAX_PITFALLS) return pitfalls;
    }
  }
  return pitfalls;
}

async function loadRecentSameQuestion(
  db: Db | Tx,
  questionId: string,
  attemptEventId: string,
): Promise<RecentSameQuestionAttempt[]> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        ne(event.id, attemptEventId),
        or(
          inArray(event.action, ['attempt', 'review']),
          eq(event.action, 'experimental:assessment_attempt'),
        ),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(RECENT_ATTEMPT_OVERSAMPLE);
  if (rows.length === 0) return [];
  const allowed = await allowedEventIds(
    db,
    rows.map((row) => row.id),
  );
  const kept = rows.filter((row) => allowed.has(row.id)).slice(0, RECENT_SAME_QUESTION_ATTEMPTS);
  if (kept.length === 0) return [];
  const native = await resolveVerdictsForNativeAttempts(
    db,
    kept.filter((row) => row.action === 'experimental:assessment_attempt'),
  );
  // The list above already dropped the attempt being attributed. Causes are
  // loaded for those same ids. A per-question failure window would also count
  // the current attempt and leave the oldest history row without a cause.
  const failureIds = kept.flatMap((row) => {
    if (row.action === 'experimental:assessment_attempt') {
      return nativeAttemptOutcome(native.get(row.id)) === 'failure' ? [row.id] : [];
    }
    return row.outcome === 'failure' ? [row.id] : [];
  });
  const loaded = await Promise.all(
    failureIds.map((id) => getFailureAttemptForDerivationById(db, id)),
  );
  const causeByAttempt = new Map(
    loaded.flatMap((failure) => {
      if (!failure || failure.attempt_event_id === attemptEventId) return [];
      const cause = effectiveCauseForFailureAttempt(failure);
      return cause ? [[failure.attempt_event_id, cause] as const] : [];
    }),
  );
  return kept.map((row) => {
    const nativeOutcome =
      row.action === 'experimental:assessment_attempt'
        ? nativeAttemptOutcome(native.get(row.id))
        : null;
    const cause = causeByAttempt.get(row.id) ?? null;
    const outcome = mapRecentOutcome(row.outcome, nativeOutcome);
    return {
      attempt_event_id: row.id,
      created_at: row.created_at.toISOString(),
      outcome,
      cause_category: outcome === 'failure' ? (cause?.primary_category ?? null) : null,
      cause_confidence:
        outcome === 'failure' && cause?.source === 'agent' ? cause.confidence : null,
    };
  });
}

function mapRecentOutcome(
  eventOutcome: string | null,
  nativeOutcome: ReturnType<typeof nativeAttemptOutcome> | null,
): RecentSameQuestionAttempt['outcome'] {
  if (nativeOutcome === 'success' || nativeOutcome === 'failure' || nativeOutcome === 'partial') {
    return nativeOutcome;
  }
  if (nativeOutcome === 'pending') return 'pending';
  if (eventOutcome === 'success' || eventOutcome === 'failure' || eventOutcome === 'partial') {
    return eventOutcome;
  }
  return 'unknown';
}

async function loadKnowledgeFailureCounts(
  db: Db | Tx,
  knowledgeIds: readonly string[],
  now: Date,
): Promise<KnowledgeFailureCount14d[]> {
  if (knowledgeIds.length === 0) return [];
  const since = new Date(now.getTime() - KNOWLEDGE_FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const failures = await getFailureAttemptsForDerivation(db, {
    since,
    limit: KNOWLEDGE_FAILURE_SCAN_LIMIT,
    includeReviewFailures: true,
  });
  const wanted = new Set(knowledgeIds);
  const counts = new Map<string, number>(knowledgeIds.map((id) => [id, 0]));
  for (const failure of failures) {
    for (const id of new Set(failure.referenced_knowledge_ids)) {
      if (!wanted.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([knowledge_id, failure_count]) => ({
    knowledge_id,
    failure_count,
  }));
}

async function loadPrerequisiteMastery(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<PrerequisiteMasteryEvidence[]> {
  if (knowledgeIds.length === 0) return [];
  const edges = await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
    })
    .from(knowledge_edge)
    .where(
      and(
        inArray(knowledge_edge.to_knowledge_id, [...knowledgeIds]),
        eq(knowledge_edge.relation_type, 'prerequisite'),
        isNull(knowledge_edge.archived_at),
      ),
    )
    .orderBy(
      asc(knowledge_edge.to_knowledge_id),
      asc(knowledge_edge.from_knowledge_id),
      asc(knowledge_edge.id),
    )
    .limit(MAX_PREREQUISITES);
  if (edges.length === 0) return [];
  const prereqIds = [...new Set(edges.map((edge) => edge.from_knowledge_id))];
  const [projection, names] = await Promise.all([
    getMasteryProjection(db, prereqIds),
    db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, prereqIds)),
  ]);
  const nameById = new Map(names.map((row) => [row.id, row.name] as const));
  return edges.map((edge) => {
    const reading = projection.get(edge.from_knowledge_id);
    const observed = reading && isObserved(reading) ? reading : null;
    const view = observed ? masteryBandView(observed) : null;
    const band = view && !view.unknown ? A5_BANDS[view.band] : null;
    return {
      knowledge_id: edge.from_knowledge_id,
      name: nameById.get(edge.from_knowledge_id) ?? null,
      supports_knowledge_id: edge.to_knowledge_id,
      band,
      low_confidence: observed ? observed.low_confidence : null,
    };
  });
}
