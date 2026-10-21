import { sha256Hex } from './migration/canonical';

/** Maximum UTF-8 bytes of raw submit arguments kept as failure evidence. */
export const RAW_ARGUMENTS_EVIDENCE_MAX_BYTES = 4096;

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * Bounded raw-arguments evidence for a failed structured submit: the truncated payload
 * plus a digest of the FULL string, so truncated rows still match the digest recorded
 * in error messages.
 */
export function rawArgumentsEvidence(
  rawArgs: string,
  maxBytes = RAW_ARGUMENTS_EVIDENCE_MAX_BYTES,
): { raw_arguments: string; raw_args_sha256: string; truncated: boolean } {
  const truncated = truncateUtf8(rawArgs, maxBytes);
  return {
    raw_arguments: truncated,
    raw_args_sha256: sha256Hex(rawArgs),
    truncated: truncated !== rawArgs,
  };
}
