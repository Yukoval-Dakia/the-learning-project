import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { type EffectiveTruth, getEffectiveTruths, writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { lockAssessmentEvaluationGroup } from '@/kernel/locks/assessment-evaluation-group-lock';
import {
  type NativeAttemptVerdict,
  nativeAttemptOutcome,
  resolveVerdictForAttempt,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { withActiveCauseCategoryOverlays } from '@/kernel/read-models/cause-overlay';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import {
  type FailureAttempt,
  getFailureAttemptsForDerivation,
} from '@/kernel/read-models/failure-attempts';
import { loadFailureLearningKnowledgeContext } from '@/kernel/read-models/failure-learning-context';
import {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
} from '@/kernel/read-models/subject-profile';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import type { SetAttemptCauseBody } from '../api/contracts';

type EventRow = typeof event.$inferSelect;

const NOT_WRONG_OR_PARTIAL = '这题这次没有判错或部分对，先不能选错因。';
const USAGE_FAILURE_WINDOW = 200;

type AttemptCauseOptionsCurrent = {
  source: 'user' | 'agent';
  primary_category: string;
  label: string;
};

type CauseTarget = {
  attempt: EventRow;
  knowledgeIds: string[];
  profile: SubjectProfile;
};

function isSelectableNativeVerdict(native: NativeAttemptVerdict | undefined): boolean {
  const outcome = nativeAttemptOutcome(native);
  if (outcome === 'failure' || outcome === 'partial') return true;
  const selected = native?.effective;
  return (
    selected?.row.provenance?.source !== 'self_report' &&
    selected?.verdict.verdict === 'unsupported' &&
    selected.verdict.reason === 'partial_unknown_points'
  );
}

function payloadKnowledgeIds(row: EventRow): string[] {
  const value = (row.payload as { referenced_knowledge_ids?: unknown }).referenced_knowledge_ids;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

async function loadKnowledgeIds(db: Db | Tx, attempt: EventRow): Promise<string[]> {
  if (attempt.action === 'experimental:assessment_attempt') {
    const native = await resolveVerdictsForNativeAttempts(db, [attempt]);
    const knowledgeIds = native.get(attempt.id)?.knowledge_ids ?? [];
    if (knowledgeIds.length > 0) return knowledgeIds;
  }
  const referenced = payloadKnowledgeIds(attempt);
  if (referenced.length > 0) return referenced;
  const [questionRow] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, attempt.subject_id));
  return questionRow?.knowledge_ids ?? [];
}

async function loadCauseTarget(
  db: Db | Tx,
  attemptEventId: string,
  lockAttempt = false,
): Promise<CauseTarget> {
  const query = db.select().from(event).where(eq(event.id, attemptEventId));
  const [attempt] = await (lockAttempt ? query.for('update') : query).limit(1);
  if (!attempt) throw new ApiError('not_found', 'attempt not found', 404);

  const allowedActions = new Set(['attempt', 'review', 'experimental:assessment_attempt']);
  if (!allowedActions.has(attempt.action) || attempt.subject_kind !== 'question') {
    throw new ApiError('not_found', 'attempt not found', 404);
  }

  const truth = (await getEffectiveTruths(db, [attempt.id])).get(attempt.id) ?? null;
  if (truth?.terminal_state !== 'active' || truth.effective_event_id !== attempt.id) {
    throw new ApiError('cause_not_available', NOT_WRONG_OR_PARTIAL, 409);
  }

  let outcome = attempt.outcome;
  if (attempt.action === 'experimental:assessment_attempt') {
    const native = await resolveVerdictsForNativeAttempts(db, [attempt]);
    const verdict = native.get(attempt.id);
    if (isSelectableNativeVerdict(verdict)) return buildCauseTarget(db, attempt);
    outcome = nativeAttemptOutcome(verdict);
  } else {
    const verdict = await resolveVerdictForAttempt(db, attempt.id);
    outcome =
      verdict.effective?.verdict.coarse_outcome ??
      verdict.embedded?.coarse_outcome ??
      attempt.outcome;
  }
  const selectableOutcomes = new Set(['failure', 'partial', 'incorrect', 'partial_unknown']);
  if (outcome === null || !selectableOutcomes.has(outcome)) {
    throw new ApiError('cause_not_available', NOT_WRONG_OR_PARTIAL, 409);
  }

  return buildCauseTarget(db, attempt);
}

async function buildCauseTarget(db: Db | Tx, attempt: EventRow): Promise<CauseTarget> {
  const knowledgeIds = await loadKnowledgeIds(db, attempt);
  const profile = await withActiveCauseCategoryOverlays(
    db,
    await resolveSubjectProfileForKnowledgeIds(db, knowledgeIds),
  );
  return { attempt, knowledgeIds, profile };
}

async function lockNativeAttemptVerification(tx: Tx, attemptEventId: string): Promise<void> {
  const [attempt] = await tx.select().from(event).where(eq(event.id, attemptEventId)).limit(1);
  if (attempt?.action !== 'experimental:assessment_attempt') return;
  const native = await resolveVerdictsForNativeAttempts(tx, [attempt]);
  const evaluationGroupId = native.get(attempt.id)?.evaluation_group_id;
  if (evaluationGroupId) await lockAssessmentEvaluationGroup(tx, evaluationGroupId);
}

function causeLabel(profile: SubjectProfile, primaryCategory: string): string {
  return (
    profile.causeCategories.find((category) => category.id === primaryCategory)?.label ??
    primaryCategory
  );
}

async function effectiveEventRows(
  db: Db | Tx,
  rows: readonly EventRow[],
): Promise<Array<{ original: EventRow; effective: EventRow; truth: EffectiveTruth }>> {
  if (rows.length === 0) return [];
  const truths = await getEffectiveTruths(
    db,
    rows.map((row) => row.id),
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const missingIds = [...truths.values()]
    .map((truth) => truth.effective_event_id)
    .filter((id): id is string => id !== null && !rowById.has(id));
  if (missingIds.length > 0) {
    const replacements = await db.select().from(event).where(inArray(event.id, missingIds));
    for (const row of replacements) rowById.set(row.id, row);
  }

  const out: Array<{ original: EventRow; effective: EventRow; truth: EffectiveTruth }> = [];
  for (const original of rows) {
    const truth = truths.get(original.id);
    if (truth?.terminal_state !== 'active' || truth.effective_event_id === null) continue;
    const effective = rowById.get(truth.effective_event_id);
    if (!effective || effective.action !== original.action) continue;
    if (effective.subject_kind !== original.subject_kind) continue;
    if (effective.subject_id !== original.subject_id) continue;
    out.push({ original, effective, truth });
  }
  return out;
}

async function currentCause(
  db: Db | Tx,
  target: CauseTarget,
): Promise<AttemptCauseOptionsCurrent | null> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        inArray(event.action, ['judge', 'experimental:user_cause']),
        eq(event.subject_kind, 'event'),
        or(
          eq(event.subject_id, target.attempt.id),
          eq(event.caused_by_event_id, target.attempt.id),
        ),
      ),
    );
  const candidates = (await effectiveEventRows(db, rows)).filter(({ original, effective }) => {
    const originalAnchor =
      original.subject_id === target.attempt.id ||
      original.caused_by_event_id === target.attempt.id;
    const effectiveAnchor =
      effective.subject_id === target.attempt.id ||
      effective.caused_by_event_id === target.attempt.id;
    return originalAnchor && effectiveAnchor;
  });
  candidates.sort((a, b) => b.effective.dispatch_seq - a.effective.dispatch_seq);
  const user = candidates.find(({ effective }) => effective.action === 'experimental:user_cause');
  const agent = candidates.find(({ effective }) => effective.action === 'judge');
  const selected = user ?? agent;
  if (!selected) return null;
  const primaryCategory =
    selected.effective.action === 'experimental:user_cause'
      ? (selected.effective.payload as { primary_category?: unknown }).primary_category
      : (selected.effective.payload as { cause?: { primary_category?: unknown } }).cause
          ?.primary_category;
  if (typeof primaryCategory !== 'string' || primaryCategory.length === 0) return null;
  return {
    source: selected.effective.action === 'experimental:user_cause' ? 'user' : 'agent',
    primary_category: primaryCategory,
    label: causeLabel(target.profile, primaryCategory),
  };
}

async function sameSubjectFailureCauses(db: Db, target: CauseTarget): Promise<string[]> {
  const failures = await getFailureAttemptsForDerivation(db, {
    limit: USAGE_FAILURE_WINDOW,
  });
  const liveQuestionIds = [
    ...new Set(
      failures
        .filter((failure) => failure.referenced_knowledge_ids.length === 0)
        .map((failure) => failure.question_id),
    ),
  ];
  const questionKnowledgeIds = new Map<string, string[]>();
  if (liveQuestionIds.length > 0) {
    const rows = await db
      .select({ id: question.id, knowledge_ids: question.knowledge_ids })
      .from(question)
      .where(inArray(question.id, liveQuestionIds));
    for (const row of rows) questionKnowledgeIds.set(row.id, row.knowledge_ids);
  }
  const knowledgeIds = [
    ...new Set([
      ...target.knowledgeIds,
      ...failures.flatMap((failure) => failure.referenced_knowledge_ids),
      ...[...questionKnowledgeIds.values()].flat(),
    ]),
  ];
  const domainById = new Map(
    (await loadFailureLearningKnowledgeContext(db, knowledgeIds)).map((node) => [
      node.id,
      node.effective_domain,
    ]),
  );
  const subjectOf = (failure: FailureAttempt): string | null => {
    const ids =
      failure.referenced_knowledge_ids.length > 0
        ? failure.referenced_knowledge_ids
        : (questionKnowledgeIds.get(failure.question_id) ?? []);
    const domain = ids.map((id) => domainById.get(id)).find(Boolean) ?? null;
    return domain ? resolveSubjectProfile(domain).id : null;
  };
  return failures.flatMap((failure) => {
    if (subjectOf(failure) !== target.profile.id) return [];
    const cause = effectiveCauseForFailureAttempt(failure);
    return cause ? [cause.primary_category] : [];
  });
}

function rankOptions(profile: SubjectProfile, usedCategories: readonly string[]) {
  const counts = new Map<string, number>();
  for (const category of usedCategories) {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return profile.causeCategories
    .map((category, index) => ({
      id: category.id,
      label: category.label,
      index,
      count: counts.get(category.id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ id, label }) => ({ id, label }));
}

export async function getAttemptCauseOptions(
  db: Db,
  attemptEventId: string,
): Promise<{
  options: Array<{ id: string; label: string }>;
  current: AttemptCauseOptionsCurrent | null;
}> {
  const target = await loadCauseTarget(db, attemptEventId);
  const [usedCategories, current] = await Promise.all([
    sameSubjectFailureCauses(db, target),
    currentCause(db, target),
  ]);
  return { options: rankOptions(target.profile, usedCategories), current };
}

export async function setAttemptCause(
  db: Db,
  attemptEventId: string,
  body: SetAttemptCauseBody,
): Promise<{
  cause: {
    source: 'user';
    primary_category: string;
    label: string;
    user_notes: string | null;
  };
}> {
  const userNotes = body.user_notes ?? null;
  return db.transaction(async (tx) => {
    // Native activation moves the effective head under this group lock. Resolve
    // the immutable group coordinate first, then re-read the verdict while the
    // lock is held so the eligibility check and cause append share its serialization.
    await lockNativeAttemptVerification(tx, attemptEventId);
    const target = await loadCauseTarget(tx, attemptEventId, true);
    assertCauseAllowedForSubjectProfile(
      { primary_category: body.primary_category },
      target.profile,
    );
    await writeEvent(tx, {
      id: createId(),
      session_id: target.attempt.session_id,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: attemptEventId,
      outcome: null,
      payload: {
        primary_category: body.primary_category,
        user_notes: userNotes,
      },
      caused_by_event_id: attemptEventId,
      task_run_id: null,
      cost_micro_usd: null,
    });
    return {
      cause: {
        source: 'user' as const,
        primary_category: body.primary_category,
        label: causeLabel(target.profile, body.primary_category),
        user_notes: userNotes,
      },
    };
  });
}
