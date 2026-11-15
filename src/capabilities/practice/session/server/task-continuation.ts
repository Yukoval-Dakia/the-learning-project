import { and, eq, inArray } from 'drizzle-orm';
import { ZodError, type z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  assessment_issuance,
  assessment_response_draft,
  learning_session,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type { PaperContinuation, PaperTaskRef } from '../../api/paper-contracts';
import {
  PaperContinuationStateSchema,
  type RecordPaperStepBodySchema,
  type ResumePaperTaskBodySchema,
} from '../api/task-continuation-contracts';
import { getFrozenPaperDetail } from './assessment/paper-detail';
import { paperBindingId, readPaperAssessmentBinding } from './assessment/paper-issuance';
import type { PaperDetailResult } from './paper-detail';
import { isPaperIntentSource } from './paper-intent-sources';
import { transitionReviewSession } from './review-session-lifecycle';

type Session = typeof learning_session.$inferSelect;
type ResumeCommand = z.infer<typeof ResumePaperTaskBodySchema>;
type StepCommand = z.infer<typeof RecordPaperStepBodySchema>;

export function paperTaskRef(session: Pick<Session, 'id' | 'started_at'>): PaperTaskRef {
  return {
    kind: 'paper_review',
    session_id: session.id,
    occurrence_ref: paperBindingId(session.id, session.started_at),
  };
}

/** Batch projection for callers that must retain the clicked session, including legacy rows. */
export async function readReviewSessionRefs(db: Db | Tx, sessionIds: string[]) {
  if (sessionIds.length === 0)
    return new Map<string, { paper_id: string; task_ref: PaperTaskRef }>();
  const rows = await db
    .select({ session: learning_session, paper: artifact })
    .from(learning_session)
    .innerJoin(artifact, eq(artifact.id, learning_session.artifact_id))
    .where(and(inArray(learning_session.id, sessionIds), eq(learning_session.type, 'review')));
  return new Map(
    rows
      .filter(({ paper }) => paper.type === 'tool_quiz' && isPaperIntentSource(paper.intent_source))
      .map(({ session, paper }) => [
        session.id,
        { paper_id: paper.id, task_ref: paperTaskRef(session) },
      ]),
  );
}

async function loadSession(tx: Tx, ref: PaperTaskRef, lock: boolean) {
  const query = tx
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, ref.session_id), eq(learning_session.type, 'review')));
  const [session] = await (lock ? query.for('update') : query);
  if (!session) throw new ApiError('not_found', '指定的卷会话不存在', 404);
  if (paperTaskRef(session).occurrence_ref !== ref.occurrence_ref)
    throw new ApiError('stale_occurrence', '指定的作答轮次已改变，请从原会话重新打开', 409);
  return session;
}

async function readLocked(
  tx: Tx,
  ref: PaperTaskRef,
  session: Session,
): Promise<PaperDetailResult & { continuation: PaperContinuation }> {
  const [paper] = session.artifact_id
    ? await tx.select().from(artifact).where(eq(artifact.id, session.artifact_id))
    : [];
  if (!paper || paper.type !== 'tool_quiz' || !isPaperIntentSource(paper.intent_source))
    throw new ApiError('paper_unavailable', '指定会话的卷已不可用', 404);
  let binding: Awaited<ReturnType<typeof readPaperAssessmentBinding>>;
  try {
    binding = await readPaperAssessmentBinding(tx, session.id);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new ApiError('invalid_paper_binding', '指定轮次的发行记录无法读取', 409);
  }
  if (!binding)
    throw new ApiError('paper_binding_missing', '指定轮次没有冻结发行记录，无法恢复作答', 409);
  if (
    binding.session_id !== ref.session_id ||
    binding.paper_id !== paper.id ||
    binding.started_at !== session.started_at.toISOString()
  )
    throw new ApiError('invalid_paper_binding', '发行记录与指定会话不一致', 409);
  const detail = await getFrozenPaperDetail(tx, paper, binding, session.status);
  const parsed = PaperContinuationStateSchema.safeParse(session.paper_continuation);
  const state = parsed.success ? parsed.data : null;
  if (state && state.occurrence_ref !== ref.occurrence_ref)
    throw new ApiError('stale_continuation', '保存的位置属于另一作答轮次', 409);
  const slot = state?.step_issuance_id
    ? binding.slots.find((s) => s.issuance_id === state.step_issuance_id)
    : null;
  const [issuance] = slot
    ? await tx
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, slot.issuance_id))
    : [];
  const current =
    slot && issuance
      ? {
          issuance_id: slot.issuance_id,
          question_id: slot.question_id,
          part_ref: slot.part_ref,
          question_revision_id: issuance.revision_id,
        }
      : null;
  const [draft] = current
    ? await tx
        .select({ save_epoch: assessment_response_draft.save_epoch })
        .from(assessment_response_draft)
        .where(eq(assessment_response_draft.issuance_id, current.issuance_id))
    : [];
  const artifactState = paper.archived_at
    ? 'archived'
    : paper.generation_status === 'ready'
      ? 'ready'
      : 'unavailable';
  const unavailableStep =
    state?.step_issuance_id != null &&
    (!current ||
      !detail.sections.some((s) =>
        s.slots.some((s) => s.assessment?.issuance_id === state.step_issuance_id),
      ));
  const unsupported = session.paper_continuation != null && !state;
  const terminal = session.status !== 'started' && session.status !== 'paused';
  const recovery = unsupported
    ? 'unsupported_format'
    : unavailableStep
      ? 'current_step_unavailable'
      : artifactState !== 'ready'
        ? 'artifact_unavailable'
        : terminal
          ? 'terminal'
          : current
            ? 'recorded'
            : 'position_not_recorded';
  return {
    ...detail,
    continuation: {
      task_ref: ref,
      revision: unsupported ? null : (state?.revision ?? 0),
      current_step: current,
      saved_draft:
        current &&
        draft &&
        detail.sections.some((section) =>
          section.slots.some(
            (slot) =>
              slot.assessment?.issuance_id === current.issuance_id &&
              slot.slot_state.submission === null,
          ),
        )
          ? { issuance_id: current.issuance_id, save_epoch: draft.save_epoch }
          : null,
      target:
        unsupported || unavailableStep || artifactState !== 'ready'
          ? 'readonly'
          : session.status === 'completed'
            ? 'retro'
            : terminal
              ? 'readonly'
              : 'answer',
      artifact_state: artifactState,
      recovery,
      last_command: state?.last_command ?? null,
    },
  };
}

/** A single snapshot binds identity, position, disclosure and native draft epochs. */
export async function readPaperTaskContinuation(
  db: Db,
  ref: PaperTaskRef,
): Promise<PaperDetailResult & { continuation: PaperContinuation }> {
  return db.transaction(async (tx) => readLocked(tx, ref, await loadSession(tx, ref, false)), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

export async function commandPaperTask(
  db: Db,
  command: ResumeCommand | StepCommand,
  action: 'resume' | 'pause' | 'navigate',
) {
  const digest = canonicalHash({ operation: action, command });
  try {
    return await db.transaction(
      async (tx) => {
        // Navigation never takes issuance/group/draft locks; the session row is its CAS owner.
        const session = await loadSession(tx, command.task_ref, true);
        const before = await readLocked(tx, command.task_ref, session);
        const position = before.continuation;
        const prior = position.last_command;
        if (prior?.id === command.command_id) {
          if (prior.digest !== digest)
            throw new ApiError('continuation_conflict', '命令标识已用于另一操作', 409);
          return before;
        }
        if (position.target !== 'answer')
          throw new ApiError('continuation_readonly', '指定会话当前只可读取', 409);
        if (position.revision !== command.expected_revision)
          throw new ApiError(
            'continuation_conflict',
            '位置已在另一页面改变，请重新读取后确认',
            409,
          );
        if (action === 'navigate' && session.status !== 'started')
          throw new ApiError('continuation_not_resumed', '请先继续指定会话', 409);
        const stepId =
          'step_issuance_id' in command
            ? command.step_issuance_id
            : (position.current_step?.issuance_id ?? null);
        if (
          action === 'navigate' &&
          !before.sections.some((s) =>
            s.slots.some((slot) => slot.assessment?.issuance_id === stepId),
          )
        )
          throw new ApiError('step_unavailable', '指定题不属于本轮可读取的发行记录', 409);
        if (action !== 'navigate')
          await transitionReviewSession(tx, session.id, action === 'resume' ? 'started' : 'paused');
        await tx
          .update(learning_session)
          .set({
            paper_continuation: {
              format: 1,
              occurrence_ref: command.task_ref.occurrence_ref,
              step_issuance_id: stepId,
              revision: command.expected_revision + 1,
              last_command: { id: command.command_id, digest },
            },
          })
          .where(eq(learning_session.id, session.id));
        return readLocked(tx, command.task_ref, await loadSession(tx, command.task_ref, false));
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    let cause: unknown = error;
    while (cause instanceof Error || (typeof cause === 'object' && cause !== null)) {
      if ('code' in cause && cause.code === '40001')
        throw new ApiError(
          'continuation_conflict',
          '另一页面同时改变了会话，请重新读取后确认',
          409,
        );
      cause = 'cause' in cause ? cause.cause : null;
    }
    throw error;
  }
}
