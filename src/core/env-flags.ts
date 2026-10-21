/** Shared grammar for runtime `*_ENABLED` flags. */
export interface ParseFlagOptions {
  /** Value used for absent, blank, or unrecognized literals. */
  defaultValue?: boolean;
}

/**
 * Parse a flag: true/1 and false/0, case-insensitive, surrounding whitespace ignored.
 * Unknown values keep the caller's default, so opt-in and opt-out share syntax.
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
