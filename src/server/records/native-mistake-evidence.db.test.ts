import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistakeListResponseSchema } from '@/capabilities/ingestion/api/contracts';
import { GET } from '@/capabilities/ingestion/api/mistakes';
import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import { readMistakes } from '@/capabilities/ingestion/public';
import {
  commitFormalAttempt,
  recordFormalAttemptCapture,
} from '@/capabilities/practice/server/assessment/attempt';
import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import { saveSubmission } from '@/capabilities/practice/server/assessment/submit';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import type {
  GroupEvidenceT,
  ModelExecutorRequest,
  ModelUnitOutcomeT,
  ResponseSlotT,
  ScoringBasisT,
  SharedMaterialT,
  SlotResponseT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  knowledge,
  learning_record,
  question,
  question_revision,
  source_asset,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { buildHonoApp } from '../../../server/app';
import { correctPaperFixture } from '../../../tests/fixtures/assessment-paper';
import { handwritingFixture } from '../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { readNativeMistakeEvidence } from './native-mistake-evidence';

const OPEN: ResponseSlotT = {
  slot_id: 's1',
  part_id: 'p1',
  kind: 'open_response',
  accepted_evidence: [
    {
      kind: 'image',
      allowed_mime_patterns: ['image/png'],
      max_bytes: 10000,
      requires_security_scan: false,
    },
    {
      kind: 'audio',
      allowed_mime_patterns: ['audio/wav'],
      max_bytes: 10000,
      requires_security_scan: false,
    },
  ],
  evidence_required: false,
};
const TEXT: ResponseSlotT = { slot_id: 's2', part_id: 'p2', kind: 'text', math_preview: false };
const OPEN_ENTRY: SlotResponseT = {
  slot_id: 's1',
  kind: 'open',
  text_md: '原答一：列式与单位',
  evidence: [],
};
const TEXT_ENTRY: SlotResponseT = { slot_id: 's2', kind: 'text', text_md: '原答二：另一部分' };
const GROUP_UNIT = {
  scoring_unit_id: 'u_group',
  slot_refs: [],
  evidence_slot_refs: [],
  material_refs: ['private'],
  requires_group_evidence: true,
  points: 1,
  criterion: {
    kind: 'rule_reference',
    rule_id: 'group_rule',
    source: 'official',
    statement_md: 'PRIVATE_GROUP_RULE',
  },
} satisfies ScoringBasisT['units'][number];

const stem = '冻结父材料：船的速度，含长段落、换行与数学 $v+c=18$。';

async function publication(
  db: Db,
  slots: ResponseSlotT[] = [OPEN, TEXT],
  materials: SharedMaterialT[] = [],
  scoringBasis?: (basis: ScoringBasisT) => ScoringBasisT,
  materialParts?: Readonly<Record<string, readonly string[]>>,
) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id: 'kc', name: '速度', domain: 'math', created_at: now, updated_at: now });
  await db.insert(question).values([
    {
      id: 'root',
      kind: 'group',
      source: 'manual',
      prompt_md: stem,
      reference_md: 'PRIVATE_PARENT_RUBRIC',
      knowledge_ids: ['kc'],
      created_at: now,
      updated_at: now,
    },
    ...['p1', 'p2', 'p3'].map((id) => ({
      id,
      parent_question_id: 'root',
      kind: 'short_answer',
      source: 'manual',
      prompt_md: `冻结子题${id}`,
      reference_md: `PRIVATE_${id}_RUBRIC`,
      knowledge_ids: ['kc'],
      created_at: now,
      updated_at: now,
    })),
  ]);
  const rows = await db.select().from(question);
  const root = rows.find((row) => row.id === 'root');
  if (!root) throw new Error('root missing');
  const contract = normalizeQuestionGroupToContract(
    root,
    rows.filter((row) => row.parent_question_id === 'root'),
  );
  contract.structure.materials.push(...materials);
  for (const part of contract.structure.parts) {
    part.material_ids.push(
      ...(materialParts?.[part.part_id] ??
        (materialParts === undefined && part.part_id === 'p1'
          ? materials.map((material) => material.material_id)
          : [])),
    );
  }
  contract.structure.materials.push({
    material_id: 'private',
    kind: 'plaintext',
    asset: { asset_id: 'rub_123456789abc', digest: 'frozen-private' },
    visibility: 'public',
    content_md: 'SECRET_REFERENCE',
  });
  for (const part of contract.structure.parts) part.material_ids.push('private');
  contract.response_spec.slots = [
    ...slots,
    { slot_id: 's3', part_id: 'p3', kind: 'text', math_preview: false },
  ];
  contract.scoring_basis = {
    units: contract.response_spec.slots
      .filter((slot) => slot.kind !== 'table')
      .map((slot) => ({
        scoring_unit_id: `u_${slot.slot_id}`,
        slot_refs: [slot.slot_id],
        evidence_slot_refs: slot.kind === 'open_response' ? [slot.slot_id] : [],
        material_refs: ['private'],
        requires_group_evidence: false,
        points: 1,
        criterion: {
          kind: 'rule_reference',
          rule_id: `rule_${slot.slot_id}`,
          source: 'official',
          statement_md: 'PRIVATE_SCORING_BASIS',
        },
      })),
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  };
  if (scoringBasis) contract.scoring_basis = scoringBasis(contract.scoring_basis);
  contract.execution_plan.assignments = contract.scoring_basis.units.map((unit) => ({
    scoring_unit_ids: [unit.scoring_unit_id],
    executor: {
      kind: 'model_executor',
      task_kind: 'AssessmentRuleJudgeTask',
      admitted_slice_id: 'offline-paper-fixture-slice',
      max_cost_usd_micros: 1000,
    },
  }));
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(db, {
    group_id: 'root',
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:mistake-native',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: {
          slice_id: 'offline-paper-fixture-slice',
          holdout_cases: 35,
          severe_errors_observed: 0,
          per_criterion_agreement: 1,
          pipeline_coverage: 1,
        },
      },
    },
  });
  expect(published.status).toBe('published');
  const execute = vi.fn(
    async (
      input: ModelExecutorRequest,
      _signal: AbortSignal | undefined,
      runId: string,
    ): Promise<ModelUnitOutcomeT> => ({
      kind: 'scored',
      points_awarded: 0,
      matched: {
        rule_id:
          input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : 'fixture',
        option_ids: [],
      },
      feedback_md: '按冻结材料离线检查',
      confidence: 0.95,
      evidence_citations: input.unit.slot_refs.length ? [{ slot_id: input.unit.slot_refs[0] }] : [],
      run_refs: [runId],
      cost_usd_micros: 120,
    }),
  );
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
    createRecordedModelExecutor(db, execute),
  );
  return { contract, execute };
}

async function record(db: Db, attemptId: string, questionId: string) {
  await db.insert(learning_record).values({
    id: `lr_${attemptId}`,
    kind: 'mistake',
    content_md: '保留原始作答',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'attempt',
    processing_status: 'raw',
    origin_event_id: attemptId,
    question_id: questionId,
    attempt_event_id: attemptId,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

async function attempt(
  db: Db,
  options: {
    anchor?: string;
    entries?: SlotResponseT[];
    images?: GroupEvidenceT[];
    partIds?: string[];
    order?: Record<string, string[]>;
    key?: string;
  } = {},
) {
  const anchor = options.anchor ?? 'root';
  const issued = await issueAssessment(db, {
    group_id: 'root',
    part_ids: options.partIds ?? ['p1', 'p2'],
    option_order_overrides: options.order,
  });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const committed = await commitFormalAttempt(db, 'solo_submit', anchor, {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: `eg_${options.key ?? 'one'}`,
    idempotency_key: `key_${options.key ?? 'one'}`,
    response_set: { entries: options.entries ?? [OPEN_ENTRY, TEXT_ENTRY] },
    group_evidence: options.images ?? [],
  });
  await record(db, committed.attempt_id, anchor);
  const failure = await getFailureAttemptById(db, committed.attempt_id);
  if (!failure?.assessment)
    throw new Error(
      `actual effective failure missing: ${JSON.stringify(committed.candidate.evaluation.record.unit_results)}`,
    );
  return { failure, issued, committed };
}

async function row(db: Db) {
  return (await readMistakes(db)).rows[0];
}

async function publicMaterialRead(db: Db) {
  vi.stubEnv('INTERNAL_TOKEN', 'synthetic-material-test-token');
  const app = buildHonoApp([ingestionCapability], { epochGate: async () => ({ runnable: true }) });
  const response = await app.request('/api/mistakes', {
    headers: { 'x-internal-token': 'synthetic-material-test-token' },
  });
  expect(response.status).toBe(200);
  const wire = MistakeListResponseSchema.parse(await response.json());
  expect(await readMistakes(db)).toEqual(wire);
  return wire.rows;
}

const materialKinds = [
  { kind: 'figure', assetKind: 'image', mime: 'image/png' },
  { kind: 'passage', assetKind: 'plaintext', mime: 'text/markdown' },
  { kind: 'table', assetKind: 'plaintext', mime: 'text/markdown' },
  { kind: 'audio', assetKind: 'audio', mime: 'audio/mpeg' },
  { kind: 'video', assetKind: 'video', mime: 'video/mp4' },
  { kind: 'pdf', assetKind: 'pdf', mime: 'application/pdf' },
  { kind: 'plaintext', assetKind: 'plaintext', mime: 'text/plain' },
] satisfies { kind: SharedMaterialT['kind']; assetKind: string; mime: string }[];

async function binaryMaterial(db: Db, fixture: (typeof materialKinds)[number]) {
  const bytes = Buffer.from(`synthetic frozen ${fixture.kind} bytes\n`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset_id = `source_${fixture.kind}`;
  await db.insert(source_asset).values({
    id: asset_id,
    kind: fixture.assetKind,
    storage_key: `PRIVATE_STORAGE/${asset_id}`,
    mime_type: fixture.mime,
    byte_size: bytes.length,
    sha256,
    provenance: { source: 'PRIVATE_PROVENANCE' },
    created_at: new Date(),
  });
  return {
    material_id: `material_${fixture.kind}`,
    kind: fixture.kind,
    asset: { asset_id, digest: `sha256:${sha256}` },
    caption: `冻结${fixture.kind}标题`,
    alt_text: '保持原有换行\n与公开替代说明 $v+c=18$。',
  } satisfies SharedMaterialT;
}

async function jointAttempt(db: Db, images: GroupEvidenceT[][]) {
  const submissions = [];
  for (const [index, partId] of ['p1', 'p2'].entries()) {
    const issued = await issueAssessment(db, { group_id: 'root', part_ids: [partId] });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const saved = await saveSubmission(db, {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: 'joint',
      idempotency_key: `joint_${index}`,
      response_set: { entries: [index === 0 ? OPEN_ENTRY : TEXT_ENTRY] },
      group_evidence: images[index],
    });
    if (!('submission' in saved)) throw new Error(saved.status);
    await db.transaction((tx) =>
      recordFormalAttemptCapture(tx, 'solo_submit', partId, saved.submission, null),
    );
    await record(db, `evt_assessment_${saved.submission.submission_id}`, partId);
    submissions.push(saved.submission);
  }
  const candidate = await evaluationService.evaluateSubmission(db, {
    submission_id: submissions[0].submission_id,
    evaluation_group_id: 'joint',
    evaluation_key: 'joint-evaluate',
    expected_submission_ids: submissions.map((sub) => sub.submission_id),
    model_executor: evaluationService.createFormalModelExecutor(db),
    provenance: { source: 'automatic', assisted: false },
  });
  await evaluationService.activateSubmissionCandidate(
    db,
    {
      evaluation_id: candidate.record.evaluation_id,
      expected_effective_id: null,
      expected_generation: 0,
    },
    { actorRef: 'test:joint' },
  );
  return { candidate, submissions };
}

async function cloneEvidence(
  db: Db,
  original: Awaited<ReturnType<typeof attempt>>,
  patches: {
    submission?: Partial<typeof assessment_submission.$inferInsert>;
    issuance?: Partial<typeof assessment_issuance.$inferInsert>;
    revision?: Partial<typeof question_revision.$inferInsert>;
    rawResponses?: unknown;
    rawGroupEvidence?: unknown;
  },
) {
  const ref = original.failure.assessment;
  if (!ref) throw new Error('assessment required');
  const [sub] = await db
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, ref.submission_id));
  const [served] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, sub.issuance_id));
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, sub.revision_id));
  await db
    .insert(question_revision)
    .values({ ...revision, revision_id: 'damaged_rev', revision_ordinal: 2, ...patches.revision });
  await db.insert(assessment_issuance).values({
    ...served,
    issuance_id: 'damaged_issue',
    revision_id: 'damaged_rev',
    ...patches.issuance,
  });
  await db.insert(evaluation_group).values({
    evaluation_group_id: 'damaged_group',
    submission_ids: ['damaged_sub'],
    created_at: sub.submitted_at,
  });
  await db.insert(assessment_submission).values({
    ...sub,
    evaluation_group_id: 'damaged_group',
    submission_id: 'damaged_sub',
    issuance_id: 'damaged_issue',
    revision_id: 'damaged_rev',
    idempotency_key: 'damaged_key',
    ...patches.submission,
    ...(patches.rawResponses === undefined
      ? {}
      : { response_set: sql`${JSON.stringify(patches.rawResponses)}::jsonb` }),
    ...(patches.rawGroupEvidence === undefined
      ? {}
      : { group_evidence: sql`${JSON.stringify(patches.rawGroupEvidence)}::jsonb` }),
  });
  const failure = {
    ...original.failure,
    assessment: {
      ...ref,
      submission_id: 'damaged_sub',
      revision_id: 'damaged_rev',
      evaluation_group_id: 'damaged_group',
    },
  };
  return (await readNativeMistakeEvidence(db, [failure])).get(failure.attempt_event_id);
}

describe('native mistake immutable evidence DB projection', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(materialKinds)(
    'reads complete frozen $kind public material through authenticated GET and readMistakes',
    async (kind) => {
      const db = testDb();
      const material = await binaryMaterial(db, kind);
      const fixture = await publication(db, [OPEN, TEXT], [material]);
      await attempt(db, { anchor: 'p1' });
      await db.update(question).set({
        prompt_md: 'MUTABLE_PROMPT',
        reference_md: 'MUTABLE_PRIVATE_SOLUTION',
        image_refs: ['mutable_image'],
        metadata: { passage: 'MUTABLE_MATERIAL' },
        updated_at: new Date(Date.now() + 1000),
      });
      const before = await Promise.all([
        db.select().from(event),
        db.select().from(assessment_submission),
        db.select().from(evaluation),
        db.select().from(question_revision),
        db.select().from(assessment_issuance),
        db.select().from(source_asset),
        db.select().from(learning_record),
        db.select().from(question),
      ]);
      const calls = fixture.execute.mock.calls.length;
      const cards = await publicMaterialRead(db);
      expect(cards).toHaveLength(1);
      expect(cards[0].prompt_materials).toContainEqual({
        material_id: material.material_id,
        kind: material.kind,
        asset_id: material.asset.asset_id,
        caption: material.caption,
        alt_text: material.alt_text,
        availability: 'available',
      });
      expect(cards[0].reference_md).toBeNull();
      expect(cards[0].wrong_answer_image_refs).toEqual([]);
      expect(JSON.stringify(cards)).not.toMatch(/PRIVATE|SECRET|MUTABLE/);
      expect(
        await Promise.all([
          db.select().from(event),
          db.select().from(assessment_submission),
          db.select().from(evaluation),
          db.select().from(question_revision),
          db.select().from(assessment_issuance),
          db.select().from(source_asset),
          db.select().from(learning_record),
          db.select().from(question),
        ]),
      ).toEqual(before);
      expect(fixture.execute).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(['passage', 'table', 'plaintext'] satisfies SharedMaterialT['kind'][])(
    'keeps full inline %s bytes when there is no source asset row or its metadata has changed',
    async (kind) => {
      const db = testDb();
      const content_md =
        '阅读材料：雨水流速与坡度并非单向因果。\n\n' +
        '- 控制水量\n  - 重复三次，排除单位歧义\n$ v = \\sqrt{2gh} $\n|坡度|流速|备注|\n|5°|0.4|边界 0|\n'.repeat(
          80,
        );
      const material: SharedMaterialT = {
        material_id: 'long_inline',
        kind,
        asset: { asset_id: 'inline_text', digest: 'frozen-inline' },
        caption: '长材料，全文保持',
        alt_text: '说明与正文均公开',
        content_md,
      };
      await publication(db, [OPEN, TEXT], [material]);
      await attempt(db, { anchor: 'p1' });
      const before = await publicMaterialRead(db);
      expect(before[0].prompt_md).toHaveLength(200);
      expect(before[0].prompt_materials).toContainEqual({
        material_id: material.material_id,
        kind,
        caption: material.caption,
        alt_text: material.alt_text,
        content_md,
        availability: 'inline',
      });
      await db.insert(source_asset).values({
        id: 'inline_text',
        kind: 'image',
        mime_type: 'image/png',
        storage_key: 'MUTABLE',
        byte_size: 20,
        sha256: 'a'.repeat(64),
        created_at: new Date(),
      });
      await db.update(question).set({ prompt_md: 'MUTABLE', updated_at: new Date() });
      expect(await publicMaterialRead(db)).toEqual(before);
    },
  );

  it('isolates selected failed faces, unissued parts and all existing private material namespaces', async () => {
    const db = testDb();
    const materials: SharedMaterialT[] = [
      {
        material_id: 'p1_only',
        kind: 'plaintext',
        asset: { asset_id: 'txt_p1', digest: 'one' },
        content_md: 'P1_PUBLIC',
      },
      {
        material_id: 'p2_only',
        kind: 'table',
        asset: { asset_id: 'txt_p2', digest: 'two' },
        content_md: 'P2_PUBLIC',
      },
      {
        material_id: 'p3_only',
        kind: 'passage',
        asset: { asset_id: 'txt_p3', digest: 'three' },
        content_md: 'UNISSUED',
      },
      {
        material_id: 'explicit_private',
        kind: 'audio',
        asset: { asset_id: 'custom_private', digest: 'private' },
        visibility: 'private',
        caption: 'PRIVATE_CAPTION',
        alt_text: 'PRIVATE_ALT',
        content_md: 'PRIVATE_BYTES',
      },
      {
        material_id: 'solution',
        kind: 'plaintext',
        asset: { asset_id: 'sol_0123456789ab', digest: 'solution' },
        visibility: 'public',
        content_md: 'SECRET_SOLUTION',
      },
    ];
    await publication(db, [OPEN, TEXT], materials, undefined, {
      p1: ['p1_only', 'explicit_private', 'solution'],
      p2: ['p2_only'],
      p3: ['p3_only'],
    });
    await attempt(db, { anchor: 'p1', key: 'first' });
    await attempt(db, { anchor: 'root', key: 'group' });
    await attempt(db, { anchor: 'p2', partIds: ['p2'], entries: [TEXT_ENTRY], key: 'second' });
    const cards = await publicMaterialRead(db);
    const ids = (questionId: string) =>
      cards
        .find((card) => card.question_id === questionId)
        ?.prompt_materials.map((material) => material.material_id);
    // Normalized public parent material is shared by all issued parts.
    expect(ids('p1')).toContain('p1_only');
    expect(ids('p1')).not.toContain('p2_only');
    expect(ids('p2')).toContain('p2_only');
    expect(ids('p2')).not.toContain('p1_only');
    expect(ids('root')).toEqual(expect.arrayContaining(['p1_only', 'p2_only']));
    expect(JSON.stringify(cards)).not.toMatch(
      /UNISSUED|PRIVATE|SECRET|explicit_private|custom_private|sol_0123456789ab|rub_123456789abc/,
    );
  });

  it.each(['missing', 'digest', 'malformed_digest', 'kind', 'mime', 'size'])(
    'preserves binary descriptions and frozen text but removes downloadable identity for %s material metadata',
    async (damage) => {
      const db = testDb();
      const material = await binaryMaterial(db, materialKinds[0]);
      const withText = { ...material, content_md: 'FROZEN_PUBLIC_TRANSCRIPT\n'.repeat(50) };
      const fixture = await publication(db, [OPEN, TEXT], [withText]);
      const answerImage = await handwritingFixture(db);
      await attempt(db, { anchor: 'p1', images: [answerImage] });
      if (damage === 'missing')
        await db.delete(source_asset).where(eq(source_asset.id, material.asset.asset_id));
      else
        await db
          .update(source_asset)
          .set(
            damage === 'digest'
              ? { sha256: 'f'.repeat(64) }
              : damage === 'malformed_digest'
                ? { sha256: 'invalid' }
                : damage === 'kind'
                  ? { kind: 'pdf' }
                  : damage === 'mime'
                    ? { mime_type: 'text/html' }
                    : { byte_size: 0 },
          )
          .where(eq(source_asset.id, material.asset.asset_id));
      const calls = fixture.execute.mock.calls.length;
      const cards = await publicMaterialRead(db);
      const projected = cards[0].prompt_materials.find(
        (item) => item.material_id === material.material_id,
      );
      expect(projected).toEqual({
        material_id: material.material_id,
        kind: material.kind,
        caption: material.caption,
        alt_text: material.alt_text,
        content_md: withText.content_md,
        availability: damage === 'missing' ? 'missing' : 'unavailable',
      });
      expect(projected).not.toHaveProperty('asset_id');
      expect(cards[0].wrong_answer_image_refs).toEqual([answerImage.evidence.asset.asset_id]);
      expect(cards[0].wrong_answer_md).toContain('原答一');
      expect(cards[0].reference_md).toBeNull();
      expect(fixture.execute).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(materialKinds)(
    'distinguishes missing and mismatched external $kind assets through both public readers',
    async (kind) => {
      const db = testDb();
      const material = await binaryMaterial(db, kind);
      await publication(db, [OPEN, TEXT], [material]);
      await attempt(db, { anchor: 'p1' });
      for (const patch of [
        { kind: 'unknown', mime_type: kind.mime, sha256: material.asset.digest.slice(7) },
        {
          kind: kind.assetKind,
          mime_type: 'application/octet-stream',
          sha256: material.asset.digest.slice(7),
        },
        { kind: kind.assetKind, mime_type: kind.mime, sha256: 'f'.repeat(64) },
      ]) {
        await db
          .update(source_asset)
          .set(patch)
          .where(eq(source_asset.id, material.asset.asset_id));
        const card = (await publicMaterialRead(db))[0];
        expect(card.prompt_materials).toContainEqual({
          material_id: material.material_id,
          kind: material.kind,
          caption: material.caption,
          alt_text: material.alt_text,
          availability: 'unavailable',
        });
        expect(JSON.stringify(card.prompt_materials)).not.toContain(material.asset.asset_id);
      }
      await db.delete(source_asset).where(eq(source_asset.id, material.asset.asset_id));
      const card = (await publicMaterialRead(db))[0];
      expect(card.prompt_materials).toContainEqual({
        material_id: material.material_id,
        kind: material.kind,
        caption: material.caption,
        alt_text: material.alt_text,
        availability: 'missing',
      });
      expect(card.wrong_answer_md).toContain('原答一');
    },
  );

  it('rejects unauthenticated material reads before exposing frozen content', async () => {
    const db = testDb();
    const material = await binaryMaterial(db, materialKinds[0]);
    await publication(db, [OPEN, TEXT], [material]);
    await attempt(db, { anchor: 'p1' });
    vi.stubEnv('INTERNAL_TOKEN', 'synthetic-material-test-token');
    const app = buildHonoApp([ingestionCapability], {
      epochGate: async () => ({ runnable: true }),
    });
    for (const headers of [new Headers(), new Headers({ 'x-internal-token': 'wrong-token' })]) {
      const response = await app.request('/api/mistakes', { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await publicMaterialRead(db))[0].prompt_materials).toContainEqual(
      expect.objectContaining({ availability: 'available' }),
    );
  });

  it('P1 preserves all_units images when the frozen basis has only a group-evidence unit through GET and readMistakes', async () => {
    const db = testDb();
    const fixture = await publication(db, [OPEN, TEXT], [], () => ({
      units: [GROUP_UNIT],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    }));
    const image = await handwritingFixture(db);
    await attempt(db, { anchor: 'p1', images: [image] });
    const events = await db.select().from(event);
    const submissions = await db.select().from(assessment_submission);
    const calls = fixture.execute.mock.calls.length;
    const response = await GET(new Request('http://localhost/api/mistakes'));
    expect(response.status).toBe(200);
    const wire = MistakeListResponseSchema.parse(await response.json());
    expect(wire.rows).toHaveLength(1);
    expect(wire.rows[0]).toMatchObject({
      question_id: 'p1',
      reference_md: null,
      wrong_answer_image_refs: [image.evidence.asset.asset_id],
      wrong_answer_md: expect.stringContaining('原答一'),
    });
    expect((await readMistakes(db)).rows).toEqual(wire.rows);
    expect(await db.select().from(event)).toEqual(events);
    expect(await db.select().from(assessment_submission)).toEqual(submissions);
    expect(fixture.execute).toHaveBeenCalledTimes(calls);
  });

  it.each(['only', 'mixed'])(
    'P1 preserves unit-targeted group-only images in a %s basis through GET and readMistakes',
    async (basisKind) => {
      const db = testDb();
      await publication(db, [OPEN, TEXT], [], (basis) => ({
        ...basis,
        units: basisKind === 'only' ? [GROUP_UNIT] : [...basis.units, GROUP_UNIT],
      }));
      const targeted = await handwritingFixture(db);
      const all = await handwritingFixture(db);
      const unrelated = await handwritingFixture(db);
      const unissued = await handwritingFixture(db);
      await attempt(db, {
        anchor: 'p1',
        images: [
          { ...targeted, target: { scope: 'units', scoring_unit_ids: ['u_group'] } },
          all,
          ...(basisKind === 'mixed'
            ? [
                {
                  ...unrelated,
                  target: { scope: 'units', scoring_unit_ids: ['u_s2'] },
                } satisfies GroupEvidenceT,
                {
                  ...unissued,
                  target: { scope: 'units', scoring_unit_ids: ['u_s3'] },
                } satisfies GroupEvidenceT,
              ]
            : []),
        ],
      });
      const response = await GET(new Request('http://localhost/api/mistakes'));
      expect(response.status).toBe(200);
      const wire = MistakeListResponseSchema.parse(await response.json());
      expect(wire.rows).toHaveLength(1);
      expect(wire.rows[0].wrong_answer_image_refs).toEqual([
        targeted.evidence.asset.asset_id,
        all.evidence.asset.asset_id,
      ]);
      expect((await readMistakes(db)).rows).toEqual(wire.rows);
    },
  );

  it('P1 excludes a cross-part unit when only one member part was actually issued', async () => {
    const db = testDb();
    await publication(db, [OPEN, TEXT], [], (basis) => ({
      ...basis,
      units: [
        ...basis.units,
        { ...basis.units[0], scoring_unit_id: 'u_cross', slot_refs: ['s1', 's2'] },
      ],
    }));
    const own = await handwritingFixture(db);
    const cross = await handwritingFixture(db);
    await attempt(db, {
      anchor: 'p1',
      partIds: ['p1'],
      entries: [OPEN_ENTRY],
      images: [own, { ...cross, target: { scope: 'units', scoring_unit_ids: ['u_cross'] } }],
    });
    const response = await GET(new Request('http://localhost/api/mistakes'));
    expect(response.status).toBe(200);
    const wire = MistakeListResponseSchema.parse(await response.json());
    expect(wire.rows).toHaveLength(1);
    expect(wire.rows[0].wrong_answer_image_refs).toEqual([own.evidence.asset.asset_id]);
    expect((await readMistakes(db)).rows).toEqual(wire.rows);
  });

  const jointAggregations: ScoringBasisT['aggregation'][] = [
    { kind: 'sum' },
    { kind: 'capped_sum', cap: 2 },
    {
      kind: 'threshold_levels',
      thresholds: [
        { level_id: 'fail', min_points: 0 },
        { level_id: 'pass', min_points: 2 },
      ],
    },
  ];
  it.each(jointAggregations)(
    'P1 retains cross-part and own-unit images for valid joint $kind scoring through GET and readMistakes',
    async (aggregation) => {
      const db = testDb();
      const fixture = await publication(db, [OPEN, TEXT], [], (basis) => ({
        ...basis,
        aggregation,
        units: [
          ...basis.units.filter(
            (unit) => aggregation.kind === 'sum' || unit.scoring_unit_id !== 'u_s3',
          ),
          {
            ...basis.units[0],
            scoring_unit_id: 'u_cross',
            slot_refs: ['s1', 's2'],
            evidence_slot_refs: ['s1'],
            requires_group_evidence: true,
          },
        ],
      }));
      const images = [];
      for (const partId of ['p1', 'p2']) {
        const own = await handwritingFixture(db);
        const cross = await handwritingFixture(db);
        const all = await handwritingFixture(db);
        const unrelated = await handwritingFixture(db);
        const unissued = aggregation.kind === 'sum' ? await handwritingFixture(db) : null;
        images.push({ partId, own, cross, all, unrelated, unissued });
      }
      const joint = await jointAttempt(
        db,
        images.map(({ partId, own, cross, all, unrelated, unissued }) => [
          {
            ...own,
            target: { scope: 'units', scoring_unit_ids: [partId === 'p1' ? 'u_s1' : 'u_s2'] },
          },
          { ...cross, target: { scope: 'units', scoring_unit_ids: ['u_cross'] } },
          all,
          {
            ...unrelated,
            target: { scope: 'units', scoring_unit_ids: [partId === 'p1' ? 'u_s2' : 'u_s1'] },
          },
          ...(unissued
            ? [
                {
                  ...unissued,
                  target: { scope: 'units', scoring_unit_ids: ['u_s3'] },
                } satisfies GroupEvidenceT,
              ]
            : []),
        ]),
      );
      expect(joint.candidate.record.provenance?.input_snapshot).toMatchObject({
        member_submission_ids: expect.arrayContaining(
          joint.submissions.map((sub) => sub.submission_id),
        ),
        issued_part_ids: ['p1', 'p2'],
      });
      expect(
        joint.candidate.record.unit_results.find((unit) => unit.scoring_unit_id === 'u_cross'),
      ).toMatchObject({ status: 'scored', points_awarded: 0 });
      const events = await db.select().from(event);
      const originals = await db.select().from(assessment_submission);
      const calls = fixture.execute.mock.calls.length;
      const response = await GET(new Request('http://localhost/api/mistakes'));
      expect(response.status).toBe(200);
      const wire = MistakeListResponseSchema.parse(await response.json());
      expect(wire.rows).toHaveLength(2);
      for (const { partId, own, cross, all } of images) {
        const card = wire.rows.find((card) => card.question_id === partId);
        expect(card?.wrong_answer_image_refs).toEqual([
          own.evidence.asset.asset_id,
          cross.evidence.asset.asset_id,
          all.evidence.asset.asset_id,
        ]);
        expect(card?.reference_md).toBeNull();
        expect(card?.wrong_answer_md).toContain(partId === 'p1' ? '原答一' : '原答二');
        expect(card?.wrong_answer_md).not.toContain(partId === 'p1' ? '原答二' : '原答一');
        const filtered = await readMistakes(db, { question_id: partId });
        expect(filtered.rows).toEqual([card]);
      }
      expect((await readMistakes(db)).rows).toEqual(wire.rows);
      expect(await db.select().from(event)).toEqual(events);
      expect(await db.select().from(assessment_submission)).toEqual(originals);
      expect(fixture.execute).toHaveBeenCalledTimes(calls);
    },
  );

  it('reads multipart parent materials and issued boundaries, remains stable after mutable edits, and hides private reference content', async () => {
    const db = testDb();
    const fixture = await publication(db);
    await attempt(db);
    const before = await row(db);
    expect(before.prompt_md).toContain(stem);
    expect(before.prompt_md).toContain('[p1]');
    expect(before.prompt_md).toContain('[p2]');
    expect(before.prompt_md).not.toContain('p3');
    expect(before.reference_md).toBeNull();
    expect(JSON.stringify(before)).not.toMatch(/PRIVATE|SECRET/);
    expect(before.wrong_answer_md).toBe('[p1/s1] 原答一：列式与单位\n[p2/s2] 原答二：另一部分');
    await db
      .update(question)
      .set({ prompt_md: 'CURRENT_EDIT', reference_md: 'CURRENT_ANSWER', updated_at: new Date() });
    const calls = fixture.execute.mock.calls.length;
    const events = await db.select().from(event);
    const originals = await db.select().from(assessment_submission);
    expect(await row(db)).toEqual(before);
    const wire = MistakeListResponseSchema.parse(
      await (await GET(new Request('http://localhost/api/mistakes'))).json(),
    );
    expect(wire.rows).toEqual([before]);
    expect(await db.select().from(event)).toEqual(events);
    expect(await db.select().from(assessment_submission)).toEqual(originals);
    expect(fixture.execute).toHaveBeenCalledTimes(calls);
  });

  it('maps open images, all_units and unit-target evidence to the anchor without unrelated-part or unissued-unit leakage', async () => {
    const db = testDb();
    await publication(db);
    const open = await handwritingFixture(db);
    const all = await handwritingFixture(db);
    const related = await handwritingFixture(db);
    const other = await handwritingFixture(db);
    const unissued = await handwritingFixture(db);
    await attempt(db, {
      anchor: 'p1',
      entries: [{ ...OPEN_ENTRY, kind: 'open', evidence: [open.evidence] }, TEXT_ENTRY],
      images: [
        all,
        { evidence: related.evidence, target: { scope: 'units', scoring_unit_ids: ['u_s1'] } },
        { evidence: other.evidence, target: { scope: 'units', scoring_unit_ids: ['u_s2'] } },
        { evidence: unissued.evidence, target: { scope: 'units', scoring_unit_ids: ['u_s3'] } },
      ],
    });
    const projected = await row(db);
    expect(projected.wrong_answer_image_refs).toEqual([
      open.evidence.asset.asset_id,
      all.evidence.asset.asset_id,
      related.evidence.asset.asset_id,
    ]);
    expect(projected.prompt_md).toContain('冻结子题p1');
    expect(projected.prompt_md).not.toContain('冻结子题p2');
    expect(projected.wrong_answer_md).not.toContain('另一部分');
  });

  it('keeps different submissions in the same joint evaluation group separate', async () => {
    const db = testDb();
    await publication(db);
    const images = [await handwritingFixture(db), await handwritingFixture(db)];
    await jointAttempt(
      db,
      images.map((image) => [image]),
    );
    const projected = (await readMistakes(db)).rows;
    expect(projected).toHaveLength(2);
    for (const [index, partId] of ['p1', 'p2'].entries()) {
      const card = projected.find((card) => card.question_id === partId);
      expect(card?.wrong_answer_image_refs).toEqual([images[index].evidence.asset.asset_id]);
      expect(card?.wrong_answer_md).toContain(index === 0 ? '原答一' : '原答二');
      expect(card?.wrong_answer_md).not.toContain(index === 0 ? '原答二' : '原答一');
    }
  });

  const cases: { name: string; slot: ResponseSlotT; entry: SlotResponseT; expected: string }[] = [
    {
      name: 'single choice',
      slot: {
        slot_id: 's1',
        part_id: 'p1',
        kind: 'single_choice',
        options: [
          { option_id: 'oa', label: '甲', text: '同名选项A' },
          { option_id: 'ob', label: '乙', text: '同名选项B' },
        ],
      },
      entry: { slot_id: 's1', kind: 'choice', option_ids: ['ob'] },
      expected: '乙 [ob] 同名选项B',
    },
    {
      name: 'multi choice',
      slot: {
        slot_id: 's1',
        part_id: 'p1',
        kind: 'multi_choice',
        min_select: 1,
        max_select: 2,
        options: [
          { option_id: 'oa', label: 'A', text: '甲' },
          { option_id: 'ob', label: 'B', text: '乙' },
        ],
      },
      entry: { slot_id: 's1', kind: 'choice', option_ids: ['ob', 'oa'] },
      expected: 'B [ob] 乙；A [oa] 甲',
    },
    {
      name: 'text',
      slot: { slot_id: 's1', part_id: 'p1', kind: 'text', math_preview: true },
      entry: { slot_id: 's1', kind: 'text', text_md: '汉字、$x$\n逐字保留' },
      expected: '汉字、$x$\n逐字保留',
    },
    {
      name: 'numeric raw input',
      slot: { slot_id: 's1', part_id: 'p1', kind: 'numeric', unit_hint: 'km/h' },
      entry: { slot_id: 's1', kind: 'numeric', value: 15, raw_input: '15.0 km/h' },
      expected: '15.0 km/h',
    },
    {
      name: 'numeric value',
      slot: { slot_id: 's1', part_id: 'p1', kind: 'numeric' },
      entry: { slot_id: 's1', kind: 'numeric', value: 0 },
      expected: '0',
    },
    {
      name: 'formula',
      slot: { slot_id: 's1', part_id: 'p1', kind: 'formula', notation: 'latex' },
      entry: { slot_id: 's1', kind: 'formula', latex: '\\frac{x}{2}=7' },
      expected: '$\\frac{x}{2}=7$',
    },
    {
      name: 'matching',
      slot: {
        slot_id: 's1',
        part_id: 'p1',
        kind: 'matching',
        allow_left_unmatched: false,
        left_items: [
          { item_id: 'ia', label: '左1', text: '第一行' },
          { item_id: 'ib', label: '左2', text: '第二行' },
        ],
        right_options: [
          { option_id: 'oa', label: '右A', text: '甲' },
          { option_id: 'ob', label: '右B', text: '乙' },
        ],
      },
      entry: {
        slot_id: 's1',
        kind: 'matching',
        pairs: [
          { item_id: 'ia', option_id: 'ob' },
          { item_id: 'ib', option_id: 'oa' },
        ],
      },
      expected: '左1 [ia] 第一行 → 右B [ob] 乙',
    },
    {
      name: 'ordering',
      slot: {
        slot_id: 's1',
        part_id: 'p1',
        kind: 'ordering',
        items: [
          { item_id: 'ia', label: '1', text: '先' },
          { item_id: 'ib', label: '2', text: '后' },
        ],
      },
      entry: { slot_id: 's1', kind: 'ordering', item_order: ['ib', 'ia'] },
      expected: '2 [ib] 后 → 1 [ia] 先',
    },
    { name: 'open', slot: OPEN, entry: OPEN_ENTRY, expected: '原答一：列式与单位' },
  ];
  it.each(cases)('renders $name from real frozen responses', async ({ slot, entry, expected }) => {
    const db = testDb();
    await publication(db, [slot, TEXT]);
    await attempt(db, {
      anchor: 'p1',
      entries: [entry, TEXT_ENTRY],
      order:
        slot.kind === 'single_choice' || slot.kind === 'multi_choice'
          ? { s1: ['ob', 'oa'] }
          : undefined,
    });
    const card = await row(db);
    expect(card.wrong_answer_md).toContain(expected);
    if (slot.kind === 'single_choice' || slot.kind === 'multi_choice')
      expect(card.prompt_md.indexOf('[ob]')).toBeLessThan(card.prompt_md.indexOf('[oa]'));
  });

  it('preserves table cell coordinates, multiple slots and the 200 character summary limit', async () => {
    const db = testDb();
    const slots: ResponseSlotT[] = [
      {
        slot_id: 'table',
        part_id: 'p1',
        kind: 'table',
        column_headers: ['船速', '水速'],
        row_labels: ['方程'],
        cells: [
          { row: 0, col: 0, slot_id: 's1' },
          { row: 0, col: 1, slot_id: 'cell2' },
        ],
      },
      { slot_id: 's1', part_id: 'p1', kind: 'numeric' },
      { slot_id: 'cell2', part_id: 'p1', kind: 'text', math_preview: false },
      TEXT,
    ];
    await publication(db, slots);
    await attempt(db, {
      anchor: 'p1',
      entries: [
        { slot_id: 's1', kind: 'numeric', value: 15 },
        { slot_id: 'cell2', kind: 'text', text_md: '边界与长文本'.repeat(60) },
        TEXT_ENTRY,
      ],
    });
    const card = await row(db);
    expect(card.prompt_md).toContain('方程 / 船速 [s1]');
    expect(card.wrong_answer_md).toContain('[p1/s1] 15');
    expect(card.wrong_answer_md).toContain('[p1/cell2]');
    expect(card.wrong_answer_md).toHaveLength(200);
  });

  it.each(['digest', 'mime', 'kind', 'size', 'time', 'missing'])(
    'fails closed for %s image assets without losing text or other valid evidence',
    async (kind) => {
      const db = testDb();
      await publication(db);
      const good = await handwritingFixture(db);
      const bad = await handwritingFixture(db);
      await attempt(db, { images: [good, bad] });
      if (kind === 'missing')
        await db.delete(source_asset).where(eq(source_asset.id, bad.evidence.asset.asset_id));
      else
        await db
          .update(source_asset)
          .set(
            kind === 'digest'
              ? { sha256: 'f'.repeat(64) }
              : kind === 'mime'
                ? { mime_type: 'image/jpeg' }
                : kind === 'kind'
                  ? { kind: 'pdf' }
                  : kind === 'size'
                    ? { byte_size: 121 }
                    : { created_at: new Date(0) },
          )
          .where(eq(source_asset.id, bad.evidence.asset.asset_id));
      const card = await row(db);
      expect(card.wrong_answer_image_refs).toEqual([good.evidence.asset.asset_id]);
      expect(card.wrong_answer_md).toContain('原答一');
    },
  );

  it('distinguishes explicit blank from missing response evidence', async () => {
    const db = testDb();
    await publication(db);
    const original = await attempt(db);
    const blank = await cloneEvidence(db, original, {
      submission: {
        response_set: { entries: [{ slot_id: 's1', kind: 'open', text_md: '', evidence: [] }] },
      },
    });
    expect(blank?.wrong_answer_md).toBe('[p1/s1] （空白作答）\n[p2/s2] （未记录作答）');
  });

  it('preserves unparsed numeric original evidence without replacing it with a number or blank', async () => {
    const db = testDb();
    await publication(db, [{ slot_id: 's1', part_id: 'p1', kind: 'numeric' }, TEXT]);
    const original = await attempt(db, {
      entries: [{ slot_id: 's1', kind: 'numeric', value: 15 }, TEXT_ENTRY],
    });
    const card = await cloneEvidence(db, original, {
      submission: {
        response_set: {
          entries: [
            { slot_id: 's1', kind: 'numeric', value: null, raw_input: '15 ? km/h' },
            TEXT_ENTRY,
          ],
        },
      },
    });
    expect(card?.wrong_answer_md).toContain('[p1/s1] 15 ? km/h');
    expect(card?.wrong_answer_md).not.toContain('空白');
  });

  it('retains valid slots when another response has unknown identities', async () => {
    const db = testDb();
    await publication(db);
    const original = await attempt(db);
    const card = await cloneEvidence(db, original, {
      submission: {
        response_set: {
          entries: [OPEN_ENTRY, { slot_id: 's2', kind: 'choice', option_ids: ['unknown'] }],
        },
      },
    });
    expect(card?.wrong_answer_md).toBe('[p1/s1] 原答一：列式与单位\n[p2/s2] （作答证据损坏）');
  });

  it.each(['unknown_part', 'wrong_revision', 'material_digest', 'corrupt_structure'])(
    'keeps the record but exposes no fabricated evidence for %s',
    async (kind) => {
      const db = testDb();
      await publication(db);
      const original = await attempt(db);
      const card = await cloneEvidence(
        db,
        original,
        kind === 'unknown_part'
          ? { issuance: { part_ids: ['unknown'] } }
          : kind === 'wrong_revision'
            ? {
                issuance: { revision_id: original.issued.issuance.binding.revision_id },
                submission: { revision_id: original.issued.issuance.binding.revision_id },
              }
            : kind === 'material_digest'
              ? {
                  issuance: {
                    material_bindings: original.issued.issuance.binding.material_bindings.map(
                      (binding) => ({ ...binding, asset_digest: 'wrong' }),
                    ),
                  },
                }
              : { revision: { structure: { group_id: 'root', materials: [], parts: [] } } },
      );
      expect(card).toEqual({
        prompt_md: '',
        prompt_materials: [],
        reference_md: null,
        wrong_answer_md: '',
        wrong_answer_image_refs: [],
      });
    },
  );

  it('preserves independent group images when response JSON is damaged', async () => {
    const db = testDb();
    await publication(db);
    const image = await handwritingFixture(db);
    const original = await attempt(db, { images: [image] });
    const card = await cloneEvidence(db, original, {
      rawResponses: { entries: [{ slot_id: 's1', kind: 'open', text_md: 42, evidence: [] }] },
    });
    expect(card?.prompt_md).toContain(stem);
    expect(card?.wrong_answer_md).toBe('（作答证据损坏）');
    expect(card?.wrong_answer_image_refs).toEqual([image.evidence.asset.asset_id]);
  });

  it('rejects damaged or unknown group targets while preserving valid independent evidence', async () => {
    const db = testDb();
    await publication(db);
    const good = await handwritingFixture(db);
    const bad = await handwritingFixture(db);
    const original = await attempt(db);
    const card = await cloneEvidence(db, original, {
      rawGroupEvidence: [
        null,
        { ...bad, target: { scope: 'units', scoring_unit_ids: ['u_s1', 'unknown'] } },
        good,
      ],
    });
    expect(card?.wrong_answer_image_refs).toEqual([good.evidence.asset.asset_id]);
    expect(card?.wrong_answer_md).toContain('原答一');
  });

  it('projects the page through a real read-only database transaction', async () => {
    const db = testDb();
    const material = await binaryMaterial(db, materialKinds[0]);
    await publication(db, [OPEN, TEXT], [material]);
    const image = await handwritingFixture(db);
    const original = await attempt(db, { images: [image] });
    const projected = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return readNativeMistakeEvidence(tx, [original.failure]);
    });
    expect(projected.get(original.failure.attempt_event_id)?.wrong_answer_image_refs).toEqual([
      image.evidence.asset.asset_id,
    ]);
    expect(projected.get(original.failure.attempt_event_id)?.prompt_materials).toContainEqual(
      expect.objectContaining({ material_id: material.material_id, availability: 'available' }),
    );
  });

  it('handles absent submissions and bad anchors without falling back to mutable questions', async () => {
    const db = testDb();
    await publication(db);
    const original = await attempt(db);
    const ref = original.failure.assessment;
    if (!ref) throw new Error('assessment required');
    for (const failure of [
      { ...original.failure, question_id: 'p3' },
      { ...original.failure, assessment: { ...ref, submission_id: 'absent' } },
      { ...original.failure, assessment: { ...ref, evaluation_group_id: 'other' } },
    ]) {
      expect(
        (await readNativeMistakeEvidence(db, [failure])).get(failure.attempt_event_id),
      ).toEqual({
        prompt_md: '',
        prompt_materials: [],
        reference_md: null,
        wrong_answer_md: '',
        wrong_answer_image_refs: [],
      });
    }
  });

  it('preserves public frozen figure descriptions without placing question images in answer image refs', async () => {
    const db = testDb();
    const picture = await handwritingFixture(db);
    await publication(
      db,
      [OPEN, TEXT],
      [
        {
          material_id: 'fig',
          kind: 'figure',
          visibility: 'public',
          asset: picture.evidence.asset,
          caption: '冻结图表',
          alt_text: '横轴时间，纵轴速度',
        },
      ],
    );
    await attempt(db, { anchor: 'p1' });
    const card = await row(db);
    expect(card.prompt_md).toContain('冻结图表');
    expect(card.prompt_md).toContain('横轴时间，纵轴速度');
    expect(card.wrong_answer_image_refs).toEqual([]);
  });

  it('keeps non-image open attachments as labelled response evidence and excludes them from image refs', async () => {
    const db = testDb();
    await publication(db);
    const original = await handwritingFixture(db);
    const audio = { ...original.evidence, kind: 'audio' as const, mime_type: 'audio/wav' };
    await db
      .update(source_asset)
      .set({ kind: 'audio', mime_type: 'audio/wav' })
      .where(eq(source_asset.id, audio.asset.asset_id));
    await attempt(db, {
      anchor: 'p1',
      entries: [{ slot_id: 's1', kind: 'open', text_md: '', evidence: [audio] }, TEXT_ENTRY],
    });
    const card = await row(db);
    expect(card.wrong_answer_md).toContain(`（附件 audio [${audio.evidence_id}]）`);
    expect(card.wrong_answer_image_refs).toEqual([]);
  });

  it('does not expose a pending effective evaluation as a wrong answer', async () => {
    const db = testDb();
    await publication(db);
    const original = await attempt(db);
    const ref = original.failure.assessment;
    if (!ref) throw new Error('assessment required');
    const [head] = await db
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, ref.evaluation_group_id));
    const candidate = await evaluationService.evaluateSubmission(db, {
      submission_id: ref.submission_id,
      evaluation_group_id: ref.evaluation_group_id,
      evaluation_key: 'pending-rejudge',
      mode: 'manual_assert',
      provenance: { source: 'manual', assisted: false },
      asserted_unit_results: ['u_s1', 'u_s2'].map((scoring_unit_id) => ({
        status: 'pending',
        scoring_unit_id,
        pending: { reason: 'unjudgeable', detail: '保留未决' },
      })),
    });
    await evaluationService.activateSubmissionCandidate(
      db,
      {
        evaluation_id: candidate.record.evaluation_id,
        expected_effective_id: head.effective_evaluation_id,
        expected_generation: head.generation,
      },
      { actorRef: 'test:pending' },
    );
    expect((await readMistakes(db)).rows).toHaveLength(0);
  });

  it('keeps native rejudge and retraction filtering in the existing reader', async () => {
    const db = testDb();
    await publication(db);
    const original = await attempt(db);
    expect((await readMistakes(db)).rows).toHaveLength(1);
    await correctPaperFixture(db, original.failure.attempt_event_id, 1);
    expect((await readMistakes(db)).rows).toHaveLength(0);
    await correctPaperFixture(db, original.failure.attempt_event_id, 0);
    expect((await readMistakes(db)).rows).toHaveLength(1);
    await writeEvent(db, {
      id: 'native-retraction',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: original.failure.attempt_event_id,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: '撤回原件',
        affected_refs: [{ kind: 'question', id: 'root' }],
      },
      created_at: new Date(),
    });
    expect((await readMistakes(db)).rows).toHaveLength(0);
  });

  it('propagates database errors instead of turning infrastructure failure into absent evidence', async () => {
    const db = testDb();
    await publication(db);
    const original = await attempt(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1ms'`);
        await expect(tx.execute(sql`SELECT pg_sleep(0.05)`)).rejects.toThrow();
        await expect(readNativeMistakeEvidence(tx, [original.failure])).rejects.toThrow();
      }),
    ).rejects.toThrow();
  });
});
