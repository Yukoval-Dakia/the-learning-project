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
import type { SubjectProfile } from '@/subjects/profile-schema';
import type { DifficultyBand } from './target-discovery';

// The producer route stamped on every jyeoo-sourced draft (difficulty_evidence
// source_route + canary events). Extracted so the literal is written once (a typo in
// an inline string would silently produce a wrong route with no compile-time check).
export const JYEOO_FETCH_ROUTE = 'jyeoo_fetch' as const;

// The ONLY host jyeoo-rs sources from — every source_url is
// `https://www.jyeoo.com/{subject}/ques/detail/{id}` (producer DESIGN §1.2). A row whose
// host is anything else is a producer anomaly (parse bug / stray redirect); the handler
// filters it BEFORE INSERT so a foreign URL can't ride the deterministic route into tier-2
// (source_verify grounds against the persisted extract, never a refetch, so a non-jyeoo URL
// would otherwise promote unchecked).
export const JYEOO_SOURCE_HOST = 'www.jyeoo.com';

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
// caps bound memory. Tunable via env for prod, with conservative defaults. Lazy readers
// (not module-load consts) so they mirror jyeooFetchEnabled/jyeooBinaryPath — runtime-
// flippable and test-overridable via process.env.
export function jyeooSpawnTimeoutMs(): number {
  return readPositiveIntEnv('JYEOO_RS_TIMEOUT_MS', 120_000);
}
export function jyeooSpawnMaxStdoutBytes(): number {
  return readPositiveIntEnv('JYEOO_RS_MAX_STDOUT_BYTES', 8 * 1024 * 1024);
}
export function jyeooSpawnMaxStderrBytes(): number {
  return readPositiveIntEnv('JYEOO_RS_MAX_STDERR_BYTES', 256 * 1024);
}

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

/**
 * The producer's per-subject config a loom subject profile declares. Single-sourced from
 * SubjectProfileSchema.jyeooSupply so the shape can never drift from the schema/write gate.
 */
export type JyeooSupplyConfig = NonNullable<SubjectProfile['jyeooSupply']>;

/**
 * The jyeoo producer subject for a loom subject id, or null when the subject has no
 * declared jyeoo support. Reads the STATIC subject profile registry (deterministic,
 * in-memory — no IO), so route-planner can consult it while staying a pure function of
 * (target, static profiles). resolveSubjectProfile handles aliases + unknown→general
 * (general has no jyeooSupply → null). `subject` is schema-guaranteed non-empty
 * (z.string().trim().min(1)), so no manual emptiness check is needed.
 */
export function jyeooSupplySubjectFor(subjectId: string): string | null {
  return resolveSubjectProfile(subjectId).jyeooSupply?.subject ?? null;
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
  }
  // Exhaustiveness guard: DifficultyBand is a closed union, so a new member added there
  // fails to compile here (never assignment) rather than silently defaulting to 'medium'.
  const _exhaustive: never = band;
  return _exhaustive;
}
