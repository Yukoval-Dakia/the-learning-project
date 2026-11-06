import { createHash } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { ResponseSpec } from '@/core/schema/assessment/response';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { notHoldoutOnlyPredicate } from '@/db/predicates';
import {
  assessment_issuance,
  assessment_submission,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { declaredAdmissionOwned } from '@/kernel/read-models/question-admission-ownership';
import { UNKNOWN_SERVING, readQuestionServing } from '@/kernel/read-models/question-serving';
import { resolveQuestionRenderNotation } from '@/kernel/read-models/subject-resolution';

/** A learner-safe reference read; answering still requires the issuance gate. */
export async function readQuestionCard(db: Db, id: string) {
  const [row] = await db
    .select({
      id: question.id,
      parent_question_id: question.parent_question_id,
      prompt_md: question.prompt_md,
      kind: question.kind,
      choices_md: question.choices_md,
      admission_owned: declaredAdmissionOwned(),
    })
    .from(question)
    .where(
      and(
        eq(question.id, id),
        ne(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        notHoldoutOnlyPredicate(question),
        sql`${question.metadata}->>'archived_at' IS NULL`,
        sql`${question.metadata}->>'dismissed_at' IS NULL`,
      ),
    )
    .limit(1);
  if (!row)
    return { question_id: id, state: 'unavailable' as const, question: null, serving: null };
  const serving = (await readQuestionServing(db, [id])).byId.get(id) ?? UNKNOWN_SERVING;
  if (serving.hold_reason === 'withdrawn') {
    return { question_id: id, state: 'withdrawn' as const, question: null, serving };
  }
  // Only the admission owner may expose a not-yet-servable question as a waiting card.
  const visible = serving.servable || (row.admission_owned && serving.admission != null);
  if (!visible)
    return { question_id: id, state: 'unavailable' as const, question: null, serving: null };
  const groupId = row.parent_question_id ?? row.id;
  const [revision] = await db
    .select({
      response_spec: question_revision.response_spec,
      structure: question_revision.structure,
      revision_id: question_revision.revision_id,
    })
    .from(question_group_lifecycle)
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
    )
    .where(eq(question_group_lifecycle.group_id, groupId))
    .limit(1);
  const parts = (revision?.structure as { parts?: { part_id: string }[] } | undefined)?.parts ?? [];
  const inlineSupported = row.parent_question_id != null || parts.length === 1;
  const partIds = row.parent_question_id ? [row.id] : parts.map((part) => part.part_id);
  const spec = ResponseSpec.safeParse(revision?.response_spec);
  const displaySlots =
    inlineSupported && spec.success && revision != null
      ? spec.data.slots
          .filter((slot) => partIds.includes(slot.part_id))
          .map((slot) => {
            if (slot.kind === 'select' && slot.axes != null) {
              return {
                ...slot,
                items: displayOrder(slot.items, `${revision.revision_id}:${slot.slot_id}:items`),
                axes: Object.fromEntries(
                  Object.entries(slot.axes).map(([axis, entries]) => [
                    axis,
                    axis === 'position'
                      ? entries
                      : displayOrder(entries, `${revision.revision_id}:${slot.slot_id}:${axis}`),
                  ]),
                ),
              };
            }
            if (slot.kind === 'matching')
              return {
                ...slot,
                left_items: displayOrder(
                  slot.left_items,
                  `${revision.revision_id}:${slot.slot_id}:left`,
                ),
                right_options: displayOrder(
                  slot.right_options,
                  `${revision.revision_id}:${slot.slot_id}:right`,
                ),
              };
            if (slot.kind === 'ordering')
              return {
                ...slot,
                items: displayOrder(slot.items, `${revision.revision_id}:${slot.slot_id}`),
              };
            return slot;
          })
      : [];
  const [latest] = await db
    .select({
      issuance_id: assessment_issuance.issuance_id,
      revision_id: assessment_issuance.revision_id,
      part_ids: assessment_issuance.part_ids,
      submitted_at: assessment_submission.submitted_at,
    })
    .from(assessment_issuance)
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, assessment_issuance.revision_id),
    )
    .leftJoin(
      assessment_submission,
      eq(assessment_submission.issuance_id, assessment_issuance.issuance_id),
    )
    .where(
      and(
        eq(question_revision.group_id, groupId),
        sql`${assessment_issuance.part_ids} @> ${JSON.stringify(partIds)}::jsonb`,
      ),
    )
    .orderBy(desc(assessment_issuance.issued_at), desc(assessment_submission.submitted_at))
    .limit(1);
  const admission = serving.admission?.status;
  return {
    question_id: id,
    state: serving.servable
      ? ('ready' as const)
      : admission === 'failed'
        ? ('failed' as const)
        : admission === 'undecided'
          ? ('undecided' as const)
          : ('checking' as const),
    question: {
      id: row.id,
      group_id: groupId,
      part_ids: partIds,
      prompt_md: row.prompt_md,
      kind: row.kind,
      choices_md: displaySlots.some(
        (slot) =>
          slot.kind === 'matching' ||
          slot.kind === 'ordering' ||
          (slot.kind === 'select' && slot.axes != null),
      )
        ? null
        : row.choices_md,
      notation: await resolveQuestionRenderNotation(db, row.id),
      admission_owned: row.admission_owned,
      inline_supported: inlineSupported,
      display_response_spec: displaySlots.length > 0 ? { slots: displaySlots } : null,
    },
    serving,
    latest_attempt: latest
      ? {
          issuance_id: latest.issuance_id,
          revision_id: latest.revision_id,
          part_ids: latest.part_ids,
          status: latest.submitted_at ? ('submitted' as const) : ('issued' as const),
        }
      : null,
  };
}

// Stable public-axis permutation, independent of all scoring keys; never expose authored axis order.
function displayOrder<T>(items: T[], seed: string): T[] {
  const shuffled = items
    .map((item, index) => ({
      item,
      index,
      rank: createHash('sha256')
        .update(seed + JSON.stringify(item))
        .digest('hex'),
    }))
    .sort((a, b) => a.rank.localeCompare(b.rank));
  if (shuffled.length > 1 && shuffled.every((entry, index) => entry.index === index))
    return [...shuffled.slice(1), shuffled[0]].map((entry) => entry.item);
  return shuffled.map((entry) => entry.item);
}
