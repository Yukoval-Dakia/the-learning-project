import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { Artifact } from '@/core/schema';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  event,
  learning_session,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { readPaperSections } from '../paper-sections';
import { issueAssessment } from './issue';

export const PaperAssessmentBinding = z.object({
  version: z.literal(1),
  paper_id: z.string(),
  session_id: z.string(),
  started_at: z.string().datetime(),
  slots: z.array(
    z.object({
      question_id: z.string(),
      part_ref: z.string().nullable(),
      section_index: z.number().int().nonnegative(),
      knowledge_focus: z.array(z.string()),
      feedback_policy: z.string(),
      question_meta: z.object({
        kind: z.string(),
        difficulty: z.number(),
        knowledge_ids: z.array(z.string()),
        parent_question_id: z.string().nullable(),
        part_index: z.number().nullable(),
      }),
      issuance_id: z.string(),
      evaluation_group_id: z.string(),
      idempotency_key: z.string(),
    }),
  ),
});
export type PaperAssessmentBindingT = z.infer<typeof PaperAssessmentBinding>;
const ACTION = 'experimental:assessment_paper_issued';

export function paperBindingId(sessionId: string, startedAt: Date) {
  return `evt_paper_issued_${canonicalHash({ sessionId, startedAt: startedAt.toISOString() })}`;
}

/** Historical sessions have no invented binding to a mutable current question. */
export async function readPaperAssessmentBinding(db: Db | Tx, sessionId: string) {
  const [session] = await db
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, sessionId));
  if (!session) return null;
  const [record] = await db
    .select()
    .from(event)
    .where(
      and(eq(event.id, paperBindingId(sessionId, session.started_at)), eq(event.action, ACTION)),
    );
  return record ? PaperAssessmentBinding.parse(record.payload) : null;
}

/** Called in the new-session transaction: either the entire paper is issued or nothing is. */
export async function issuePaperAssessment(tx: Tx, sessionId: string, paperId: string) {
  const [session] = await tx
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, sessionId));
  if (!session || session.artifact_id !== paperId || session.type !== 'review') {
    throw new ApiError('coordinate_mismatch', 'paper review session does not match', 409);
  }
  const prior = await readPaperAssessmentBinding(tx, sessionId);
  if (prior) return prior;
  const [paper] = await tx.select().from(artifact).where(eq(artifact.id, paperId));
  if (!paper) throw new ApiError('not_found', 'paper not found', 404);
  const state = Artifact.parse(paper).tool_state;
  const sections = readPaperSections(state);
  const slots = sections.length
    ? sections.flatMap((section, sectionIndex) =>
        section.assignments.map((a) => ({
          question_id: a.question_id,
          part_ref: a.part_ref ?? null,
          section_index: sectionIndex,
          knowledge_focus: section.knowledge_focus,
          feedback_policy: section.feedback_policy,
        })),
      )
    : (state?.question_ids ?? []).map((question_id) => ({
        question_id,
        part_ref: null,
        section_index: 0,
        knowledge_focus: [] as string[],
        feedback_policy: 'immediate',
      }));
  const seen = new Set<string>();
  const pending = [];
  for (const slot of slots) {
    const key = `${slot.question_id}::${slot.part_ref ?? ''}`;
    if (seen.has(key)) throw new ApiError('coordinate_mismatch', 'duplicate paper slot', 409);
    seen.add(key);
    const [q] = await tx
      .select({
        id: question.id,
        parent_id: question.parent_question_id,
        kind: question.kind,
        difficulty: question.difficulty,
        knowledge_ids: question.knowledge_ids,
        part_index: question.part_index,
      })
      .from(question)
      .where(eq(question.id, slot.question_id));
    if (!q) throw new ApiError('not_found', 'paper question not found', 404);
    pending.push({
      slot: {
        ...slot,
        question_meta: {
          kind: q.kind,
          difficulty: q.difficulty,
          knowledge_ids: q.knowledge_ids,
          parent_question_id: q.parent_id,
          part_index: q.part_index,
        },
      },
      groupId: q.parent_id ?? q.id,
    });
  }
  // Shared roots acquire locks in the same order across overlapping papers.
  const issuedSlots = new Map<string, PaperAssessmentBindingT['slots'][number]>();
  for (const { slot, groupId } of [...pending].sort((a, b) => a.groupId.localeCompare(b.groupId))) {
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, groupId));
    if (!lifecycle?.current_revision_id)
      throw new ApiError('unpublished', 'paper question has no frozen published revision', 409);
    const [revision] = await tx
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, lifecycle.current_revision_id));
    if (!revision) throw new ApiError('unpublished', 'paper revision is unavailable', 409);
    const partId = slot.part_ref ?? slot.question_id;
    const partIds = revision.structure.parts.some((part) => part.part_id === partId)
      ? [partId]
      : slot.part_ref === null && groupId === slot.question_id
        ? revision.structure.parts.map((part) => part.part_id)
        : [];
    if (!partIds.length)
      throw new ApiError('coordinate_mismatch', 'paper slot is outside published parts', 409);
    const identity = canonicalHash({
      session_id: sessionId,
      started_at: session.started_at.toISOString(),
      question_id: slot.question_id,
      part_ref: slot.part_ref,
    });
    const issued = await issueAssessment(tx, {
      group_id: groupId,
      revision_id: revision.revision_id,
      part_ids: partIds,
      issuance_id: `iss_paper_${identity}`,
      container_occurrence_ref: `paper_${identity}`,
      actorRef: 'assessment:paper-open',
      now: session.started_at,
    });
    if (issued.status !== 'issued' && issued.status !== 'replayed') {
      throw new ApiError(issued.status, `paper slot issuance failed: ${issued.status}`, 409);
    }
    issuedSlots.set(`${slot.question_id}::${slot.part_ref ?? ''}`, {
      ...slot,
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: `eg_paper_${identity}`,
      idempotency_key: `paper_${identity}`,
    });
  }
  const binding = PaperAssessmentBinding.parse({
    version: 1,
    paper_id: paperId,
    session_id: sessionId,
    started_at: session.started_at.toISOString(),
    slots: slots.map((slot) => issuedSlots.get(`${slot.question_id}::${slot.part_ref ?? ''}`)),
  });
  await writeEvent(tx, {
    id: paperBindingId(sessionId, session.started_at),
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: ACTION,
    subject_kind: 'artifact',
    subject_id: paperId,
    outcome: null,
    payload: binding,
    created_at: session.started_at,
    ingest_at: session.started_at,
  });
  return binding;
}
