// Memory-brief host port (YUK-1794 B1). Agency owns the brief read semantics
// (row + purpose-current gate + freshness) in `capabilities/agency/context`;
// kernel cannot import a capability, so the reader is installed at startup —
// same shape as the learner-context port. Callers get the raw note plus the
// freshness signal; they must not re-implement the purpose/freshness rules.

import type { Db, Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

type DbLike = Db | Tx;

export interface MemoryBriefNote {
  id: string;
  scope_key: string;
  subject_id: string | null;
  recent_week_md: string;
  recent_months_md: string;
  long_term_md: string;
  /** Advisory render annotation only, not evidence-gated (a score is not provenance). */
  long_term_freshness_score: number | null;
  refreshed_at: Date | null;
  source_event_id: string | null;
  version: number;
  recent_week_evidence_ids: string[];
  recent_months_evidence_ids: string[];
  long_term_evidence_ids: string[];
}

export interface MemoryBriefFreshness {
  /** 'missing' covers both "no row" and "purpose withdrawn, not yet regenerated". */
  state: 'fresh' | 'stale' | 'missing';
  /** Age of refreshed_at; null when the row/timestamp is absent. */
  age_ms: number | null;
  stale_after_ms: number;
}

export interface MemoryBriefRead {
  /** null when the row is absent or its brief purpose is no longer current. */
  note: MemoryBriefNote | null;
  freshness: MemoryBriefFreshness;
}

export type MemoryBriefReader = (
  db: DbLike,
  scopeKey: string,
  now?: Date,
) => Promise<MemoryBriefRead>;

const READER_SLOT = 'kernel/read-models/memory-brief:reader';

export function installMemoryBriefReader(reader: MemoryBriefReader): void {
  installHostOperation(READER_SLOT, reader);
}

/**
 * The one memory-brief read for non-agency consumers. A missing install is a
 * host wiring defect, not a read failure — callers that degrade on errors must
 * rethrow HostOperationNotInstalledError rather than hide it.
 */
export async function readMemoryBrief(
  db: DbLike,
  scopeKey: string,
  now?: Date,
): Promise<MemoryBriefRead> {
  const reader = installedHostOperation<MemoryBriefReader>(READER_SLOT);
  if (!reader) {
    throw new HostOperationNotInstalledError(
      'memory-brief reader is not installed; call installAgencyHostOperations at startup',
    );
  }
  return reader(db, scopeKey, now);
}
