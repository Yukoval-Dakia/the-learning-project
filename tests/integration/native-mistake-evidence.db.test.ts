import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistakeListResponseSchema } from '@/capabilities/ingestion/api/contracts';
import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import { readMistakes } from '@/capabilities/ingestion/public';
import { commitFormalAttempt } from '@/capabilities/practice/server/assessment/attempt';
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
import { knowledge, learning_record, question, source_asset } from '@/db/schema';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { buildHonoApp } from '../../server/app';
import { seedHistoricalAssessmentIssuance } from '../fixtures/historical-assessment-issuance';
import { resetDb, testDb } from '../helpers/db';

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
  const issued = await seedHistoricalAssessmentIssuance(db, {
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

describe('native mistake immutable evidence DB projection', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
});
