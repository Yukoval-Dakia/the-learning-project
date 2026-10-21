import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { Artifact } from '@/core/schema';
import type { ResponseSlotT } from '@/core/schema/assessment';
import { SERVING_UNAVAILABLE_REASONS } from '@/core/schema/assessment/serving-admission';
import {
  PAPER_MODE_UNSUPPORTED_SLOT_KIND,
  firstWholePaperUnrenderableSlot,
} from '@/core/schema/assessment/slot-renderers';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  assessment_issuance,
  event,
  learning_session,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { readPaperSections } from '../paper-sections';
import { issueAssessment, readAutomaticServingDecision, revisionRowToContract } from './issue';

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
  /**
   * slots the serving gate refused at open time (typed reason only;
   * no issuance exists for them, so no issuance_id is recorded). Optional so
   * bindings written before this field existed still parse.
   */
  withheld_slots: z
    .array(
      z.object({
        question_id: z.string(),
        part_ref: z.string().nullable(),
        section_index: z.number().int().nonnegative(),
        reason: z.enum(SERVING_UNAVAILABLE_REASONS),
      }),
    )
    .optional(),
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

type PaperToolState = ReturnType<typeof Artifact.parse>['tool_state'];

function listPaperSlots(state: PaperToolState) {
  const sections = readPaperSections(state);
  return sections.length
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
}

/** The frozen current revision and part scope a paper slot would be issued at. */
async function resolvePaperSlotRevision(
  tx: Tx,
  slot: { question_id: string; part_ref: string | null },
  groupId: string,
) {
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
  return { revision, partIds };
}

/**
 * the whole-paper page draws answers only for WHOLE_PAPER_SLOT_KINDS. A paper
 * with an issued answer slot outside that list is refused as a whole (open and hand-in):
 * the page would show no control and hand in an empty answer.
 */
function paperModeUnsupported(paperId: string, slot: ResponseSlotT) {
  return new ApiError(
    PAPER_MODE_UNSUPPORTED_SLOT_KIND,
    `paper ${paperId} has a ${slot.kind} answer slot (${slot.slot_id}) the whole-paper page cannot render`,
    409,
  );
}

/**
 * Read-only opening preflight, run before the session row or any issuance is written:
 * refuses when a slot the issuance gate would admit carries an answer slot the paper page
 * cannot render. Slots the gate withholds stay withheld, so they do not refuse.
 */
export async function assertPaperOpenable(tx: Tx, paperId: string): Promise<void> {
  const [paper] = await tx.select().from(artifact).where(eq(artifact.id, paperId));
  if (!paper) throw new ApiError('not_found', 'paper not found', 404);
  for (const slot of listPaperSlots(Artifact.parse(paper).tool_state)) {
    const [q] = await tx
      .select({ id: question.id, parent_id: question.parent_question_id })
      .from(question)
      .where(eq(question.id, slot.question_id));
    if (!q) throw new ApiError('not_found', 'paper question not found', 404);
    const { revision, partIds } = await resolvePaperSlotRevision(tx, slot, q.parent_id ?? q.id);
    const unrenderable = firstWholePaperUnrenderableSlot(revision.response_spec.slots, partIds);
    if (!unrenderable) continue;
    const decision = await readAutomaticServingDecision(
      tx,
      revisionRowToContract(revision),
      partIds,
    );
    if (decision.kind === 'admitted') throw paperModeUnsupported(paperId, unrenderable);
  }
}

/**
 * Refuses when any of these issued paper slots carries an answer slot the paper page cannot
 * render. Reads the immutable issuance + revision rows only.
 */
export async function assertIssuedPaperSlotsRenderable(
  db: Db | Tx,
  paperId: string,
  issuanceIds: readonly string[],
): Promise<void> {
  if (issuanceIds.length === 0) return;
  const rows = await db
    .select({
      part_ids: assessment_issuance.part_ids,
      response_spec: question_revision.response_spec,
    })
    .from(assessment_issuance)
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, assessment_issuance.revision_id),
    )
    .where(inArray(assessment_issuance.issuance_id, [...new Set(issuanceIds)]));
  for (const row of rows) {
    const unrenderable = firstWholePaperUnrenderableSlot(row.response_spec.slots, row.part_ids);
    if (unrenderable) throw paperModeUnsupported(paperId, unrenderable);
  }
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
  const slots = listPaperSlots(Artifact.parse(paper).tool_state);
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
  const withheldSlots: NonNullable<PaperAssessmentBindingT['withheld_slots']> = [];
  for (const { slot, groupId } of [...pending].sort((a, b) => a.groupId.localeCompare(b.groupId))) {
    const { revision, partIds } = await resolvePaperSlotRevision(tx, slot, groupId);
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
      // a gate-refused slot is withheld individually so a mixed paper
      // stays openable; every other failure (structural, lifecycle, claim) still
      // aborts the whole opening transaction.
      if (issued.status === 'not_admitted' && issued.serving_reason !== undefined) {
        withheldSlots.push({
          question_id: slot.question_id,
          part_ref: slot.part_ref,
          section_index: slot.section_index,
          reason: issued.serving_reason,
        });
        continue;
      }
      throw new ApiError(issued.status, `paper slot issuance failed: ${issued.status}`, 409);
    }
    // backstop for a gate decision that changed after the preflight: throwing here
    // rolls back the whole opening transaction (session row and every issuance with it).
    const unrenderable = firstWholePaperUnrenderableSlot(
      revision.response_spec.slots,
      issued.issuance.binding.part_ids,
    );
    if (unrenderable) throw paperModeUnsupported(paperId, unrenderable);
    issuedSlots.set(`${slot.question_id}::${slot.part_ref ?? ''}`, {
      ...slot,
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: `eg_paper_${identity}`,
      idempotency_key: `paper_${identity}`,
    });
  }
  if (issuedSlots.size === 0) {
    throw new ApiError('not_admitted', `paper ${paperId} has no automatically servable slots`, 409);
  }
  const binding = PaperAssessmentBinding.parse({
    version: 1,
    paper_id: paperId,
    session_id: sessionId,
    started_at: session.started_at.toISOString(),
    slots: slots
      .map((slot) => issuedSlots.get(`${slot.question_id}::${slot.part_ref ?? ''}`))
      .filter((slot) => slot !== undefined),
    ...(withheldSlots.length > 0 ? { withheld_slots: withheldSlots } : {}),
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
