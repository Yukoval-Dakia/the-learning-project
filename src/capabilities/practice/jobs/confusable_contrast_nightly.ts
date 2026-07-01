// YUK-533 (ADR-0036 RT1 consumer) — confusable-contrast supply discovery + dispatch nightly.
//
// Structurally mirrors question_supply_nightly.ts: pure discovery (discoverConfusable
// ContrastTargets, zero write / zero LLM) → QuestionSupplyTarget[] (one per confusable KC
// pair) → dispatchSupplyTargets routes each to the existing quiz_gen face (propose-only
// drafts) or marks manual. The whole job is DARK behind CONFUSABLE_CONTRAST_ENABLED: the
// discovery returns [] when the flag is OFF, so this nightly is a NO-OP until the flip.
//
// ── 红线：成本（G-COST）─────────────────────────────────────────────────────
// This cron makes paid acquisition (LLM quiz_gen) happen automatically. The ONLY job-spam
// guards are the dispatcher's 7d fingerprint cooldown (recentDispatchExists) + this job's
// per-run cap (DEFAULT_MAX_PER_RUN). This job DEPENDS on the dispatcher's cooldown as the
// cost guard — it NEVER bypasses the dispatcher to enqueue quiz_gen directly. cron sits
// after the question_supply nightly (06:00) so the confusable pass is the last supply lane.
//
// ── 红线：propose-only (B5) + 只读消费 (G3) ─────────────────────────────────
// quiz_gen persists every generated item with draft_status='draft' (NOT the review pool, no
// FSRS) — never auto-active. This job只 discovers (read-only) + dispatches; it writes no
// question, no b-anchor, no edge. Pure read-only consumption + dispatch.

import type { Db } from '@/db/client';
import { discoverConfusableContrastTargets } from '@/server/question-supply/confusable-contrast-discovery';
import type { DispatchResult } from '@/server/question-supply/dispatcher';
import { dispatchSupplyTargets } from '@/server/question-supply/dispatcher';
import type { Job } from 'pg-boss';

type DispatchDeps = Parameters<typeof dispatchSupplyTargets>[2];

type DepsOverride = {
  /** dispatcher 注入（DB 测试可注入 fake enqueue / cooldown / tavilyAvailable）。 */
  dispatchDeps?: DispatchDeps;
  /** 本轮最多派发多少个对比目标（防一次 cron 打爆付费队列，mirror question_supply_nightly F3）。default 25。 */
  maxPerRun?: number;
};

// ── 红线：per-run 派发硬顶（G-COST）──────────────────────────────────────────
// Accident hard-cap, NOT a tight limit: on the FIRST run (before any cooldown evidence
// exists) the dispatcher's 7d fingerprint cooldown cannot throttle, so a large confusable
// mesh would flood the paid quiz_gen queue in one pass. discoverConfusableContrastTargets
// returns targets priority-desc, so slice top-N = "dispatch the N highest-priority pairs,
// defer the rest to the next run". 25 aligns with question_supply_nightly DEFAULT_MAX_PER_RUN.
const DEFAULT_MAX_PER_RUN = 25;

export interface ConfusableContrastNightlyResult {
  /** discoverConfusableContrastTargets 发现的对比目标**总数**（per-run cap 之前）。 */
  discovered: number;
  /** 本轮实际进入派发的目标数（= min(discovered, maxPerRun)）。 */
  considered: number;
  /** per-run cap 截掉、留待下轮的目标数（discovered − considered）。 */
  deferred: number;
  /** 真派到后台队列的目标数（status='dispatched'）。 */
  dispatched: number;
  /** 无后台队列、留给人工/UI 的目标数（status='manual'）。 */
  manual: number;
  /** cooldown / 无锚等被跳过的目标数（status='skipped'）。 */
  skipped: number;
  /** 派发抛错的目标数（status='failed'）。 */
  failed: number;
}

function tallyByStatus(
  results: DispatchResult[],
  discovered: number,
): ConfusableContrastNightlyResult {
  const out: ConfusableContrastNightlyResult = {
    discovered,
    considered: results.length,
    deferred: Math.max(0, discovered - results.length),
    dispatched: 0,
    manual: 0,
    skipped: 0,
    failed: 0,
  };
  for (const r of results) {
    switch (r.status) {
      case 'dispatched':
        out.dispatched++;
        break;
      case 'manual':
        out.manual++;
        break;
      case 'skipped':
        out.skipped++;
        break;
      case 'failed':
        out.failed++;
        break;
    }
  }
  return out;
}

/**
 * 端到端夜扫：发现对比目标 → 派发到既有 quiz_gen 面。零写、零新 AI task。空目标早返回
 * （flag OFF 或无 confusable 边 ⇒ 零派发，不触付费 job）。
 */
export async function runConfusableContrastNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<ConfusableContrastNightlyResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const targets = await discoverConfusableContrastTargets(db);
  if (targets.length === 0) {
    // Zero-target early return — reuse tallyByStatus so the all-zero shape can never drift
    // from the tally path if a field is added to ConfusableContrastNightlyResult (DRY).
    return tallyByStatus([], 0);
  }
  // per-run 硬顶：targets 已按 priority 降序（discoverConfusableContrastTargets），slice top-N
  // 即派最高优先级的 N 个，其余留下轮（截掉的目标不 dispatch ⇒ 无 fingerprint 落库 ⇒ 无 cooldown 副作用）。
  const dispatchTargets = targets.slice(0, maxPerRun);
  const results = await dispatchSupplyTargets(db, dispatchTargets, deps.dispatchDeps);
  return tallyByStatus(results, targets.length);
}

export function buildConfusableContrastNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runConfusableContrastNightly(db);
      console.log('[confusable_contrast_nightly] result', result);
    } catch (err) {
      // PRE-discovery / dispatch 阶段的意外 throw（如 DB read 故障）冒泡 → pg-boss DLQ 重试。
      // 单个 target 的 dispatch 错已被 dispatchSupplyTargets 内部 per-target try/catch 兜住。
      console.error('[confusable_contrast_nightly] failed', err);
      throw err;
    }
  };
}
