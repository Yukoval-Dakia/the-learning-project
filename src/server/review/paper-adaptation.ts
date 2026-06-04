// U5 (YUK-203, §4.7) — mid-attempt paper adaptation event (RL5, ADR-0006 v2
// evidence-first).
//
// When the paper artifact is mutated in place mid-attempt (optimistic-
// concurrency version bump), an `experimental:adaptation` event MUST be written
// in the SAME transaction as the artifact update, or the audit trail drifts from
// the mutation. Uses the ExperimentalEvent escape hatch (Q10) — NOT a new
// KnownEvent: mid-attempt adaptation is exploratory (CO §5.7) and promoting it
// to a first-class schema + migration is premature until the shape stabilizes.
//
// DEFER (§11 completeness): the U5 MVP answering page is static text+choice and
// has NO mid-attempt adaptation trigger (no UI/Coach path rewrites the paper
// in-session). This helper is the CONTRACT — the write point any future
// adaptation trigger must call. It is exercised by a contract test (helper +
// version-bump happen together) but no real trigger ships in U5.

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';

type DbLike = Db | Tx;

export interface WritePaperAdaptationEventInput {
  /** the paper artifact mutated mid-attempt */
  artifactId: string;
  /** the artifact version before the mutation */
  fromVersion: number;
  /** the artifact version after the mutation */
  toVersion: number;
  /** human-readable summary of what changed */
  changeSummary: string;
  /** the judgement that triggered the adaptation — chains the audit trail */
  triggeringJudgeEventId: string;
  /** the review session running the paper (optional) */
  sessionId?: string | null;
}

/**
 * Emit the `experimental:adaptation` event. MUST be called inside the same
 * transaction as the artifact `version` bump (caller's responsibility) so the
 * audit trail cannot drift from the mutation.
 *
 * @returns the new event id.
 */
export async function writePaperAdaptationEvent(
  db: DbLike,
  input: WritePaperAdaptationEventInput,
): Promise<string> {
  const eventId = newId();
  await writeEvent(db, {
    id: eventId,
    session_id: input.sessionId ?? null,
    actor_kind: 'agent',
    actor_ref: 'paper_adaptation',
    action: 'experimental:adaptation',
    // ExperimentalEvent locks only action + payload; subject fields ride the
    // envelope. subject_kind='artifact' / subject_id=the mutated paper.
    subject_kind: 'artifact',
    subject_id: input.artifactId,
    outcome: 'success',
    payload: {
      artifact_id: input.artifactId,
      from_version: input.fromVersion,
      to_version: input.toVersion,
      change_summary: input.changeSummary,
    },
    caused_by_event_id: input.triggeringJudgeEventId,
    created_at: new Date(),
  });
  return eventId;
}
