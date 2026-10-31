import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ContextKeySchema,
  DigestSchema,
  LearnerIdSchema,
  SkillIdSchema,
  VERSIONS,
  coldState,
} from '@/core/forgetting';
import { initialFsrsState } from '@/core/fsrs';
import { newId } from '@/core/ids';
import { canonicalHash } from '@/core/migration/canonical';
import { CandidateStateSchema, type SchedulingState } from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { withLearningStateLock } from '@/db/learning-state-lock';
import { material_fsrs_state } from '@/db/schema';

type DbLike = Db | Tx;
type FsrsSubjectKind = 'question' | 'knowledge';

const EngineSelection = z.enum(['fsrs', 'forgetting_candidate']);

function selectedForgettingEngine() {
  return EngineSelection.parse(process.env.FORGETTING_ENGINE ?? 'fsrs');
}

function candidateSeed(skillId: string, context?: string) {
  return {
    learnerId: LearnerIdSchema.parse('self'),
    skillId: SkillIdSchema.parse(skillId),
    scope: context
      ? { kind: 'context' as const, key: ContextKeySchema.parse(context) }
      : { kind: 'global' as const },
    versions: VERSIONS,
    inputDigest: DigestSchema.parse(
      canonicalHash({ skillId, context: context ?? null, versions: VERSIONS }),
    ),
  };
}

function initialCandidateState(skillId: string, now: Date) {
  return CandidateStateSchema.parse({
    engine: 'forgetting_candidate',
    schemaVersion: 'scheduling-state-v1',
    global: coldState(candidateSeed(skillId)),
    contexts: {},
    conversion: 'initial',
    provenance: 'engineering',
    calibration: 'uncalibrated',
    due: now,
    last_review: null,
    dueKind: 'initial',
    fallbackReason: null,
  });
}

/** Every enrollment uses the same server-side selection and its existing subject identity. */
export function initialSchedulingState(
  subjectId: string,
  now: Date,
): { state: SchedulingState; due_at: Date } {
  if (selectedForgettingEngine() === 'forgetting_candidate')
    return { state: initialCandidateState(subjectId, now), due_at: now };
  const initial = initialFsrsState(now);
  return {
    state: { ...initial.state, engine: 'fsrs', schemaVersion: 'scheduling-state-v1' },
    due_at: initial.dueAt,
  };
}

export interface UpsertFsrsStateInput {
  subject_kind: FsrsSubjectKind;
  subject_id: string;
  state: SchedulingState;
  due_at: Date;
  last_review_event_id: string | null;
}

/**
 * Materialize a fresh card only when the subject was never enrolled.
 *
 * Unlike upsert, conflicts are intentionally a no-op: enrollment can race a review submit,
 * and a newly-created card must never overwrite the newer schedule.
 */
export async function enrollFsrsStateIfAbsent(
  db: DbLike,
  input: UpsertFsrsStateInput,
): Promise<boolean> {
  return withLearningStateLock(db, async (tx): Promise<boolean> => {
    const inserted = await tx
      .insert(material_fsrs_state)
      .values({
        id: newId(),
        subject_kind: input.subject_kind,
        subject_id: input.subject_id,
        state: input.state,
        due_at: input.due_at,
        last_review_event_id: input.last_review_event_id,
        updated_at: new Date(),
      })
      .onConflictDoNothing({
        target: [material_fsrs_state.subject_kind, material_fsrs_state.subject_id],
      })
      .returning({ id: material_fsrs_state.id });
    return inserted.length > 0;
  });
}

/**
 * Drop the derived FSRS row after a one-shot diagnostic's first review.
 *
 * The immutable question and review evidence stay; removing only the schedule keeps a
 * settled diagnostic from resurfacing as an ordinary recurring review.
 */
export async function retireQuestionFsrsState(db: DbLike, questionId: string): Promise<boolean> {
  return withLearningStateLock(db, async (tx): Promise<boolean> => {
    const deleted = await tx
      .delete(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'question'),
          eq(material_fsrs_state.subject_id, questionId),
        ),
      )
      .returning({ id: material_fsrs_state.id });
    return deleted.length > 0;
  });
}
