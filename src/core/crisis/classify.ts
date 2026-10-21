// Deterministic crisis detection: lexical only, no model call. The raw text never
// leaves the caller; events record only class, template version, and entry point.
// First match wins: explicit > indirect > quoted_ironic > distress.

import { CRISIS_GUARD_CONFIG, type CrisisDetectionClass } from './config';

export type {
  CrisisDetectionClass,
  CrisisGuardConfig,
  CrisisTemplate,
} from './config';
export {
  CRISIS_GUARD_CONFIG,
  CRISIS_GUARD_CONFIG_VERSION,
  crisisTemplateForClass,
} from './config';

function normalize(text: string): string {
  // Lowercase for English patterns and collapse whitespace; keep emoji (joke signal).
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Match each pattern against both forms: whitespace-collapsed (English phrases) and
 * fully despaced (Chinese input often has stray spaces). Either hit counts.
 */
function matchesAny(patterns: readonly RegExp[], spaced: string, despaced: string): boolean {
  return patterns.some((pattern) => pattern.test(spaced) || pattern.test(despaced));
}

/** Pure; never throws — any input failure degrades to 'none'. */
export function classifyCrisisExpression(rawText: string): CrisisDetectionClass {
  let text: string;
  try {
    text = normalize(rawText);
  } catch {
    return 'none';
  }
  if (!text) return 'none';
  const despaced = text.replace(/ /g, '');
  const ordered: readonly [CrisisDetectionClass, readonly RegExp[]][] = [
    ['explicit', CRISIS_GUARD_CONFIG.explicit_patterns],
    ['indirect', CRISIS_GUARD_CONFIG.indirect_patterns],
    ['quoted_ironic', CRISIS_GUARD_CONFIG.quoted_ironic_patterns],
    ['distress', CRISIS_GUARD_CONFIG.distress_patterns],
  ];
  for (const [detectionClass, patterns] of ordered) {
    try {
      if (matchesAny(patterns, text, despaced)) return detectionClass;
    } catch {
      // One corrupt pattern group must not block the remaining classes.
    }
  }
  return 'none';
}
