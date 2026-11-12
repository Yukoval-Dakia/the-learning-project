import type { Db } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';
export interface BacktraceContextQuery {
  attempt_event_id?: string;
  question_id?: string;
  session_id?: string;
}
export interface BacktraceContextResult {
  /** Model-facing digest; unchanged when no context resolves. */
  digest: string | null;
  /**
   * Event ids whose content fed the digest. Copilot replies persist them so
   * the derivation closure still authorizes against the consumed sources.
   */
  sourceEventIds: string[];
}
type Reader = (
  db: Db,
  query: BacktraceContextQuery,
) => Promise<BacktraceContextResult | string | null>;
const SLOT = 'kernel/read-models/backtrace:context';
export function installBacktraceContextReader(reader: Reader) {
  installHostOperation(SLOT, reader);
}
export async function readBacktraceContext(
  db: Db,
  query: BacktraceContextQuery,
): Promise<BacktraceContextResult | null> {
  const reader = installedHostOperation<Reader>(SLOT);
  if (!reader) throw new HostOperationNotInstalledError('Backtrace context reader not installed');
  const result = await reader(db, query);
  if (!result) return null;
  return typeof result === 'string' ? { digest: result, sourceEventIds: [] } : result;
}
