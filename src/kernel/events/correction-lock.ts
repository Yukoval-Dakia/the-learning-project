/**
 * Transaction-level advisory-lock namespace shared by correction writers and
 * consumers that must decide against an unchanging source-event truth.
 */
export function eventCorrectionLockKey(eventId: string): string {
  return `intervention:source:${eventId}`;
}

/** Serializes any correction insert with activation's complete direct-chain read. */
export function eventCorrectionsGlobalLockKey(): string {
  return 'intervention:corrections:all';
}
