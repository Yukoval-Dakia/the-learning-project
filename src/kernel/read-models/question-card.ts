import { and, desc, eq, getTableColumns, ne, sql } from 'drizzle-orm';
import {
  PublishedQuestionRevision,
  deriveIssuanceBinding,
  hasOnlyDeterministicExecutors,
  projectIssuedScoringBasis,
  projectPracticeIssuance,
} from '@/core/schema/assessment';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { notHoldoutOnlyPredicate } from '@/db/predicates';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { blockDigest, blockRefForDigest } from '@/kernel/blocks/digest';
import { declaredAdmissionOwned } from '@/kernel/read-models/question-admission-ownership';
import { UNKNOWN_SERVING, readQuestionServing } from '@/kernel/read-models/question-serving';
import { resolveQuestionRenderNotation } from '@/kernel/read-models/subject-resolution';
import { revisionRowToContract } from '@/kernel/records/assessment-issuance';

/** A learner-safe reference read; answering still requires the issuance gate. */
export async function readQuestionCard(db: Db, id: string, sessionId?: string) {
  const empty = { question_id: id, inline_block_ref: null, latest_attempt: null };
  const [row] = await db
    .select({
      id: question.id,
      parent_question_id: question.parent_question_id,
      kind: question.kind,
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
  if (!row) return { ...empty, state: 'unavailable' as const, question: null, serving: null };
  const serving = (await readQuestionServing(db, [id])).byId.get(id) ?? UNKNOWN_SERVING;
  if (serving.hold_reason === 'withdrawn') {
    return { ...empty, state: 'withdrawn' as const, question: null, serving };
  }
  // Only the admission owner may expose a not-yet-servable question as a waiting card.
  const visible = serving.servable || (row.admission_owned && serving.admission != null);
  if (!visible) return { ...empty, state: 'unavailable' as const, question: null, serving: null };
  const groupId = row.parent_question_id ?? row.id;
  const [revision] = await db
    .select(getTableColumns(question_revision))
    .from(question_group_lifecycle)
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
    )
    .where(eq(question_group_lifecycle.group_id, groupId))
    .limit(1);
  const parsedRevision = revision
    ? PublishedQuestionRevision.safeParse(revisionRowToContract(revision))
    : null;
  if (!parsedRevision?.success)
    return { ...empty, state: 'unavailable' as const, question: null, serving };
  const published = parsedRevision.data;
  const partIds = row.parent_question_id
    ? [row.id]
    : published.structure.parts.map((part) => part.part_id);
  let display: ReturnType<typeof projectPracticeIssuance>;
  try {
    // Previewing the public projection neither persists nor authorizes an issuance.
    display = projectPracticeIssuance(published, {
      issuance_id: 'question-card-preview',
      binding: deriveIssuanceBinding(published, { part_ids: partIds }),
      issued_at: published.published_at,
      claim: { policy: 'unbounded', status: 'unclaimed', claimed_by_ref: null },
    });
  } catch {
    return { ...empty, state: 'unavailable' as const, question: null, serving };
  }
  const singlePart = display.faces.length === 1;
  const inlineSupported =
    singlePart &&
    display.faces[0].material_ids.length === 0 &&
    hasOnlyDeterministicExecutors(
      published.execution_plan,
      new Set(
        projectIssuedScoringBasis(published, partIds).units.map((unit) => unit.scoring_unit_id),
      ),
    );
  const displaySlots = display.response_spec.slots;
  const choiceSlot = displaySlots.length === 1 ? displaySlots[0] : undefined;
  const choices =
    choiceSlot?.kind === 'single_choice' || choiceSlot?.kind === 'multi_choice'
      ? choiceSlot.options.map((option) => option.text)
      : choiceSlot?.kind === 'select' &&
          choiceSlot.axes == null &&
          choiceSlot.items.every(
            (item) => item.coordinates == null && item.gap_after_codepoint == null,
          )
        ? choiceSlot.items.map((item) => item.label_md)
        : null;
  const inlineBlockRef = blockRefForDigest(
    blockDigest({
      v: 1,
      kind: 'question_ref',
      display: 'inline',
      question_ids: [id],
      alt: '题目',
      label: '打开题目',
    }),
  );
  // A session only scopes recovery; it grants no additional question visibility in this single-tenant read.
  const [latest] = sessionId
    ? await db
        .select({
          issuance_id: assessment_issuance.issuance_id,
          revision_id: assessment_issuance.revision_id,
          part_ids: assessment_issuance.part_ids,
          submitted_at: assessment_submission.submitted_at,
          confirmed: sql<boolean>`exists(select 1 from ${event} where ${event.action} = 'experimental:assessment_attempt' and ${event.payload}->>'submission_id' = ${assessment_submission.submission_id})`,
          graded: sql<boolean>`exists(select 1 from ${evaluation} where ${evaluation.submission_id} = ${assessment_submission.submission_id} and ${evaluation.status} = 'completed')`,
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
            eq(
              assessment_issuance.container_occurrence_ref,
              `copilot-card:${sessionId}:${inlineBlockRef}`,
            ),
            sql`${assessment_issuance.part_ids} @> ${JSON.stringify(partIds)}::jsonb`,
          ),
        )
        .orderBy(desc(assessment_issuance.issued_at), desc(assessment_submission.submitted_at))
        .limit(1)
    : [];
  const admission = serving.admission?.status;
  return {
    question_id: id,
    inline_block_ref: inlineBlockRef,
    state: serving.servable
      ? ('ready' as const)
      : admission === 'failed'
        ? ('failed' as const)
        : admission === 'undecided'
          ? ('undecided' as const)
          : admission === 'pending' && serving.hold_reason === 'awaiting_admission'
            ? ('checking' as const)
            : ('unavailable' as const),
    question: {
      id: row.id,
      group_id: groupId,
      part_ids: partIds,
      prompt_md: display.faces.map((face) => face.prompt_md).join('\n\n'),
      ...(singlePart && display.faces[0].blank_order != null
        ? { blank_order: display.faces[0].blank_order }
        : {}),
      kind: row.kind,
      choices_md: choices,
      notation: await resolveQuestionRenderNotation(db, row.id),
      admission_owned: row.admission_owned,
      inline_supported: inlineSupported,
      display_response_spec: display.response_spec,
    },
    serving,
    latest_attempt: latest
      ? {
          issuance_id: latest.issuance_id,
          revision_id: latest.revision_id,
          part_ids: latest.part_ids,
          status: latest.confirmed
            ? ('submitted' as const)
            : latest.graded
              ? ('graded_unconfirmed' as const)
              : latest.submitted_at
                ? ('answer_saved' as const)
                : ('issued' as const),
        }
      : null,
  };
}
