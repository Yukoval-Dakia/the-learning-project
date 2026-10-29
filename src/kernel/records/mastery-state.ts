// Online mastery_state diagnostic writes: attempt updates, explicit upserts and KC retirement.
// Callers own settlement, revert and cross-surface merge transactions and recovery.
// Canonical reads stay in kernel/read-models/mastery-state and mastery-projection.

import { and, eq, inArray, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { ThetaRowSnapshotT } from '@/core/schema/event/state-snapshot';
import {
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  type RtCorrectBuffer,
  SRT_ENABLED,
  SRT_FISHER_WEIGHT_ENABLED,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  eloK,
  expectedScore,
  pushRtCorrectSample,
  resolveSrtTimeLimit,
  srtOutcome,
  updateThetaPrecision,
} from '@/core/theta';
import {
  THETA_GRID_ENABLED,
  type ThetaGridPosterior,
  gridUpdate,
  uniformPrior,
} from '@/core/theta-grid';
import type { Db, Tx } from '@/db/client';
import {
  acquireLearningStateWriteLock,
  acquireSortedAdvisoryLocks,
  withLearningStateLock,
} from '@/db/learning-state-lock';
import { mastery_state } from '@/db/schema';
import { withoutNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import {
  ABILITY_GLOBAL_SUBJECT_KIND,
  type AbilityGlobalByKnowledgeId,
  getMasteryState,
} from '@/kernel/read-models/mastery-state';
import { readAttemptDifficulty } from '@/kernel/read-models/question-difficulty';

type DbLike = Db | Tx;

// A2 alias of the kernel read-model literal; the private name keeps the write path stable.
const ABILITY_GLOBAL_KIND = ABILITY_GLOBAL_SUBJECT_KIND;

export interface UpsertMasteryStateInput {
  subject_kind?: string; // default 'knowledge'
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  // Nullable so verbatim revert can restore a pre-attempt NULL. Live writers pass a Date.
  last_outcome_at: Date | null;
  // Optional columns: omitted means "leave unchanged" on update.
  theta_precision?: number;
  last_theta_delta?: number | null;
  // Shadow grid posterior; written only when the caller passes it, no downstream reader.
  theta_grid_json?: ThetaGridPosterior | null;
  // Per-KC correct-RT collection; written only for an SRT-eligible correct attempt.
  rt_correct_ms?: RtCorrectBuffer | null;
}

/**
 * Upsert the p(L) state projection for one knowledge node. ON CONFLICT
 * (subject_kind, subject_id) races on `mastery_state_unique`; the loser falls back to
 * UPDATE in one statement. The θ̂ math lives in updateThetaForAttempt.
 *
 * Self-acquires the global learning-state write lock G via `withLearningStateLock`
 * (own tx for a Db, caller's tx for a Tx). G is re-entrant within a transaction, so a
 * caller already holding it can call this safely.
 */
export async function upsertMasteryState(
  db: DbLike,
  input: UpsertMasteryStateInput,
): Promise<void> {
  await withLearningStateLock(db, async (tx) => {
    const now = new Date();
    const subjectKind = input.subject_kind ?? 'knowledge';
    // Optional columns are inlined identically into INSERT and UPDATE: the field-name
    // literals must stay visible to audit:schema's write-path scanner. A shared spread
    // hid rt_correct_ms and broke the audit (YUK-497). The two blocks must stay in sync.
    await tx
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
        ...(input.theta_precision !== undefined ? { theta_precision: input.theta_precision } : {}),
        ...(input.last_theta_delta !== undefined
          ? { last_theta_delta: input.last_theta_delta }
          : {}),
        ...(input.theta_grid_json !== undefined ? { theta_grid_json: input.theta_grid_json } : {}),
        ...(input.rt_correct_ms !== undefined ? { rt_correct_ms: input.rt_correct_ms } : {}),
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
          ...(input.theta_precision !== undefined
            ? { theta_precision: input.theta_precision }
            : {}),
          ...(input.last_theta_delta !== undefined
            ? { last_theta_delta: input.last_theta_delta }
            : {}),
          ...(input.theta_grid_json !== undefined
            ? { theta_grid_json: input.theta_grid_json }
            : {}),
          ...(input.rt_correct_ms !== undefined ? { rt_correct_ms: input.rt_correct_ms } : {}),
          updated_at: now,
        },
      });
  });
}

/**
 * Repair `mastery_state` when a KC is merged: never combine θ̂ or recompute statistics.
 * Neither row → 'noop'; only fromId → rename; both → freeze the fromId row (inert) and
 * log. Takes the shared `fsrs:knowledge` locks for both ids in sorted order, so a
 * concurrent grading upsert blocks until the merge commits.
 */
export async function retireMasteryStateOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<'noop' | 'renamed' | 'frozen'> {
  // YUK-497 — global learning-state write lock before the per-key locks (shared tx-entry order).
  await acquireLearningStateWriteLock(tx);
  // Sorted acquire of BOTH ids' locks (SAME namespace as updateThetaForAttempt) → no deadlock.
  await acquireSortedAdvisoryLocks(tx, 'fsrs:knowledge', [fromId, intoId]);
  const rows = await tx
    .select({ subject_id: mastery_state.subject_id })
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, 'knowledge'),
        inArray(mastery_state.subject_id, [fromId, intoId]),
      ),
    );
  const present = new Set(rows.map((r) => r.subject_id));
  if (!present.has(fromId)) return 'noop';
  if (!present.has(intoId)) {
    await tx
      .update(mastery_state)
      .set({ subject_id: intoId, updated_at: new Date() })
      .where(
        and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, fromId)),
      );
    return 'renamed';
  }
  // Both sides carry evidence — FREEZE: no blind θ̂ combine (would fabricate a statistic). The
  // from-row is retained for forensics but is inert (no reader scans an unrewritten subject_id).
  console.warn(
    '[retireMasteryStateOnMerge] both from+into have mastery_state — freezing from-row (no θ̂ merge)',
    { fromId, intoId },
  );
  return 'frozen';
}

export interface UpdateThetaForAttemptInput {
  /** q.knowledge_ids — every KC this question probes gets updated (PFA per-KC).
   * YUK-1600: goal/container ids are dropped here — the θ writer itself is the gate. */
  knowledgeIds: string[];
  /** read item_calibration.b for the anchor. */
  questionId: string;
  /** success=1, failure=0. */
  outcome: 0 | 1;
  /** fallback anchor source (1-5) when no item_calibration.b. */
  difficulty: number;
  /**
   * Optional latency in ms. With SRT_ENABLED, replaces binary credit with continuous
   * time-aware credit; otherwise binary credit is unchanged. Converted to seconds at
   * the seam to match resolveSrtTimeLimit.
   */
  responseTimeMs?: number | null;
  /** The attempt event id that produced this update. */
  attemptEventId: string;
  now: Date;
  /** question.kind / question.source; omitted skips the family lookup. */
  kind?: string;
  source?: string;
  /**
   * Canonical question primary KC (q.knowledge_ids[0]). Paper submit's knowledgeIds[0]
   * is the slot primary, which may differ from the question primary; family read and
   * write keys must agree.
   */
  familyPrimaryKnowledgeId?: string | null;
  /**
   * Durable-lane-only frozen KC → ability_global domain mapping. `undefined` preserves the
   * synchronous/paper behavior of resolving the current knowledge tree inside this tx.
   */
  abilityGlobalByKnowledgeId?: AbilityGlobalByKnowledgeId;
}

/**
 * 热路径唯一入口：一次 attempt 更新该题挂的全部 KC 的 θ̂，同 tx 内调用。
 *
 * 多 KC：更新全部 KC；答对每 KC 等量小幅上调；答错按 (1 − p(L_k)) 归一化分摊，
 * 越可能没掌握的 KC 担更多责任。b 锚只读：item_calibration.b（bWeight=1）→
 * difficultyToLogitB（弱锚降权），G4 在线路径绝不写 b。
 *
 * Returns the per-KC before/after snapshot, including A2 'ability_global' rows. `before`
 * is the full raw pre-attempt row; null means cold start (0 is a real θ̂), so revert can
 * restore or delete verbatim and settlement replay does not double-count θ_global.
 */
export interface ThetaSnapshotEntry {
  /** Row id: knowledge id, or DOMAIN id when subject_kind='ability_global'. */
  kc_id: string;
  /** mastery_state partition — absent means 'knowledge' (payload-compatible). */
  subject_kind?: 'knowledge' | 'ability_global';
  before: ThetaRowSnapshotT | null;
  after: number;
}
export interface UpdateThetaForAttemptResult {
  theta_snapshots: ThetaSnapshotEntry[];
}

export async function updateThetaForAttempt(
  tx: Tx,
  input: UpdateThetaForAttemptInput,
): Promise<UpdateThetaForAttemptResult> {
  await acquireLearningStateWriteLock(tx);
  const knowledgeIds = await withoutNonKcKnowledgeIds(
    tx,
    Array.from(new Set(input.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0))),
  );
  if (knowledgeIds.length === 0) return { theta_snapshots: [] };

  // Serialize the per-KC read-modify-write. The caller's FSRS lock may cover only a
  // subset, so take our own lock on every KC in the same `fsrs:knowledge:<id>`
  // namespace, sorted to keep a stable order. Released at tx commit.
  for (const id of [...knowledgeIds].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:knowledge:${id}`}))`);
  }

  // Read inside the locked attempt tx, before mastery state, using frozen question metadata.
  const { b, bWeight } = await readAttemptDifficulty(tx, {
    questionId: input.questionId,
    difficulty: input.difficulty,
    kind: input.kind,
    source: input.source,
    familyPrimaryKnowledgeId: input.familyPrimaryKnowledgeId,
    knowledgeIds,
  });

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
      // Raw pre-attempt row for the verbatim snapshot. null = cold start (revert deletes).
      // Keeping the whole row avoids the old bug where a θ̂-only snapshot left counts and
      // precision stale on revert.
      raw: row ?? null,
      theta: row?.theta_hat ?? 0,
      evidence: row?.evidence_count ?? 0,
      success: row?.success_count ?? 0,
      fail: row?.fail_count ?? 0,
      // Cold-start precision = 1 (one unit of weak prior information), same as the DB default.
      precision: row?.theta_precision ?? 1,
      // Pre-attempt shadow posterior; null means never folded (cold-start uniform prior).
      gridPrior: (row?.theta_grid_json as ThetaGridPosterior | null | undefined) ?? null,
      // The post-attempt push appends to this pre-attempt buffer.
      rtBuffer: (row?.rt_correct_ms as RtCorrectBuffer | null | undefined)?.samples ?? null,
    };
  });

  // ── A2 hierarchical Elo: resolve each KC's per-domain θ_global ──────────────
  //
  // Flag off (default): θ_global ≡ 0, no domain is resolved or read, so the path is
  // byte-identical to single-layer Elo. Flag on: effectiveTheta_k = θ_global(domain_k) +
  // θ_KC_k. An orphan/null-root domain degrades that KC to θ_global = 0 instead of
  // aborting the attempt; the KC still updates its θ_KC.
  const domainOfKc = new Map<string, string | null>(); // KC id → resolved domain id (null = unresolved)
  const globalThetaOfDomain = new Map<string, number>(); // domain id → current θ_global (0 if no row)
  if (HIERARCHICAL_ELO_ENABLED) {
    // Durable jobs carry the mapping frozen at answer time. Legacy/synchronous callers omit it
    // and retain the current-tree resolution behavior.
    for (const id of knowledgeIds) {
      let domain: string | null = null;
      if (input.abilityGlobalByKnowledgeId !== undefined) {
        domain = input.abilityGlobalByKnowledgeId[id] ?? null;
      } else {
        try {
          domain = await getEffectiveDomain(tx, id);
        } catch {
          domain = null; // orphan / null-root-domain → no domain anchor for this KC.
        }
      }
      domainOfKc.set(id, domain);
      if (domain !== null && !globalThetaOfDomain.has(domain)) {
        const grow = await getMasteryState(tx, domain, ABILITY_GLOBAL_KIND);
        globalThetaOfDomain.set(domain, grow?.theta_hat ?? 0); // null → cold-start θ_global=0
      }
    }
  }
  // Flag off or unresolved domain → θ_global = 0, so effectiveTheta == θ_KC.
  const globalOf = (kcId: string): number => {
    const domain = domainOfKc.get(kcId) ?? null;
    return domain !== null ? (globalThetaOfDomain.get(domain) ?? 0) : 0;
  };
  const effectiveThetas = states.map((s) => s.theta + globalOf(s.id));

  // 3. 多 KC 合取 credit（owner 拍板 MLE，review SF-1）：conjunctiveCredits 返回每 KC 的
  //    log 似然梯度；单 KC 退化为标准 Elo。
  //
  // SRT gate: SRT_ENABLED, a finite responseTimeMs, and resolved d must all hold;
  // otherwise binary credit is used unchanged. Continuous credit modulates only the
  // per-KC credit value; eloK, bWeight, b anchor, and precision math are untouched.
  //
  // The credit formula is unchanged under A2; only the θ input becomes effectiveTheta.
  const rtMs = input.responseTimeMs;
  const useSrt = SRT_ENABLED && typeof rtMs === 'number' && Number.isFinite(rtMs);
  let credits: number[];
  if (useSrt) {
    const d = resolveSrtTimeLimit(input.difficulty); // seconds (module const)
    const tSeconds = (rtMs as number) / 1000; // ms → s
    // A1 (YUK-450) — Fisher-conditioned TIME WEIGHT. Flag ON → w = 4·pItem·(1−pItem): peak 1
    //   at pItem=0.5 (RT most informative when difficulty ≈ ability), → 0 at extreme p (RT
    //   near-uninformative + noisiest; also tames the over-harsh "easy item answered slow"
    //   negative credit). pItem = whole-item p(correct) = Π expectedScore(effectiveθ_k, b) —
    //   built from the learner's OWN θ̂ + the locked b anchor (self-state, n=1; NO per-item
    //   time-discrimination φ). Flag OFF (DEFAULT) → w = 1 → srtOutcome byte-identical to today.
    const pItem = effectiveThetas.reduce((acc, th) => acc * expectedScore(th, b), 1);
    const timeWeight = SRT_FISHER_WEIGHT_ENABLED ? 4 * pItem * (1 - pItem) : 1;
    const srt = srtOutcome(input.outcome === 1, d, tSeconds, timeWeight); // ∈ [0,1]
    credits = conjunctiveCreditsContinuous(effectiveThetas, b, srt);
  } else {
    credits = conjunctiveCredits(effectiveThetas, b, input.outcome);
  }

  // 4 + 5. Per-KC offset update + upsert: θ_KC += k · bWeight · credit_k.
  // The A2 global drift is applied separately below; the step itself is unchanged.
  // Precision stays on the KC layer at the pre-attempt offset.
  const thetaSnapshots: ThetaSnapshotEntry[] = [];
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const k = eloK(s.evidence);
    const newTheta = s.theta + k * bWeight * credits[i];
    // Accumulate θ precision with the same b anchor and bWeight as the θ̂ update; evaluate
    // Fisher information at the pre-update θ. A2 keeps this on the KC layer, not effective θ.
    const newPrecision = updateThetaPrecision(s.precision, s.theta, b, bWeight);
    const delta = newTheta - s.theta;
    // Retain correct-RT samples without feeding them into θ̂; other attempts leave the buffer alone.
    const rtBuffer =
      useSrt && input.outcome === 1
        ? { samples: pushRtCorrectSample(s.rtBuffer, rtMs as number) }
        : undefined;
    await upsertMasteryState(tx, {
      subject_id: s.id,
      theta_hat: newTheta,
      evidence_count: s.evidence + 1,
      success_count: s.success + (input.outcome === 1 ? 1 : 0),
      fail_count: s.fail + (input.outcome === 0 ? 1 : 0),
      last_outcome_at: input.now,
      theta_precision: newPrecision,
      rt_correct_ms: rtBuffer,
      last_theta_delta: delta,
    });
    // Bracket this KC's transition verbatim. before = full raw pre-attempt row (null =
    // cold start); after = newTheta. Whole jsonb objects make revert byte-exact.
    const before: ThetaRowSnapshotT | null =
      s.raw === null
        ? null
        : {
            theta_hat: s.raw.theta_hat,
            evidence_count: s.raw.evidence_count,
            success_count: s.raw.success_count,
            fail_count: s.raw.fail_count,
            theta_precision: s.raw.theta_precision,
            last_theta_delta: s.raw.last_theta_delta ?? null,
            last_outcome_at: s.raw.last_outcome_at ?? null,
            rt_correct_ms: (s.raw.rt_correct_ms as RtCorrectBuffer | null) ?? null,
            theta_grid_json: (s.raw.theta_grid_json as ThetaGridPosterior | null) ?? null,
          };
    thetaSnapshots.push({ kc_id: s.id, before, after: newTheta });
  }

  // ── A2 per-domain θ_global drift (once per touched domain) ──────────────────
  //
  // Flag off: nothing runs; no 'ability_global' row is ever written. Flag on: each touched
  // domain drifts slowly (ELO_K_GLOBAL ≪ eloK) by the mean credit of its KCs, so a multi-KC
  // item moves the domain once. bWeight applies identically.
  if (HIERARCHICAL_ELO_ENABLED) {
    // Unresolved-domain KCs contribute to no global row.
    const creditsByDomain = new Map<string, number[]>();
    for (let i = 0; i < states.length; i++) {
      const domain = domainOfKc.get(states[i].id) ?? null;
      if (domain === null) continue;
      const list = creditsByDomain.get(domain) ?? [];
      list.push(credits[i]);
      creditsByDomain.set(domain, list);
    }
    // Sorted domain order keeps the advisory-lock acquire order stable.
    for (const domain of [...creditsByDomain.keys()].sort()) {
      const domainCredits = creditsByDomain.get(domain) as number[];
      // Mean of the domain's KC credits → one update per attempt per domain.
      const aggregateCredit = domainCredits.reduce((acc, c) => acc + c, 0) / domainCredits.length;
      // Serialize the θ_global row in a per-domain namespace disjoint from the per-KC keys.
      // Acquired after the sorted per-KC locks, so no new deadlock cycle.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mastery:ability_global:${domain}`}))`,
      );
      // Re-read under the lock so a concurrent same-domain increment is not lost. Read the
      // raw row so the snapshot `before` is a verbatim whole-row restore point.
      const lockedRows = await tx
        .select()
        .from(mastery_state)
        .where(
          and(
            eq(mastery_state.subject_kind, ABILITY_GLOBAL_KIND),
            eq(mastery_state.subject_id, domain),
          ),
        )
        .limit(1);
      const lockedRow = lockedRows[0] ?? null;
      const lockedGlobal = lockedRow?.theta_hat ?? 0;
      const lockedNewGlobal = lockedGlobal + ELO_K_GLOBAL * bWeight * aggregateCredit;
      // Global rows reuse mastery_state: counts are a plain attempt tally, not read by
      // p(L); success/fail stay binary; precision keeps its default. last_theta_delta is
      // observability only.
      const globalEvidence = (lockedRow?.evidence_count ?? 0) + 1;
      await upsertMasteryState(tx, {
        subject_kind: ABILITY_GLOBAL_KIND,
        subject_id: domain,
        theta_hat: lockedNewGlobal,
        evidence_count: globalEvidence,
        success_count: (lockedRow?.success_count ?? 0) + (input.outcome === 1 ? 1 : 0),
        fail_count: (lockedRow?.fail_count ?? 0) + (input.outcome === 0 ? 1 : 0),
        last_outcome_at: input.now,
        last_theta_delta: lockedNewGlobal - lockedGlobal,
      });
      // Bracket the global transition verbatim too; otherwise a revert restores the KC
      // layer but leaves θ_global and evidence_count double-counted.
      const globalBefore: ThetaRowSnapshotT | null =
        lockedRow === null
          ? null
          : {
              theta_hat: lockedRow.theta_hat,
              evidence_count: lockedRow.evidence_count,
              success_count: lockedRow.success_count,
              fail_count: lockedRow.fail_count,
              theta_precision: lockedRow.theta_precision,
              last_theta_delta: lockedRow.last_theta_delta ?? null,
              last_outcome_at: lockedRow.last_outcome_at ?? null,
              rt_correct_ms: (lockedRow.rt_correct_ms as RtCorrectBuffer | null) ?? null,
              theta_grid_json: (lockedRow.theta_grid_json as ThetaGridPosterior | null) ?? null,
            };
      thetaSnapshots.push({
        kc_id: domain,
        subject_kind: 'ability_global',
        before: globalBefore,
        after: lockedNewGlobal,
      });
    }
  }

  // ── A4 discrete grid-Bayes θ_KC posterior, SHADOW write ─────────────────────
  //
  // PURE-ADDITIVE: persist a discrete posterior over the θ_KC offset, shadow-only. The Elo
  // theta_hat remains the source of truth; nothing downstream reads theta_grid_json.
  //
  // Gates: THETA_GRID_ENABLED and a single-KC item. Multi-KC's shared Bernoulli outcome does
  // not factor into independent per-KC posteriors. Likelihood is binary only.
  //
  // θ_global enters as a fixed translation: b' = b − θ_global. The grid does not model it.
  // n=1-legal: single-learner sequential Bayes with b locked; cold start uses a uniform prior.
  if (THETA_GRID_ENABLED && states.length === 1) {
    const s = states[0];
    const bPrime = b - globalOf(s.id);
    const prior = s.gridPrior ?? uniformPrior();
    const posterior = gridUpdate(prior, bPrime, input.outcome);
    // Patch only the shadow column written by the per-KC loop, leaving θ̂/counts untouched
    // so the source-of-truth path cannot be perturbed.
    await tx
      .update(mastery_state)
      .set({ theta_grid_json: posterior, updated_at: input.now })
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, s.id)));
  }

  // Snapshot every row this fn wrote, including A2 global rows, for revert/replay.
  return { theta_snapshots: thetaSnapshots };
}
