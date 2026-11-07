// Practice candidate read port (YUK-1790 LIGHT). The practice session owner owns the
// candidate union; the learning-direction owner (Coach) reads it through this kernel slot
// instead of importing a session implementation. Reads only — no queue write, no booking.
//
// `snapshot_id` joins every page of one planning read: pages never mix candidate states.
import type {
  PracticeCandidateQuery,
  PracticeCandidateRead,
} from '@/core/schema/practice-candidate';
import type { Db, Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

export type PracticeCandidateReader = (
  db: Db | Tx,
  query: PracticeCandidateQuery,
) => Promise<PracticeCandidateRead>;

const READER_SLOT = 'kernel/read-models/practice-candidates:reader';

export function installPracticeCandidateReader(reader: PracticeCandidateReader): void {
  installHostOperation(READER_SLOT, reader);
}

/**
 * A missing install is a host wiring defect, not a read failure: callers must rethrow
 * HostOperationNotInstalledError rather than degrade it to "no candidates".
 */
export async function readPracticeCandidates(
  db: Db | Tx,
  query: PracticeCandidateQuery,
): Promise<PracticeCandidateRead> {
  const reader = installedHostOperation<PracticeCandidateReader>(READER_SLOT);
  if (!reader) {
    throw new HostOperationNotInstalledError(
      'practice candidate reader is not installed; call installPracticeHost at startup',
    );
  }
  return reader(db, query);
}
