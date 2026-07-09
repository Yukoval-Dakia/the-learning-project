// YUK-579 — GET /api/admin/coverage-lattice db 测（真实 Postgres）。断言：
//   1. 形状：subjects → KC 行（池级判词从真实 scanCoverageGaps 反读）+ emitted 缺口 targets。
//   2. 诚实（should#3 agreement）：空池 KC 三轴 null + frontier_zero；低档单题 KC → source_quality
//      + diagnostic；满覆盖 KC 无这三类缺口。invariant：depthMet ⟺ usableCount≥threshold ⟺
//      frontier_zero 缺席；usableCount===0 ⟺ 三轴 null。
//   3. MF1 活动 join：seed 一条 fingerprint 匹配的 dispatched 事件 → 该 gap.lastActivity.inCooldown。
//   4. READ-ONLY：GET 后 event/question 行数不变（零写零 FSRS）。
//   5. 空态：无 active KC → subjects []。
//
// hermetic：每测 beforeEach resetDb()。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, item_calibration, knowledge, learning_item, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { SUPPLY_DISPATCH_COOLDOWN_DAYS } from '@/server/question-supply/dispatcher';
import { targetFingerprint } from '@/server/question-supply/target-discovery';
import { resetDb } from '../../../../tests/helpers/db';
import { GET } from './coverage-lattice';

async function seedKnowledge(id: string, domain = 'yuwen') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedActiveLearningItem(knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(learning_item).values({
    id: createId(),
    source: 'test',
    title: 'active item',
    content: '',
    knowledge_ids: knowledgeIds,
    status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(
  knowledgeIds: string[],
  opts: { kind?: string; source: string; difficulty?: number },
) {
  const now = new Date();
  const id = createId();
  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'choice',
    prompt_md: `Q ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty: opts.difficulty ?? 3,
    source: opts.source,
    metadata: null as never,
    draft_status: null,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

async function seedNearThetaCalibration(questionId: string) {
  // effectiveB = b_anchor = 0 → difficultyBandFor(0, θ̂≈0) = 'near'（真实标定锚）。
  await db.insert(item_calibration).values({
    id: createId(),
    question_id: questionId,
    b: null,
    b_anchor: 0,
    b_calib: null,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
  });
}

type LatticeBody = {
  subjects: Array<{
    subjectId: string;
    kcs: Array<{
      knowledgeId: string;
      usableCount: number;
      depthMet: boolean;
      hasHighTier: boolean | null;
      hasNearThetaAnchor: boolean | null;
      formatDiverse: boolean | null;
      gapKinds: string[];
      gaps: Array<{
        gapKind: string;
        fingerprint: string;
        scaffold: boolean;
        lastActivity: unknown;
      }>;
    }>;
  }>;
  totals: { activeKcs: number; kcsWithGaps: number; totalGaps: number };
  coverage_depth_threshold: number;
  cooldown_days: number;
  scope_note: string;
  scan_ms: number;
};

async function getBody(): Promise<LatticeBody> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as LatticeBody;
}

function findRow(body: LatticeBody, kid: string) {
  return body.subjects.flatMap((s) => s.kcs).find((k) => k.knowledgeId === kid);
}

describe('GET /api/admin/coverage-lattice (YUK-579)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty-pool KC → usableCount 0, three axes null, frontier_zero gap (scaffold)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    const body = await getBody();
    const row = findRow(body, kid);
    expect(row).toBeDefined();
    expect(row?.usableCount).toBe(0);
    expect(row?.depthMet).toBe(false);
    expect(row?.hasHighTier).toBeNull();
    expect(row?.hasNearThetaAnchor).toBeNull();
    expect(row?.formatDiverse).toBeNull();
    expect(row?.gapKinds).toContain('frontier_zero');
    expect(row?.gaps.find((g) => g.gapKind === 'frontier_zero')?.scaffold).toBe(true);
  });

  it('low-tier single-question KC → source_quality + diagnostic gaps (honest booleans off scanner)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    // 1 question, low acquisition tier (quiz_gen generated), no calibration → no near-θ anchor.
    await seedQuestion([kid], { source: 'quiz_gen', kind: 'choice' });

    const body = await getBody();
    const row = findRow(body, kid);
    expect(row?.usableCount).toBe(1);
    expect(row?.depthMet).toBe(false); // 1 < 2 → frontier_zero too
    expect(row?.hasHighTier).toBe(false); // only low-tier → source_quality
    expect(row?.hasNearThetaAnchor).toBe(false); // no calibration → diagnostic
    expect(row?.gapKinds).toEqual(expect.arrayContaining(['source_quality', 'diagnostic']));
  });

  it('covered KC (2 high-tier near-θ questions) → no frontier/source/diagnostic gaps', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    const q1 = await seedQuestion([kid], { source: 'manual', kind: 'choice' });
    const q2 = await seedQuestion([kid], { source: 'manual', kind: 'choice' });
    await seedNearThetaCalibration(q1);
    await seedNearThetaCalibration(q2);

    const body = await getBody();
    const row = findRow(body, kid);
    expect(row?.usableCount).toBe(2);
    expect(row?.depthMet).toBe(true);
    expect(row?.hasHighTier).toBe(true);
    expect(row?.hasNearThetaAnchor).toBe(true);
    expect(row?.gapKinds).not.toContain('frontier_zero');
    expect(row?.gapKinds).not.toContain('source_quality');
    expect(row?.gapKinds).not.toContain('diagnostic');
  });

  it('consistency invariants + disclosed constants across all rows', async () => {
    const a = createId();
    const b = createId();
    await seedKnowledge(a);
    await seedKnowledge(b);
    await seedActiveLearningItem([a]);
    await seedActiveLearningItem([b]);
    await seedQuestion([b], { source: 'quiz_gen' });

    const body = await getBody();
    expect(body.coverage_depth_threshold).toBe(2);
    expect(body.cooldown_days).toBe(SUPPLY_DISPATCH_COOLDOWN_DAYS);
    expect(body.scope_note).toContain('scanCoverageGaps');
    for (const row of body.subjects.flatMap((s) => s.kcs)) {
      expect(row.depthMet).toBe(row.usableCount >= body.coverage_depth_threshold);
      expect(row.depthMet).toBe(!row.gapKinds.includes('frontier_zero'));
      const allNull =
        row.hasHighTier === null && row.hasNearThetaAnchor === null && row.formatDiverse === null;
      expect(allNull).toBe(row.usableCount === 0);
    }
  });

  it('MF1 activity join — a matching dispatched event annotates the gap in-cooldown', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    // frontier_zero for an empty KC uses fixed scaffold coords (kind='any'/band='near'/tier2).
    const fp = targetFingerprint({
      subjectId: 'yuwen',
      knowledgeIds: [kid],
      kind: 'any',
      difficultyBand: 'near',
      gapKind: 'frontier_zero',
      minSourceTier: 2,
    });
    await writeEvent(db, {
      id: createId(),
      actor_kind: 'system',
      actor_ref: 'question_supply',
      action: 'experimental:question_supply',
      subject_kind: 'knowledge',
      subject_id: kid,
      outcome: 'success',
      payload: { fingerprint: fp, status: 'dispatched', gap_kind: 'frontier_zero' },
      created_at: new Date(),
      ingest_at: new Date(),
    });

    const body = await getBody();
    const gap = findRow(body, kid)?.gaps.find((g) => g.fingerprint === fp);
    expect(gap).toBeDefined();
    expect(gap?.lastActivity).not.toBeNull();
    expect((gap?.lastActivity as { inCooldown: boolean }).inCooldown).toBe(true);
  });

  it('READ-ONLY — GET writes nothing (event + question counts unchanged)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    await seedQuestion([kid], { source: 'quiz_gen' });

    const beforeEvents = (await db.select().from(event)).length;
    const beforeQuestions = (await db.select().from(question)).length;
    await getBody();
    expect((await db.select().from(event)).length).toBe(beforeEvents);
    expect((await db.select().from(question)).length).toBe(beforeQuestions);
  });

  it('empty state — no active KC → subjects [] (no crash)', async () => {
    const body = await getBody();
    expect(body.subjects).toEqual([]);
    expect(body.totals.activeKcs).toBe(0);
    expect(typeof body.scan_ms).toBe('number');
  });
});
