/** Shared grammar for runtime `*_ENABLED` environment flags. */
export interface ParseFlagOptions {
  /** Value used for an absent, blank, or unrecognized literal. */
  defaultValue?: boolean;
}

/**
 * Parse a runtime feature flag with one repo-wide literal grammar.
 *
 * `true` / `1` enable and `false` / `0` disable, case-insensitively and with
 * surrounding whitespace ignored. Unknown values preserve the caller's declared
 * default, so opt-in and opt-out flags share syntax without changing polarity.
 */
export function parseFlag(
  value: string | undefined,
  { defaultValue = false }: ParseFlagOptions = {},
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return defaultValue;
}
