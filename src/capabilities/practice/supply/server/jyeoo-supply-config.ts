// Constants and spawn env for the jyeoo agent tool chain. The producer's grade route
// cannot target a KC and its daily account budget does not fit per-target dispatch;
// candidates are fetched by tools/jyeoo-fetch-candidates.ts and committed through
// tools/store-sourced-question.ts.

// Shared route literal with sourcing_web / quiz_gen; still a valid provenance value.
export const JYEOO_FETCH_ROUTE = 'jyeoo_fetch';
// Question images must be localized into loom assets before ingestion; no off-site URLs.
export const JYEOO_SOURCE_HOST = 'www.jyeoo.com';

import { homedir } from 'node:os';
import { getConfig, resolveConfigValue } from '@/core/config/store';

// JYEOO_RS_BINARY wins; otherwise the path shared by local smoke runs and the worker.
export function jyeooBinaryPath(): string {
  const resolved = getConfig('JYEOO_RS_BINARY');
  if (typeof resolved === 'string' && resolved.trim().length > 0) return resolved;
  return `${homedir()}/yukoval-projects/jyeoo-rs/target/release/jyeoo-rs`;
}

// Functions rather than module-load constants so tests can vary env per case.
// Grade-route fetches run ~45s+/question serially, so callers fetching N questions must
// raise JYEOO_SPAWN_TIMEOUT_MS to at least N×90s; the 120s default is only an anti-hang
// bound. Manual backfill uses jyeooBackfillSpawnTimeoutMs, which scales with batch size.
// Numeric env values pass through Number.parseInt: garbage becomes NaN and non-positive
// values are rejected at the spawn boundary (fail-closed, recorded as a spawn failure).
export function jyeooSpawnTimeoutMs(): number {
  const v = getConfig('JYEOO_SPAWN_TIMEOUT_MS');
  return typeof v === 'number' ? v : 120_000;
}

/** Per-question backfill budget: observed ~45s/question including jitter, doubled for discovery. */
export const JYEOO_BACKFILL_PER_QUESTION_MS = 90_000;

/**
 * Backfill spawn timeout, in priority order: explicit JYEOO_BACKFILL_TIMEOUT_MS, then a
 * configured JYEOO_SPAWN_TIMEOUT_MS, then sessionMax × JYEOO_BACKFILL_PER_QUESTION_MS.
 * An empty string counts as unset; garbage or non-positive values fail closed at spawn.
 */
export function jyeooBackfillSpawnTimeoutMs(sessionMax: number): number {
  // Unset means neither DB nor env supplied the key; code defaults fall through.
  const backfill = resolveConfigValue('JYEOO_BACKFILL_TIMEOUT_MS');
  if (backfill.source === 'db' || backfill.source === 'env') return backfill.value as number;
  const spawn = resolveConfigValue('JYEOO_SPAWN_TIMEOUT_MS');
  if (spawn.source === 'db') return spawn.value as number;
  if (spawn.source === 'env') {
    // The direct reader passes '' through as NaN; the backfill chain treats it as unset
    // and derives a default. Only env can hold '', since DB values are positive ints.
    if (process.env.JYEOO_SPAWN_TIMEOUT_MS !== '') return spawn.value as number;
  }
  return sessionMax * JYEOO_BACKFILL_PER_QUESTION_MS;
}

export function jyeooSpawnMaxStdoutBytes(): number {
  const v = getConfig('JYEOO_SPAWN_MAX_STDOUT_BYTES');
  return typeof v === 'number' ? v : 8 * 1024 * 1024;
}
export function jyeooSpawnMaxStderrBytes(): number {
  const v = getConfig('JYEOO_SPAWN_MAX_STDERR_BYTES');
  return typeof v === 'number' ? v : 1024 * 1024;
}
