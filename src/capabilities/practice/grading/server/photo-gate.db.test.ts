import { createHash } from 'node:crypto';
import {
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { afterEach, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  EvidenceAttachmentT,
  GroupEvidenceT,
  ScoringUnitT,
  SlotResponseT,
} from '@/core/schema/assessment';
import {
  ai_task_runs,
  assessment_issuance,
  assessment_submission,
  evaluation_group,
  event,
  knowledge,
  model_admission_slice,
  question,
  question_revision,
} from '@/db/schema';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { type PiAdapterDeps, PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  type ModelSliceAdmissionRunDataT,
  runModelSliceAdmission,
} from '../jobs/model_slice_admission_run';
import { createFormalModelExecutor, evaluateSubmission } from './judge/evaluate-submission';
import { currentModelPinForKind, registerModelAdmissionSlice } from './model-slice-registry';

const now = new Date('2026-11-07T00:00:00Z');
const task = 'AssessmentRuleJudgeTask';
const model: Model<'openai-completions'> = {
  id: 'mimo-v2.6-flash',
  name: 'offline',
  provider: 'opencode-go',
  api: 'openai-completions',
  baseUrl: 'https://offline.invalid',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 262144,
  maxTokens: 32768,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
const image: EvidenceAttachmentT = {
  evidence_id: 'synthetic-image',
  kind: 'image',
  asset: {
    asset_id: 'synthetic-png',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  },
  mime_type: 'image/png',
  bytes: bytes.length,
  uploaded_at: now.toISOString(),
};
const unit: ScoringUnitT = {
  scoring_unit_id: 'u1',
  slot_refs: ['s1'],
  material_refs: [],
  evidence_slot_refs: [],
  requires_group_evidence: false,
  criterion: {
    kind: 'rule_reference',
    rule_id: 'r1',
    statement_md: 'Award the declared score',
    source: 'official',
  },
  points: 4,
};
const slots = ['s1', 's2'].map((slot_id) => ({
  slot_id,
  part_id: 'p1',
  kind: 'open_response' as const,
  accepted_evidence: [],
  evidence_required: false,
}));
const parts = [{ part_id: 'p1', prompt_md: 'Explain your answer', material_ids: [] }];
const open = (text = 'award=4', evidence: EvidenceAttachmentT[] = []): SlotResponseT => ({
  slot_id: 's1',
  kind: 'open',
  text_md: text,
  evidence,
});

async function seedRevision(id: string, slice: string | null) {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'Explain',
    source: 'web_sourced',
    knowledge_ids: ['k-photo'],
    created_at: now,
    updated_at: now,
  });
  await db.insert(question_revision).values({
    revision_id: id,
    group_id: id,
    revision_ordinal: 1,
    integrity_digest: 'sha256:fixture',
    structure: { group_id: id, parts, materials: [] },
    response_spec: { slots },
    scoring_basis: { units: [unit], aggregation: { kind: 'sum' }, blank_scores_zero: false },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u1'],
          executor: {
            kind: 'model_executor',
            task_kind: task,
            admitted_slice_id: slice,
            max_cost_usd_micros: 10000,
          },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    availability: 'general_pool',
    published_at: now,
  });
}
async function ledgers() {
  const db = testDb();
  return {
    runs: await db.select().from(ai_task_runs),
    events: await db.select().from(event),
    slices: await db.select().from(model_admission_slice),
  };
}

afterEach(() => {
  __setPiAdapterForTests(undefined);
  resetTestConfig();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// @invariant grading: a closed photo binding prevents paid calls and automatic scores for image submissions and non-dry-run admission jobs, while text retains its request, score and admission thresholds
// @fails-if either entry reaches the provider or writes a claim/admission for images, or text loses its byte-identical model input, score or original minimum/four-class gate
it('keeps photo submissions unpaid through formal grading and admission without changing text', async () => {
  const target = new URL(process.env.TEST_DATABASE_URL ?? '');
  console.info('photo-gate DB target', {
    host: target.hostname,
    port: target.port,
    database: target.pathname.slice(1),
  });
  if (['5433', '5544'].includes(target.port) || target.pathname === '/loom')
    throw new Error('forbidden DB target');
  vi.stubGlobal('fetch', () => {
    throw new Error('network is forbidden');
  });
  vi.stubEnv('OPENCODE_API_KEY', 'synthetic-fixture-key');
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  setTestConfig({
    'task.AssessmentRuleJudgeTask.provider': 'opencode-go',
    'task.AssessmentRuleJudgeTask.model': model.id,
    'task.AssessmentRuleJudgeTask.reasoning': { level: 'none' },
    'task.AssessmentRuleJudgeTask.override_global_pin': true,
  });
  const requests: string[] = [];
  const streamSimple: NonNullable<PiAdapterDeps['models']>['streamSimple'] = (_model, context) => {
    const text = JSON.stringify(context.messages);
    console.info('raw model context', text);
    requests.push(
      JSON.stringify(
        context.messages.map((message) => ({ role: message.role, content: message.content })),
      ),
    );
    const award = Number(/award=(\d)/.exec(text)?.[1] ?? 4);
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: 'rule',
            rule_id: 'r1',
            points_awarded: award,
            confidence: 1,
            feedback_md: 'fixture',
            evidence_citations: [{ slot_id: 's1', quote: `award=${award}` }],
          }),
        },
      ],
      stopReason: 'stop',
      timestamp: now.getTime(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0.000001, output: 0.000001, cacheRead: 0, cacheWrite: 0, total: 0.000002 },
      },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  __setPiAdapterForTests(new PiAgentAdapter({ models: { getModel: () => model, streamSimple } }));
  let textInput: string | undefined;
  const formalRows: Array<{
    name: string;
    entries: SlotResponseT[];
    group: GroupEvidenceT[];
    photo: boolean;
  }> = [
    { name: 'text-before', entries: [open()], group: [], photo: false },
    { name: 'image-id-only', entries: [open('', [image])], group: [], photo: true },
    { name: 'text-and-image', entries: [open('award=4', [image])], group: [], photo: true },
    { name: 'empty-and-image', entries: [open('  ', [image])], group: [], photo: true },
    {
      name: 'group-image',
      entries: [open()],
      group: [{ evidence: image, target: { scope: 'all_units' } }],
      photo: true,
    },
    {
      name: 'other-slot-image',
      entries: [open(), { ...open('', [image]), slot_id: 's2' }],
      group: [],
      photo: true,
    },
    { name: 'text-after', entries: [open()], group: [], photo: false },
  ];
  for (const row of formalRows) {
    await resetDb();
    const db = testDb(),
      pin = currentModelPinForKind(task);
    if (!pin) throw new Error('missing task pin');
    const slice = await registerModelAdmissionSlice(db, {
      response_class: 'free',
      task_kind: task,
      ...pin,
      holdout_evidence_ref: 'fixture-evidence',
      admitted_by: 'owner',
    });
    await db
      .insert(knowledge)
      .values({ id: 'k-photo', name: 'Algebra', domain: 'math', created_at: now, updated_at: now });
    await seedRevision('formal-revision', slice.slice_id);
    await db.insert(assessment_issuance).values({
      issuance_id: 'issuance',
      revision_id: 'formal-revision',
      part_ids: ['p1'],
      material_bindings: [],
      option_order: [],
      container_occurrence_ref: null,
      claim_policy: 'one_time',
      claim_status: 'unclaimed',
      claimed_by_ref: null,
      issued_at: now,
    });
    await db
      .insert(evaluation_group)
      .values({ evaluation_group_id: 'group', submission_ids: ['submission'], created_at: now });
    await db.insert(assessment_submission).values({
      submission_id: 'submission',
      issuance_id: 'issuance',
      revision_id: 'formal-revision',
      evaluation_group_id: 'group',
      response_set: { entries: row.entries },
      group_evidence: row.group,
      idempotency_key: 'fixture',
      submitted_at: now,
    });
    const before = await ledgers(),
      calls = requests.length;
    const result = await evaluateSubmission(db, {
      submission_id: 'submission',
      evaluation_group_id: 'group',
      model_executor: createFormalModelExecutor(db),
    });
    const after = await ledgers();
    console.info(
      'formal raw readback',
      row.name,
      JSON.stringify({ result, ledger: after, calls: requests.length - calls }),
    );
    if (row.photo) {
      expect(result.record.unit_results, row.name).toMatchObject([
        { status: 'pending', pending: { reason: 'unjudgeable' } },
      ]);
      expect(requests.length, row.name).toBe(calls);
      expect(after.runs, row.name).toEqual(before.runs);
      expect(
        after.events.filter(
          (e) =>
            e.action === 'experimental:assessment_model_claim' ||
            e.action === 'experimental:assessment_model_result',
        ),
        row.name,
      ).toEqual([]);
    } else {
      expect(result.record.unit_results, row.name).toMatchObject([
        { status: 'scored', points_awarded: 4 },
      ]);
      expect(requests.length).toBe(calls + 1);
      if (textInput === undefined) textInput = requests[calls];
      else expect(requests[calls]).toBe(textInput);
      expect(after.runs).toHaveLength(1);
    }
    console.info(
      'formal row',
      row.name,
      result.record.unit_results,
      'provider calls',
      requests.length - calls,
    );
  }
  await resetDb();
  const db = testDb(),
    pin = currentModelPinForKind(task);
  if (!pin) throw new Error('missing task pin');
  await db
    .insert(knowledge)
    .values({ id: 'k-photo', name: 'Algebra', domain: 'math', created_at: now, updated_at: now });
  for (let i = 0; i < 30; i++) await seedRevision(`holdout-${i}`, null);
  const items: ModelSliceAdmissionRunDataT['items'] = Array.from({ length: 30 }, (_, i) =>
    (['correct', 'equivalent', 'wrong', 'partial'] as const).map((answer_class, c) => ({
      item_id: `${i}-${answer_class}`,
      revision_id: `holdout-${i}`,
      unit,
      question_parts: parts,
      response_slots: slots,
      slot_responses: [open(`award=${[4, 4, 0, 2][c]}`)],
      group_evidence: [],
      materials: [],
      reference_points: { correct: 4, equivalent: 4, wrong: 0, partial: 2 }[answer_class],
      answer_class,
      class_reason: 'independent synthetic reference',
    })),
  ).flat();
  const payload = (id: string, selected = items) => ({
    run_id: id,
    slice: { response_class: 'free' as const, task_kind: task, ...pin },
    items: selected,
    holdout_digest: `sha256:${canonicalHash(selected)}`,
    per_item_max_cost_usd_micros: 10000,
    admitted_by: 'owner',
  });
  for (const location of ['slot', 'group'] as const)
    for (const dry_run of [false, undefined]) {
      const photos = structuredClone(items),
        last = photos[photos.length - 1];
      if (!last) throw new Error('missing fixture item');
      if (location === 'slot') last.slot_responses = [open('award=2', [image])];
      else last.group_evidence = [{ evidence: image, target: { scope: 'all_units' } }];
      const before = await ledgers(),
        calls = requests.length;
      await expect(
        runModelSliceAdmission(db, {
          ...payload(`photo-${location}-${dry_run}`, photos),
          ...(dry_run === undefined ? {} : { dry_run }),
        }),
      ).rejects.toThrow('image comparisons require dry_run=true');
      expect(await ledgers()).toEqual(before);
      console.info('admission image refused', location, dry_run ?? 'omitted', 'ledger unchanged');
      expect(requests.length).toBe(calls);
    }
  const calls = requests.length;
  await expect(
    runModelSliceAdmission(db, payload('too-small', items.slice(0, 29))),
  ).rejects.toThrow('29 items < 30');
  await expect(
    runModelSliceAdmission(db, payload('missing-class', items.slice(0, 119))),
  ).rejects.toThrow('each with all four classes');
  expect(requests.length).toBe(calls);
  const reference = await runModelSliceAdmission(db, {
    ...payload('reference'),
    dry_run: true,
    comparison_role: 'reference',
  });
  expect(reference).toMatchObject({ dry_run: true, admitted: false });
  const candidate = await runModelSliceAdmission(db, {
    ...payload('candidate'),
    reference_run_id: 'reference',
  });
  console.info(
    'text admission readback',
    JSON.stringify({ reference, candidate, providerCalls: requests.length - calls }),
  );
  expect(candidate).toMatchObject({ passed: true, admitted: true, items: 120 });
  expect(requests.length - calls).toBe(240);
}, 120000);
