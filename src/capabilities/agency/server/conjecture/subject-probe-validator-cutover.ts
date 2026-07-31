import { newId } from '@/core/ids';
import { ConjectureProbeQualityAudit } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import { subjectProbeValidatorsBlockingEnabled } from '@/server/agency/conjecture/probe-quality';
import { acquireProposalDecisionLock } from '@/server/proposals/applier-helpers';
import {
  type ProposalInboxRow,
  getProposalInboxRow,
  listProposalInboxRows,
} from '@/server/proposals/inbox';
import { SUBJECT_PROBE_VALIDATOR_POLICY_VERSION } from '@/subjects/probe-quality';

type DbLike = Db | Tx;
type ListPendingConjecturesFn = (db: DbLike) => Promise<ProposalInboxRow[]>;
type GetProposalFn = (db: DbLike, proposalId: string) => Promise<ProposalInboxRow | null>;
type AcquireProposalDecisionLockFn = (tx: Tx, proposalId: string) => Promise<void>;
type WriteEventFn = (db: DbLike, input: WriteEventInput) => Promise<string>;

interface SubjectProbeValidatorBlockingCutoverDeps {
  blockingEnabledFn?: () => boolean;
  listPendingConjecturesFn?: ListPendingConjecturesFn;
  getProposalFn?: GetProposalFn;
  acquireProposalDecisionLockFn?: AcquireProposalDecisionLockFn;
  writeEventFn?: WriteEventFn;
  nowFn?: () => Date;
}

export interface SubjectProbeValidatorBlockingCutoverReport {
  enabled: boolean;
  pending_scanned: number;
  retired: number;
}

function hasPersistedSubjectValidatorFailure(row: ProposalInboxRow): boolean {
  if (row.status !== 'pending' || row.payload.kind !== 'conjecture') return false;
  const audit = ConjectureProbeQualityAudit.safeParse(row.payload.proposed_change.probe_quality);
  return (
    audit.success &&
    audit.data.schema_version === 4 &&
    audit.data.policy_version === SUBJECT_PROBE_VALIDATOR_POLICY_VERSION &&
    audit.data.subject_validator_results.some((result) => result.outcome === 'fail')
  );
}

function retirementEventId(proposalId: string): string {
  // A later owner restore is a new correction generation. Reusing a deterministic
  // proposal-only id would make writeEvent's first-write-wins ignore the next
  // blocking retirement. The decision lock + post-lock status reload already make
  // simultaneous app/worker boots idempotent, so each actual retirement must append.
  return `subject_probe_validator_blocking_retire_${proposalId}_${newId()}`;
}

/**
 * Blocking activation cutover.
 *
 * Shadow mode deliberately permits a v4 package with persisted deterministic
 * validator failures to remain pending. Once blocking is enabled, that same row
 * is no longer acceptable and would otherwise occupy the cause x KC dedup key
 * forever. API and worker boot both call this before serving/consuming work, so a
 * flag deployment first retires every such row and the next meeting can prepare
 * a replacement under the blocking policy.
 *
 * The per-proposal advisory lock serializes this system correction with an owner
 * decision. The second simultaneous app/worker caller reloads the folded row
 * after taking the lock and skips it; a later owner restore receives a fresh
 * correction event rather than colliding with the first retirement.
 */
export async function prepareSubjectProbeValidatorBlockingCutover(
  db: Db,
  deps: SubjectProbeValidatorBlockingCutoverDeps = {},
): Promise<SubjectProbeValidatorBlockingCutoverReport> {
  const blockingEnabledFn = deps.blockingEnabledFn ?? subjectProbeValidatorsBlockingEnabled;
  if (!blockingEnabledFn()) {
    return { enabled: false, pending_scanned: 0, retired: 0 };
  }

  const listPendingConjecturesFn =
    deps.listPendingConjecturesFn ??
    ((handle: DbLike) => listProposalInboxRows(handle, { status: 'pending', kind: 'conjecture' }));
  const getProposalFn = deps.getProposalFn ?? getProposalInboxRow;
  const acquireProposalDecisionLockFn =
    deps.acquireProposalDecisionLockFn ?? acquireProposalDecisionLock;
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const nowFn = deps.nowFn ?? (() => new Date());
  const pending = await listPendingConjecturesFn(db);
  const candidates = pending.filter(hasPersistedSubjectValidatorFailure);
  let retired = 0;

  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      await acquireProposalDecisionLockFn(tx, candidate.id);
      const current = await getProposalFn(tx, candidate.id);
      if (!current || !hasPersistedSubjectValidatorFailure(current)) return;

      const now = nowFn();
      await writeEventFn(tx, {
        id: retirementEventId(candidate.id),
        actor_kind: 'agent',
        actor_ref: 'subject_probe_validator_blocking_cutover',
        action: 'correct',
        subject_kind: 'event',
        subject_id: candidate.id,
        outcome: 'success',
        payload: {
          correction_kind: 'retract',
          reason_md:
            'Conjecture retired when subject probe validators became blocking; regenerate under the blocking policy.',
          affected_refs: [{ kind: 'open_inquiry', id: candidate.id }],
        },
        caused_by_event_id: candidate.id,
        affected_scopes: [],
        ingest_at: now,
        created_at: now,
      });
      retired += 1;
    });
  }

  return {
    enabled: true,
    pending_scanned: pending.length,
    retired,
  };
}
