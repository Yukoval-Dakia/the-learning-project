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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { SUPPLY_DISPATCH_COOLDOWN_DAYS, targetFingerprint } from '@/capabilities/practice/public';
import { type Db, type Tx, db } from '@/db/client';
import {
  event,
  item_calibration,
  knowledge,
  learning_item,
  mastery_state,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type CoverageLatticeRead, loadCoverageLattice } from '../public';
import { diagnosticsPublicSnapshot } from '../server/diagnostics-read-test-helpers';
import { GET } from './coverage-lattice';
import { CoverageLatticeResponseSchema } from './diagnostic-contracts';

async function seedKnowledge(id: string, domain = 'yuwen', database: Db | Tx = db) {
  const now = new Date();
  await database
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

async function seedOpenLearningItem(knowledgeIds: string[], database: Db | Tx = db) {
  const now = new Date();
  await database.insert(learning_item).values({
    id: createId(),
    source: 'test',
    title: 'open item',
    content: '',
    knowledge_ids: knowledgeIds,
    status: 'pending',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(
  knowledgeIds: string[],
  opts: { kind?: string; source: string; difficulty?: number },
  database: Db | Tx = db,
) {
  const now = new Date();
  const id = createId();
  await database.insert(question).values({
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

async function seedNearThetaCalibration(questionId: string, database: Db | Tx = db) {
  // effectiveB = b_anchor = 0 → difficultyBandFor(0, θ̂≈0) = 'near'（真实标定锚）。
  await database.insert(item_calibration).values({
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

type LatticeBody = z.infer<typeof CoverageLatticeResponseSchema>;

async function getBody(): Promise<LatticeBody> {
  const now = new Date();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    const publicRead = await loadCoverageLattice(db, now);
    const res = await GET();
    expect(res.status).toBe(200);
    const wire: unknown = await res.json();
    const body = CoverageLatticeResponseSchema.parse(wire);
    expect(wire).toEqual(body);
    expect(normalizeScan(body)).toEqual(normalizeScan(publicRead));
    return body;
  } finally {
    vi.useRealTimers();
  }
}

function normalizeScan(read: CoverageLatticeRead) {
  expect(read.scan_ms).toBeGreaterThanOrEqual(0);
  return { ...read, scan_ms: 0 };
}

function findRow(body: CoverageLatticeRead, kid: string) {
  return body.subjects.flatMap((s) => s.kcs).find((k) => k.knowledgeId === kid);
}

describe('GET /api/admin/coverage-lattice (YUK-579)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty-pool KC → usableCount 0, three axes null, frontier_zero gap (scaffold)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedOpenLearningItem([kid]);

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
    await seedOpenLearningItem([kid]);
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
    await seedOpenLearningItem([kid]);
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
    await seedOpenLearningItem([a]);
    await seedOpenLearningItem([b]);
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
    await seedOpenLearningItem([kid]);

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
    expect(gap?.lastActivity?.inCooldown).toBe(true);
  });

  it('READ-ONLY — GET writes nothing (event + question counts unchanged)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedOpenLearningItem([kid]);
    await seedQuestion([kid], { source: 'quiz_gen' });

    const beforeEvents = (await db.select().from(event)).length;
    const beforeQuestions = (await db.select().from(question)).length;
    await getBody();
    expect((await db.select().from(event)).length).toBe(beforeEvents);
    expect((await db.select().from(question)).length).toBe(beforeQuestions);
  });

  it('public reader sees inherited KC/pool/calibration/activity only inside the caller Tx and performs no writes', async () => {
    const now = new Date('2026-10-08T23:59:59.123Z');
    const empty = createId();
    const thin = createId();
    const covered = createId();
    const baseline = await diagnosticsPublicSnapshot(testDb());
    const rollback = new Error('intentional coverage rollback');
    await expect(
      testDb().transaction(async (tx) => {
        await seedKnowledge('tx_parent', 'yuwen', tx);
        for (const kid of [empty, thin, covered]) {
          await tx.insert(knowledge).values({
            id: kid,
            name: '继承科目与长条件'.repeat(100),
            parent_id: 'tx_parent',
            domain: null,
            created_at: now,
            updated_at: now,
          });
        }
        await seedOpenLearningItem([empty, thin, covered], tx);
        await seedQuestion([thin], { source: 'quiz_gen' }, tx);
        const first = await seedQuestion([covered], { source: 'manual', kind: 'choice' }, tx);
        const second = await seedQuestion([covered], { source: 'manual', kind: 'choice' }, tx);
        await seedNearThetaCalibration(first, tx);
        await seedNearThetaCalibration(second, tx);
        await tx.insert(mastery_state).values({
          id: createId(),
          subject_kind: 'knowledge',
          subject_id: thin,
          theta_hat: 0.4,
          theta_precision: 2,
          evidence_count: 9,
        });
        const fingerprint = targetFingerprint({
          subjectId: 'yuwen',
          knowledgeIds: [empty],
          kind: 'any',
          difficultyBand: 'near',
          gapKind: 'frontier_zero',
          minSourceTier: 2,
        });
        await writeEvent(tx, {
          id: createId(),
          actor_kind: 'system',
          actor_ref: 'question_supply',
          action: 'experimental:question_supply',
          subject_kind: 'knowledge',
          subject_id: empty,
          outcome: 'success',
          payload: {
            fingerprint,
            status: 'dispatched',
            details: { original: '复杂证据'.repeat(200), ambiguity: [null, false] },
          },
          created_at: now,
          ingest_at: now,
        });
        const before = await diagnosticsPublicSnapshot(tx);
        expect(before).not.toEqual(baseline);
        const read = await loadCoverageLattice(tx, now);
        expect(CoverageLatticeResponseSchema.parse(read)).toEqual(read);
        expect(read.subjects.map((s) => s.subjectId)).toEqual(['yuwen']);
        expect(read.generated_at).toBe(now.toISOString());
        expect(read.totals.activeKcs).toBe(3);
        expect(findRow(read, thin)).toMatchObject({
          usableCount: 1,
          evidenceCount: 9,
          thetaHat: 0.4,
          hasHighTier: false,
        });
        expect(findRow(read, covered)).toMatchObject({
          usableCount: 2,
          depthMet: true,
          hasHighTier: true,
          hasNearThetaAnchor: true,
        });
        expect(
          findRow(read, empty)?.gaps.find((g) => g.fingerprint === fingerprint)?.lastActivity,
        ).toMatchObject({ inCooldown: true, lastDispatchedAt: now.toISOString() });
        expect((await loadCoverageLattice(db, now)).subjects).toEqual([]);
        expect((await loadCoverageLattice(testDb(), now)).subjects).toEqual([]);
        expect(await diagnosticsPublicSnapshot(db)).toEqual(baseline);
        expect(await diagnosticsPublicSnapshot(tx)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await loadCoverageLattice(testDb(), now)).subjects).toEqual([]);
    expect(await diagnosticsPublicSnapshot(testDb())).toEqual(baseline);
  });

  it('public now controls inclusive activity lookback and exclusive cooldown expiration', async () => {
    const now = new Date('2026-10-08T23:59:59.123Z');
    const kids = [createId(), createId(), createId()];
    for (const kid of kids) await seedKnowledge(kid);
    await seedOpenLearningItem(kids);
    const lookback = Math.max(30, SUPPLY_DISPATCH_COOLDOWN_DAYS) * 86_400_000;
    const dates = [
      new Date(now.getTime() - lookback),
      new Date(now.getTime() - lookback - 1),
      new Date(now.getTime() - SUPPLY_DISPATCH_COOLDOWN_DAYS * 86_400_000),
    ];
    for (const [index, kid] of kids.entries()) {
      const fingerprint = targetFingerprint({
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
        payload: { fingerprint, status: 'dispatched' },
        created_at: dates[index],
        ingest_at: dates[index],
      });
    }
    const before = await diagnosticsPublicSnapshot(db);
    const read = await loadCoverageLattice(db, now);
    const activity = (kid: string) => findRow(read, kid)?.gaps[0].lastActivity;
    expect(activity(kids[0])?.lastDispatchedAt).toBe(dates[0].toISOString());
    expect(activity(kids[1])).toBeNull();
    expect(activity(kids[2])).toMatchObject({
      inCooldown: false,
      cooldownUntil: now.toISOString(),
    });
    const prior = await loadCoverageLattice(db, new Date(now.getTime() - 1));
    expect(findRow(prior, kids[2])?.gaps[0].lastActivity?.inCooldown).toBe(true);
    expect(await diagnosticsPublicSnapshot(db)).toEqual(before);
  });

  it('empty state — no active KC → subjects [] (no crash)', async () => {
    const body = await getBody();
    expect(body.subjects).toEqual([]);
    expect(body.totals.activeKcs).toBe(0);
    expect(typeof body.scan_ms).toBe('number');
  });
});
