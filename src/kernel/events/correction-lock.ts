/**
 * Advisory-lock keys shared by correction writers and readers that must decide
 * against an unchanging source event.
 */
export function eventCorrectionLockKey(eventId: string): string {
  return `intervention:source:${eventId}`;
}

/** Serializes correction inserts with activation's complete direct-chain read. */
export function eventCorrectionsGlobalLockKey(): string {
  return 'intervention:corrections:all';
}
