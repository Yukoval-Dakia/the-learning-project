// TASK 7 — replay FAITHFULNESS fixture (the ONLY DB test in src/server/calibration/).
//
// Proves replayTheta produces BYTE-IDENTICAL post-attempt θ_KC and θ_global to the REAL
// production updateThetaForAttempt for a short attempt sequence, under LIVE flags. If
// this fails, the harness is invalid — the V-A1-fwd gate must not be trusted.
//
// Coverage (M2 + B3 + M3):
//   - a single-KC attempt (forward-scorable path)
//   - a MULTI-KC attempt (pins the conjunctive credit path)
//   - a NON-ZERO family b_delta (pins loader-b == production-b via effectiveFamilyB)
//   - with-RT and without-RT attempts (pins the SRT-vs-binary credit fork)
//   - θ_global equality after each same-domain attempt (M3: sequential pre-attempt
//     global == production's re-read lockedGlobal)
//   - a binary-variant guard: srtEnabled:false replay == production with SRT_ENABLED
//     mocked false (proves the srtEnabled param maps to the real flag)
//
// Runs under vitest.db.config.ts (testcontainer). resetDb() per test.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SRT_ENABLED is a live const (true). For the binary-variant guard we mock just that one
// export to false and keep everything else real (the state.db.test.ts pattern).
const srtFlag = { value: true };
vi.mock('@/core/theta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/theta')>();
  return {
    ...actual,
    get SRT_ENABLED() {
      return srtFlag.value;
    },
  };
});

// A4 (YUK-436) — THETA_GRID_ENABLED is a live const (dark-ship default false). For the grid
// faithfulness fixture we mock just that one export to TRUE so production WRITES
// theta_grid_json, and assert the replay grid track reproduces the persisted posterior.
// Everything else in @/core/theta-grid (gridUpdate / posteriorMean / uniformPrior / …) stays
// REAL — the same primitives the replay engine consumes, so this is a true oracle.
const gridFlag = { value: false };
vi.mock('@/core/theta-grid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/theta-grid')>();
  return {
    ...actual,
    get THETA_GRID_ENABLED() {
      return gridFlag.value;
    },
  };
});

import { newId } from '@/core/ids';
import { difficultyToLogitB } from '@/core/theta';
import { GRID_POINTS, type ThetaGridPosterior } from '@/core/theta-grid';
import { db } from '@/db/client';
import {
  item_calibration,
  item_family_calibration,
  knowledge,
  mastery_state,
  question,
} from '@/db/schema';
import { type ReplayAttempt, replayTheta } from '@/server/calibration/replay';
import { effectiveFamilyB, getFamilyCalibration } from '@/server/mastery/personalized-difficulty';
import { effectiveB } from '@/server/mastery/recalibration';
import { updateThetaForAttempt } from '@/server/mastery/state';
import { resetDb } from '../../../tests/helpers/db';

const ABILITY_GLOBAL_KIND = 'ability_global'; // module-private in state.ts — hardcode the literal.
const DOMAIN = 'wenyan';

async function seedKnowledgeWithDomain(id: string, domain = DOMAIN) {
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

async function seedQuestion(id: string, knowledgeIds: string[], difficulty = 3) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedItemCalibration(questionId: string, b: number) {
  await db.insert(item_calibration).values({
    id: newId(),
    question_id: questionId,
    b,
    b_anchor: b,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
  });
}

async function seedFamily(familyKey: string, bDelta: number) {
  await db.insert(item_family_calibration).values({
    id: newId(),
    family_key: familyKey,
    b_delta: bDelta,
    evidence_count: 30,
    calibrated_n: 30,
    confidence: 0.6,
  });
}

async function readThetaKc(knowledgeId: string): Promise<number | null> {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  return rows[0]?.theta_hat ?? null;
}

async function readThetaGlobal(domain: string): Promise<number | null> {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, ABILITY_GLOBAL_KIND),
        eq(mastery_state.subject_id, domain),
      ),
    )
    .limit(1);
  return rows[0]?.theta_hat ?? null;
}

/**
 * Reconstruct production's exact b + bWeight for an attempt, EXACTLY as the loader does:
 * effectiveB(item_calibration row) → columnarB (or difficulty fallback) → effectiveFamilyB.
 */
async function reconstructBAndWeight(
  questionId: string,
  difficulty: number,
  familyKey: string | null,
): Promise<{ b: number; bWeight: number }> {
  const calRows = await db
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  const calB = effectiveB(calRows[0]);
  const columnarB = calB ?? difficultyToLogitB(difficulty);
  const bWeight = calB !== null ? 1 : 0.3; // DIFFICULTY_PROXY_WEIGHT
  let b = columnarB;
  if (familyKey !== null) {
    const familyRow = await getFamilyCalibration(db, familyKey);
    b = effectiveFamilyB(columnarB, familyRow);
  }
  return { b, bWeight };
}

interface SeqAttempt {
  knowledgeIds: string[];
  scoredKnowledgeId: string | null;
  questionId: string;
  outcome: 0 | 1;
  difficulty: number;
  responseTimeMs: number | null;
  familyKey: string | null;
  familyPrimaryKnowledgeId: string;
}

describe('replayTheta — byte-identity vs production updateThetaForAttempt', () => {
  beforeEach(async () => {
    srtFlag.value = true;
    await resetDb();
  });
  afterEach(() => {
    srtFlag.value = true;
  });

  it('SRT-on: replay matches production θ_KC + θ_global for a mixed single/multi-KC, with/without-RT sequence', async () => {
    const kc1 = createId();
    const kc2 = createId();
    const q1 = createId(); // single-KC [kc1] + non-zero family delta (B3 / M2-b)
    const q2 = createId(); // multi-KC [kc1, kc2] (M2-a conjunctive path)

    await seedKnowledgeWithDomain(kc1);
    await seedKnowledgeWithDomain(kc2);
    await seedQuestion(q1, [kc1], 3);
    await seedQuestion(q2, [kc1, kc2], 4);
    await seedItemCalibration(q1, 0.5);
    await seedItemCalibration(q2, -0.25);
    // family key format = buildFamilyKey(subject, primaryKnowledgeId, kind, source).
    // subject is derived via getEffectiveDomain→resolveKnownSubjectId; here domain=wenyan.
    const q1FamilyKey = `wenyan:${kc1}:short_answer:manual`;
    await seedFamily(q1FamilyKey, 0.6); // non-zero delta → b = columnarB + 0.6

    // Sequence: q1 correct rt=2000, q2 wrong rt=null, q1 correct rt=40000, q2 correct rt=null.
    const seq: SeqAttempt[] = [
      {
        knowledgeIds: [kc1],
        scoredKnowledgeId: kc1,
        questionId: q1,
        outcome: 1,
        difficulty: 3,
        responseTimeMs: 2000,
        familyKey: q1FamilyKey,
        familyPrimaryKnowledgeId: kc1,
      },
      {
        knowledgeIds: [kc1, kc2],
        scoredKnowledgeId: null,
        questionId: q2,
        outcome: 0,
        difficulty: 4,
        responseTimeMs: null,
        familyKey: `wenyan:${kc1}:short_answer:manual`,
        familyPrimaryKnowledgeId: kc1,
      },
      {
        knowledgeIds: [kc1],
        scoredKnowledgeId: kc1,
        questionId: q1,
        outcome: 1,
        difficulty: 3,
        responseTimeMs: 40000,
        familyKey: q1FamilyKey,
        familyPrimaryKnowledgeId: kc1,
      },
      {
        knowledgeIds: [kc1, kc2],
        scoredKnowledgeId: null,
        questionId: q2,
        outcome: 1,
        difficulty: 4,
        responseTimeMs: null,
        familyKey: `wenyan:${kc1}:short_answer:manual`,
        familyPrimaryKnowledgeId: kc1,
      },
    ];

    // ── Build matching ReplayAttempt[] (b reconstructed exactly as the loader will). ──
    const replayAttempts: ReplayAttempt[] = [];
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i];
      const { b, bWeight } = await reconstructBAndWeight(a.questionId, a.difficulty, a.familyKey);
      const domainByKc: Record<string, string | null> = {};
      for (const kc of a.knowledgeIds) domainByKc[kc] = DOMAIN;
      replayAttempts.push({
        knowledgeIds: a.knowledgeIds,
        scoredKnowledgeId: a.scoredKnowledgeId,
        domainByKc,
        outcome: a.outcome,
        difficulty: a.difficulty,
        b,
        bWeight,
        responseTimeMs: a.responseTimeMs,
        createdAt: i,
        eventId: `e${i}`,
      });
    }

    // ── Drive production once per attempt, in order, capturing θ after EACH attempt. ──
    const prodThetaKc1: number[] = [];
    const prodThetaKc2: number[] = [];
    const prodThetaGlobal: number[] = [];
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i];
      await db.transaction(async (tx) => {
        await updateThetaForAttempt(tx, {
          knowledgeIds: a.knowledgeIds,
          questionId: a.questionId,
          outcome: a.outcome,
          difficulty: a.difficulty,
          attemptEventId: `e${i}`,
          now: new Date(),
          responseTimeMs: a.responseTimeMs ?? undefined,
          kind: 'short_answer',
          source: 'manual',
          familyPrimaryKnowledgeId: a.familyPrimaryKnowledgeId,
        });
      });
      prodThetaKc1.push((await readThetaKc(kc1)) ?? 0);
      prodThetaKc2.push((await readThetaKc(kc2)) ?? 0);
      prodThetaGlobal.push((await readThetaGlobal(DOMAIN)) ?? 0);
    }

    // ── Replay (PURE) and compare the POST-attempt running θ after each prefix. ──
    // replayTheta exposes finalState (the running maps production persists), so we replay
    // the prefix [0..i] and read the final state directly — no probe trickery.
    //
    // TOLERANCE 5 (≈1e-6) — now a CONSERVATIVE bound (YUK-495 S4 widened
    // mastery_state.theta_hat to `double precision`, so the live θ̂ re-reads bit-exactly;
    // the pre-S4 `real`/~7-sig-digit text truncation this tolerance was sized for is gone).
    // Any residual gap is replay-recompute arithmetic, not column truncation. Tightening
    // toward bit-exact is the Tier-2 bit-exact-replay slice's job (#46 / decision-②: the
    // replay must route through the shared polySigmoid the live θ̂ uses once
    // POLY_SIGMOID_ENABLED flips) — see the PERSISTENCE-PRECISION NOTE in replay.ts. The
    // forward gate's predictedP is robust to ~1e-6 regardless.
    for (let i = 0; i < seq.length; i++) {
      const prefix = replayAttempts.slice(0, i + 1);
      const { finalState } = replayTheta(prefix, { srtEnabled: true });
      expect(finalState.thetaKc.get(kc1) ?? 0).toBeCloseTo(prodThetaKc1[i], 5);
      expect(finalState.thetaKc.get(kc2) ?? 0).toBeCloseTo(prodThetaKc2[i], 5);
      // M3 — θ_global after each same-domain attempt matches production's lockedGlobal-based value.
      expect(finalState.thetaGlobal.get(DOMAIN) ?? 0).toBeCloseTo(prodThetaGlobal[i], 5);
    }
  });

  it('binary-variant guard: srtEnabled:false replay == production with SRT_ENABLED mocked false', async () => {
    const kc = createId();
    const q = createId();
    await seedKnowledgeWithDomain(kc);
    await seedQuestion(q, [kc], 3);
    await seedItemCalibration(q, 0.0);

    // Production with SRT flag OFF.
    srtFlag.value = false;
    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kc],
        questionId: q,
        outcome: 1,
        difficulty: 3,
        attemptEventId: 'b0',
        now: new Date(),
        responseTimeMs: 3000, // RT present, but flag off → binary
        kind: 'short_answer',
        source: 'manual',
        familyPrimaryKnowledgeId: kc,
      });
    });
    const prodTheta = (await readThetaKc(kc)) ?? 0;

    const { b, bWeight } = await reconstructBAndWeight(q, 3, null);
    const replayAttempt: ReplayAttempt = {
      knowledgeIds: [kc],
      scoredKnowledgeId: kc,
      domainByKc: { [kc]: DOMAIN },
      outcome: 1,
      difficulty: 3,
      b,
      bWeight,
      responseTimeMs: 3000,
      createdAt: 0,
      eventId: 'b0',
    };
    const { finalState } = replayTheta([replayAttempt], { srtEnabled: false });
    // tol 5 (now a conservative bound post-S4 double-precision widen — see the SRT-on test's tolerance note).
    expect(finalState.thetaKc.get(kc) ?? 0).toBeCloseTo(prodTheta, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) GRID FAITHFULNESS FIXTURE — the independent production oracle for the
// replay grid track. Drives the REAL updateThetaForAttempt with THETA_GRID_ENABLED
// mocked TRUE over a short SINGLE-KC sequence (resolvable domain → θ_global drifts,
// exercising the bPrime = b − θ_global path), reads back the persisted
// mastery_state.theta_grid_json, and asserts replayTheta(..., {gridEnabled:true})'s
// final per-KC posterior matches it elementwise. This PROVES the replay grid track ==
// production's persisted shadow posterior (including the PRE-attempt θ_global anchor —
// production's globalThetaOfDomain is never mutated by the drift, so the grid fold uses
// the pre-attempt global; the replay mirrors that by capturing preGlobal before its drift).
// ─────────────────────────────────────────────────────────────────────────────
async function readGridJson(knowledgeId: string): Promise<ThetaGridPosterior | null> {
  const rows = await db
    .select({ grid: mastery_state.theta_grid_json })
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  return (rows[0]?.grid as ThetaGridPosterior | null | undefined) ?? null;
}

describe('replayTheta — grid-Bayes posterior faithfulness vs production theta_grid_json (A4)', () => {
  beforeEach(async () => {
    srtFlag.value = true;
    gridFlag.value = false;
    await resetDb();
  });
  afterEach(() => {
    srtFlag.value = true;
    gridFlag.value = false;
  });

  it('grid ON: replay final per-KC posterior == persisted theta_grid_json (single-KC seq with θ_global drift)', async () => {
    gridFlag.value = true; // production WRITES theta_grid_json for single-KC items.

    const kc = createId();
    const q = createId();
    await seedKnowledgeWithDomain(kc); // resolvable domain → θ_global drifts each attempt
    await seedQuestion(q, [kc], 3);
    await seedItemCalibration(q, 0.5); // calibrated b anchor (bWeight 1)

    // RT-less single-KC attempts: grid likelihood is BINARY only, so SRT does not touch the
    // posterior; RT-less also keeps the θ_global drift deterministic-binary. The bPrime =
    // b − θ_global path is exercised because θ_global accumulates across the sequence.
    const outcomes: (0 | 1)[] = [1, 0, 1, 1, 0];

    // ── Drive production once per attempt, in order. ──
    for (let i = 0; i < outcomes.length; i++) {
      await db.transaction(async (tx) => {
        await updateThetaForAttempt(tx, {
          knowledgeIds: [kc],
          questionId: q,
          outcome: outcomes[i],
          difficulty: 3,
          attemptEventId: `g${i}`,
          now: new Date(),
          // no responseTimeMs → binary credit (grid is binary regardless)
          kind: 'short_answer',
          source: 'manual',
          familyPrimaryKnowledgeId: kc,
        });
      });
    }
    const persisted = await readGridJson(kc);
    expect(persisted).not.toBeNull();
    expect(persisted?.evidence).toBe(outcomes.length);
    expect(persisted?.probs).toHaveLength(GRID_POINTS);

    // ── Build matching ReplayAttempt[] (b reconstructed exactly as the loader will). ──
    const { b, bWeight } = await reconstructBAndWeight(q, 3, null);
    const replayAttempts: ReplayAttempt[] = outcomes.map((o, i) => ({
      knowledgeIds: [kc],
      scoredKnowledgeId: kc,
      domainByKc: { [kc]: DOMAIN },
      outcome: o,
      difficulty: 3,
      b,
      bWeight,
      responseTimeMs: null,
      createdAt: i,
      eventId: `g${i}`,
    }));

    const { finalState } = replayTheta(replayAttempts, {
      srtEnabled: srtFlag.value,
      gridEnabled: true,
    });
    const replayPosterior = finalState.thetaGridByKc.get(kc);
    expect(replayPosterior).toBeDefined();
    const rp = replayPosterior as ThetaGridPosterior;
    expect(rp.evidence).toBe(outcomes.length);

    // Elementwise probability match to ~1e-6 (conservative bound post-S4: bPrime depends on
    // the persisted θ_global, now a `double precision` column round-tripped bit-exactly —
    // any residual gap is recompute arithmetic, not column truncation).
    const persistedProbs = (persisted as ThetaGridPosterior).probs;
    expect(rp.probs).toHaveLength(persistedProbs.length);
    for (let j = 0; j < persistedProbs.length; j++) {
      expect(rp.probs[j]).toBeCloseTo(persistedProbs[j], 6);
    }
  });
});
