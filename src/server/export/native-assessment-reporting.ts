import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { sameMemberSet } from '@/core/assessment-input';
import {
  AssessmentIssuance,
  EvaluationGroup,
  EvaluationRecord,
  PublishedQuestionRevision,
  SubmissionRecord,
  projectPracticeIssuance,
  validateIssuanceBinding,
} from '@/core/schema/assessment';
import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  learning_session,
  question_revision,
} from '@/db/schema';
import { LearningScope } from '@/kernel/read-models/assessment-learning-scope';
import {
  type NativeReviewOccurrence,
  projectNativeReviewOccurrences,
} from '@/kernel/read-models/assessment-review-occurrences';
import {
  nativeAttemptOutcome,
  projectGroupVerdicts,
} from '@/kernel/read-models/assessment-verdict';
import type { Row } from './csv';

function jsonCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const json = <T extends z.ZodType>(schema: T) => z.preprocess(jsonCell, schema);
const date = z.union([z.date(), z.string().min(1), z.number().finite()]).pipe(z.coerce.date());
const RevisionRow = createSelectSchema(question_revision).extend({
  structure: json(PublishedQuestionRevision.shape.structure),
  response_spec: json(PublishedQuestionRevision.shape.response_spec),
  scoring_basis: json(PublishedQuestionRevision.shape.scoring_basis),
  execution_plan: json(PublishedQuestionRevision.shape.execution_plan),
  published_at: date,
});
const IssuanceRow = createSelectSchema(assessment_issuance).extend({
  part_ids: json(AssessmentIssuance.shape.binding.shape.part_ids),
  material_bindings: json(AssessmentIssuance.shape.binding.shape.material_bindings),
  option_order: json(AssessmentIssuance.shape.binding.shape.option_order),
  claim_policy: AssessmentIssuance.shape.claim.shape.policy,
  claim_status: AssessmentIssuance.shape.claim.shape.status,
  issued_at: date,
});
const SubmissionRow = createSelectSchema(assessment_submission).extend({
  response_set: json(SubmissionRecord.shape.response_set),
  group_evidence: json(SubmissionRecord.shape.group_evidence),
  submitted_at: date,
});
// Validate both the selected columns and the status/aggregate contract. Preserve
// additional provenance keys, which are immutable execution receipts.
const EvaluationRow = createSelectSchema(evaluation)
  .extend({
    status: EvaluationRecord.shape.status,
    unit_results: json(EvaluationRecord.shape.unit_results),
    aggregate: json(EvaluationRecord.shape.aggregate),
    run_refs: json(EvaluationRecord.shape.run_refs),
    provenance: json(z.record(z.string(), z.unknown()).nullable()),
    created_at: date,
  })
  .superRefine((row, ctx) => {
    const parsed = EvaluationRecord.safeParse({ ...row, provenance: row.provenance ?? undefined });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });
const HeadRow = createSelectSchema(evaluation_effective_head).extend({ updated_at: date });
const GroupRow = createSelectSchema(evaluation_group).extend({
  submission_ids: json(EvaluationGroup.shape.submission_ids),
  created_at: date,
});
const SessionRow = createSelectSchema(learning_session)
  .pick({ id: true, status: true, started_at: true })
  .extend({ started_at: date });
const EventRow = z.object({
  id: z.string(),
  action: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  session_id: z.string().nullable().default(null),
  caused_by_event_id: z.string().nullable().default(null),
  payload: json(z.record(z.string(), z.unknown())),
  created_at: date,
});
const AnchorPayload = z.object({
  submission_id: z.string(),
  issuance_id: z.string(),
  revision_id: z.string(),
  evaluation_group_id: z.string(),
  original_evaluation_id: z.string().nullable(),
  response_md: z.string().nullable(),
  paper_feedback_policy: z.string().optional(),
  paper_started_at: z.string().optional(),
});

function parsedRows<T extends z.ZodType>(rows: Row[] | undefined, schema: T): z.output<T>[] {
  return (rows ?? []).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

type FrozenContext = ReturnType<typeof frozenContext>;
function frozenContext(row: z.infer<typeof RevisionRow>, issued: z.infer<typeof IssuanceRow>) {
  if (row.group_id !== row.structure.group_id) return null;
  const revision = PublishedQuestionRevision.parse({
    ...row,
    published_at: row.published_at.toISOString(),
  });
  const issuance = AssessmentIssuance.parse({
    issuance_id: issued.issuance_id,
    issued_at: issued.issued_at.toISOString(),
    binding: issued,
    claim: {
      policy: issued.claim_policy,
      status: issued.claim_status,
      claimed_by_ref: issued.claimed_by_ref,
    },
  });
  if (validateIssuanceBinding(issuance.binding, revision).length) return null;
  const face = projectPracticeIssuance(revision, issuance);
  const controls = face.response_spec.slots.flatMap((slot) => {
    const options = 'options' in slot ? slot.options : [];
    const items = 'items' in slot ? slot.items : [];
    if (slot.kind === 'matching')
      return [...slot.left_items, ...slot.right_options].map(
        (item) => `${item.label}. ${item.text}`,
      );
    if (slot.kind === 'table') return [slot.column_headers.join(' | '), ...slot.row_labels];
    return [
      ...(slot.placement?.label ? [slot.placement.label] : []),
      ...options.map((option) => `${option.label}. ${option.text}`),
      ...items.map((item) => `${item.label}. ${item.text}`),
      ...(slot.kind === 'numeric' && slot.unit_hint ? [slot.unit_hint] : []),
    ];
  });
  // Reference rendering selects issued units without projecting aggregation.
  // A joint capped/level evaluation can contain partial member issuances even
  // though their aggregation is only valid over the complete group.
  const slotIds = new Set(face.response_spec.slots.map((slot) => slot.slot_id));
  const reference = revision.scoring_basis.units
    .filter((unit) => unit.slot_refs.every((id) => slotIds.has(id)))
    .map((unit) => {
      const slots = face.response_spec.slots.filter((slot) =>
        unit.slot_refs.includes(slot.slot_id),
      );
      const options = new Map(
        slots.flatMap((slot) => {
          const values =
            'options' in slot ? slot.options : slot.kind === 'matching' ? slot.right_options : [];
          return values.map((value) => [value.option_id, `${value.label}. ${value.text}`] as const);
        }),
      );
      const items = new Map(
        slots.flatMap((slot) => {
          const values =
            'items' in slot ? slot.items : slot.kind === 'matching' ? slot.left_items : [];
          return values.map((value) => [value.item_id, `${value.label}. ${value.text}`] as const);
        }),
      );
      const criterion = unit.criterion;
      switch (criterion.kind) {
        case 'option_set_key':
          return criterion.accepted_option_ids.map((id) => options.get(id) ?? id).join('\n');
        case 'matching_pairs_key':
          return criterion.accepted_pairs
            .map(
              (pair) =>
                `${items.get(pair.item_id) ?? pair.item_id} → ${options.get(pair.option_id) ?? pair.option_id}`,
            )
            .join('\n');
        case 'text_key':
          return criterion.accepted_texts.join('\n\n');
        case 'numeric_key':
          return `${criterion.expected}${criterion.expected_unit ? ` ${criterion.expected_unit}` : ''}`;
        case 'rule_reference':
          return criterion.statement_md;
        case 'holistic_level':
          return criterion.levels.map((level) => level.descriptor_md).join('\n\n');
        default: {
          const unreachable: never = criterion;
          return unreachable;
        }
      }
    })
    .join('\n\n');
  const materials = new Set(
    revision.structure.parts
      .filter((part) => issued.part_ids.includes(part.part_id))
      .flatMap((part) => part.material_ids),
  );
  const solution = revision.structure.materials
    .filter(
      (material) =>
        materials.has(material.material_id) && /^sol_[0-9a-f]{12}$/.test(material.asset.asset_id),
    )
    .map((material) => material.content_md)
    .filter(Boolean)
    .join('\n\n');
  return {
    prompt: [
      ...face.materials.flatMap((material) => (material.content_md ? [material.content_md] : [])),
      ...face.faces.map((part) => part.prompt_md),
      ...controls,
    ].join('\n\n'),
    reference: solution || reference,
    responseSpec: face.response_spec,
  };
}

function frozenResponse(
  submission: z.infer<typeof SubmissionRow>,
  context: NonNullable<FrozenContext>,
) {
  return submission.response_set.entries
    .map((entry) => {
      const slot = context.responseSpec.slots.find((slot) => slot.slot_id === entry.slot_id);
      const options =
        slot && 'options' in slot
          ? slot.options
          : slot?.kind === 'matching'
            ? slot.right_options
            : [];
      const items =
        slot && 'items' in slot ? slot.items : slot?.kind === 'matching' ? slot.left_items : [];
      const optionText = (id: string) => {
        const option = options.find((option) => option.option_id === id);
        return option ? `${option.label}. ${option.text}` : id;
      };
      const itemText = (id: string) => {
        const item = items.find((item) => item.item_id === id);
        return item ? `${item.label}. ${item.text}` : id;
      };
      switch (entry.kind) {
        case 'text':
          return entry.text_md;
        case 'open':
          return [
            entry.text_md,
            ...entry.evidence.map((evidence) => `${evidence.kind}: ${evidence.asset.asset_id}`),
          ]
            .filter(Boolean)
            .join('\n');
        case 'numeric':
          return entry.raw_input ?? entry.value?.toString() ?? '';
        case 'formula':
          return entry.latex;
        case 'choice':
          return entry.option_ids.map(optionText).join('\n');
        case 'matching':
          return entry.pairs
            .map((pair) => `${itemText(pair.item_id)} → ${optionText(pair.option_id)}`)
            .join('\n');
        case 'ordering':
          return entry.item_order.map(itemText).join('\n');
        default: {
          const unreachable: never = entry;
          return unreachable;
        }
      }
    })
    .join('\n\n');
}

export interface NativeCsvAttempt {
  id: string;
  createdAt: Date;
  questionId: string;
  groupId: string;
  prompt: string;
  reference: string;
  response: string;
  knowledgeIds: string[];
  difficulty: number | null;
  originalOutcome: ReturnType<typeof nativeAttemptOutcome>;
  effectiveOutcome: ReturnType<typeof nativeAttemptOutcome>;
}

/** All group members are validated before projection; invalid members must not
 * shrink the scoring denominator. No database writes or live question fallback. */
export function projectNativeCsv(
  tables: Record<string, Row[]>,
  activeEventIds: ReadonlySet<string>,
) {
  const events = parsedRows(tables.event, EventRow);
  const submissions = parsedRows(tables.assessment_submission, SubmissionRow);
  const revisions = parsedRows(tables.question_revision, RevisionRow);
  const issuances = parsedRows(tables.assessment_issuance, IssuanceRow);
  const evaluations = parsedRows(tables.evaluation, EvaluationRow);
  const heads = parsedRows(tables.evaluation_effective_head, HeadRow);
  const groupRows = new Map(
    parsedRows(tables.evaluation_group, GroupRow).map((row) => [row.evaluation_group_id, row]),
  );
  const invalidGroups = new Set<string>();
  const validEvaluationIds = new Set(evaluations.map((row) => row.evaluation_id));
  for (const raw of tables.evaluation ?? [])
    if (
      !validEvaluationIds.has(String(raw.evaluation_id)) &&
      typeof raw.evaluation_group_id === 'string'
    )
      invalidGroups.add(raw.evaluation_group_id);
  for (const sub of submissions) {
    const declared = groupRows.get(sub.evaluation_group_id);
    const actual = submissions
      .filter((row) => row.evaluation_group_id === sub.evaluation_group_id)
      .map((row) => row.submission_id);
    if (!declared || !sameMemberSet(declared.submission_ids, actual))
      invalidGroups.add(sub.evaluation_group_id);
  }
  const validHeadGroups = new Set(heads.map((row) => row.evaluation_group_id));
  for (const raw of tables.evaluation_effective_head ?? [])
    if (
      typeof raw.evaluation_group_id === 'string' &&
      !validHeadGroups.has(raw.evaluation_group_id)
    )
      invalidGroups.add(raw.evaluation_group_id);
  const validSubmissionIds = new Set(submissions.map((row) => row.submission_id));
  for (const raw of tables.assessment_submission ?? [])
    if (
      !validSubmissionIds.has(String(raw.submission_id)) &&
      typeof raw.evaluation_group_id === 'string'
    )
      invalidGroups.add(raw.evaluation_group_id);
  const subById = new Map(submissions.map((row) => [row.submission_id, row]));
  const revById = new Map(revisions.map((row) => [row.revision_id, row]));
  const issById = new Map(issuances.map((row) => [row.issuance_id, row]));
  const evalById = new Map(evaluations.map((row) => [row.evaluation_id, row]));
  const sessions = new Map(
    parsedRows(tables.learning_session, SessionRow).map((row) => [row.id, row]),
  );
  const scopes = new Map<string, z.infer<typeof LearningScope>>();
  for (const event of events) {
    if (
      event.action !== 'experimental:assessment_submission' ||
      event.subject_kind !== 'submission'
    )
      continue;
    const parsed = LearningScope.safeParse(event.payload.learning_scope);
    if (parsed.success) scopes.set(event.subject_id, parsed.data);
  }
  const contextByIssuance = new Map<string, FrozenContext>();
  for (const sub of submissions) {
    const issuance = issById.get(sub.issuance_id);
    const revision = revById.get(sub.revision_id);
    if (!issuance || !revision || issuance.revision_id !== sub.revision_id) {
      invalidGroups.add(sub.evaluation_group_id);
      continue;
    }
    try {
      const context = frozenContext(revision, issuance);
      if (!context) invalidGroups.add(sub.evaluation_group_id);
      contextByIssuance.set(issuance.issuance_id, context);
    } catch {
      invalidGroups.add(sub.evaluation_group_id);
    }
  }
  for (const head of heads) {
    const sub = subById.get(head.submission_id);
    const selected = head.effective_evaluation_id
      ? evalById.get(head.effective_evaluation_id)
      : null;
    if (
      !sub ||
      sub.evaluation_group_id !== head.evaluation_group_id ||
      (head.effective_evaluation_id &&
        (!selected ||
          selected.submission_id !== head.submission_id ||
          selected.evaluation_group_id !== head.evaluation_group_id))
    )
      invalidGroups.add(head.evaluation_group_id);
  }
  const input = {
    groupIds: [...new Set(submissions.map((row) => row.evaluation_group_id))],
    heads,
    evaluations,
    submissions,
    revisions,
    issuances,
    activeActivations: [],
    settlements: [],
  } satisfies Parameters<typeof projectGroupVerdicts>[0];
  const groups = projectGroupVerdicts(input);
  for (const [id, group] of groups)
    if (group.effective && !group.effective.scoring_basis) invalidGroups.add(id);
  const originalOutcomes = new Map<string, ReturnType<typeof nativeAttemptOutcome>>();
  const attempts: NativeCsvAttempt[] = [];
  const hiddenGroups = new Set(invalidGroups);
  const anchors = events.filter(
    (event) =>
      event.action === 'experimental:assessment_attempt' && event.subject_kind === 'question',
  );
  for (const anchor of anchors) {
    const payload = AnchorPayload.safeParse(anchor.payload);
    if (!payload.success) {
      if (typeof anchor.payload.evaluation_group_id === 'string')
        hiddenGroups.add(anchor.payload.evaluation_group_id);
      continue;
    }
    const p = payload.data;
    const sub = subById.get(p.submission_id);
    const revision = revById.get(p.revision_id);
    const issuance = issById.get(p.issuance_id);
    const context = contextByIssuance.get(p.issuance_id);
    const session = anchor.session_id ? sessions.get(anchor.session_id) : null;
    if (
      !activeEventIds.has(anchor.id) ||
      !sub ||
      !revision ||
      !issuance ||
      !context ||
      sub.evaluation_group_id !== p.evaluation_group_id ||
      sub.issuance_id !== p.issuance_id ||
      sub.revision_id !== p.revision_id ||
      (anchor.subject_id !== revision.group_id && !issuance.part_ids.includes(anchor.subject_id)) ||
      (p.paper_feedback_policy === 'judge_now_show_later' &&
        (session?.status !== 'completed' ||
          session.started_at.toISOString() !== p.paper_started_at))
    ) {
      hiddenGroups.add(p.evaluation_group_id);
      continue;
    }
    const original =
      p.original_evaluation_id !== null
        ? evalById.get(p.original_evaluation_id)
        : evaluations
            .filter(
              (row) =>
                row.submission_id === sub.submission_id &&
                row.evaluation_group_id === sub.evaluation_group_id,
            )
            .sort(
              (a, b) =>
                a.attempt - b.attempt ||
                a.created_at.getTime() - b.created_at.getTime() ||
                a.evaluation_id.localeCompare(b.evaluation_id),
            )[0];
    if (
      p.original_evaluation_id !== null &&
      (!original ||
        original.submission_id !== sub.submission_id ||
        original.evaluation_group_id !== sub.evaluation_group_id)
    ) {
      hiddenGroups.add(p.evaluation_group_id);
      continue;
    }
    let originalOutcome: ReturnType<typeof nativeAttemptOutcome> = 'pending';
    if (original) {
      const cached = originalOutcomes.get(original.evaluation_id);
      if (cached) originalOutcome = cached;
      else {
        const projected = projectGroupVerdicts({
          groupIds: [sub.evaluation_group_id],
          evaluations: [original],
          submissions: submissions.filter(
            (member) => member.evaluation_group_id === sub.evaluation_group_id,
          ),
          revisions: [revision],
          issuances,
          activeActivations: [],
          settlements: [],
          heads: [
            {
              evaluation_group_id: original.evaluation_group_id,
              submission_id: original.submission_id,
              effective_evaluation_id: original.evaluation_id,
              generation: 0,
              updated_at: original.created_at,
            },
          ],
        });
        originalOutcome = nativeAttemptOutcome(projected.get(sub.evaluation_group_id));
        originalOutcomes.set(original.evaluation_id, originalOutcome);
      }
    }
    const scope = scopes.get(sub.submission_id);
    const frozenQuestions =
      scope?.group_id === revision.group_id
        ? scope.questions.filter(
            (q) =>
              q.id === anchor.subject_id ||
              (anchor.subject_id === revision.group_id && issuance.part_ids.includes(q.id)),
          )
        : [];
    attempts.push({
      id: anchor.id,
      createdAt: anchor.created_at,
      questionId: anchor.subject_id,
      groupId: sub.evaluation_group_id,
      prompt: context.prompt,
      reference: context.reference,
      response: p.response_md ?? frozenResponse(sub, context),
      knowledgeIds: [...new Set(frozenQuestions.flatMap((q) => q.knowledge_ids))],
      difficulty: frozenQuestions.length === 1 ? frozenQuestions[0].difficulty : null,
      originalOutcome,
      effectiveOutcome: nativeAttemptOutcome(groups.get(sub.evaluation_group_id)),
    });
  }
  const settlements = events.filter(
    (event) => event.action === 'experimental:assessment_settlement',
  );
  for (const settlement of settlements)
    if (
      settlement.payload.effect === 'withdrawn' &&
      typeof settlement.payload.evaluation_group_id === 'string'
    )
      hiddenGroups.add(settlement.payload.evaluation_group_id);
  const visible = attempts.filter((attempt) => !hiddenGroups.has(attempt.groupId));
  const reviewGroups = new Map<
    string,
    { questionIds: string[]; outcome: NativeReviewOccurrence['outcome'] }
  >();
  for (const attempt of visible) {
    const group = reviewGroups.get(attempt.groupId) ?? {
      questionIds: [],
      outcome: attempt.effectiveOutcome,
    };
    if (!group.questionIds.includes(attempt.questionId)) group.questionIds.push(attempt.questionId);
    reviewGroups.set(attempt.groupId, group);
  }
  const reviews = projectNativeReviewOccurrences(settlements, reviewGroups).map((occurrence) => {
    const members = visible.filter((attempt) => attempt.groupId === occurrence.groupId);
    const snapshot = events.find(
      (event) =>
        event.id === `${occurrence.settlementId}:snapshot:fsrs` &&
        event.action === 'experimental:state_snapshot' &&
        event.subject_kind === 'event' &&
        event.subject_id === occurrence.settlementId &&
        event.caused_by_event_id === `${occurrence.settlementId}:checkpoint:fsrs` &&
        event.payload.attempt_event_id === occurrence.settlementId,
    );
    const parsed = StateSnapshotExperimental.shape.payload.safeParse(snapshot?.payload);
    const cards = parsed.success ? parsed.data.fsrs_snapshots : [];
    const card =
      occurrence.fsrsSubjects.length === 1 &&
      cards.length === 1 &&
      `${cards[0].subject_kind}:${cards[0].subject_id}` === occurrence.fsrsSubjects[0]
        ? cards[0]
        : null;
    return {
      ...occurrence,
      prompt: [...new Set(members.map((member) => member.prompt))].join('\n\n'),
      knowledgeIds: [...new Set(members.flatMap((member) => member.knowledgeIds))],
      before: card?.before ?? null,
      after: card?.after ?? null,
    };
  });
  return { attempts: visible, reviews };
}
