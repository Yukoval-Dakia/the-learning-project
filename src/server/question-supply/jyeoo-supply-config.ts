// YUK-697 — jyeoo-rs deterministic supply config + gating predicates.
//
// docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md §2/§3;
// ~/jyeoo-rs/docs/DESIGN.md (producer contract).
//
// This module is the SINGLE source of truth for "which loom subjects have a jyeoo
// producer, and how do we invoke it". The subject profile DECLARES support via the
// optional `jyeooSupply` field (src/subjects/math/profile.ts); everything else here
// (dg mapping, CLI args, kill switch) is deterministic config. Pure — no IO, no DB.

import { resolveSubjectProfile } from '@/subjects/profile';
import type { DifficultyBand } from './target-discovery';

// The producer route stamped on every jyeoo-sourced draft (difficulty_evidence
// source_route + canary events). Extracted so the literal is written once (a typo in
// an inline string would silently produce a wrong route with no compile-time check).
export const JYEOO_FETCH_ROUTE = 'jyeoo_fetch' as const;

// Kill switch (P4). Dark-ship OPT-IN, default OFF — mirrors QUESTION_SUPPLY_REFILL_ENABLED
// (accepts both 'true' and '1'). OFF ⇒ the dispatcher skips jyeoo_fetch and falls back to
// sourcing_web (chooseAutoRoute), and the handler no-ops if a job still reaches it.
export function jyeooFetchEnabled(): boolean {
  const raw = process.env.JYEOO_FETCH_ENABLED;
  return raw === 'true' || raw === '1';
}

// Path to the jyeoo-rs binary. Configurable so prod/NAS can pin an absolute path and
// tests can point at a fake script. Defaults to `jyeoo-rs` on PATH.
export function jyeooBinaryPath(): string {
  const raw = process.env.JYEOO_RS_BINARY;
  return raw && raw.trim().length > 0 ? raw.trim() : 'jyeoo-rs';
}

// Bounded-subprocess guardrails (jyeoo-spawn). Deterministic caps so a runaway/wedged
// producer can never exhaust the worker: wall-clock timeout kills the process; the byte
// caps bound memory. Tunable via env for prod, with conservative defaults.
export const JYEOO_SPAWN_TIMEOUT_MS = readPositiveIntEnv('JYEOO_RS_TIMEOUT_MS', 120_000);
export const JYEOO_SPAWN_MAX_STDOUT_BYTES = readPositiveIntEnv(
  'JYEOO_RS_MAX_STDOUT_BYTES',
  8 * 1024 * 1024,
);
export const JYEOO_SPAWN_MAX_STDERR_BYTES = readPositiveIntEnv(
  'JYEOO_RS_MAX_STDERR_BYTES',
  256 * 1024,
);

// Default pages to request per search (DESIGN §6 草案 uses 2). One page ~= a handful of
// questions; 2 keeps the fetch bounded and polite (producer enforces its own ≥300ms
// pacing + concurrency cap).
export const JYEOO_DEFAULT_PAGES = 2;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The producer's per-subject config a loom subject profile declares. */
export interface JyeooSupplyConfig {
  /** jyeoo-rs subject vocabulary token, e.g. 'math2' (NOT the loom subject id). */
  subject: string;
}

/**
 * The jyeoo producer subject for a loom subject id, or null when the subject has no
 * declared jyeoo support. Reads the STATIC subject profile registry (deterministic,
 * in-memory — no IO), so route-planner can consult it while staying a pure function of
 * (target, static profiles). resolveSubjectProfile handles aliases + unknown→general
 * (general has no jyeooSupply → null).
 */
export function jyeooSupplySubjectFor(subjectId: string): string | null {
  const profile = resolveSubjectProfile(subjectId) as { jyeooSupply?: JyeooSupplyConfig };
  const cfg = profile.jyeooSupply;
  return cfg && typeof cfg.subject === 'string' && cfg.subject.length > 0 ? cfg.subject : null;
}

/** Does this loom subject have a declared jyeoo producer? Pure (static profile read). */
export function subjectSupportsJyeooFetch(subjectId: string): boolean {
  return jyeooSupplySubjectFor(subjectId) != null;
}

/**
 * Map a loom coverage DifficultyBand → jyeoo `--dg` filter token (DESIGN §1.4 vocab:
 * easy / fairly-easy / medium / hard / difficult). The band is θ̂-relative (near = at the
 * learner's ability); we request the jyeoo difficulty tier closest to that band so the
 * producer deterministically filters the right shelf (design §2.2 — jyeoo's edge over an
 * agent that can only self-report difficulty). Calibration of jyeoo's 5-tier scale onto
 * loom logit-b is a declared follow-up (design §2.2 步骤2), not this seam's job.
 */
export function jyeooDgTokenForBand(band: DifficultyBand): string {
  switch (band) {
    case 'below':
      return 'easy';
    case 'near':
      return 'medium';
    case 'above':
      return 'hard';
    case 'stretch':
      return 'difficult';
    default:
      return 'medium';
  }
}
