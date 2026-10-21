// Prep-desk read model: the top pending conjectures as a finite "为你而备" feed, not a
// backlog. Two invariants: internal calibration numbers never cross the wire (a raw
// probability invites optimizing the number), and a pending conjecture carries the unrun
// probe text because no question has been served yet.

import type { Db } from '@/db/client';
import { listProposalInboxPage } from '@/kernel/proposals/inbox';

export const PREP_DESK_MAX = 3;

// Rank a recent window before applying the cap; a high-salience older conjecture
// outside this window would otherwise be unreachable.
const PREP_DESK_FETCH_LIMIT = 50;

export interface PrepDeskEvidenceRef {
  kind: string;
  id: string;
}

export interface PrepDeskConjecture {
  id: string;
  claim: string;
  knowledge_id: string;
  cause_category: string;
  /** The unrun probe text — the question the team is about to ask. */
  probe_md: string;
  recurrence_count: number;
  discriminating: boolean;
  corrected_by_owner: boolean;
  evidence: PrepDeskEvidenceRef[];
  proposed_at: string;
}

export interface PrepDeskConjecturesResult {
  conjectures: PrepDeskConjecture[];
}

/** Rank by salience (confidence × recurrence) locally; confidence never leaves this scope. */
export async function loadPrepDeskConjectures(db: Db): Promise<PrepDeskConjecturesResult> {
  const { rows } = await listProposalInboxPage(db, {
    status: 'pending',
    kind: 'conjecture',
    limit: PREP_DESK_FETCH_LIMIT,
  });

  const ranked = rows
    .flatMap((row) => {
      if (row.payload.kind !== 'conjecture') return [];
      const change = row.payload.proposed_change;
      const salience = change.confidence * change.recurrence_count;
      const conjecture: PrepDeskConjecture = {
        id: row.id,
        claim: change.claim_md,
        knowledge_id: change.knowledge_id,
        cause_category: change.cause_category,
        probe_md: change.probe_md,
        recurrence_count: change.recurrence_count,
        discriminating: change.discriminating,
        corrected_by_owner: change.corrected_by_owner,
        evidence: row.payload.evidence_refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
        proposed_at: row.proposed_at.toISOString(),
      };
      return [{ salience, conjecture }];
    })
    .sort((a, b) => b.salience - a.salience)
    .slice(0, PREP_DESK_MAX)
    .map((entry) => entry.conjecture);

  return { conjectures: ranked };
}
