import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectCopilotActivity } from '@/capabilities/copilot/server/tool-activity';
import { generateReferenceSolution } from '@/capabilities/practice/question-bank/server/reference-solution';
import * as schema from '@/db/schema';
import { artifact, event, material_fsrs_state, question, source_asset } from '@/db/schema';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/kernel/records/assessment-normalization';
import {
  publishQuestionGroup,
  publishQuestionGroupFromRow,
} from '@/kernel/records/assessment-publication';
import type { ToolContext } from '@/kernel/tools/types';
import { executeDomainToolCall } from '@/server/ai/tools/mcp-bridge';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { fileBankGapTool } from '../../server/tools/file-bank-gap';
import { assertPaperOpenable } from '../../session/server/assessment/paper-issuance';
import { writeQuizTool } from '../../session/tools/write-quiz';
import { runEmbedBackfill } from '../jobs/embed_backfill';
import { selectBankReceipt } from '../public';
import { archiveQuestion, editQuestion } from '../server/question-bank-write';
import { encodeBankRef } from './bank-ref';
import { BankSearchScopeSchema, runSearchBank } from './bank-search';
import type { BankAssessment } from './bank-search-contract';
import { checkBankTool } from './check-bank';
import { readBankTool } from './read-bank';
import { searchBankTool } from './search-bank';

const db = testDb();

const embedState = vi.hoisted((): { vector: number[]; onBatch: (() => Promise<void>) | null } => ({
  onBatch: null,
  vector: (() => {
    const v = new Array(1024).fill(0);
    v[0] = 1;
    return v;
  })(),
}));
vi.mock('@/server/ai/embed', () => ({
  EMBED_MODEL: 'text-embedding-v4',
  embedText: async () => embedState.vector,
  embedMany: async (texts: string[]) => {
    await embedState.onBatch?.();
    return texts.map(() => embedState.vector.slice());
  },
}));

const ctx = {
  db,
  taskRunId: 'test-run',
  callerActor: { kind: 'agent' as const, ref: 'test' },
} satisfies ToolContext;

const ADMITTED = {
  state: 'admitted' as const,
  evidence: {
    marking_provenance: 'official' as const,
    verification: { structural_check_passed: true, independent_verification: null },
    model_slice: null,
  },
};

async function seedQuestion(id: string, overrides: Partial<typeof question.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'single_choice',
    prompt_md: `题 ${id}`,
    reference_md: 'B',
    choices_md: ['甲', '乙', '丙'],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    draft_status: 'active',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
    ...overrides,
  });
}

async function publishAdmitted(id: string) {
  const result = await publishQuestionGroupFromRow(db, {
    rootId: id,
    admission: ADMITTED,
    availability: 'general_pool',
    actorRef: 'test:publish',
    now: new Date(),
  });
  if (result.status !== 'published') throw new Error(`publish failed: ${result.status}`);
  return result;
}

async function searchHits(input: Record<string, unknown>) {
  const { query, limit, cursor, ...scope } = input;
  return runSearchBank(
    db,
    cursor
      ? { form: 'cursor', cursor: String(cursor) }
      : {
          form: 'new',
          query: String(query ?? ''),
          limit: Number(limit ?? 20),
          scope: BankSearchScopeSchema.parse({
            draft_state: 'all',
            admission_state: 'any',
            ...scope,
          }),
        },
  );
}

async function receiptFixture(run: string, kinds?: string[]) {
  vi.stubEnv('BANK_GAP_EVIDENCE_SECRET', 'bank-boundary-fixture-signing-key-at-least-32-chars');
  await seedQuestion('receipt-question', {
    prompt_md: '边界样本：已知二次方程，判断根的个数。',
    knowledge_ids: ['math'],
  });
  await publishAdmitted('receipt-question');
  const owner: ToolContext = {
    ...ctx,
    taskRunId: run,
    callerActor: { kind: 'user', ref: 'receipt-owner' },
  };
  const search = await searchBankTool.execute(owner, {
    query: '边界样本',
    count: 2,
    ...(kinds ? { filters: { kinds } } : {}),
  });
  const hit = search.hits[0];
  const evidence = [{ source: hit.evidence[0].source, quote: hit.evidence[0].text }];
  if (!hit.ref) throw new Error('Published fixture has no revision ref');
  const assessment: BankAssessment = {
    ref: hit.ref,
    parts: hit.parts,
    checks: [{ condition: 'r1', verdict: 'supported', evidence }],
    joint: { verdict: 'supported', evidence },
  };
  return { owner, search, assessment };
}

describe('bank tools boundary invariants (search_bank / read_bank / check_bank)', () => {
  beforeEach(async () => {
    vi.stubEnv('BANK_GAP_EVIDENCE_SECRET', 'bank-boundary-fixture-signing-key-at-least-32-chars');
    await resetDb();
  });

  // @invariant data: served-face search returns only eligible items (withdrawn never; drafts/withheld only on the explicit dedup face) @fails-if a hard filter is dropped or ignored in SQL so withdrawn/withheld/draft items leak into the admitted+active served hits
  it('hard filters cannot be bypassed: withdrawn never served; draft/admission filters hold', async () => {
    await seedQuestion('bt_admitted', {
      prompt_md: '电容器充放电过程中电荷量的变化判断题（已准入）',
      embedding: embedState.vector.slice(),
      embed_model: 'text-embedding-v4',
      embed_version: 2,
      embed_content_hash: 'seed-bt-admitted',
    });
    await publishAdmitted('bt_admitted');
    await seedQuestion('bt_withheld', { prompt_md: '电容器充放电的位移电流说法判断（未过准入）' });
    const withheldPub = await publishQuestionGroupFromRow(db, {
      rootId: 'bt_withheld',
      actorRef: 'test:publish',
      now: new Date(),
    });
    if (withheldPub.status !== 'published') throw new Error('withheld publish failed');
    await seedQuestion('bt_draft', {
      prompt_md: '电容器充放电平衡态的新拟草稿（draft）',
      draft_status: 'draft',
    });
    await seedQuestion('bt_withdrawn', { prompt_md: '电容器充放电旧题（已归档撤回）' });
    await publishAdmitted('bt_withdrawn');
    const [row] = await db.select().from(question).where(eq(question.id, 'bt_withdrawn'));
    const archived = await archiveQuestion(db, 'bt_withdrawn', row.version, 'test');
    expect(archived.status).toBe('archived');

    await seedQuestion('bt_wrong_source', {
      prompt_md: '电容器充放电来源不匹配',
      source: 'manual',
    });
    await publishAdmitted('bt_wrong_source');
    await seedQuestion('bt_wrong_kind', { prompt_md: '电容器充放电题型不匹配', kind: 'reading' });
    await publishAdmitted('bt_wrong_kind');
    const served = await searchHits({
      query: '电容器 充放电',
      admission_state: 'admitted',
      draft_state: 'active',
      source: 'web_sourced',
      kind: 'choice',
    });
    expect(served.hits.map((h) => h.question_id)).toEqual(['bt_admitted']);
    expect(served.hits[0].ref).toMatch(/^qrev1:/);
    const literal = await searchBankTool.execute(ctx, {
      query: '电容器',
      filters: { terms: ['已准入'] },
    });
    expect(literal.hits.map((h) => h.id)).toEqual(['bt_admitted']);
    const wrong = await searchBankTool.execute(ctx, {
      query: '电容器',
      filters: { history: 'wrong' },
    });
    expect(wrong.hits).toEqual([]);
    await db.insert(event).values({
      id: 'bank-real-failure',
      actor_kind: 'user',
      actor_ref: 'learner',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'bt_admitted',
      outcome: 'failure',
      payload: { answer_md: 'incorrect' },
    });
    const failedHistory = await searchBankTool.execute(ctx, {
      query: '电容器',
      filters: { history: 'wrong' },
    });
    expect(failedHistory.hits.map((h) => h.id)).toEqual(['bt_admitted']);
    await db.insert(schema.item_calibration).values({
      id: 'bank-calibration',
      question_id: 'bt_admitted',
      source: 'fixed_anchor',
      b_post: 0.7,
    });
    const calibrated = await searchBankTool.execute(ctx, {
      query: '电容器',
      filters: { difficulty: { basis: 'calibrated', range: [0.6, 0.8] } },
    });
    expect(calibrated.hits.map((h) => h.id)).toEqual(['bt_admitted']);
    expect(calibrated.hits[0].facts.difficulty.basis).toBe('calibrated');
    expect(calibrated.hits[0].facts.difficulty.value).toBeCloseTo(0.7);

    const dedup = await searchHits({ query: '电容器 充放电' });
    const ids = dedup.hits.map((h) => h.question_id);
    expect(ids).toContain('bt_admitted');
    expect(ids).toContain('bt_withheld');
    expect(ids).toContain('bt_draft');
    expect(ids).not.toContain('bt_withdrawn');
    const draftHit = dedup.hits.find((h) => h.question_id === 'bt_draft');
    expect(draftHit?.ref).toBeNull();
    expect(draftHit?.missing).toContain('no_published_revision');
    const admittedRef = served.hits[0].ref;
    expect(admittedRef).not.toBeNull();
    expect((await searchHits({ query: '电容器', within_refs: [] })).hits).toEqual([]);
    const narrowed = await searchHits({ query: '电容器', within_refs: [admittedRef] });
    expect(narrowed.hits.map((hit) => hit.ref)).toEqual([admittedRef]);
    const missingScope = {
      subject: 'missing-subject',
      kind: 'choice',
      source: 'web_sourced',
      draft_state: 'active',
      admission_state: 'admitted',
      within_refs: [admittedRef],
    };
    const absent = await searchHits({ query: '电容器', ...missingScope, limit: 6 });
    expect(absent.hits).toEqual([]);
    expect(absent.coverage.verdict).toBe('none');
    expect(absent.coverage.unsatisfied_constraints).toEqual([
      {
        query: '电容器',
        scope: missingScope,
        requested_count: 6,
        retrieved_count: 0,
        reason: 'insufficient_retrieved_candidates',
      },
    ]);
    expect(absent.coverage.gap_request).toMatchObject({
      target_contract: 'EvidenceDemandV1',
      claim: { kind: 'content_coverage', statement: '电容器' },
      inventory_goal: { eligible_count: 6 },
      constraints: absent.coverage.unsatisfied_constraints[0],
    });
    const invalidCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        q: '电容器',
        scope: { admission_state: 'INVALID' },
        limit: -1,
        offset: 0,
        f: '0'.repeat(16),
      }),
    ).toString('base64url');
    await expect(searchHits({ cursor: invalidCursor })).rejects.toThrow('valid bank-search cursor');

    // A legacy admitted group may contain a human-only sibling. Search advertises
    // only eligible parts; checking the actual selected part must match issuance.
    await seedQuestion('bt_mixed', { prompt_md: '混合判分题组', kind: 'reading' });
    await seedQuestion('bt_auto_part', { parent_question_id: 'bt_mixed', part_index: 0 });
    await seedQuestion('bt_human_part', { parent_question_id: 'bt_mixed', part_index: 1 });
    const [root] = await db.select().from(question).where(eq(question.id, 'bt_mixed'));
    const parts = await db.select().from(question).where(eq(question.parent_question_id, root.id));
    const contract = normalizeQuestionGroupToContract(root, parts);
    const humanSlots = contract.response_spec.slots
      .filter((slot) => slot.part_id === 'bt_human_part')
      .map((slot) => slot.slot_id);
    const humanUnits = new Set(
      contract.scoring_basis.units
        .filter((unit) => unit.slot_refs.some((slot) => humanSlots.includes(slot)))
        .map((unit) => unit.scoring_unit_id),
    );
    contract.execution_plan.assignments = contract.execution_plan.assignments.flatMap(
      (assignment) =>
        assignment.scoring_unit_ids.map((id) => ({
          scoring_unit_ids: [id],
          executor: humanUnits.has(id) ? { kind: 'human_review' as const } : assignment.executor,
        })),
    );
    contract.integrity_digest = contractIntegrityDigest(contract);
    const mixed = await publishQuestionGroup(db, {
      group_id: root.id,
      contract,
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      admission: ADMITTED,
      availability: 'general_pool',
      actorRef: 'test:mixed',
      now: new Date(),
    });
    if (mixed.status !== 'published') throw new Error('mixed publish failed');
    const mixedRef = encodeBankRef(mixed.revision_id, mixed.revision_digest);
    const mixedSearch = await searchHits({ query: '混合判分', admission_state: 'admitted' });
    expect(
      mixedSearch.hits.find((hit) => hit.ref === mixedRef)?.automatically_servable_part_ids,
    ).toEqual(['bt_auto_part']);
    const mixedChecks = await checkBankTool.execute(
      ctx,
      checkBankTool.inputSchema.parse({
        checks: ['bt_auto_part', 'bt_human_part'].map((part) => ({
          id: part,
          refs: [mixedRef],
          kind: 'ref_state',
          params: { assert: 'is_servable', part_ids: [part] },
        })),
      }),
    );
    expect(mixedChecks.checks.map((check) => check.verdict)).toEqual(['supported', 'contradicted']);
  });

  // @invariant data: a versioned ref resolves to its exact immutable revision or returns an explicit per-ref error @fails-if ref resolution falls back to the group current revision or swallows unresolvable/digest-mismatch/withdrawn as an ok read
  it('a ref never silently swaps to latest; expired/withdrawn refs are explicit errors', async () => {
    await seedQuestion('bt_versioned', {
      prompt_md: '求 f(x)=√(x-3) 的定义域（第一版题面）',
    });
    const v1 = await publishAdmitted('bt_versioned');
    const v1Ref = encodeBankRef(v1.revision_id, v1.revision_digest);
    await seedQuestion('bt_page_two', { prompt_md: '函数定义域第二个候选' });
    await publishAdmitted('bt_page_two');
    const firstPage = await searchHits({ query: '定义域', limit: 1 });
    const cursor = firstPage.coverage.next_cursor;
    expect(cursor).not.toBeNull();
    await seedQuestion('bt_page_new', { prompt_md: '函数定义域新插入候选' });
    const resumed = await searchHits({ cursor });
    expect(resumed.hits).toEqual((await searchHits({ cursor })).hits);
    expect(resumed.hits.map((hit) => hit.question_id)).not.toContain('bt_page_new');
    expect(resumed.hits[0].question_id).not.toBe(firstPage.hits[0].question_id);

    const [row] = await db.select().from(question).where(eq(question.id, 'bt_versioned'));
    const edit = await editQuestion(
      db,
      'bt_versioned',
      row.version,
      {
        prompt_md: '求 f(x)=√(2x-6) 的定义域（第二版题面，条件已改）',
      },
      'test:edit',
    );
    expect(edit.status).toBe('updated');
    await expect(searchHits({ cursor })).rejects.toThrow('candidate snapshot changed');

    const secondRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [v1Ref], include: ['content', 'relations'] }),
    );
    const item = secondRead.items[0];
    expect(item.status).toBe('ok');
    if (item.status !== 'ok') return;
    expect(item.content?.parts[0].prompt_md).toContain('第一版题面');
    expect(item.current).toBe(false);
    await expect(searchHits({ query: '定义域', within_refs: [v1Ref] })).rejects.toThrow(
      'superseded',
    );
    expect(item.lifecycle.current_revision_ref).not.toBeNull();
    expect(item.lifecycle.current_revision_ref).not.toBe(v1Ref);

    const check = await checkBankTool.execute(
      ctx,
      checkBankTool.inputSchema.parse({
        checks: [{ id: 'old-is-current', refs: [v1Ref], kind: 'ref_state' }],
      }),
    );
    expect(check.checks[0].verdict).toBe('contradicted');

    const tampered = `qrev1:${v1.revision_id}:${'0'.repeat(12)}`;
    const ghost = `qrev1:ghost123456789:${'a'.repeat(12)}`;
    const errs = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [tampered, ghost] }),
    );
    expect(errs.items.map((i) => i.status).sort()).toEqual(['digest_mismatch', 'unresolvable']);

    const [row2] = await db.select().from(question).where(eq(question.id, 'bt_versioned'));
    await archiveQuestion(db, 'bt_versioned', row2.version, 'test');
    const withdrawnRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [v1Ref] }),
    );
    expect(withdrawnRead.items[0].status).toBe('withdrawn');
  });

  // @invariant data: material coverage distinguishes absent assets from present verified figures @fails-if asset absence is hidden or a bare storage SHA mismatches its sha256-prefixed revision digest
  it('missing figures are reported honestly, not hidden behind a readable stem', async () => {
    await seedQuestion('bt_fig', {
      prompt_md: '如图所示，在正方体中求异面直线所成角。（图缺失题）',
      figures: [
        {
          asset_id: 'bt_missing_asset',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, width: 1, height: 1 },
          attached_to_index: 'stem',
          attach_confidence: 'manual',
        },
      ],
    });
    const pub = await publishAdmitted('bt_fig');
    const ref = encodeBankRef(pub.revision_id, pub.revision_digest);

    const read = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [ref], include: ['content', 'materials'] }),
    );
    const item = read.items[0];
    expect(item.status).toBe('ok');
    if (item.status !== 'ok') return;
    expect(item.content?.parts[0].prompt_md).toContain('正方体'); // 题面仍可读
    expect(item.coverage.complete).toBe(false); // 但缺口不被掩盖
    expect(item.coverage.unavailable.join(' ')).toContain('bt_missing_asset');
    const material = (item.materials ?? []).find((m) => m.asset.asset_id === 'bt_missing_asset');
    expect(material?.asset.present).toBe(false);
    // 缺文件不能被标成已核对；null = 行不在，和「摘要比对通过」区分开。
    expect(material?.asset.digest_verified).toBeNull();
    // A present verified figure must succeed; this catches prefix-only false gaps.
    await db.insert(source_asset).values({
      id: 'bt_present_asset',
      kind: 'image',
      storage_key: 'fixture/figure',
      mime_type: 'image/png',
      byte_size: 100,
      sha256: 'a'.repeat(64),
      created_at: new Date(),
    });
    await seedQuestion('bt_present', {
      prompt_md: '图示完整的正方体',
      figures: [
        {
          asset_id: 'bt_present_asset',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, width: 1, height: 1 },
          attached_to_index: 'stem',
          attach_confidence: 'manual',
        },
      ],
    });
    const presentPub = await publishAdmitted('bt_present');
    const presentRef = encodeBankRef(presentPub.revision_id, presentPub.revision_digest);
    // 默认 overview 不带材料，但任何 include 都核验二进制资产。在场且摘要相符
    // 时这里必须完整，用来抓住「裸 sha256 对不上 sha256: 前缀」的假缺口。
    const overview = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [presentRef] }),
    );
    const overviewItem = overview.items[0];
    expect(overviewItem.status).toBe('ok');
    if (overviewItem.status !== 'ok') return;
    expect(overviewItem.coverage.complete).toBe(true);

    const presentRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({ refs: [presentRef], include: ['materials'] }),
    );
    const presentItem = presentRead.items[0];
    expect(presentItem.status).toBe('ok');
    if (presentItem.status !== 'ok') return;
    // 受限角色要材料层时，私人参考答案会被省略，coverage 因此不完整。
    // 这不能把在场的图说成缺文件或摘要不符。
    expect(presentItem.coverage.unavailable.join(' ')).toContain('private material');
    expect(presentItem.coverage.unavailable.join(' ')).not.toContain('bt_present_asset');
    const presentMaterial = (presentItem.materials ?? []).find(
      (m) => m.asset.asset_id === 'bt_present_asset',
    );
    expect(presentMaterial?.asset.present).toBe(true);
    expect(presentMaterial?.asset.digest_verified).toBe(true);
    const checked = await checkBankTool.execute(
      ctx,
      checkBankTool.inputSchema.parse({
        checks: [{ id: 'asset', refs: [presentRef], kind: 'material_assets_present' }],
      }),
    );
    expect(checked.checks[0].verdict).toBe('supported');
  });

  // @invariant security: the copilot and question_preparer actors read every private layer while an unlisted agent ref stays denied @fails-if either granted actor regresses to denied_layers or a bare unlisted agent ref gains answers/rubric/private materials
  it('grants copilot the answer layer and keeps an unlisted actor restricted', async () => {
    await seedQuestion('bt_copilot_role', { prompt_md: '读层授权边界题' });
    const pub = await publishAdmitted('bt_copilot_role');
    const ref = encodeBankRef(pub.revision_id, pub.revision_digest);
    const privateLayers = ['answers', 'rubric', 'scoring', 'execution', 'metadata'] as const;

    for (const actorRef of ['agent:copilot', 'agent:question_preparer'] as const) {
      const grantedRead = await readBankTool.execute(
        { ...ctx, callerActor: { kind: 'agent' as const, ref: actorRef } },
        readBankTool.inputSchema.parse({
          refs: [ref],
          include: ['materials', ...privateLayers],
        }),
      );
      const granted = grantedRead.items[0];
      expect(granted.status).toBe('ok');
      if (granted.status !== 'ok') continue;
      expect(granted.denied_layers ?? []).toEqual([]);
      expect(granted.answers?.units.length).toBeGreaterThan(0);
      expect((granted.materials ?? []).some((m) => m.visibility === 'private')).toBe(true);
    }

    const deniedRead = await readBankTool.execute(
      ctx,
      readBankTool.inputSchema.parse({
        refs: [ref],
        include: ['materials', ...privateLayers],
      }),
    );
    const denied = deniedRead.items[0];
    expect(denied.status).toBe('ok');
    if (denied.status !== 'ok') return;
    expect(denied.denied_layers).toEqual([...privateLayers]);
    expect(denied.answers).toBeUndefined();
    expect((denied.materials ?? []).some((m) => m.visibility === 'private')).toBe(false);
  });

  // @invariant security: bank tools expose no learner-state fields and mutate no learner-state rows while serving @fails-if a tool directly accesses learner tables without bank-role permission, returns learner-state fields, changes persisted learner rows, or evaluates refs outside a read-only repeatable-read snapshot
  it('the tools neither return nor mutate learner state', async () => {
    await seedQuestion('bt_learner', { prompt_md: '等比数列通项公式求解题（带学习者历史）' });
    await seedQuestion('bt_learner_part', { parent_question_id: 'bt_learner', part_index: 0 });
    const pub = await publishAdmitted('bt_learner');
    const ref = encodeBankRef(pub.revision_id, pub.revision_digest);

    await db.insert(event).values({
      id: 'bt_evt_attempt',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'test',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'bt_learner',
      outcome: 'failure',
      payload: { answer: 'wrong' },
      created_at: new Date(),
    });
    await db.insert(material_fsrs_state).values({
      id: 'bt_fsrs_card',
      subject_kind: 'question',
      subject_id: 'bt_learner',
      state: {
        due: new Date('2026-10-12T00:00:00.000Z'),
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: new Date('2026-10-11T00:00:00.000Z'),
      },
      due_at: new Date('2026-10-12T00:00:00.000Z'),
    });

    const before = {
      events: await db.select().from(event),
      fsrs: await db.select().from(material_fsrs_state),
    };
    // A real PG role can read bank-owned tables only and cannot write any table.
    // Direct learner-state access fails; the controlled owner function returns only a purpose bit.
    const role = `bank_read_${randomUUID().replaceAll('-', '')}`;
    await db.execute(sql.raw(`CREATE ROLE "${role}" NOLOGIN`));
    const client = postgres(process.env.TEST_DATABASE_URL ?? '', { max: 1 });
    const bankDb = drizzle(client, { schema });
    try {
      await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
      await db.execute(
        sql.raw(
          `GRANT SELECT ON question, question_revision, question_group_lifecycle, source_asset TO "${role}"`,
        ),
      );
      await db.execute(
        sql.raw(`GRANT SELECT, INSERT, DELETE ON bank_search_snapshot TO "${role}"`),
      );
      await bankDb.execute(sql.raw(`SET ROLE "${role}"`));
      const bankCtx = { ...ctx, db: bankDb } satisfies ToolContext;
      const read = await readBankTool.execute(
        bankCtx,
        readBankTool.inputSchema.parse({
          refs: [ref],
          include: ['content', 'answers', 'metadata', 'solution_prior'],
        }),
      );
      // The real PG role can see revisions only inside one read-only RR snapshot.
      // A lost transaction or a live-current helper call outside it hides the ref,
      // making the actual search/check assertions fail (no mocked query boundary).
      await db.execute(sql.raw('ALTER TABLE question_revision ENABLE ROW LEVEL SECURITY'));
      await db.execute(
        sql.raw(`CREATE POLICY bank_snapshot ON question_revision FOR SELECT TO "${role}"
        USING (current_setting('transaction_isolation') = 'repeatable read'
          AND current_setting('transaction_read_only') = 'on')`),
      );
      const search = await searchBankTool.execute(
        bankCtx,
        searchBankTool.inputSchema.parse({ query: '等比数列 通项' }),
      );
      const check = await checkBankTool.execute(
        bankCtx,
        checkBankTool.inputSchema.parse({ checks: [{ id: 's', refs: [ref], kind: 'ref_state' }] }),
      );
      expect(search.hits.map((hit) => hit.ref)).toContain(ref);
      expect(read.items[0].status).toBe('ok');
      expect(check.checks[0].verdict).toBe('supported');
      expect(JSON.stringify({ search, read, check })).not.toMatch(
        /"(attempts|review_history|fsrs_state|mastery|records)"/,
      );
    } finally {
      await client.end();
      await db.execute(sql.raw('DROP POLICY IF EXISTS bank_snapshot ON question_revision'));
      await db.execute(sql.raw('ALTER TABLE question_revision DISABLE ROW LEVEL SECURITY'));
      await db.execute(sql.raw(`DROP OWNED BY "${role}"`));
      await db.execute(sql.raw(`DROP ROLE "${role}"`));
    }
    expect(await db.select().from(event)).toEqual(before.events);
    expect(await db.select().from(material_fsrs_state)).toEqual(before.fsrs);
  });

  // @invariant data: a content-changing backfill invalidates the stale embedding so the old vector stops being recalled @fails-if an in-flight embedding response refills a NULL slot after the source content changed
  it('after a reference-solution backfill changes content, the old vector is no longer used', async () => {
    const axisVector = (i: number) => {
      const v = new Array<number>(1024).fill(0);
      v[i] = 1;
      return v;
    };
    embedState.vector = axisVector(3);
    await seedQuestion('bt_stale_vec', {
      prompt_md: '椭圆离心率的取值范围判断题（补写参考答案前）',
      reference_md: null,
      embedding: axisVector(3),
      embed_model: 'text-embedding-v4',
      embed_version: 2,
      embed_content_hash: 'stale-hash-before-backfill',
    });

    embedState.onBatch = async () => {
      const backfill = await generateReferenceSolution({
        db,
        questionId: 'bt_stale_vec',
        runTaskFn: async () => ({
          text: JSON.stringify({
            reference_solution: {
              expected_signals: ['椭圆定义'],
              final_answer: '0<e<1',
              answer_equivalents: [],
            },
            worked_solution_md: '由椭圆定义 0<e<1，逐一核对选项。',
            confidence: 0.9,
          }),
        }),
      });
      expect(backfill.status).toBe('generated');
    };
    // Pause the external embedding response until the real content update commits.
    await db.update(question).set({ embed_version: 1 }).where(eq(question.id, 'bt_stale_vec'));
    try {
      expect(await runEmbedBackfill(db)).toBe(0);
    } finally {
      embedState.onBatch = null;
    }

    const [row] = await db.select().from(question).where(eq(question.id, 'bt_stale_vec'));
    expect(row.embedding).toBeNull();
    const search = await searchHits({ query: '万有引力人造卫星轨道' });
    expect(search.hits.map((h) => h.question_id)).not.toContain('bt_stale_vec');
  });
  // @invariant grading: deterministic checks never support an uninterpreted claim or silently substitute a different assertion
  // @fails-if a free-text claim or unsupported assertion receives supported from a narrower ref-state predicate
  it('check_bank preserves unknown for unsupported claims and assertions', async () => {
    await seedQuestion('bt_claim', { prompt_md: '同材料不等于同文章的阅读判断题' });
    const pub = await publishAdmitted('bt_claim');
    const ref = encodeBankRef(pub.revision_id, pub.revision_digest);
    const output = await checkBankTool.execute(
      ctx,
      checkBankTool.inputSchema.parse({
        allow_model: true,
        checks: [
          { id: 'current', kind: 'ref_state', refs: [ref] },
          {
            id: 'claim',
            kind: 'ref_state',
            refs: [ref],
            claim: 'This question proves the learner has mastered reading.',
          },
          {
            id: 'unsupported',
            kind: 'ref_state',
            refs: [ref],
            params: { assert: 'learner_mastered' },
          },
        ],
      }),
    );
    expect(output.checks.map((check) => check.verdict)).toEqual([
      'supported',
      'unknown',
      'unknown',
    ]);
    expect(output.checks[1].interpretation).toBe(
      'This question proves the learner has mastered reading.',
    );
  });

  // @invariant security: caller judgments keep their provenance and unknown/contradicted required never qualify @fails-if a caller opinion is stored as a verified fact, uncited support is accepted or unknown/contradicted enters a paper
  it('requires cited supported conditions and joint while retaining caller attribution', async () => {
    const { owner, search, assessment } = await receiptFixture('receipt-judgment');
    await expect(
      searchBankTool.execute(owner, { query: '边界样本', conditions: [] }),
    ).rejects.toThrow('required');
    const inspection = await searchBankTool.execute(owner, {
      query: '边界样本',
      use: 'inspect',
      conditions: [],
    });
    await expect(
      writeQuizTool.execute(owner, { search_id: inspection.search_id, assessments: [] }),
    ).rejects.toThrow('practice or inventory');
    await seedQuestion('unread-part', { prompt_md: '未读图样本 ![图](missing.png)' });
    await publishAdmitted('unread-part');
    const unread = await searchBankTool.execute(owner, {
      query: '未读图样本',
      filters: { terms: ['未读图样本'] },
    });
    const hit = unread.hits[0];
    expect(hit.missing.some((m) => m.reason === 'media_not_read')).toBe(true);
    const evidence = [{ source: hit.evidence[0].source, quote: hit.evidence[0].text }];
    await expect(
      writeQuizTool.execute(owner, {
        search_id: unread.search_id,
        assessments: [
          {
            ref: hit.ref!,
            parts: hit.parts,
            checks: [{ condition: 'r1', verdict: 'supported', evidence }],
            joint: { verdict: 'supported', evidence },
          },
        ],
      }),
    ).rejects.toThrow('supported required and joint');

    for (const verdict of ['unknown', 'contradicted'] as const) {
      const rejected = { ...assessment, checks: assessment.checks.map((c) => ({ ...c, verdict })) };
      await expect(
        writeQuizTool.execute(owner, { search_id: search.search_id, assessments: [rejected] }),
      ).rejects.toThrow('supported required and joint');
    }
    await expect(
      writeQuizTool.execute(owner, {
        search_id: search.search_id,
        assessments: [
          {
            ...assessment,
            joint: { verdict: 'supported', evidence: [{ source: 'foreign', quote: 'forged' }] },
          },
        ],
      }),
    ).rejects.toThrow('authorized selected content');
    expect(await db.select().from(artifact)).toHaveLength(0);
    await writeQuizTool.execute(owner, { search_id: search.search_id, assessments: [assessment] });
    const [paper] = await db.select().from(artifact);
    expect(paper.tool_state).toMatchObject({
      session_meta: { bank_decision_source: 'caller_assessed' },
    });
    expect(JSON.stringify(paper.tool_state)).not.toContain(assessment.joint.evidence[0].quote);
  });

  // @invariant security: private receipt quotes never reach learner tool activity or mirrored events
  // @fails-if assessment quotes or demand prose survive the live, persisted or tool_use projection
  it('keeps receipt evidence out of learner-visible tool activity', async () => {
    const { owner, search, assessment } = await receiptFixture('receipt-private');
    const marker = 'PRIVATE_REFERENCE_RUBRIC_SENTINEL';
    const input = {
      search_id: search.search_id,
      assessments: [
        {
          ...assessment,
          joint: {
            verdict: 'supported',
            evidence: [{ source: 'criterion:private', quote: marker }],
          },
        },
      ],
    };
    const visible: unknown[] = [];
    const start = projectCopilotActivity({ kind: 'tool_started', toolName: 'write_quiz', input });
    visible.push(start);
    await executeDomainToolCall(writeQuizTool, input, {
      ctx: { ...owner, callerActor: { kind: 'agent', ref: 'copilot' } },
      onToolComplete: (call) => {
        visible.push(call);
        visible.push(projectCopilotActivity({ kind: 'tool_finished', ...call }));
      },
    });
    visible.push(...(await db.select().from(event).where(eq(event.action, 'tool_use'))));
    expect(visible.length).toBeGreaterThan(3);
    expect(JSON.stringify(visible)).not.toContain(marker);
    expect(start?.input).toEqual({ search_id: search.search_id, assessments_count: 1 });
    expect(
      projectCopilotActivity({
        kind: 'tool_started',
        toolName: 'file_bank_gap',
        input: { ...input, demand: { claim: { statement: marker } } },
      })?.input,
    ).toEqual({ search_id: search.search_id, assessments_count: 1 });
  });

  // @invariant concurrency: receipt-based paper selection serializes and never issues another revision @fails-if concurrent same-run calls create two papers or a later current revision silently replaces the selected one at paper opening
  it('serializes receipt consumption and rejects replacement revisions when opening the paper', async () => {
    const { owner, search, assessment } = await receiptFixture('receipt-paper-race');
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        writeQuizTool.execute(owner, { search_id: search.search_id, assessments: [assessment] }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const papers = await db.select().from(artifact);
    expect(papers).toHaveLength(1);
    await editQuestion(
      db,
      'receipt-question',
      0,
      { prompt_md: '边界样本：修改后的另一份题面。' },
      'receipt-edit',
    );
    await expect(db.transaction((tx) => assertPaperOpenable(tx, papers[0].id))).rejects.toThrow(
      'searched question revision changed',
    );
  });

  // @invariant concurrency: a filing binds the original receipt and concurrent identical content is idempotent @fails-if stale evidence can file, a repeated request creates multiple ledger claims, or changed judgments replay as identical
  it('revalidates gap evidence and deduplicates concurrent filings without upgrading caller judgments', async () => {
    const { owner, search, assessment } = await receiptFixture('receipt-gap-race', [
      'choice',
      'fill_blank',
    ]);
    const negative = {
      ...assessment,
      checks: assessment.checks.map((c) => ({ ...c, verdict: 'contradicted' as const })),
      joint: { ...assessment.joint, verdict: 'contradicted' as const },
    };
    const demand = {
      version: 1 as const,
      demand_id: 'receipt-gap',
      policy_version: 'supply-v2-phase-a',
      subject_id: 'math',
      claim: { kind: 'content_coverage' as const, knowledge_ids: ['math'], statement: '边界样本' },
      evidence: { observables: ['correct response'], minimum_observations: 1 },
      task: { kinds: ['choice', 'fill_blank'], allowed_uses: ['practice' as const] },
      difficulty: { band: 'near' as const, scale: 'authored', target_value: null },
      inventory_goal: { eligible_count: 2, horizon_days: 7 },
      control: { needed_by: null, max_budget_micro_usd: 0, max_attempts: 1 },
      causes: [{ kind: 'coverage_gap' as const }],
    };
    await db.insert(schema.knowledge).values({
      id: 'math',
      name: '数学',
      domain: 'math',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const ticket = { ...demand, inventory_goal: { ...demand.inventory_goal, eligible_count: 12 } };
    const preparer = {
      ...owner,
      callerActor: { kind: 'agent' as const, ref: 'question_preparer' },
      supplyDemand: ticket,
    };
    await expect(
      searchBankTool.execute(preparer, { query: '边界样本', use: 'inventory', count: 2 }),
    ).rejects.toThrow('bound ticket');
    const stock = await searchBankTool.execute(preparer, {
      query: '边界样本',
      use: 'inventory',
      page_size: 1,
    });
    expect(stock.goal).toEqual({ use: 'inventory', count: 12 });
    expect(stock.hits.map((h) => h.id)).toEqual(['receipt-question']);
    expect(stock.conditions[0].text).toContain('correct response');
    await db
      .update(schema.bank_search_snapshot)
      .set({
        as_of: new Date(Date.now() - 20 * 60_000),
        expires_at: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(schema.bank_search_snapshot.search_id, stock.search_id));
    await expect(
      selectBankReceipt(db, preparer, stock.search_id, [assessment], true, true),
    ).resolves.toMatchObject({ accepted_refs: [assessment.ref] });
    await expect(
      writeQuizTool.execute(preparer, { search_id: stock.search_id, assessments: [assessment] }),
    ).rejects.toThrow('expired');

    await expect(
      writeQuizTool.execute(
        { ...owner, supplyDemand: { ...ticket, demand_id: 'other-ticket' } },
        {
          search_id: stock.search_id,
          assessments: [assessment],
        },
      ),
    ).rejects.toThrow();
    const input = {
      request_id: 'receipt-gap-request',
      demand,
      search_id: search.search_id,
      assessments: [negative],
    };
    const filings = await Promise.all([
      fileBankGapTool.execute(owner, input),
      fileBankGapTool.execute(owner, input),
    ]);
    expect(
      filings.every((f) => f.status === 'held' && f.reason.startsWith('budget_exhausted')),
    ).toBe(true);
    expect(filings.filter((f) => f.deduplicated)).toHaveLength(1);
    expect(
      await db.select().from(event).where(eq(event.id, 'fbgap|receipt-gap-request')),
    ).toHaveLength(1);
    const changed = await fileBankGapTool.execute(owner, {
      ...input,
      assessments: [
        {
          ...negative,
          checks: negative.checks.map((c) => ({ ...c, verdict: 'unknown' as const })),
        },
      ],
    });
    expect(changed.status).toBe('rejected');
    await editQuestion(db, 'receipt-question', 0, { prompt_md: '新题面' }, 'receipt-edit');
    await expect(
      fileBankGapTool.execute(owner, { ...input, request_id: 'stale-gap-request' }),
    ).rejects.toThrow('stale');
    expect(
      await db.select().from(event).where(eq(event.id, 'fbgap|stale-gap-request')),
    ).toHaveLength(0);
    await db.update(schema.bank_search_snapshot).set({
      as_of: new Date(Date.now() - 20 * 60_000),
      expires_at: new Date(Date.now() - 5 * 60_000),
    });
    const replay = await fileBankGapTool.execute(
      { ...owner, taskRunId: 'retry-after-response-loss' },
      input,
    );
    expect(replay.deduplicated).toBe(true);
    expect(replay.status).toBe('held');
  });
});
