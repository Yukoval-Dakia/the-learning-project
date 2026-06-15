// B1-W1 — single-owner of `mastery_state` (ADR-0035 决定#2，对称 fsrs/state.ts).
//
// Per ADR-0035: `mastery_state` is the p(L) diagnostic projection (θ̂ + PFA
// success/fail counts) per knowledge node. It is the SECOND review axis,
// orthogonal to the FSRS R-axis (material_fsrs_state) — three-axis orthogonality
// red line (ADR-0035). This module is the ONLY allowed writer of this table in
// src/server/ + app/ (step9-invariant-audit.test.ts enforces it).
//
// 写路径：submit.ts / paper-submit.ts 的 attempt tx 内调 updateThetaForAttempt
// （同 tx，不新开事务，守 hermetic）。

import { and, eq, inArray } from 'drizzle-orm';

import { newId } from '@/core/ids';
import {
  DIFFICULTY_PROXY_WEIGHT,
  difficultyToLogitB,
  eloK,
  expectedScore,
  updateTheta,
} from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration, mastery_state } from '@/db/schema';

type DbLike = Db | Tx;

export interface MasteryStateRow {
  subject_kind: string;
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date | null;
}

export interface UpsertMasteryStateInput {
  subject_kind?: string; // default 'knowledge'
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date;
}

/**
 * Upsert the p(L) state projection for a knowledge node. ON CONFLICT
 * (subject_kind, subject_id) — concurrent attempts on the same KC race on the
 * `mastery_state_unique` index; the loser falls back to UPDATE in one statement.
 * Pure persistence — the θ̂ math lives in updateThetaForAttempt.
 */
export async function upsertMasteryState(
  db: DbLike,
  input: UpsertMasteryStateInput,
): Promise<void> {
  const now = new Date();
  const subjectKind = input.subject_kind ?? 'knowledge';
  await db
    .insert(mastery_state)
    .values({
      id: newId(),
      subject_kind: subjectKind,
      subject_id: input.subject_id,
      theta_hat: input.theta_hat,
      evidence_count: input.evidence_count,
      success_count: input.success_count,
      fail_count: input.fail_count,
      last_outcome_at: input.last_outcome_at,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [mastery_state.subject_kind, mastery_state.subject_id],
      set: {
        theta_hat: input.theta_hat,
        evidence_count: input.evidence_count,
        success_count: input.success_count,
        fail_count: input.fail_count,
        last_outcome_at: input.last_outcome_at,
        updated_at: now,
      },
    });
}

/**
 * Read the current p(L) state row for a knowledge node, or null (cold start).
 */
export async function getMasteryState(
  db: DbLike,
  knowledgeId: string,
  subjectKind = 'knowledge',
): Promise<MasteryStateRow | null> {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, subjectKind), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    theta_hat: row.theta_hat,
    evidence_count: row.evidence_count,
    success_count: row.success_count,
    fail_count: row.fail_count,
    last_outcome_at: row.last_outcome_at ?? null,
  };
}

export interface UpdateThetaForAttemptInput {
  /** q.knowledge_ids — every KC this question probes gets updated (PFA per-KC). */
  knowledgeIds: string[];
  /** read item_calibration.b for the anchor. */
  questionId: string;
  /** success=1, failure=0. */
  outcome: 0 | 1;
  /** fallback anchor source (1-5) when no item_calibration.b. */
  difficulty: number;
  /** provenance — the attempt event id that produced this update. */
  attemptEventId: string;
  now: Date;
}

/**
 * 接线层 — 一次 attempt 更新该题挂的全部 KC 的 θ̂（多 KC 加权语义）。这是热路径
 * 唯一入口。同 tx 内调用（submit.ts / paper-submit.ts）。
 *
 * 多 KC 归因语义（VERIFY:multi-kc holds_with_caveat 吸收）:
 *   - 更新全部 KC（PFA per-KC 累积，非「只更最弱」）。
 *   - 答对（outcome=1）：每 KC 等量小幅上调（答对是全 KC 弱证据，补偿型）。
 *   - 答错（outcome=0）：按 (1 - p(L_k)) 归一化分摊步长——越可能没掌握的 KC 担
 *     越多责任，已掌握 KC 受冲击小（Conjunctive-BKT 式 credit-assignment，
 *     避免「答错冤枉已掌握 KC」）。
 *
 * b 锚来源（item-半边锁死，只读不写，G4）：item_calibration.b（有 → bWeight=1）→
 *   兜底 difficultyToLogitB（弱锚 → bWeight=DIFFICULTY_PROXY_WEIGHT 降权，
 *   VERIFY:difficulty-logit-map 吸收）。
 *
 * θ̂_min 是选题聚合（ex-ante），本 wave 不实现，仅此注释留口。
 */
export async function updateThetaForAttempt(
  tx: Tx,
  input: UpdateThetaForAttemptInput,
): Promise<void> {
  const knowledgeIds = Array.from(
    new Set(input.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (knowledgeIds.length === 0) return;

  // 1. Read the b anchor (item-half locked: read-only). track='hard' only —
  //    soft track never reaches p(L)/scheduling (ADR-0035).
  const calRows = await tx
    .select({ b: item_calibration.b })
    .from(item_calibration)
    .where(
      and(eq(item_calibration.question_id, input.questionId), eq(item_calibration.track, 'hard')),
    )
    .limit(1);
  const calB = calRows[0]?.b ?? null;
  const b = calB ?? difficultyToLogitB(input.difficulty);
  // Weak difficulty-proxy anchor → down-weight the update (D2 / VERIFY).
  const bWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT;

  // 2. Read every KC's current state (null → cold start: θ=0, counts=0).
  const existing = await tx
    .select()
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, 'knowledge'),
        inArray(mastery_state.subject_id, knowledgeIds),
      ),
    );
  const byId = new Map(existing.map((r) => [r.subject_id, r]));
  const states = knowledgeIds.map((id) => {
    const row = byId.get(id);
    return {
      id,
      theta: row?.theta_hat ?? 0,
      evidence: row?.evidence_count ?? 0,
      success: row?.success_count ?? 0,
      fail: row?.fail_count ?? 0,
    };
  });

  // 3. credit-assignment weights (VERIFY:multi-kc).
  const creditWeights = computeCreditWeights(
    states.map((s) => s.theta),
    b,
    input.outcome,
  );

  // 4 + 5. Per-KC update + upsert.
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const k = eloK(s.evidence);
    const finalWeight = creditWeights[i] * bWeight;
    const newTheta = updateTheta(s.theta, b, input.outcome, k, finalWeight);
    await upsertMasteryState(tx, {
      subject_id: s.id,
      theta_hat: newTheta,
      evidence_count: s.evidence + 1,
      success_count: s.success + (input.outcome === 1 ? 1 : 0),
      fail_count: s.fail + (input.outcome === 0 ? 1 : 0),
      last_outcome_at: input.now,
    });
  }
}

/**
 * Credit-assignment weights across the KCs probed by ONE attempt.
 *   - single KC → [1].
 *   - correct (outcome=1) → all 1 (compensatory: a correct answer is weak
 *     evidence for every probed KC, equal small bump).
 *   - wrong (outcome=0) → normalized by (1 - p(L_k)): the KC most likely NOT
 *     mastered carries the most blame; an already-mastered KC barely moves.
 *     Degenerate guard: if every KC is fully mastered (Σ ≈ 0) fall back to equal
 *     split so a wrong answer is never silently dropped.
 */
function computeCreditWeights(thetas: number[], b: number, outcome: 0 | 1): number[] {
  const n = thetas.length;
  if (n === 1) return [1];
  if (outcome === 1) return thetas.map(() => 1);
  // outcome === 0: blame ∝ (1 - p(L_k)), p(L_k) = σ(θ_k - b).
  const blame = thetas.map((theta) => 1 - expectedScore(theta, b));
  const total = blame.reduce((acc, x) => acc + x, 0);
  if (total <= 0) return thetas.map(() => 1 / n);
  return blame.map((x) => x / total);
}
