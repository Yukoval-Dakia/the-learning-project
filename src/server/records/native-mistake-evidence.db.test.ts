import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistakeListResponseSchema } from '@/capabilities/ingestion/api/contracts';
import { GET } from '@/capabilities/ingestion/api/mistakes';
import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import { readMistakes } from '@/capabilities/ingestion/public';
import { commitFormalAttempt } from '@/capabilities/practice/server/assessment/attempt';
import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
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
  assessment_submission,
  event,
  knowledge,
  learning_record,
  question,
  source_asset,
} from '@/db/schema';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { buildHonoApp } from '../../../server/app';
import { handwritingFixture } from '../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../tests/helpers/db';

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

describe('native mistake immutable evidence DB projection', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
});
