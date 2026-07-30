/** Minimal response-aware fields shared by proposal/lifecycle compatibility tests. */
export const RESPONSE_AWARE_PROBE_FIELDS = {
  schema_version: 2 as const,
  response_mode: 'short_answer' as const,
  gold_response_signature: { kind: 'text' as const, response_md: 'gold response' },
  target_error_response_signature: {
    kind: 'text' as const,
    response_md: 'target-error response',
  },
} as const;
