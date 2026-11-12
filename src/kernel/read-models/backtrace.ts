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
type Reader = (db: Db, query: BacktraceContextQuery) => Promise<string | null>;
const SLOT = 'kernel/read-models/backtrace:context';
export function installBacktraceContextReader(reader: Reader) {
  installHostOperation(SLOT, reader);
}
export async function readBacktraceContext(db: Db, query: BacktraceContextQuery) {
  const reader = installedHostOperation<Reader>(SLOT);
  if (!reader) throw new HostOperationNotInstalledError('Backtrace context reader not installed');
  return reader(db, query);
}
