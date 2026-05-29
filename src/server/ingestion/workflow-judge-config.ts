/**
 * WorkflowJudge auto-enroll config — T-OC slice 3 (YUK-145, OC-4 / OC-5).
 *
 * See `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-4/OC-5) +
 * `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` §4 + ADR-0026.
 *
 * ============================================================================
 * CRITICAL SAFETY: `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` DEFAULTS TO **OFF**.
 * ============================================================================
 *
 * With the flag at its default, NOTHING auto-enrolls — every captured block
 * routes to the EXISTING human review flow (app/api/ingestion/[id]/import), so
 * production behaviour is byte-equivalent to today. Auto-enroll only activates
 * when the env var is set EXPLICITLY to the string 'true' (case-insensitive).
 *
 * This is the **INVERSE** of the WAVE6_TRIGGER_*_ENABLED convention in
 * `src/server/artifacts/note-refine-triggers.ts`, which defaults ON. Auto-enroll
 * writes durable learning data on the user's behalf (events + records), so per
 * OC-5 evidence-first conservative rollout it must default OFF and stay OFF until
 * the "AI auto-enrolled N items" review surface exists (DEFERRED to slice 3b —
 * see lane plan §DEFERRED) and the user explicitly opts in.
 */

/** Env var that gates the auto-enroll path. Default OFF (see file header). */
export const AUTO_ENROLL_FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';
/** Env var for the combined-confidence threshold. Default 0.85 (conservative). */
export const AUTO_ENROLL_THRESHOLD_FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD';

/** Conservative default threshold: high bar → most blocks go to human review. */
export const DEFAULT_AUTO_ENROLL_THRESHOLD = 0.85;

/** Minimal env shape these readers need (a superset of NodeJS.ProcessEnv). */
export type FlagEnv = Record<string, string | undefined>;

/**
 * True ONLY when `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` is explicitly 'true'
 * (case-insensitive). Undefined / '' / 'false' / any other value → false.
 *
 * NOTE the polarity: this is opt-IN (default off), the opposite of
 * `noteRefineTriggerEnabled` which is opt-OUT (default on). Auto-enroll is a
 * data-writing action on the user's behalf and must be unmissably OFF by default.
 */
export function autoEnrollEnabled(env: FlagEnv = process.env): boolean {
  const value = env[AUTO_ENROLL_FLAG];
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

/**
 * Combined-confidence threshold for routing 'auto'. Defaults to
 * `DEFAULT_AUTO_ENROLL_THRESHOLD` (0.85) when unset/invalid. Clamped to [0, 1].
 */
export function autoEnrollThreshold(env: FlagEnv = process.env): number {
  const raw = env[AUTO_ENROLL_THRESHOLD_FLAG];
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_AUTO_ENROLL_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_ENROLL_THRESHOLD;
  return Math.min(1, Math.max(0, parsed));
}
