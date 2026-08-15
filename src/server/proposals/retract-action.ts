import { newId } from '@/core/ids';
import type { ActivityRefT } from '@/core/schema/activity';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { getProposalLifecycleOperation } from '@/kernel/proposals';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  extractRecordEvidenceIds,
  rollbackRecordsActioned,
} from '@/kernel/records/record-processing';
import type { RetractAiProposalOpts, RetractAiProposalResult } from './action-types';
import { acquireProposalDecisionLock } from './applier-helpers';
import { ownerInput, proposalLifecycleRegistry, requireProposal } from './lifecycle-context';

function activityRefsForProposal(proposal: ProposalInboxRow): ActivityRefT[] {
  const direct = activityRefFromTarget(proposal.target.subject_kind, proposal.target.subject_id);
  if (direct) return [direct];

  for (const ref of proposal.payload.evidence_refs) {
    const activityRef = activityRefFromEvidence(ref);
    if (activityRef) return [activityRef];
  }
  return [{ kind: 'open_inquiry', id: proposal.id }];
}

function activityRefFromTarget(subjectKind: string, subjectId: string | null): ActivityRefT | null {
  if (!subjectId) return null;
  if (subjectKind === 'question') return { kind: 'question', id: subjectId };
  if (subjectKind === 'record') return { kind: 'record', id: subjectId };
  if (subjectKind === 'project_milestone') return { kind: 'project_milestone', id: subjectId };
  if (subjectKind === 'open_inquiry') return { kind: 'open_inquiry', id: subjectId };
  return null;
}

function activityRefFromEvidence(
  ref: AiProposalPayloadT['evidence_refs'][number],
): ActivityRefT | null {
  if (ref.kind === 'question') return { kind: 'question', id: ref.id };
  if (ref.kind === 'record') return { kind: 'record', id: ref.id };
  return null;
}

export async function retractAiProposal(
  db: Db,
  proposalId: string,
  opts: RetractAiProposalOpts = {},
): Promise<RetractAiProposalResult> {
  const proposal = await requireProposal(db, proposalId);
  const correctionEventId = newId();
  const declaration = getProposalLifecycleOperation(
    proposalLifecycleRegistry,
    proposal.payload.kind,
    'retract',
  );
  const applier = declaration ? await declaration.load() : undefined;

  await db.transaction(async (tx) => {
    await acquireProposalDecisionLock(tx, proposalId);
    const correctionAt = new Date();
    await writeEvent(tx, {
      id: correctionEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: opts.reason_md ?? 'proposal retracted from inbox',
        affected_refs: opts.affected_refs ?? activityRefsForProposal(proposal),
      },
      caused_by_event_id: proposalId,
      created_at: correctionAt,
    });

    if (applier) {
      await applier(tx, {
        proposalId,
        proposal: ownerInput(proposal),
        correction_at: correctionAt,
        reason_md: opts.reason_md,
        affected_refs: opts.affected_refs,
      });
    }

    const recordIds = extractRecordEvidenceIds(proposal.payload.evidence_refs);
    if (recordIds.length > 0) await rollbackRecordsActioned(tx, recordIds);
  });

  return { kind: 'retracted', correction_event_id: correctionEventId };
}
