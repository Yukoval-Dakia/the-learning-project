import { eq, inArray } from 'drizzle-orm';
import type { MistakeProjection } from '@/capabilities/ingestion/public';
import type { FailureAttempt } from '@/capabilities/knowledge/public';
import {
  AssessmentIssuance,
  EvaluationContractError,
  EvaluationInputSnapshot,
  type EvidenceAttachmentT,
  GroupEvidence,
  type PublicMaterialViewT,
  PublishedQuestionRevision,
  ResponseSet,
  type ResponseSlotT,
  type ScoringUnitT,
  type SharedMaterialT,
  type SlotResponseT,
  isBlankSlotResponse,
  projectIssuedScoringBasis,
  projectPracticeIssuance,
  validateIssuanceBinding,
  validateResponseSet,
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  question_revision,
  source_asset,
} from '@/db/schema';
import { issuanceRowToContract, revisionRowToContract } from '@/kernel/records/assessment-issuance';

type NativeMistakeEvidence = Pick<
  MistakeProjection,
  'prompt_md' | 'prompt_materials' | 'reference_md' | 'wrong_answer_md' | 'wrong_answer_image_refs'
>;

const unavailable = (): NativeMistakeEvidence => ({
  prompt_md: '',
  prompt_materials: [],
  reference_md: null,
  wrong_answer_md: '',
  wrong_answer_image_refs: [],
});

function materialAssetMatches(
  kind: PublicMaterialViewT['kind'],
  asset: typeof source_asset.$inferSelect,
) {
  if (asset.byte_size <= 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) return false;
  switch (kind) {
    case 'figure':
      return (
        asset.kind === 'image' &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime_type)
      );
    case 'audio':
      return asset.kind === 'audio' && /^audio\/[a-z0-9.+-]+$/.test(asset.mime_type);
    case 'video':
      return asset.kind === 'video' && /^video\/[a-z0-9.+-]+$/.test(asset.mime_type);
    case 'pdf':
      return asset.kind === 'pdf' && asset.mime_type === 'application/pdf';
    case 'passage':
    case 'table':
    case 'plaintext':
      return (
        asset.kind === 'plaintext' && ['text/plain', 'text/markdown'].includes(asset.mime_type)
      );
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function optionText(option: { label: string; text: string; option_id: string }): string {
  return `${option.label} [${option.option_id}] ${option.text}`;
}

function itemText(item: { label: string; text: string; item_id: string }): string {
  return `${item.label} [${item.item_id}] ${item.text}`;
}

function slotFace(slot: ResponseSlotT): string {
  switch (slot.kind) {
    case 'single_choice':
    case 'multi_choice':
      return slot.options.map(optionText).join('\n');
    case 'matching':
      return [
        slot.left_items.map(itemText).join('\n'),
        slot.right_options.map(optionText).join('\n'),
      ].join('\n');
    case 'ordering':
      return slot.items.map(itemText).join('\n');
    case 'table':
      return [
        slot.column_headers.join(' | '),
        ...slot.cells.map(
          (cell) =>
            `${slot.row_labels[cell.row]} / ${slot.column_headers[cell.col]} [${cell.slot_id}]`,
        ),
      ].join('\n');
    case 'numeric':
      return slot.unit_hint ?? '';
    case 'text':
    case 'formula':
    case 'open_response':
      return '';
    default: {
      const exhaustive: never = slot;
      return exhaustive;
    }
  }
}

function responseText(slot: ResponseSlotT, entry: SlotResponseT): string {
  if (isBlankSlotResponse(entry)) return '（空白作答）';
  switch (entry.kind) {
    case 'text':
      return entry.text_md;
    case 'open':
      return [
        entry.text_md,
        ...entry.evidence.map(
          (attachment) => `（附件 ${attachment.kind} [${attachment.evidence_id}]）`,
        ),
      ]
        .filter(Boolean)
        .join('\n');
    case 'numeric':
      return entry.raw_input?.trim()
        ? entry.raw_input
        : entry.value === null
          ? ''
          : String(entry.value);
    case 'formula':
      return `$${entry.latex}$`;
    case 'choice':
      return slot.kind === 'single_choice' || slot.kind === 'multi_choice'
        ? entry.option_ids
            .map((id) => slot.options.find((option) => option.option_id === id))
            .filter((option) => option !== undefined)
            .map(optionText)
            .join('；')
        : '';
    case 'matching':
      return slot.kind === 'matching'
        ? entry.pairs
            .map((pair) => {
              const item = slot.left_items.find((item) => item.item_id === pair.item_id);
              const option = slot.right_options.find(
                (option) => option.option_id === pair.option_id,
              );
              return item && option ? `${itemText(item)} → ${optionText(option)}` : '';
            })
            .join('；')
        : '';
    case 'ordering':
      return slot.kind === 'ordering'
        ? entry.item_order
            .map((id) => slot.items.find((item) => item.item_id === id))
            .filter((item) => item !== undefined)
            .map(itemText)
            .join(' → ')
        : '';
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/** Only the current page's immutable submissions are read. Missing or damaged evidence never uses live questions. */
export async function readNativeMistakeEvidence(db: Db | Tx, failures: readonly FailureAttempt[]) {
  const native = failures.filter((failure) => failure.assessment !== undefined);
  const result = new Map<string, NativeMistakeEvidence>();
  if (native.length === 0) return result;
  const ids = [
    ...new Set(
      native.flatMap((failure) => (failure.assessment ? [failure.assessment.submission_id] : [])),
    ),
  ];
  const rows = await db
    .select({
      submission: assessment_submission,
      issuance: assessment_issuance,
      revision: question_revision,
    })
    .from(assessment_submission)
    .leftJoin(
      assessment_issuance,
      eq(assessment_submission.issuance_id, assessment_issuance.issuance_id),
    )
    .leftJoin(
      question_revision,
      eq(assessment_submission.revision_id, question_revision.revision_id),
    )
    .where(inArray(assessment_submission.submission_id, ids));
  const byId = new Map(rows.map((row) => [row.submission.submission_id, row]));
  const evaluationIds = [
    ...new Set(
      native.flatMap((failure) =>
        failure.assessment?.effective_evaluation_id
          ? [failure.assessment.effective_evaluation_id]
          : [],
      ),
    ),
  ];
  const evaluations =
    evaluationIds.length > 0
      ? await db
          .select({
            evaluation_id: evaluation.evaluation_id,
            evaluation_group_id: evaluation.evaluation_group_id,
            provenance: evaluation.provenance,
          })
          .from(evaluation)
          .where(inArray(evaluation.evaluation_id, evaluationIds))
      : [];
  const evaluationById = new Map(evaluations.map((row) => [row.evaluation_id, row]));
  const imagesByAttempt = new Map<string, EvidenceAttachmentT[]>();
  const materialsByAttempt = new Map<
    string,
    { view: PublicMaterialViewT; asset: SharedMaterialT['asset'] }[]
  >();

  for (const failure of native) {
    const evidence = unavailable();
    result.set(failure.attempt_event_id, evidence);
    const ref = failure.assessment;
    const row = ref && byId.get(ref.submission_id);
    if (
      !ref ||
      !row?.issuance ||
      !row.revision ||
      row.submission.revision_id !== ref.revision_id ||
      row.submission.evaluation_group_id !== ref.evaluation_group_id
    )
      continue;
    const parsedRevision = PublishedQuestionRevision.safeParse(revisionRowToContract(row.revision));
    const parsedIssuance = AssessmentIssuance.safeParse(issuanceRowToContract(row.issuance));
    if (!parsedRevision.success || !parsedIssuance.success) continue;
    const revision = parsedRevision.data;
    const issuance = parsedIssuance.data;
    if (
      revision.group_id !== revision.structure.group_id ||
      validateStructure(revision.structure).length > 0 ||
      validateResponseSpec(revision.response_spec, revision.structure).length > 0 ||
      validateScoringBasis(revision.scoring_basis, revision.response_spec, revision.structure)
        .length > 0 ||
      validateIssuanceBinding(issuance.binding, revision).length > 0
    )
      continue;
    const dto = projectPracticeIssuance(revision, issuance);
    const faces =
      failure.question_id === revision.group_id
        ? dto.faces
        : dto.faces.filter((face) => face.part_id === failure.question_id);
    if (faces.length === 0) continue;
    const parts = new Set(faces.map((face) => face.part_id));
    const slots = dto.response_spec.slots.filter((slot) => parts.has(slot.part_id));
    const materialIds = new Set(faces.flatMap((face) => face.material_ids));
    const selectedMaterials = dto.materials.filter((material) =>
      materialIds.has(material.material_id),
    );
    materialsByAttempt.set(
      failure.attempt_event_id,
      selectedMaterials.flatMap((view) => {
        const frozen = revision.structure.materials.find(
          (material) => material.material_id === view.material_id,
        );
        return frozen ? [{ view, asset: frozen.asset }] : [];
      }),
    );
    const multipleParts = revision.structure.parts.length > 1;
    evidence.prompt_md = [
      ...selectedMaterials.map(
        (material) =>
          material.content_md ?? [material.caption, material.alt_text].filter(Boolean).join('\n'),
      ),
      ...faces.map((face) =>
        [
          multipleParts ? `${face.question_no ?? ''} [${face.part_id}]` : '',
          face.prompt_md,
          ...slots.filter((slot) => slot.part_id === face.part_id).map(slotFace),
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 200);
    // No persisted FeedbackVisibilityPolicy is available here. Private scoring content stays private.
    const parsedResponses = ResponseSet.safeParse(row.submission.response_set);
    const responses = parsedResponses.success ? parsedResponses.data : { entries: [] };
    const answerable = slots.filter((slot) => slot.kind !== 'table');
    const images: EvidenceAttachmentT[] = [];
    evidence.wrong_answer_md = !parsedResponses.success
      ? '（作答证据损坏）'
      : answerable
          .map((slot) => {
            const entries = responses.entries.filter((entry) => entry.slot_id === slot.slot_id);
            const entry = entries[0];
            const prefix =
              multipleParts || answerable.length > 1 ? `[${slot.part_id}/${slot.slot_id}] ` : '';
            if (!entry) return `${prefix}（未记录作答）`;
            if (
              entries.length !== 1 ||
              validateResponseSet({ slots: [slot] }, { entries: [entry] }).length > 0
            )
              return `${prefix}（作答证据损坏）`;
            if (entry.kind === 'open') images.push(...entry.evidence);
            return `${prefix}${responseText(slot, entry)}`;
          })
          .join('\n')
          .slice(0, 200);
    // FailureAttempt's resolver has verified this effective evaluation against freezeEvaluationInput.
    // Its snapshot supplies joint scope only; responses and attachments remain this submission's.
    const effective = ref.effective_evaluation_id
      ? evaluationById.get(ref.effective_evaluation_id)
      : undefined;
    const parsedInput = EvaluationInputSnapshot.safeParse(effective?.provenance?.input_snapshot);
    const issuedPartIds =
      effective?.evaluation_group_id === ref.evaluation_group_id &&
      parsedInput.success &&
      parsedInput.data.revision_id === revision.revision_id &&
      parsedInput.data.member_submission_ids.includes(ref.submission_id) &&
      issuance.binding.part_ids.every((id) => parsedInput.data.issued_part_ids.includes(id))
        ? parsedInput.data.issued_part_ids
        : issuance.binding.part_ids;
    // Group-only units belong to the frozen group scope, without an invented part or slot.
    const anchorSlotIds = new Set(answerable.map((slot) => slot.slot_id));
    let issuedUnits: ScoringUnitT[] = [];
    try {
      issuedUnits = projectIssuedScoringBasis(revision, issuedPartIds).units;
    } catch (error) {
      if (!(error instanceof EvaluationContractError)) throw error;
    }
    const anchorUnits = new Set(
      issuedUnits
        .filter((unit) => {
          const refs = [...unit.slot_refs, ...unit.evidence_slot_refs];
          return (
            refs.some((id) => anchorSlotIds.has(id)) ||
            (refs.length === 0 && unit.requires_group_evidence)
          );
        })
        .map((unit) => unit.scoring_unit_id),
    );
    const knownUnits = new Set(revision.scoring_basis.units.map((unit) => unit.scoring_unit_id));
    for (const raw of Array.isArray(row.submission.group_evidence)
      ? row.submission.group_evidence
      : []) {
      const parsed = GroupEvidence.safeParse(raw);
      if (!parsed.success) continue;
      const group = parsed.data;
      if (
        group.target.scope === 'all_units'
          ? anchorUnits.size > 0
          : group.target.scoring_unit_ids.every((id) => knownUnits.has(id)) &&
            group.target.scoring_unit_ids.some((id) => anchorUnits.has(id))
      )
        images.push(group.evidence);
    }
    imagesByAttempt.set(
      failure.attempt_event_id,
      images.filter((image) => image.kind === 'image'),
    );
  }

  const assetIds = [
    ...new Set(
      [...imagesByAttempt.values()]
        .flatMap((images) => images.map((image) => image.asset.asset_id))
        .concat(
          [...materialsByAttempt.values()].flatMap((materials) =>
            materials.map(({ asset }) => asset.asset_id),
          ),
        ),
    ),
  ];
  const assets =
    assetIds.length > 0
      ? await db.select().from(source_asset).where(inArray(source_asset.id, assetIds))
      : [];
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const [attemptId, materials] of materialsByAttempt) {
    const evidence = result.get(attemptId);
    if (!evidence) continue;
    evidence.prompt_materials = materials.map(({ view, asset: frozenAsset }) => {
      const { asset_id, ...text } = view;
      if (
        (text.kind === 'passage' || text.kind === 'table' || text.kind === 'plaintext') &&
        text.content_md !== undefined
      ) {
        return { ...text, kind: text.kind, content_md: text.content_md, availability: 'inline' };
      }
      const asset = assetsById.get(asset_id);
      if (!asset) return { ...text, availability: 'missing' };
      if (
        !materialAssetMatches(view.kind, asset) ||
        frozenAsset.digest !== `sha256:${asset.sha256}`
      )
        return { ...text, availability: 'unavailable' };
      return { ...view, availability: 'available' };
    });
  }
  for (const [attemptId, images] of imagesByAttempt) {
    const evidence = result.get(attemptId);
    if (!evidence) continue;
    evidence.wrong_answer_image_refs = [
      ...new Set(
        images
          .filter((image) => {
            const asset = assetsById.get(image.asset.asset_id);
            return (
              asset?.kind === 'image' &&
              ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime_type) &&
              image.mime_type === asset.mime_type &&
              /^[0-9a-f]{64}$/.test(asset.sha256) &&
              image.asset.digest === `sha256:${asset.sha256}` &&
              image.bytes === asset.byte_size &&
              image.uploaded_at === asset.created_at.toISOString()
            );
          })
          .map((image) => image.asset.asset_id),
      ),
    ];
  }
  return result;
}
