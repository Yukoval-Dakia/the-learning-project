// One question, one agent read: whether it can be issued, the latest score and
// wrong-cause, the card that actually holds FSRS due, each knowledge name and
// mastery, and the two difficulty baselines (item anchor, family offset).
// A faulty-item inference rides the same read for agents; the learner snapshot
// drops that field.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { A5_BANDS } from '@/core/mastery-band';
import { QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION } from '@/core/schema/event';
import {
  type KnowledgeSignal,
  absentSignal,
  knownSignal,
  unknownSignal,
} from '@/core/schema/knowledge-signal';
import type { LearnerJudgment } from '@/core/schema/learner-judgment';
import { difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { isPoolVisible } from '@/db/predicates';
import { event, item_calibration, knowledge, question_group_lifecycle } from '@/db/schema';
import { withoutNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import {
  LEARNER_JUDGMENT_SOURCE,
  projectKnowledgeState,
} from '@/kernel/read-models/knowledge-state';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import {
  type AttemptFact,
  type QuestionTimelineEntry,
  getQuestionTimeline,
  hintDependenceOf,
  medianOf,
  readAttemptFacts,
  readSameDifficultyDurations,
  recordedDurations,
} from '@/kernel/read-models/question-activity';
import {
  type ItemCalibrationBRow,
  effectiveB,
  effectiveFamilyB,
  getFamilyCalibration,
  resolveFamilyKeyForQuestion,
} from '@/kernel/read-models/question-difficulty';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { difficultyBandFor } from '@/kernel/supply-contracts';

const SOURCE = 'capabilities/practice/scheduling/server/question-issue-read';
const ISSUANCE_SOURCE = 'kernel/records/assessment-issuance:readAutomaticallyServableQuestionIds';
const SCORE_SOURCE = 'kernel/read-models/question-activity:getQuestionTimeline';
const ITEM_SOURCE = 'kernel/read-models/question-difficulty:effectiveB';
const FAMILY_SOURCE = 'kernel/read-models/question-difficulty:effectiveFamilyB';
const FAULTY_SOURCE = `event:${QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION}`;
const ATTEMPT_FACT_SOURCE = 'kernel/read-models/question-activity:readAttemptFacts';
const BAND_SOURCE = 'kernel/supply-contracts:difficultyBandFor';

const ISSUANCE_BLOCKS = [
  'draft',
  'missing_lifecycle',
  'not_admitted',
  'suspended',
  'withdrawn',
  'not_in_general_pool',
  'not_servable',
] as const;

export type IssuanceBlock = (typeof ISSUANCE_BLOCKS)[number];

export type QuestionLifecycleGate = {
  draft_status: string | null;
  lifecycle: {
    scoring_admission_state: 'admitted' | 'withheld';
    suspended: boolean;
    withdrawn: boolean;
    availability: 'general_pool' | 'container_only';
  } | null;
};

/** First pool gate that fails, in the same order as automatic serving. Null means the coarse gates passed. */
export function coarseIssuanceBlock(row: QuestionLifecycleGate): IssuanceBlock | null {
  if (!isPoolVisible(row)) return 'draft';
  const life = row.lifecycle;
  if (!life) return 'missing_lifecycle';
  if (life.scoring_admission_state !== 'admitted') return 'not_admitted';
  if (life.suspended) return 'suspended';
  if (life.withdrawn) return 'withdrawn';
  if (life.availability !== 'general_pool') return 'not_in_general_pool';
  return null;
}

type DueFact =
  | { kind: 'known'; at: Date }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string };

/** Soonest known card. Unknown dues are not invented; a mix still returns the known date. */
export function earliestKnownDue(facts: readonly DueFact[]): Date | null {
  let best: number | null = null;
  for (const fact of facts) {
    if (fact.kind !== 'known') continue;
    const ms = fact.at.getTime();
    if (best === null || ms < best) best = ms;
  }
  return best === null ? null : new Date(best);
}

function signalSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable(),
    known: z.boolean(),
    source: z.string(),
    asOf: z.string(),
    missingReason: z.string().nullable(),
  });
}

const ItemBasis = z.enum(['posterior', 'anchor', 'legacy_b', 'difficulty_proxy']);
const DifficultyBandName = z.enum(['below', 'near', 'above', 'stretch']);

const CauseSchema = z.object({
  primary: z.string(),
  primary_label: z.string().nullable(),
  confidence: z.number().nullable(),
  secondary: z.array(z.string()),
});

export const QuestionIssueReadingSchema = z.object({
  issuance: signalSchema(
    z.object({
      servable: z.boolean(),
      blocked_by: z.enum(ISSUANCE_BLOCKS).nullable(),
    }),
  ),
  recent_scoring: signalSchema(
    z.object({
      event_id: z.string(),
      at: z.string(),
      outcome: z.string(),
      cause: CauseSchema.nullable(),
    }),
  ),
  fsrs: z.object({
    card: z.enum(['knowledge', 'question', 'none']),
    due_at: signalSchema(z.string()),
  }),
  knowledge: z.array(
    z.object({
      id: z.string(),
      name: signalSchema(z.string()),
      mastery: signalSchema(z.number()),
      band: signalSchema(z.enum(A5_BANDS)),
      due_at: signalSchema(z.string()),
    }),
  ),
  difficulty: z.object({
    item: signalSchema(
      z.object({
        logit: z.number(),
        basis: ItemBasis,
        source: z.string().nullable(),
        ordinal: z.number().int(),
      }),
    ),
    family: signalSchema(
      z.object({
        logit: z.number(),
        delta: z.number(),
        family_key: z.string(),
        evidence_count: z.number().int().nonnegative(),
      }),
    ),
    band: signalSchema(
      z.object({
        band: DifficultyBandName,
        logit: z.number(),
        theta_hat: z.number(),
        knowledge_id: z.string(),
        provenance: z.enum(['observed', 'inferred']),
      }),
    ),
  }),
  timing: z.object({
    median_ms: signalSchema(
      z.object({
        ms: z.number(),
        samples: z.number().int().positive(),
      }),
    ),
    relative_to_same_difficulty: signalSchema(
      z.object({
        ratio: z.number(),
        question_median_ms: z.number(),
        question_samples: z.number().int().positive(),
        baseline_median_ms: z.number(),
        baseline_samples: z.number().int().positive(),
      }),
    ),
  }),
  hint_dependence: signalSchema(
    z.object({
      points: z
        .array(
          z.object({
            event_id: z.string(),
            at: z.string(),
            outcome: z.string(),
            hints_used: z.number().int().nonnegative(),
            final_hint_level: z.number().int().nonnegative().nullable(),
          }),
        )
        .max(20),
      recorded_attempts: z.number().int().nonnegative(),
      omitted_attempts: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  ),
  faulty: signalSchema(
    z.object({
      event_id: z.string(),
      at: z.string(),
      inference: z.literal(true),
      learner_id: z.string(),
      question_id: z.string(),
      kc_ids: z.array(z.string()),
      attempt_ids: z.object({
        incorrect: z.array(z.string()),
        correct: z.array(z.string()),
      }),
      window: z.object({
        ms: z.number(),
        from: z.string(),
        until: z.string(),
      }),
    }),
  ),
});

export type QuestionIssueReading = z.infer<typeof QuestionIssueReadingSchema>;

const FaultyPayload = z.object({
  inference: z.literal(true),
  learner_id: z.string(),
  question_id: z.string(),
  kc_ids: z.array(z.string()),
  attempt_ids: z.object({
    incorrect: z.array(z.string()),
    correct: z.array(z.string()),
  }),
  window: z.object({
    ms: z.number(),
    from: z.string(),
    until: z.string(),
  }),
});

export type QuestionIssueInput = {
  questionId: string;
  parentQuestionId: string | null;
  knowledgeIds: readonly string[];
  difficulty: number;
  kind: string;
  source: string;
  draftStatus: string | null;
  /** Question-card due. Used when no role=kc point is tagged. Goal and container tags are not that card. */
  questionDueAt: Date | null;
  asOf: Date;
};

const SCORE_ACTIONS = ['attempt', 'experimental:assessment_attempt'] as const;

function blank<T>(asOf: Date, reason: string): KnowledgeSignal<T> {
  return unknownSignal<T>(SOURCE, asOf, reason);
}

export function unobservedQuestionIssue(asOf: Date): QuestionIssueReading {
  const reason = 'not_observed';
  return {
    issuance: blank(asOf, reason),
    recent_scoring: blank(asOf, reason),
    fsrs: { card: 'none', due_at: blank(asOf, reason) },
    knowledge: [],
    difficulty: {
      item: blank(asOf, reason),
      family: blank(asOf, reason),
      band: blank(asOf, reason),
    },
    timing: {
      median_ms: blank(asOf, reason),
      relative_to_same_difficulty: blank(asOf, reason),
    },
    hint_dependence: blank(asOf, reason),
    faulty: blank(asOf, reason),
  };
}

function itemBasis(row: ItemCalibrationBRow | undefined): z.infer<typeof ItemBasis> {
  if (row?.b_post != null) return 'posterior';
  if (row?.b_anchor != null) return 'anchor';
  if (row?.b != null) return 'legacy_b';
  return 'difficulty_proxy';
}

type DbLike = Db | Tx;

async function readIssuance(
  db: DbLike,
  input: QuestionIssueInput,
): Promise<QuestionIssueReading['issuance']> {
  const servable = await readAutomaticallyServableQuestionIds(db, [input.questionId]);
  if (servable.has(input.questionId)) {
    return knownSignal({ servable: true, blocked_by: null }, ISSUANCE_SOURCE, input.asOf);
  }
  const groupId = input.parentQuestionId ?? input.questionId;
  const [life] = await db
    .select({
      scoring_admission_state: question_group_lifecycle.scoring_admission_state,
      suspended: question_group_lifecycle.suspended,
      withdrawn: question_group_lifecycle.withdrawn,
      availability: question_group_lifecycle.availability,
    })
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .limit(1);
  const blocked =
    coarseIssuanceBlock({
      draft_status: input.draftStatus,
      lifecycle: life ?? null,
    }) ?? 'not_servable';
  return knownSignal({ servable: false, blocked_by: blocked }, ISSUANCE_SOURCE, input.asOf);
}

async function readDifficulty(
  db: DbLike,
  input: QuestionIssueInput,
): Promise<Omit<QuestionIssueReading['difficulty'], 'band'>> {
  const [row] = await db
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
      b_post: item_calibration.b_post,
      source: item_calibration.source,
    })
    .from(item_calibration)
    .where(
      and(eq(item_calibration.question_id, input.questionId), eq(item_calibration.track, 'hard')),
    )
    .limit(1);
  const basis = itemBasis(row);
  const columnar = effectiveB(row);
  const logit = columnar ?? difficultyToLogitB(input.difficulty);
  const item = knownSignal(
    {
      logit,
      basis,
      source: basis === 'difficulty_proxy' ? null : (row?.source ?? null),
      ordinal: input.difficulty,
    },
    ITEM_SOURCE,
    input.asOf,
  );
  const primary = input.knowledgeIds[0];
  const familyKey = await resolveFamilyKeyForQuestion(db, {
    primaryKnowledgeId: primary,
    kind: input.kind,
    source: input.source,
  });
  if (!familyKey) {
    return {
      item,
      family: unknownSignal(FAMILY_SOURCE, input.asOf, 'no_primary_knowledge'),
    };
  }
  const family = await getFamilyCalibration(db, familyKey);
  return {
    item,
    family: knownSignal(
      {
        logit: effectiveFamilyB(logit, family),
        delta: family?.b_delta ?? 0,
        family_key: familyKey,
        evidence_count: family?.evidence_count ?? 0,
      },
      FAMILY_SOURCE,
      input.asOf,
    ),
  };
}

async function readFaulty(
  db: DbLike,
  questionId: string,
  asOf: Date,
): Promise<QuestionIssueReading['faulty']> {
  const [row] = await db
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  if (!row) return absentSignal(FAULTY_SOURCE, asOf);
  const parsed = FaultyPayload.safeParse(row.payload);
  if (!parsed.success) return unknownSignal(FAULTY_SOURCE, asOf, 'payload_unreadable');
  return knownSignal(
    { event_id: row.id, at: row.created_at.toISOString(), ...parsed.data },
    FAULTY_SOURCE,
    asOf,
  );
}

function scoreSignal(
  entry: QuestionTimelineEntry | undefined,
  asOf: Date,
): QuestionIssueReading['recent_scoring'] {
  if (entry?.kind !== 'attempt') return absentSignal(SCORE_SOURCE, asOf);
  return knownSignal(
    {
      event_id: entry.event_id,
      at: entry.created_at.toISOString(),
      outcome: entry.outcome,
      cause: entry.cause
        ? {
            primary: entry.cause.primary,
            primary_label: entry.cause.primary_label,
            confidence: entry.cause.confidence,
            secondary: entry.cause.secondary,
          }
        : null,
    },
    SCORE_SOURCE,
    asOf,
  );
}

function difficultyBandSignal(
  logit: number | undefined,
  primaryId: string | undefined,
  judgment: LearnerJudgment | undefined,
  asOf: Date,
): QuestionIssueReading['difficulty']['band'] {
  if (!primaryId) return unknownSignal(BAND_SOURCE, asOf, 'no_primary_knowledge');
  if (logit === undefined) return unknownSignal(BAND_SOURCE, asOf, 'item_logit_unknown');
  if (judgment?.ability.kind !== 'available') {
    return unknownSignal(
      BAND_SOURCE,
      asOf,
      judgment?.ability.kind === 'unknown' ? judgment.ability.reason : 'learner_judgment_missing',
    );
  }
  const theta = judgment.ability.reading.theta_hat;
  if (!Number.isFinite(theta)) return unknownSignal(BAND_SOURCE, asOf, 'theta_not_finite');
  return knownSignal(
    {
      band: difficultyBandFor(logit, theta),
      logit,
      theta_hat: theta,
      knowledge_id: primaryId,
      provenance: judgment.ability.reading.provenance,
    },
    BAND_SOURCE,
    asOf,
  );
}

function timingSignals(
  rows: readonly AttemptFact[],
  baseline: readonly number[],
  asOf: Date,
): QuestionIssueReading['timing'] {
  const samples = recordedDurations(rows);
  const questionMedian = medianOf(samples);
  const medianMs =
    questionMedian === null
      ? unknownSignal<{ ms: number; samples: number }>(
          ATTEMPT_FACT_SOURCE,
          asOf,
          'duration_not_recorded',
        )
      : knownSignal({ ms: questionMedian, samples: samples.length }, ATTEMPT_FACT_SOURCE, asOf);
  const baselineMedian = medianOf(baseline);
  if (questionMedian === null) {
    return {
      median_ms: medianMs,
      relative_to_same_difficulty: unknownSignal(
        ATTEMPT_FACT_SOURCE,
        asOf,
        'duration_not_recorded',
      ),
    };
  }
  if (baselineMedian === null) {
    return {
      median_ms: medianMs,
      relative_to_same_difficulty: unknownSignal(
        ATTEMPT_FACT_SOURCE,
        asOf,
        'no_same_difficulty_baseline',
      ),
    };
  }
  if (baselineMedian === 0) {
    return {
      median_ms: medianMs,
      relative_to_same_difficulty: unknownSignal(ATTEMPT_FACT_SOURCE, asOf, 'baseline_median_zero'),
    };
  }
  return {
    median_ms: medianMs,
    relative_to_same_difficulty: knownSignal(
      {
        ratio: questionMedian / baselineMedian,
        question_median_ms: questionMedian,
        question_samples: samples.length,
        baseline_median_ms: baselineMedian,
        baseline_samples: baseline.length,
      },
      ATTEMPT_FACT_SOURCE,
      asOf,
    ),
  };
}

function hintSignal(
  rows: readonly AttemptFact[],
  asOf: Date,
): QuestionIssueReading['hint_dependence'] {
  const dependence = hintDependenceOf(rows);
  if (!dependence) return absentSignal(ATTEMPT_FACT_SOURCE, asOf);
  return knownSignal(dependence, ATTEMPT_FACT_SOURCE, asOf);
}

export async function readQuestionIssue(
  db: DbLike,
  input: QuestionIssueInput,
): Promise<QuestionIssueReading> {
  const knowledgeIds = [...new Set(input.knowledgeIds.filter((id) => id.length > 0))];
  const primaryId = input.knowledgeIds[0];
  const [
    issuance,
    difficulty,
    faulty,
    names,
    judgment,
    scoreRows,
    schedulableIds,
    attemptRows,
    baselineDurations,
  ] = await Promise.all([
    readIssuance(db, input),
    readDifficulty(db, input),
    readFaulty(db, input.questionId, input.asOf),
    knowledgeIds.length === 0
      ? Promise.resolve(new Map<string, string>())
      : db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)))
          .then((rows) => new Map(rows.map((row) => [row.id, row.name]))),
    knowledgeIds.length === 0
      ? Promise.resolve(null)
      : readLearnerJudgments(db, {
          knowledge_ids: knowledgeIds,
          context: 'any',
          as_of: input.asOf,
        }),
    getQuestionTimeline(db, input.questionId, 1, SCORE_ACTIONS),
    withoutNonKcKnowledgeIds(db, knowledgeIds),
    readAttemptFacts(db, [input.questionId]).then((facts) => facts.get(input.questionId) ?? []),
    readSameDifficultyDurations(db, input.difficulty, input.questionId),
  ]);

  const byId = new Map(judgment?.items.map((item) => [item.knowledge_id, item]) ?? []);
  const knowledgeRows: QuestionIssueReading['knowledge'] = knowledgeIds.map((id) => {
    const item = byId.get(id);
    const projected = item
      ? projectKnowledgeState(item, input.asOf)
      : {
          band: unknownSignal<(typeof A5_BANDS)[number]>(
            LEARNER_JUDGMENT_SOURCE,
            input.asOf,
            'learner_judgment_missing',
          ),
          due_at: unknownSignal<string>(
            LEARNER_JUDGMENT_SOURCE,
            input.asOf,
            'learner_judgment_missing',
          ),
        };
    const name = names.get(id);
    const point =
      item &&
      item.ability.kind === 'available' &&
      (item.ability_claim.kind === 'observed' || item.ability_claim.kind === 'low_observed')
        ? item.ability.reading.mastery
        : null;
    const mastery =
      point !== null && Number.isFinite(point)
        ? knownSignal(point, LEARNER_JUDGMENT_SOURCE, input.asOf)
        : unknownSignal<number>(
            LEARNER_JUDGMENT_SOURCE,
            input.asOf,
            item ? masteryMissingReason(item.ability_claim) : 'learner_judgment_missing',
          );
    return {
      id,
      name: name
        ? knownSignal(name, `${SOURCE}:knowledgeName`, input.asOf)
        : unknownSignal<string>(`${SOURCE}:knowledgeName`, input.asOf, 'knowledge_missing'),
      mastery,
      band: projected.band,
      due_at: projected.due_at,
    };
  });

  const fsrs =
    schedulableIds.length > 0
      ? knowledgeCard(
          schedulableIds.map((id) => byId.get(id)?.review_timing.freshness.due_at ?? missingDue),
          input.asOf,
        )
      : questionCard(input.questionDueAt, input.asOf);

  return QuestionIssueReadingSchema.parse({
    issuance,
    recent_scoring: scoreSignal(scoreRows[0], input.asOf),
    fsrs,
    knowledge: knowledgeRows,
    difficulty: {
      ...difficulty,
      band: difficultyBandSignal(
        difficulty.item.value?.logit,
        primaryId && primaryId.length > 0 ? primaryId : undefined,
        primaryId ? byId.get(primaryId) : undefined,
        input.asOf,
      ),
    },
    timing: timingSignals(attemptRows, baselineDurations, input.asOf),
    hint_dependence: hintSignal(attemptRows, input.asOf),
    faulty,
  });
}

const missingDue: DueFact = { kind: 'unknown', reason: 'learner_judgment_missing' };

function masteryMissingReason(claim: { kind: string; reason?: string }): string {
  if (claim.kind === 'observed' || claim.kind === 'low_observed') return 'mastery_not_finite';
  return claim.reason ?? claim.kind;
}

function knowledgeCard(facts: readonly DueFact[], asOf: Date): QuestionIssueReading['fsrs'] {
  const soonest = earliestKnownDue(facts);
  if (soonest) {
    return {
      card: 'knowledge',
      due_at: knownSignal(soonest.toISOString(), LEARNER_JUDGMENT_SOURCE, asOf),
    };
  }
  const unknown = facts.find((fact) => fact.kind === 'unknown');
  if (unknown && unknown.kind === 'unknown') {
    return {
      card: 'knowledge',
      due_at: unknownSignal(LEARNER_JUDGMENT_SOURCE, asOf, unknown.reason),
    };
  }
  return { card: 'knowledge', due_at: absentSignal(LEARNER_JUDGMENT_SOURCE, asOf) };
}

function questionCard(dueAt: Date | null, asOf: Date): QuestionIssueReading['fsrs'] {
  if (!dueAt) return { card: 'none', due_at: absentSignal(SOURCE, asOf) };
  return { card: 'question', due_at: knownSignal(dueAt.toISOString(), SOURCE, asOf) };
}
