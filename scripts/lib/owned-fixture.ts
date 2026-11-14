// Canonical practice fixture for the owned runtime: ONE reusable helper that
// drives the real ingestion → publication → issuance path. It never fabricates
// admission state, seals, digests or mastery — the returned `integrity_digest`
// is the value actually stored on `question_revision` after the publish
// transaction committed (the classifier runs inside `publishQuestionGroup`
// before that write, so the stored seal already reflects choice-order
// classification). Callers supply the small synthetic question/contract inputs;
// this helper owns only the upstream provenance plumbing every prior bespoke
// fixture re-implemented.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ImportBody } from '@/capabilities/ingestion/api/import-schema';
import { completeIngestionImport } from '@/capabilities/ingestion/server/import-completion';
import { insertIngestionSourceDocument } from '@/capabilities/ingestion/server/session/source-document-provenance';
import { installPracticeHost } from '@/capabilities/practice/public';
import { defaultPresentation } from '@/core/schema/assessment/presentation';
import { QuestionDraftDocument } from '@/core/schema/question-draft';
import type { Db } from '@/db/client';
import {
  learning_session,
  question_block,
  question_group_lifecycle,
  question_revision,
  source_asset,
} from '@/db/schema';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import {
  type PublishQuestionGroupInput,
  publishQuestionGroup,
} from '@/kernel/records/assessment-publication';
import {
  createKnowledgeNodeFromEvents,
  ensureSubjectRoot,
} from '@/kernel/records/knowledge-node-birth';
import { draftDocumentToContract } from '@/kernel/records/question-draft-contract';
import {
  readContractEpoch,
  transitionContractEpoch,
} from '@/server/migration/contract-epoch/epoch';
import { CODE_CONTRACT_EPOCH } from '@/server/migration/contract-epoch/rules';

const MANUAL_ADMISSION = {
  state: 'admitted' as const,
  evidence: {
    marking_provenance: 'manual' as const,
    verification: { structural_check_passed: true, independent_verification: null },
    model_slice: null,
  },
};

export interface CanonicalFixtureInput {
  /** Unique suffix for every generated id — keeps repeated fixtures distinct. */
  tag: string;
  /** Select items in declaration order. `key` names the accepted stable ids. */
  items: Array<{ id: string; label: string }>;
  key: string[];
  /** Optional pre-computed asset bytes; a deterministic default otherwise. */
  assetBytes?: Uint8Array;
  promptMd?: string;
  difficulty?: number;
}

export interface CanonicalFixtureResult {
  questionId: string;
  kcId: string;
  sessionId: string;
  blockId: string;
  revisionId: string;
  /** Actual stored digest read back from question_revision — not recomputed. */
  storedIntegrityDigest: string;
  /** Slot 0 choice_order as classified + stored on the revision. */
  choiceOrder: string | null;
  correctStableIds: string[];
}

export interface IssuedOccurrence {
  issuanceId: string;
  revisionId: string;
  optionOrder: unknown;
  containerRef: unknown;
  practiceDto: unknown;
  status: string;
}

export type FixtureDb = Db;

async function activateEpochIfNeeded(db: FixtureDb): Promise<void> {
  const epoch = await readContractEpoch(db);
  if (epoch?.epoch !== CODE_CONTRACT_EPOCH || epoch?.state !== 'active') {
    for (const kind of ['begin_prepare', 'mark_ready', 'activate'] as const) {
      await transitionContractEpoch(db, kind, CODE_CONTRACT_EPOCH, 'owned-practice-fixture');
    }
  }
}

let hostInstalled = false;
async function ensurePracticeHost(): Promise<void> {
  if (!hostInstalled) {
    await installPracticeHost();
    hostInstalled = true;
  }
}

async function seedProvenance(
  db: FixtureDb,
  tag: string,
  assetBytes: Uint8Array,
  promptMd: string,
  difficulty: number,
  kcId: string,
): Promise<{
  sessionId: string;
  blockId: string;
  importBody: ReturnType<typeof ImportBody.parse>;
}> {
  const assetId = `asset_${tag}`;
  const docId = `doc_${tag}`;
  const sessionId = `ing_${tag}`;
  const blockId = `block_${tag}`;
  const sha = createHash('sha256').update(assetBytes).digest('hex');
  const now = new Date();
  await db.insert(source_asset).values({
    id: assetId,
    kind: 'image',
    storage_key: `owned/${tag}/page-1.png`,
    mime_type: 'image/png',
    byte_size: assetBytes.length,
    sha256: sha,
    created_at: now,
  });
  await db.transaction((tx) =>
    insertIngestionSourceDocument(tx, docId, {
      sourceAssetIds: [assetId],
      entrypoint: 'vision_single',
      derivationPolicy: 'allow',
      now,
    }),
  );
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: docId,
    source_asset_ids: [assetId],
    status: 'extracted',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.transaction(async (tx) => {
    const { rootId } = await ensureSubjectRoot(tx, 'math', '数学');
    const created = await createKnowledgeNodeFromEvents(
      tx,
      {
        id: kcId,
        name: `Owned KC ${tag}`,
        domain: 'math',
        parent_id: rootId,
        proposed_by_ai: false,
        created_at: now,
      },
      { actorRef: 'owned-practice-fixture' },
    );
    assert.equal(created, true);
  });
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: docId,
    source_asset_ids: [assetId],
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
    ordinal: 0,
    extracted_prompt_md: promptMd,
    reference_md: 'B',
    structured: null,
    layout_quality: 'structured',
    wrong_answer_md: null,
    image_refs: [assetId],
    crop_refs: [],
    figures: [],
    visual_complexity: 'low',
    extraction_confidence: 0.9,
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const importBody = ImportBody.parse({
    blocks: [
      {
        block_id: blockId,
        source_block_ids: [blockId],
        page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
        image_refs: [assetId],
        final_prompt_md: promptMd,
        final_reference_md: 'B',
        final_wrong_answer_md: '',
        outcome: 'unanswered',
        knowledge_ids: [kcId],
        cause: null,
        difficulty,
        question_kind: 'choice',
      },
    ],
  });
  return { sessionId, blockId, importBody };
}

/**
 * Drive one synthetic choice group through the real manual import + publish +
 * epoch path and return the ids a workload needs to issue occurrences. The
 * caller remains free to issue as many real `issueAssessment` occurrences as
 * its scenario needs — this helper does not freeze issuance.
 */
export async function createCanonicalPracticeFixture(
  db: FixtureDb,
  input: CanonicalFixtureInput,
): Promise<CanonicalFixtureResult> {
  const { tag } = input;
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/.test(tag)) {
    throw new Error(`fixture tag "${tag}" is not a safe id suffix`);
  }
  const items = input.items;
  const key = input.key;
  if (items.length < 2) throw new Error('fixture needs at least two select items');
  for (const accepted of key) {
    if (!items.some((it) => it.id === accepted)) {
      throw new Error(`fixture key "${accepted}" is not a declared item`);
    }
  }
  const assetBytes =
    input.assetBytes ?? new Uint8Array(createHash('sha256').update(`owned-${tag}`).digest());
  const promptMd = input.promptMd ?? `Owned synthetic prompt ${tag}`;
  const difficulty = input.difficulty ?? 3;
  const kcId = `kc_${tag}`;

  await activateEpochIfNeeded(db);
  await ensurePracticeHost();
  const fx = await seedProvenance(db, tag, assetBytes, promptMd, difficulty, kcId);

  const imported = await completeIngestionImport(db, fx.sessionId, fx.importBody);
  assert.equal(imported.question_ids.length, 1);
  const questionId = imported.question_ids[0];

  const doc = QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      {
        part_id: 'p1',
        prompt_md: '选择正确的结果',
        material_ids: [],
        units: [
          {
            unit_id: 'u1',
            slot_id: 's1',
            response_class: 'select',
            response_spec: {
              kind: 'select',
              pick: 'one',
              items: items.map((it) => ({ item_id: it.id, label_md: it.label })),
            },
            key: { kind: 'select', accepted_item_ids: key },
            points: 1,
            rule: {
              version: 1,
              cases: [{ when: { wrong: { eq: 0 }, miss: { eq: 0 } }, award: { points: 1 } }],
              otherwise: { points: 0 },
            },
            method: { kind: 'set-compare' },
            material_refs: [],
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: [kcId],
    source: { kind: 'manual' },
    metadata: {},
  });
  const draft = draftDocumentToContract(doc, questionId);
  assert.deepEqual(draft.conversion_issues, []);
  const contract: PublishQuestionGroupInput['contract'] = {
    structure: draft.structure,
    response_spec: draft.response_spec,
    scoring_basis: draft.scoring_basis,
    execution_plan: draft.execution_plan,
    presentation:
      defaultPresentation(draft.structure, draft.response_spec, draft.scoring_basis) ?? undefined,
    integrity_digest: '',
  };
  contract.integrity_digest = contractIntegrityDigest(contract);

  const lifecycle = (
    await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, questionId))
  )[0];
  const published = await publishQuestionGroup(db, {
    group_id: questionId,
    contract,
    expectedCurrentRevision: lifecycle.current_revision_id,
    expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
    availability: 'general_pool',
    admission: MANUAL_ADMISSION,
    actorRef: 'owned-practice-fixture',
    sessionId: fx.sessionId,
    now: new Date(),
  });
  assert.equal(published.status, 'published', JSON.stringify(published));

  const after = (
    await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, questionId))
  )[0];
  const revision = (
    await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, after.current_revision_id as string))
  )[0];
  const slot = (revision.response_spec as { slots?: Array<{ choice_order?: string }> } | null)
    ?.slots?.[0];
  return {
    questionId,
    kcId,
    sessionId: fx.sessionId,
    blockId: fx.blockId,
    revisionId: revision.revision_id,
    storedIntegrityDigest: revision.integrity_digest,
    choiceOrder: slot?.choice_order ?? null,
    correctStableIds: key,
  };
}

/** Issue one real ordinary occurrence; the caller owns settlement submission. */
export async function issueFixtureOccurrence(
  db: FixtureDb,
  questionId: string,
  extra: { issuanceId?: string; now?: Date } = {},
): Promise<IssuedOccurrence> {
  const issued = await issueAssessment(db, {
    group_id: questionId,
    issuance_id: extra.issuanceId,
    now: extra.now,
  });
  if (issued.status !== 'issued' && issued.status !== 'replayed') {
    const detail = 'issues' in issued ? issued.issues : issued;
    throw new Error(`issuance failed (${issued.status}): ${JSON.stringify(detail)}`);
  }
  const binding = issued.issuance.binding as Record<string, unknown>;
  return {
    issuanceId: issued.issuance.issuance_id,
    revisionId: binding.revision_id as string,
    optionOrder: binding.option_order,
    containerRef: binding.container_occurrence_ref,
    practiceDto: issued.practice_dto,
    status: issued.status,
  };
}

/** Random-uuid-backed submission idempotency key, matching prior workloads. */
export function fixtureIdempotencyKey(): string {
  return `key_${randomUUID()}`;
}
