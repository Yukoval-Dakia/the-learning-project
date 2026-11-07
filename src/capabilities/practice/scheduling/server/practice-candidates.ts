// YUK-1790 LIGHT — practice candidate read (the session owner's candidate composition).
//
// One page = one repeatable-read, read-only snapshot. The union is the design's D2 set:
// due (FSRS / never-reviewed), admitted mistake variants, new-check, the real prerequisite
// frontier, in-scope never-started admitted questions, and the existing doable papers /
// intervention containers. It is deliberately NOT the old softmax pre-selection: every
// source here is that source owner's deterministic pool, and caps are reported as
// truncation facts (source_caps / exclusions), never as silent completeness.
//
// Dedupe key: refKind + refId + revision. Roles accumulate, so a question that is both due
// and an active variant keeps BOTH facts. Nothing is written: no queue, no flag, no run.
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { LearningItemOpenStatus } from '@/core/schema/business';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { KnowledgeSignal } from '@/core/schema/knowledge-signal';
import { absentSignal, knownSignal, unknownSignal } from '@/core/schema/knowledge-signal';
import {
  type CandidateAttemptWindow,
  type CandidateDueFact,
  type CandidateExclusion,
  type CandidateGap,
  type CandidateKnowledgeSignal,
  type CandidateRevision,
  PRACTICE_CANDIDATE_PAGE_SIZE,
  PRACTICE_CANDIDATE_ROLES,
  type PracticeCandidateQuery,
  type PracticeCandidateRead,
  type PracticeCandidateRole,
  type PracticeCandidateRow,
} from '@/core/schema/practice-candidate';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import {
  answer,
  event,
  goal,
  learning_item,
  material_fsrs_state,
  mistake_variant,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import {
  type ActiveGoal,
  listActiveGoalsWithResolvedScope,
} from '@/kernel/read-models/active-goal-scope';
import { readCauseJudgment } from '@/kernel/read-models/cause-judgment';
import {
  getNonKcKnowledgeIds,
  withoutNonKcKnowledgeIds,
} from '@/kernel/read-models/knowledge-roles';
import { projectKnowledgeState } from '@/kernel/read-models/knowledge-state';
import { learnableFrontierResolved } from '@/kernel/read-models/learnable-frontier';
import {
  readLearnerJudgments,
  readQuestionCardReviewTimings,
} from '@/kernel/read-models/learner-judgment';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { EVIDENCE_DEMAND_VERSION } from '@/kernel/supply-contracts';
import { getPracticeList } from '../../session/public';
import { type CandidateInput, collectCandidateSignals } from './candidate-signals';
import { REVIEW_DUE_LIMIT_MAX, queryReviewDue } from './due-list';
import { knowledgeLabels } from './knowledge-labels';
import { FRONTIER_MAX_ITEMS } from './learnable-frontier';
import { readQuestionPace } from './question-pace';
import { VARIANT_INPUT_LIMIT } from './stream-inputs';

type DbLike = Db | Tx;

const LEARNER_JUDGMENT_SOURCE = 'kernel/read-models/learner-judgment:readLearnerJudgments';
const CAUSE_JUDGMENT_SOURCE = 'kernel/read-models/cause-judgment:readCauseJudgment';
const QUESTION_CARD_SOURCE = 'kernel/read-models/learner-judgment:readQuestionCardReviewTiming';
const SIGNAL_SOURCE = 'practice/scheduling/server/candidate-signals:collectCandidateSignals';
const EXAM_RELEVANCE_SOURCE =
  'practice/scheduling/server/candidate-signals:examRelevanceForKnowledgeIds';
const RECURRENCE_SOURCE =
  'practice/scheduling/server/candidate-signals:batchAggregateMisconceptionRecurrence';
const DIFFICULTY_SOURCE = 'kernel/read-models/question-difficulty:prepareCandidateDifficultyRead';

/** Newest attempt rows scanned per question for the recent-attempt window. */
const ATTEMPT_WINDOW = 6;
/** Prompt excerpt bound: enough to understand the task, never the answer key. */
const PROMPT_EXCERPT_CHARS = 600;
const VARIANT_WINDOW_DAYS = 7;
const NEW_CHECK_LIMIT = 3;
/** Knowledge points one new-check scan may look at; the discovered set is reported as a cap. */
const NEW_CHECK_KC_SCAN_CAP = 24;
const UNATTEMPTED_SCAN_CAP = 40;
const PAPER_LIMIT = 50;
const GAP_DETAIL_LIMIT = 8;
const EXCLUSION_SAMPLE_LIMIT = 5;

const ROLE_RANK: Record<PracticeCandidateRole, number> = {
  due: 0,
  intervention: 0,
  variant: 1,
  new_check: 2,
  frontier: 3,
  unattempted: 4,
  paper: 5,
};

type SourceEntry = {
  refKind: 'question' | 'paper';
  refId: string;
  role: PracticeCandidateRole;
  /** Knowledge card that selected this row as due; null = question-level card. */
  dueKnowledgeId: string | null;
  /** Position inside its source's deterministic order. */
  order: number;
};

type PaperSource = {
  artifactId: string;
  title: string;
  source: string;
  intentSource: string;
  generationStatus: string;
  totalSlots: number;
  knowledgeIds: string[];
};

type QuestionRow = {
  id: string;
  prompt_md: string;
  knowledge_ids: string[];
  kind: string | null;
  difficulty: number | null;
  source: string | null;
  parent_question_id: string | null;
};

type CapFact = { source: string; cap: number; observed: number; hit: boolean };

type ExclusionBucket = {
  reason: CandidateExclusion['reason'];
  roles: Set<PracticeCandidateRole>;
  count: number;
  refIds: string[];
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function bumpBucket(
  buckets: Map<CandidateExclusion['reason'], ExclusionBucket>,
  reason: CandidateExclusion['reason'],
  roles: readonly PracticeCandidateRole[],
  refId: string,
): void {
  const bucket = buckets.get(reason) ?? { reason, roles: new Set(), count: 0, refIds: [] };
  for (const role of roles) bucket.roles.add(role);
  bucket.count += 1;
  if (bucket.refIds.length < EXCLUSION_SAMPLE_LIMIT) bucket.refIds.push(refId);
  buckets.set(reason, bucket);
}

function roleList(roles: Iterable<PracticeCandidateRole>): PracticeCandidateRole[] {
  return [...roles].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b] || a.localeCompare(b));
}

function dueSignal(
  due: { kind: string; at?: Date; reason?: string },
  asOf: Date,
  source: string,
): KnowledgeSignal<string> {
  if (due.kind === 'known' && due.at) return knownSignal(due.at.toISOString(), source, asOf);
  if (due.kind === 'absent') return absentSignal<string>(source, asOf);
  return unknownSignal<string>(source, asOf, due.reason ?? 'due_unavailable');
}

function overdueHours(due: KnowledgeSignal<string>, asOf: Date): number | null {
  if (!due.known || due.value === null) return null;
  const at = Date.parse(due.value);
  if (Number.isNaN(at)) return null;
  return Math.round(((asOf.getTime() - at) / 3_600_000) * 10) / 10;
}

function decodeCursor(cursor: string): { snapshotId: string; offset: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s?: unknown;
      o?: unknown;
    };
    if (typeof parsed.s !== 'string' || typeof parsed.o !== 'number') return null;
    if (!Number.isInteger(parsed.o) || parsed.o < 0) return null;
    return { snapshotId: parsed.s, offset: parsed.o };
  } catch {
    return null;
  }
}

function encodeCursor(snapshotId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ s: snapshotId, o: offset }), 'utf8').toString('base64url');
}

/** Scope is a hard membership set. `all` leaves it open (reported as unscoped). */
type ResolvedScope = {
  kind: 'all' | 'knowledge' | 'goal';
  knowledgeIds: string[];
  knowledgeIdSet: ReadonlySet<string>;
  goals: ActiveGoal[];
  unscoped: boolean;
  unresolved: string | null;
};

async function resolveScope(
  db: DbLike,
  scopeInput: PracticeCandidateQuery['scope'],
): Promise<ResolvedScope> {
  const goals = await listActiveGoalsWithResolvedScope(db as Db);
  if (scopeInput.kind === 'all') {
    return {
      kind: 'all',
      knowledgeIds: [],
      knowledgeIdSet: new Set(),
      goals,
      unscoped: true,
      unresolved: null,
    };
  }
  if (scopeInput.kind === 'knowledge') {
    const ids = [...new Set(scopeInput.knowledgeIds)];
    const idSet = new Set(ids);
    return {
      kind: 'knowledge',
      knowledgeIds: ids,
      knowledgeIdSet: idSet,
      goals: goals.filter((entry) => entry.scope_knowledge_ids.some((kc) => idSet.has(kc))),
      unscoped: false,
      unresolved: null,
    };
  }
  const target = goals.find((entry) => entry.id === scopeInput.goalId) ?? null;
  if (target === null) {
    return {
      kind: 'goal',
      knowledgeIds: [],
      knowledgeIdSet: new Set(),
      goals: [],
      unscoped: false,
      unresolved: `goal ${scopeInput.goalId} is not an active goal; its scope cannot be resolved`,
    };
  }
  const ids = [...new Set(target.scope_knowledge_ids)];
  return {
    kind: 'goal',
    knowledgeIds: ids,
    knowledgeIdSet: new Set(ids),
    goals: [target],
    unscoped: false,
    unresolved:
      ids.length === 0
        ? `goal ${target.id} resolves to an empty knowledge scope; no candidate can be in scope`
        : null,
  };
}

/**
 * A question is in scope only when EVERY knowledge id it probes is in the scope set: a
 * hard "只练这个范围" constraint must not smuggle an out-of-range item in. Containers
 * (papers) are the documented exception — they keep container identity and are admitted
 * on intersection.
 */
function questionInScope(knowledgeIds: readonly string[], scope: ResolvedScope): boolean {
  if (scope.kind === 'all') return true;
  if (knowledgeIds.length === 0) return false;
  return knowledgeIds.every((kc) => scope.knowledgeIdSet.has(kc));
}

function containerInScope(knowledgeIds: readonly string[], scope: ResolvedScope): boolean {
  if (scope.kind === 'all') return true;
  return knowledgeIds.some((kc) => scope.knowledgeIdSet.has(kc));
}

async function readQuestionRows(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, QuestionRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      knowledge_ids: question.knowledge_ids,
      kind: question.kind,
      difficulty: question.difficulty,
      source: question.source,
      parent_question_id: question.parent_question_id,
    })
    .from(question)
    .where(inArray(question.id, unique));
  return new Map(rows.map((row) => [row.id, { ...row, knowledge_ids: row.knowledge_ids ?? [] }]));
}

async function readRevisions(
  db: DbLike,
  rows: Map<string, QuestionRow>,
): Promise<Map<string, CandidateRevision>> {
  const groupIds = [...new Set([...rows.values()].map((row) => row.parent_question_id ?? row.id))];
  const out = new Map<string, CandidateRevision>();
  if (groupIds.length === 0) return out;
  const lifecycles = await db
    .select({
      group_id: question_group_lifecycle.group_id,
      current_revision_id: question_group_lifecycle.current_revision_id,
    })
    .from(question_group_lifecycle)
    .where(inArray(question_group_lifecycle.group_id, groupIds));
  const revisionIds = lifecycles
    .map((row) => row.current_revision_id)
    .filter((id): id is string => id !== null);
  const revisions = revisionIds.length
    ? await db
        .select({
          revision_id: question_revision.revision_id,
          integrity_digest: question_revision.integrity_digest,
        })
        .from(question_revision)
        .where(inArray(question_revision.revision_id, revisionIds))
    : [];
  const digestById = new Map(revisions.map((row) => [row.revision_id, row.integrity_digest]));
  const lifecycleByGroup = new Map(lifecycles.map((row) => [row.group_id, row]));
  for (const [id, row] of rows) {
    const groupId = row.parent_question_id ?? id;
    const revisionId = lifecycleByGroup.get(groupId)?.current_revision_id ?? null;
    out.set(id, {
      known: revisionId !== null,
      revision_id: revisionId,
      digest: revisionId !== null ? (digestById.get(revisionId) ?? null) : null,
      version: null,
      missing_reason: revisionId === null ? 'no_published_revision' : null,
    });
  }
  return out;
}

type AttemptRow = { id: string; subject_id: string; outcome: string | null; created_at: Date };

async function readAttemptWindows(
  db: DbLike,
  questionIds: readonly string[],
  asOf: Date,
): Promise<Map<string, CandidateAttemptWindow>> {
  const out = new Map<string, CandidateAttemptWindow>();
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return out;
  const rows = await db.execute<AttemptRow>(sql`
    select id, subject_id, outcome, created_at from (
      select e.id, e.subject_id, e.outcome, e.created_at,
        row_number() over (
          partition by e.subject_id
          order by e.created_at desc, e.dispatch_seq desc, e.id desc
        ) as rn
      from ${event} e
      where e.subject_kind = 'question'
        and e.subject_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        and e.action in ('attempt', 'experimental:assessment_attempt')
    ) ranked
    where rn <= ${ATTEMPT_WINDOW}
    order by subject_id, rn
  `);
  const active = new Set<string>();
  if (rows.length > 0) {
    const statuses = await getCorrectionStatuses(
      db,
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      if (statuses.get(row.id)?.state === 'active') active.add(row.id);
    }
  }
  const fetchedByQuestion = new Map<string, number>();
  const activeByQuestion = new Map<string, AttemptRow[]>();
  for (const row of rows) {
    fetchedByQuestion.set(row.subject_id, (fetchedByQuestion.get(row.subject_id) ?? 0) + 1);
    if (!active.has(row.id)) continue;
    const bucket = activeByQuestion.get(row.subject_id) ?? [];
    bucket.push(row);
    activeByQuestion.set(row.subject_id, bucket);
  }
  for (const id of ids) {
    const bucket = activeByQuestion.get(id) ?? [];
    const windowComplete = (fetchedByQuestion.get(id) ?? 0) < ATTEMPT_WINDOW;
    const counts = { success: 0, partial: 0, failure: 0 };
    for (const row of bucket) {
      if (row.outcome === 'success') counts.success += 1;
      else if (row.outcome === 'partial') counts.partial += 1;
      else if (row.outcome === 'failure') counts.failure += 1;
    }
    const latest = bucket[0] ?? null;
    out.set(id, {
      // A completed window is the lifetime history; a clipped window is only a floor.
      count: windowComplete
        ? knownSignal(bucket.length, 'kernel/events:event.attempt', asOf)
        : unknownSignal<number>(
            'kernel/events:event.attempt',
            asOf,
            'attempt_history_exceeds_window; count is a floor, not a lifetime total',
          ),
      outcomes: counts,
      last_at: latest ? latest.created_at.toISOString() : null,
      last_outcome:
        latest === null
          ? null
          : latest.outcome === 'success' ||
              latest.outcome === 'partial' ||
              latest.outcome === 'failure'
            ? latest.outcome
            : null,
      window: ATTEMPT_WINDOW,
      window_complete: windowComplete,
    });
  }
  return out;
}

function emptyAttemptWindow(asOf: Date, reason: string): CandidateAttemptWindow {
  return {
    count: unknownSignal<number>('none', asOf, reason),
    outcomes: { success: 0, partial: 0, failure: 0 },
    last_at: null,
    last_outcome: null,
    window: ATTEMPT_WINDOW,
    window_complete: false,
  };
}

/**
 * The first servable question per knowledge point, for every point at once. The single-KC
 * loop this replaces ran one query per point inside the snapshot transaction; the containment
 * OR is the same membership test, and the admitted set decides servability once for all rows.
 */
async function pickFirstServablePerKnowledge(
  db: DbLike,
  knowledgeIds: readonly string[],
): Promise<Map<string, string | undefined>> {
  const first = new Map<string, string | undefined>();
  for (const knowledgeId of knowledgeIds) first.set(knowledgeId, undefined);
  if (knowledgeIds.length === 0) return first;
  const containment = sql`(${sql.join(
    knowledgeIds.map(
      (knowledgeId) => sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
    ),
    sql` or `,
  )})`;
  const rows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(
      and(
        containment,
        notDraftPredicate(question.draft_status),
        questionSuspendedPredicate(question),
      ),
    )
    // Deterministic pick; the composer's sibling omits this, this read does not.
    .orderBy(question.id);
  const admitted = await readAutomaticallyServableQuestionIds(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if (!admitted.has(row.id)) continue;
    for (const knowledgeId of row.knowledge_ids ?? []) {
      if (first.has(knowledgeId) && first.get(knowledgeId) === undefined) {
        first.set(knowledgeId, row.id);
      }
    }
  }
  return first;
}

export async function readPracticeCandidates(
  db: Db | Tx,
  input: PracticeCandidateQuery,
): Promise<PracticeCandidateRead> {
  if ('$client' in db) {
    return db.transaction((tx) => readPracticeCandidatesInSnapshot(tx, input), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  return readPracticeCandidatesInSnapshot(db, input);
}

async function readPracticeCandidatesInSnapshot(
  db: DbLike,
  input: PracticeCandidateQuery,
): Promise<PracticeCandidateRead> {
  const asOf = new Date();
  const scope = await resolveScope(db, input.scope);
  const pageSize = input.pageSize ?? PRACTICE_CANDIDATE_PAGE_SIZE;
  if (scope.unresolved !== null) {
    return terminalRead(db, asOf, scope, 'scope_unresolved', scope.unresolved, pageSize);
  }

  const caps: CapFact[] = [];
  const exclusions = new Map<CandidateExclusion['reason'], ExclusionBucket>();
  const raw: SourceEntry[] = [];

  // ── 1. Due: the product's own due page (FSRS projection + never-reviewed + round-robin).
  const { rows: dueRows } = await queryReviewDue(db as Db, {
    limit: REVIEW_DUE_LIMIT_MAX,
    now: asOf,
  });
  caps.push({
    source: 'practice/scheduling/server/due-list:queryReviewDue',
    cap: REVIEW_DUE_LIMIT_MAX,
    observed: dueRows.length,
    hit: dueRows.length >= REVIEW_DUE_LIMIT_MAX,
  });
  dueRows.forEach((row, index) => {
    raw.push({
      refKind: 'question',
      refId: row.question_id,
      role: 'due',
      dueKnowledgeId: row.fsrs_subject_kind === 'knowledge' ? row.fsrs_subject_id : null,
      order: index,
    });
  });

  // ── 2. Admitted mistake variants (same 7-day failure window as the composer).
  const since = new Date(asOf.getTime() - VARIANT_WINDOW_DAYS * 24 * 3600 * 1000);
  const recentFailures = await db
    .select({ qid: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'attempt'),
        eq(event.outcome, 'failure'),
        eq(event.subject_kind, 'question'),
        gte(event.created_at, since),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const failedQids = [...new Set(recentFailures.map((row) => row.qid))];
  const variantCandidates = failedQids.length
    ? await db
        .select({
          variant_question_id: mistake_variant.variant_question_id,
          parent_question_id: mistake_variant.parent_question_id,
        })
        .from(mistake_variant)
        .where(
          and(
            eq(mistake_variant.status, 'active'),
            isNotNull(mistake_variant.variant_question_id),
            inArray(mistake_variant.parent_question_id, failedQids),
          ),
        )
        .orderBy(desc(mistake_variant.created_at), desc(mistake_variant.id))
    : [];
  caps.push({
    source: 'practice/scheduling/server/stream-inputs:mistake_variant',
    cap: VARIANT_INPUT_LIMIT,
    observed: variantCandidates.length,
    hit: variantCandidates.length > VARIANT_INPUT_LIMIT,
  });
  variantCandidates.forEach((row, index) => {
    if (row.variant_question_id === null) return;
    raw.push({
      refKind: 'question',
      refId: row.variant_question_id,
      role: 'variant',
      dueKnowledgeId: null,
      order: index,
    });
  });

  // ── 3. New-check: open learning items whose KCs have no FSRS card yet.
  const items = await db
    .select({ knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(inArray(learning_item.status, LearningItemOpenStatus.options));
  const candidateKids = await withoutNonKcKnowledgeIds(
    db,
    items.flatMap((item) => item.knowledge_ids),
  );
  const newCheckEntries: SourceEntry[] = [];
  if (candidateKids.length > 0) {
    const tracked = await db
      .select({ kid: material_fsrs_state.subject_id })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          inArray(material_fsrs_state.subject_id, candidateKids),
        ),
      );
    const trackedSet = new Set(tracked.map((row) => row.kid));
    const untracked = candidateKids.filter((kid) => !trackedSet.has(kid));
    const scannedKids = untracked.slice(0, NEW_CHECK_KC_SCAN_CAP);
    const firstServable = await pickFirstServablePerKnowledge(db, scannedKids);
    let index = 0;
    for (const kid of scannedKids) {
      const picked = firstServable.get(kid);
      if (picked === undefined) continue;
      newCheckEntries.push({
        refKind: 'question',
        refId: picked,
        role: 'new_check',
        dueKnowledgeId: null,
        order: index,
      });
      index += 1;
      if (newCheckEntries.length >= NEW_CHECK_LIMIT) break;
    }
    caps.push({
      source: 'practice/scheduling/server/practice-candidates:new_check_scan',
      cap: NEW_CHECK_KC_SCAN_CAP,
      observed: untracked.length,
      hit: untracked.length > NEW_CHECK_KC_SCAN_CAP,
    });
  }
  caps.push({
    source: 'practice/scheduling/server/stream-inputs:new_check',
    cap: NEW_CHECK_LIMIT,
    observed: newCheckEntries.length,
    hit: newCheckEntries.length >= NEW_CHECK_LIMIT,
  });
  raw.push(...newCheckEntries);

  // ── 4. Learnable frontier (real prerequisite closure; sparse/overflow is a typed fact).
  const frontier = await learnableFrontierResolved(db);
  const frontierEntries: SourceEntry[] = [];
  {
    const frontierKids = frontier.ids.slice(0, FRONTIER_MAX_ITEMS);
    const firstServable = await pickFirstServablePerKnowledge(db, frontierKids);
    let index = 0;
    for (const kid of frontierKids) {
      const picked = firstServable.get(kid);
      if (picked === undefined) continue;
      frontierEntries.push({
        refKind: 'question',
        refId: picked,
        role: 'frontier',
        dueKnowledgeId: null,
        order: index,
      });
      index += 1;
    }
  }
  caps.push({
    source: 'practice/scheduling/server/learnable-frontier:learnableFrontierResolved',
    cap: FRONTIER_MAX_ITEMS,
    observed: frontier.ids.length,
    hit: frontier.ids.length > FRONTIER_MAX_ITEMS,
  });
  raw.push(...frontierEntries);

  // ── 5. In-scope questions the learner has never started (no attempt, no draft answer).
  const scopeContainment =
    scope.knowledgeIds.length > 0
      ? sql`(${sql.join(
          scope.knowledgeIds.map(
            (kc) => sql`${question.knowledge_ids} @> ${JSON.stringify([kc])}::jsonb`,
          ),
          sql` or `,
        )})`
      : undefined;
  const neverStarted = await db
    .select({ id: question.id })
    .from(question)
    .where(
      and(
        notDraftPredicate(question.draft_status),
        questionSuspendedPredicate(question),
        scopeContainment,
        sql`not exists (
          select 1 from ${event} e
          where e.subject_kind = 'question' and e.subject_id = ${question.id}
            and e.action in ('attempt', 'review', 'experimental:assessment_attempt')
        )`,
        sql`not exists (select 1 from ${answer} a where a.question_id = ${question.id})`,
      ),
    )
    .orderBy(desc(question.created_at), question.id)
    .limit(UNATTEMPTED_SCAN_CAP + 1);
  caps.push({
    source: 'practice/scheduling/server/practice-candidates:unattempted',
    cap: UNATTEMPTED_SCAN_CAP,
    observed: neverStarted.length,
    hit: neverStarted.length > UNATTEMPTED_SCAN_CAP,
  });
  neverStarted.slice(0, UNATTEMPTED_SCAN_CAP).forEach((row, index) => {
    raw.push({
      refKind: 'question',
      refId: row.id,
      role: 'unattempted',
      dueKnowledgeId: null,
      order: index,
    });
  });

  // ── 6. Existing doable papers (container identity preserved).
  const practiceList = await getPracticeList(db, { limit: PAPER_LIMIT });
  const paperRows: PaperSource[] = practiceList.papers
    .filter((paper) => paper.generation_status === 'ready' && paper.session === null)
    .map((paper) => ({
      artifactId: paper.artifact_id,
      title: paper.title,
      source: paper.source,
      intentSource: paper.intent_source,
      generationStatus: paper.generation_status,
      totalSlots: paper.total_slots,
      knowledgeIds: paper.knowledge_ids,
    }));
  caps.push({
    source: 'practice/session/public:getPracticeList',
    cap: PAPER_LIMIT,
    observed: paperRows.length,
    hit: practiceList.next_cursor !== null,
  });
  paperRows.forEach((paper, index) => {
    raw.push({
      refKind: 'paper',
      refId: paper.artifactId,
      role: 'paper',
      dueKnowledgeId: null,
      order: index,
    });
  });

  // ── 7. Scope filter + servability gate for every collected question ref.
  const questionEntries = raw.filter((entry) => entry.refKind === 'question');
  const questionRows = await readQuestionRows(
    db,
    questionEntries.map((entry) => entry.refId),
  );
  const scopeKept: SourceEntry[] = [];
  for (const entry of raw) {
    if (entry.refKind === 'paper') {
      const paper = paperRows.find((item) => item.artifactId === entry.refId);
      if (paper !== undefined && containerInScope(paper.knowledgeIds, scope)) scopeKept.push(entry);
      else bumpBucket(exclusions, 'out_of_scope', [entry.role], entry.refId);
      continue;
    }
    const row = questionRows.get(entry.refId);
    if (row === undefined) {
      bumpBucket(exclusions, 'not_admitted', [entry.role], entry.refId);
      continue;
    }
    if (questionInScope(row.knowledge_ids, scope)) scopeKept.push(entry);
    else bumpBucket(exclusions, 'out_of_scope', [entry.role], entry.refId);
  }

  const dueQuestionIds = [
    ...new Set(
      scopeKept
        .filter((entry) => entry.refKind === 'question' && entry.role === 'due')
        .map((entry) => entry.refId),
    ),
  ];
  const otherQuestionIds = [
    ...new Set(
      scopeKept
        .filter((entry) => entry.refKind === 'question' && entry.role !== 'due')
        .map((entry) => entry.refId),
    ),
  ];
  // Intervention diagnostics keep their approved-delivery exception ONLY on the due role;
  // every other role uses the plain general-pool gate.
  const admitted = new Set<string>([
    ...(await readAutomaticallyServableQuestionIds(db, dueQuestionIds, {
      includeInterventionDiagnostics: true,
    })),
    ...(await readAutomaticallyServableQuestionIds(db, otherQuestionIds)),
  ]);
  const kept: SourceEntry[] = [];
  for (const entry of scopeKept) {
    if (entry.refKind !== 'question') {
      kept.push(entry);
      continue;
    }
    if (admitted.has(entry.refId)) kept.push(entry);
    else bumpBucket(exclusions, 'not_admitted', [entry.role], entry.refId);
  }

  // ── 8. Dedupe by refKind + refId + revision; roles accumulate.
  const revisions = await readRevisions(db, questionRows);
  type UnionRow = {
    refKind: 'question' | 'paper';
    refId: string;
    roles: Set<PracticeCandidateRole>;
    order: number;
    /** Only populated by `due` entries; `null` is the legacy question-level card. */
    dueKnowledgeIds: Set<string | null>;
    revisionKey: string;
  };
  const union = new Map<string, UnionRow>();
  for (const entry of kept) {
    const revisionKey =
      entry.refKind === 'paper'
        ? `artifact:${entry.refId}`
        : (revisions.get(entry.refId)?.revision_id ?? 'no_revision');
    const key = `${entry.refKind}:${entry.refId}:${revisionKey}`;
    const existing = union.get(key);
    if (existing) {
      existing.roles.add(entry.role);
      if (entry.role === 'due') existing.dueKnowledgeIds.add(entry.dueKnowledgeId);
      existing.order = Math.min(existing.order, entry.order);
      bumpBucket(exclusions, 'duplicate_ref', [entry.role], entry.refId);
      continue;
    }
    const dueKnowledgeIds = new Set<string | null>();
    if (entry.role === 'due') dueKnowledgeIds.add(entry.dueKnowledgeId);
    union.set(key, {
      refKind: entry.refKind,
      refId: entry.refId,
      roles: new Set([entry.role]),
      order: entry.order,
      dueKnowledgeIds,
      revisionKey,
    });
  }

  const ordered = [...union.values()].sort((a, b) => {
    const rankA = Math.min(...[...a.roles].map((role) => ROLE_RANK[role]));
    const rankB = Math.min(...[...b.roles].map((role) => ROLE_RANK[role]));
    if (rankA !== rankB) return rankA - rankB;
    if (a.order !== b.order) return a.order - b.order;
    return a.refId.localeCompare(b.refId);
  });

  const scopeDigest = sha256(
    canonical({ kind: scope.kind, knowledgeIds: [...scope.knowledgeIds].sort() }),
  );
  const snapshotId = sha256(
    canonical({
      scopeDigest,
      refs: ordered.map((row) => ({
        refKind: row.refKind,
        refId: row.refId,
        revision: row.revisionKey,
        roles: roleList(row.roles),
      })),
    }),
  );

  // ── 9. Snapshot identity check + page selection.
  let offset = 0;
  let expectedSnapshotId: string | null = null;
  if (input.cursor != null || input.snapshotId != null) {
    const decoded = input.cursor != null ? decodeCursor(input.cursor) : null;
    if (input.cursor != null && decoded === null) {
      return terminalRead(db, asOf, scope, 'snapshot_changed', 'invalid_cursor', pageSize, {
        snapshotId,
        expected: input.snapshotId ?? null,
      });
    }
    if (
      input.cursor != null &&
      input.snapshotId != null &&
      decoded?.snapshotId !== input.snapshotId
    ) {
      return terminalRead(
        db,
        asOf,
        scope,
        'snapshot_changed',
        'cursor_snapshot_mismatch',
        pageSize,
        {
          snapshotId,
          expected: input.snapshotId,
        },
      );
    }
    expectedSnapshotId = input.snapshotId ?? decoded?.snapshotId ?? null;
    if (expectedSnapshotId !== null && expectedSnapshotId !== snapshotId) {
      return terminalRead(db, asOf, scope, 'snapshot_changed', 'candidate_set_changed', pageSize, {
        snapshotId,
        expected: expectedSnapshotId,
      });
    }
    offset = decoded?.offset ?? 0;
  }
  const pageRows = ordered.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < ordered.length;
  for (let index = offset + pageSize; index < ordered.length; index += 1) {
    bumpBucket(exclusions, 'page_overflow', roleList(ordered[index].roles), ordered[index].refId);
  }

  // ── 10. Signals for the returned page only (bounded IO, one batch per owner).
  const pageQuestionIds = pageRows
    .filter((row) => row.refKind === 'question')
    .map((row) => row.refId);
  const pageKnowledgeIds = [
    ...new Set([
      ...pageQuestionIds.flatMap((id) => questionRows.get(id)?.knowledge_ids ?? []),
      // A due row's card can name a KC the question's own knowledge_ids omit; the due
      // fact still needs its judgment, so those ids join the same batch.
      ...pageRows.flatMap((row) =>
        [...row.dueKnowledgeIds].filter((id): id is string => id !== null),
      ),
      ...pageRows
        .filter((row) => row.refKind === 'paper')
        .flatMap(
          (row) => paperRows.find((item) => item.artifactId === row.refId)?.knowledgeIds ?? [],
        ),
    ]),
  ];
  const nonKc = new Set(await getNonKcKnowledgeIds(db, pageKnowledgeIds));
  const judgments = await readLearnerJudgments(db, {
    knowledge_ids: pageKnowledgeIds,
    context: 'any',
    as_of: asOf,
  });
  const causes = await readCauseJudgment(db, { knowledge_ids: pageKnowledgeIds, as_of: asOf });
  const judgmentById = new Map(judgments.items.map((item) => [item.knowledge_id, item]));
  const causeById = new Map(causes.items.map((item) => [item.knowledge_id, item]));
  const labels = await knowledgeLabels(db, pageKnowledgeIds);
  const pace = await readQuestionPace(db, asOf);
  const attemptWindows = await readAttemptWindows(db, pageQuestionIds, asOf);
  // Legacy question-level due cards (due fact with knowledge_id=null) are read once for the
  // whole page, not once per row: the card read is a batch loader underneath.
  const legacyDueQuestionIds = [
    ...new Set(
      pageRows
        .filter((row) => row.refKind === 'question' && row.dueKnowledgeIds.has(null))
        .map((row) => row.refId),
    ),
  ];
  const legacyDueTiming = await readQuestionCardReviewTimings(db, legacyDueQuestionIds, asOf);
  const signalInputs: CandidateInput[] = pageQuestionIds.flatMap((id) => {
    const row = questionRows.get(id);
    if (row === undefined) return [];
    const unionRow = pageRows.find((entry) => entry.refId === id);
    const roles = unionRow?.roles ?? new Set<PracticeCandidateRole>();
    const role: CandidateInput['role'] = roles.has('due')
      ? 'due'
      : roles.has('variant')
        ? 'diagnostic'
        : roles.has('new_check')
          ? 'new_check'
          : roles.has('frontier')
            ? 'frontier'
            : 'diagnostic';
    return [
      {
        refKind: 'question' as const,
        refId: id,
        role,
        kind: (row.kind ?? undefined) as CandidateInput['kind'],
        knowledgeIds: row.knowledge_ids,
        difficulty: row.difficulty ?? undefined,
        source: row.source ?? undefined,
      },
    ];
  });
  const signals = await collectCandidateSignals(db, signalInputs);
  const signalById = new Map(signals.map((signal) => [signal.refId, signal]));

  const knowledgeSignalFor = (knowledgeId: string): CandidateKnowledgeSignal => {
    const judgment = judgmentById.get(knowledgeId);
    const cause = causeById.get(knowledgeId);
    const projected = judgment !== undefined ? projectKnowledgeState(judgment, asOf) : null;
    const roleBlocked = nonKc.has(knowledgeId);
    const missingReason = roleBlocked
      ? 'knowledge_role_not_mastery_evaluable'
      : judgment === undefined
        ? 'missing_learner_judgment'
        : 'reading_unavailable';
    return {
      knowledge_id: knowledgeId,
      name: labels.get(knowledgeId) ?? null,
      mastery: projected?.band ?? unknownSignal(LEARNER_JUDGMENT_SOURCE, asOf, missingReason),
      evidence_count:
        projected?.evidence_count ?? unknownSignal(LEARNER_JUDGMENT_SOURCE, asOf, missingReason),
      retention:
        projected?.retention ?? unknownSignal(LEARNER_JUDGMENT_SOURCE, asOf, missingReason),
      due_at: projected?.due_at ?? unknownSignal(LEARNER_JUDGMENT_SOURCE, asOf, missingReason),
      decay: projected?.decay ?? unknownSignal(LEARNER_JUDGMENT_SOURCE, asOf, missingReason),
      consecutive_errors:
        cause?.consecutive_errors ??
        unknownSignal(CAUSE_JUDGMENT_SOURCE, asOf, 'missing_cause_judgment'),
      top_causes:
        cause?.top_causes ?? unknownSignal(CAUSE_JUDGMENT_SOURCE, asOf, 'missing_cause_judgment'),
    };
  };

  const candidates: PracticeCandidateRow[] = [];
  for (const row of pageRows) {
    if (row.refKind === 'paper') {
      const paper = paperRows.find((item) => item.artifactId === row.refId);
      if (paper === undefined) continue;
      candidates.push({
        ref_kind: 'paper',
        ref_id: paper.artifactId,
        container: 'paper',
        roles: roleList(row.roles),
        revision: {
          known: true,
          revision_id: paper.artifactId,
          digest: null,
          version: null,
          missing_reason: 'artifact_container_has_no_integrity_digest',
        },
        prompt: null,
        knowledge_ids: paper.knowledgeIds,
        knowledge: paper.knowledgeIds.map(knowledgeSignalFor),
        question: null,
        serving: {
          servable: true,
          source: 'practice/session/public:getPracticeList',
          checked_at: asOf.toISOString(),
          admission_status: null,
          admission_reason: null,
          hold_reason: null,
        },
        recent_attempts: emptyAttemptWindow(asOf, 'paper_container_has_no_question_attempt_stream'),
        due: [],
        exam_relevance: unknownSignal<number>(
          EXAM_RELEVANCE_SOURCE,
          asOf,
          'paper_container_is_not_scored_by_selection_signals',
        ),
        cause_recurrence: unknownSignal<number>(
          RECURRENCE_SOURCE,
          asOf,
          'paper_container_is_not_scored_by_selection_signals',
        ),
        mfi: {
          value: null,
          known: true,
          score_kind: null,
          recall_locked: false,
          source: SIGNAL_SOURCE,
          as_of: asOf.toISOString(),
          missing_reason: 'paper_container_is_not_scored_by_selection_signals',
        },
        paper: {
          title: paper.title,
          source: paper.source,
          intent_source: paper.intentSource,
          generation_status: paper.generationStatus,
          total_slots: paper.totalSlots,
        },
      });
      continue;
    }

    const questionRow = questionRows.get(row.refId);
    if (questionRow === undefined) continue;
    const revision = revisions.get(row.refId) ?? {
      known: false,
      revision_id: null,
      digest: null,
      version: null,
      missing_reason: 'no_published_revision',
    };
    const signal = signalById.get(row.refId);
    const dueFacts: CandidateDueFact[] = [];
    for (const knowledgeId of row.dueKnowledgeIds) {
      if (knowledgeId === null) {
        // Legacy question-level card: its own read model owns due/retention.
        const timing = legacyDueTiming.get(row.refId) ?? null;
        const dueAt =
          timing !== null
            ? dueSignal(timing.freshness.due_at, asOf, QUESTION_CARD_SOURCE)
            : unknownSignal<string>(QUESTION_CARD_SOURCE, asOf, 'missing_question_fsrs_projection');
        const retention =
          timing === null
            ? unknownSignal<number>(QUESTION_CARD_SOURCE, asOf, 'missing_question_fsrs_projection')
            : timing.recall.kind === 'point'
              ? knownSignal<number>(timing.recall.value, QUESTION_CARD_SOURCE, asOf)
              : timing.recall.kind === 'unknown'
                ? unknownSignal<number>(QUESTION_CARD_SOURCE, asOf, timing.recall.reason)
                : unknownSignal<number>(
                    QUESTION_CARD_SOURCE,
                    asOf,
                    'question_card_has_no_recall_reading',
                  );
        dueFacts.push({
          knowledge_id: null,
          due_at: dueAt,
          overdue_hours: overdueHours(dueAt, asOf),
          retention,
        });
        continue;
      }
      const judgment = judgmentById.get(knowledgeId);
      const projected = judgment !== undefined ? projectKnowledgeState(judgment, asOf) : null;
      const dueAt =
        projected?.due_at ??
        unknownSignal<string>(LEARNER_JUDGMENT_SOURCE, asOf, 'missing_learner_judgment');
      dueFacts.push({
        knowledge_id: knowledgeId,
        due_at: dueAt,
        overdue_hours: overdueHours(dueAt, asOf),
        retention:
          projected?.retention ??
          unknownSignal<number>(LEARNER_JUDGMENT_SOURCE, asOf, 'missing_learner_judgment'),
      });
    }

    const promptText = questionRow.prompt_md.slice(0, PROMPT_EXCERPT_CHARS);
    const examRelevance =
      signal?.examRelevance !== undefined
        ? knownSignal(signal.examRelevance, EXAM_RELEVANCE_SOURCE, asOf)
        : unknownSignal<number>(EXAM_RELEVANCE_SOURCE, asOf, 'no_in_window_steering_goal');
    const recurrence =
      signal?.misconceptionRecurrence !== undefined
        ? knownSignal(signal.misconceptionRecurrence, RECURRENCE_SOURCE, asOf)
        : unknownSignal<number>(
            RECURRENCE_SOURCE,
            asOf,
            'recurrence_reader_not_available_for_this_candidate',
          );
    const mfiKnown = signal?.mfiScore !== undefined;
    const recallLocked = signal?.recallLocked ?? false;

    candidates.push({
      ref_kind: 'question',
      ref_id: row.refId,
      container:
        questionRow.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE
          ? 'intervention'
          : 'question',
      roles: roleList(row.roles),
      revision,
      prompt: {
        text: promptText,
        chars: questionRow.prompt_md.length,
        truncated: questionRow.prompt_md.length > promptText.length,
        source: 'question.prompt_md',
      },
      knowledge_ids: questionRow.knowledge_ids,
      knowledge: questionRow.knowledge_ids.map(knowledgeSignalFor),
      question: {
        kind:
          questionRow.kind === null
            ? unknownSignal<string>('question.kind', asOf, 'question_kind_not_set')
            : knownSignal(questionRow.kind, 'question.kind', asOf),
        difficulty:
          questionRow.difficulty === null
            ? unknownSignal<number>('question.difficulty', asOf, 'difficulty_not_set')
            : knownSignal(questionRow.difficulty, 'question.difficulty', asOf),
        difficulty_b:
          signal?.b !== undefined
            ? knownSignal(signal.b, DIFFICULTY_SOURCE, asOf)
            : unknownSignal<number>(
                DIFFICULTY_SOURCE,
                asOf,
                (signal?.bSource ?? 'none') === 'none'
                  ? 'no_calibration_or_difficulty'
                  : 'b_unavailable',
              ),
        b_source: signal?.bSource ?? 'none',
        // A default pace is a placeholder for planning, not a measurement: the candidate
        // read must not present it as an observed fact.
        estimated_minutes:
          pace.source === 'observed'
            ? knownSignal(
                pace.minutes,
                `practice/scheduling/server/question-pace:observed(n=${pace.sample_count})`,
                asOf,
              )
            : unknownSignal<number>(
                `practice/scheduling/server/question-pace:default(n=${pace.sample_count})`,
                asOf,
                'insufficient_pace_samples; the 2-minute default is a planning placeholder, not a measurement',
              ),
      },
      serving: {
        servable: true,
        source: 'kernel/records/assessment-issuance:readAutomaticallyServableQuestionIds',
        checked_at: asOf.toISOString(),
        admission_status: 'admitted',
        admission_reason: null,
        hold_reason: null,
      },
      recent_attempts:
        attemptWindows.get(row.refId) ?? emptyAttemptWindow(asOf, 'attempt_window_unavailable'),
      due: dueFacts,
      exam_relevance: examRelevance,
      cause_recurrence: recurrence,
      mfi: {
        value: signal?.mfiScore ?? null,
        known: mfiKnown || recallLocked,
        score_kind: signal?.scoreKind ?? null,
        recall_locked: recallLocked,
        source: SIGNAL_SOURCE,
        as_of: asOf.toISOString(),
        missing_reason: mfiKnown
          ? null
          : recallLocked
            ? 'recall_locked_not_scored'
            : 'insufficient_theta_or_difficulty',
      },
      paper: null,
    });
  }

  // ── 11. Gaps: deterministic empty-pool facts (no model needed to see the hole).
  const gaps: CandidateGap[] = [];
  if (scope.kind !== 'all') {
    // Coverage is measured over the whole union, not just this page.
    const covered = new Set<string>();
    for (const row of ordered) {
      const knowledgeIds =
        row.refKind === 'paper'
          ? (paperRows.find((item) => item.artifactId === row.refId)?.knowledgeIds ?? [])
          : (questionRows.get(row.refId)?.knowledge_ids ?? []);
      for (const kc of knowledgeIds) covered.add(kc);
    }
    const uncovered = scope.knowledgeIds.filter((kc) => !covered.has(kc));
    for (const kc of uncovered.slice(0, GAP_DETAIL_LIMIT)) {
      gaps.push({
        scope_kind: scope.kind,
        knowledge_ids: [kc],
        reason: 'no_servable_candidate',
        detail: `knowledge point ${kc} has no servable candidate on this page`,
        demand_version: String(EVIDENCE_DEMAND_VERSION),
      });
    }
    if (uncovered.length > GAP_DETAIL_LIMIT) {
      gaps.push({
        scope_kind: scope.kind,
        knowledge_ids: uncovered.slice(GAP_DETAIL_LIMIT),
        reason: 'no_servable_candidate',
        detail: `${uncovered.length - GAP_DETAIL_LIMIT} more in-scope knowledge points have no servable candidate`,
        demand_version: String(EVIDENCE_DEMAND_VERSION),
      });
    }
  }
  if (frontier.kind === 'sparse') {
    gaps.push({
      scope_kind: scope.kind,
      knowledge_ids: [],
      reason: 'frontier_sparse',
      detail: 'the prerequisite graph has no live edge yet, so no frontier candidate exists',
      demand_version: String(EVIDENCE_DEMAND_VERSION),
    });
  }
  if (frontier.kind === 'overflow') {
    gaps.push({
      scope_kind: scope.kind,
      knowledge_ids: [],
      reason: 'frontier_overflow',
      detail:
        'prerequisite closure overflowed its depth/node guard; the frontier is blanked, not partial',
      demand_version: String(EVIDENCE_DEMAND_VERSION),
    });
  }
  if (dueRows.length === 0) {
    gaps.push({
      scope_kind: scope.kind,
      knowledge_ids: [],
      reason: 'due_pool_empty',
      detail: 'no due card and no never-reviewed failure is actionable at asOf',
      demand_version: String(EVIDENCE_DEMAND_VERSION),
    });
  }

  const byRole = Object.fromEntries(
    PRACTICE_CANDIDATE_ROLES.map((role) => [
      role,
      ordered.filter((row) => row.roles.has(role)).length,
    ]),
  ) as Record<PracticeCandidateRole, number>;
  const byContainer = { question: 0, intervention: 0, paper: 0 };
  for (const row of ordered) {
    if (row.refKind === 'paper') byContainer.paper += 1;
    else if (questionRows.get(row.refId)?.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE)
      byContainer.intervention += 1;
    else byContainer.question += 1;
  }

  return {
    status: 'ok',
    snapshot_id: snapshotId,
    as_of: asOf.toISOString(),
    expected_snapshot_id: expectedSnapshotId,
    scope: {
      kind: scope.kind,
      knowledge_ids: scope.knowledgeIds,
      goal_ids: scope.goals.map((entry) => entry.id),
      unscoped: scope.unscoped,
    },
    versions: {
      goals: await readGoalVersions(db, scope.goals),
      scope_digest: scopeDigest,
      steering: steeringVersionSignal(scope.goals, asOf),
    },
    counts: {
      // Every source entry collected before identity dedupe (duplicates counted once per role).
      total_before_dedup: raw.length,
      total_after_dedup: ordered.length,
      returned: candidates.length,
      by_role: byRole,
      by_container: byContainer,
      source_caps: caps,
    },
    page: {
      cursor: input.cursor ?? null,
      next_cursor: hasMore ? encodeCursor(snapshotId, offset + pageSize) : null,
      page_size: pageSize,
      has_more: hasMore,
    },
    candidates,
    gaps,
    exclusions: [...exclusions.values()]
      .sort((a, b) => a.reason.localeCompare(b.reason))
      .map((bucket) => ({
        reason: bucket.reason,
        roles: roleList(bucket.roles),
        count: bucket.count,
        ref_ids: bucket.refIds,
      })),
  };
}

async function readGoalVersions(
  db: DbLike,
  goals: readonly ActiveGoal[],
): Promise<Array<{ goal_id: string; version: number | null; updated_at: string | null }>> {
  if (goals.length === 0) return [];
  const rows = await db
    .select({ id: goal.id, version: goal.version, updated_at: goal.updated_at })
    .from(goal)
    .where(
      inArray(
        goal.id,
        goals.map((entry) => entry.id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return goals.map((entry) => {
    const row = byId.get(entry.id);
    return {
      goal_id: entry.id,
      version: row?.version ?? null,
      updated_at: row?.updated_at.toISOString() ?? null,
    };
  });
}

/** Steering has no version of its own; goal.version is the containing row's CAS counter. */
function steeringVersionSignal(goals: readonly ActiveGoal[], asOf: Date): KnowledgeSignal<null> {
  const hasSteering = goals.some((entry) => entry.steering !== null);
  return hasSteering
    ? unknownSignal<null>('goal.steering', asOf, 'steering_payload_has_no_persisted_version')
    : unknownSignal<null>('goal.steering', asOf, 'no_steering_goal_in_scope');
}

/**
 * A read that cannot enumerate candidates (unresolved scope, changed snapshot). It returns
 * a typed gap instead of an empty list, so a caller can never read "no candidates" out of
 * a failed resolution: status mirrors the reason.
 */
async function terminalRead(
  db: DbLike,
  asOf: Date,
  scope: ResolvedScope,
  reason: 'scope_unresolved' | 'snapshot_changed',
  detail: string,
  pageSize: number,
  snapshot?: { snapshotId: string; expected: string | null },
): Promise<PracticeCandidateRead> {
  const emptyScopeDigest = sha256(
    canonical({ kind: scope.kind, knowledgeIds: [...scope.knowledgeIds].sort() }),
  );
  return {
    status: reason,
    snapshot_id: snapshot?.snapshotId ?? emptyScopeDigest,
    as_of: asOf.toISOString(),
    expected_snapshot_id: snapshot?.expected ?? null,
    scope: {
      kind: scope.kind,
      knowledge_ids: scope.knowledgeIds,
      goal_ids: scope.goals.map((entry) => entry.id),
      unscoped: scope.unscoped,
    },
    versions: {
      // A terminal read still reports the containing goal versions it could resolve.
      goals: await readGoalVersions(db, scope.goals),
      scope_digest: emptyScopeDigest,
      steering: steeringVersionSignal(scope.goals, asOf),
    },
    counts: {
      total_before_dedup: 0,
      total_after_dedup: 0,
      returned: 0,
      by_role: Object.fromEntries(PRACTICE_CANDIDATE_ROLES.map((role) => [role, 0])) as Record<
        PracticeCandidateRole,
        number
      >,
      by_container: { question: 0, intervention: 0, paper: 0 },
      source_caps: [],
    },
    page: {
      cursor: null,
      next_cursor: null,
      page_size: pageSize,
      has_more: false,
    },
    candidates: [],
    gaps: [
      {
        scope_kind: scope.kind,
        knowledge_ids: scope.knowledgeIds,
        reason,
        detail,
        demand_version: String(EVIDENCE_DEMAND_VERSION),
      },
    ],
    exclusions: [],
  };
}

/** One deterministic sentence over the read result, for the tool summary. */
export function summarizeCandidateRead(result: PracticeCandidateRead): string {
  if (result.status === 'scope_unresolved') {
    return `candidates · scope unresolved (${result.gaps[0]?.detail ?? 'no detail'})`;
  }
  if (result.status === 'snapshot_changed') {
    return `candidates · snapshot changed (${result.expected_snapshot_id ?? 'unknown'} -> ${result.snapshot_id})`;
  }
  const roles = PRACTICE_CANDIDATE_ROLES.filter((role) => result.counts.by_role[role] > 0)
    .map((role) => `${role}=${result.counts.by_role[role]}`)
    .join(' ');
  return `candidates · ${result.counts.returned}/${result.counts.total_after_dedup} · ${roles || 'none'} · gaps=${result.gaps.length}`;
}
