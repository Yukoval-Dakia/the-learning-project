import { NotePatch } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
  ProposalRetractApplier,
} from '@/kernel/proposals';
import { toProposalLifecycleResult } from '@/kernel/proposals';
import {
  asPlainRecord,
  ensureAcceptOnly,
  findExistingRateEvent,
  requiredString,
} from '@/kernel/proposals/applier-helpers';
import {
  type ProposalAcceptEffectOutcome,
  type RecordedProposalRate,
  runProposalAccept,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  NOTE_REFINE_ACCEPT_ACTOR,
  persistNoteRefineApply,
  undoNoteRefineApplyEvent,
} from './note-refine-apply';

export const noteUpdateProposalRetractApplier: ProposalRetractApplier = async (db, input) => {
  const ownerDb = db as Db;
  const rate = await findExistingRateEvent(ownerDb, input.proposalId);
  const applyEventId =
    rate?.decision === 'accept'
      ? (rate.payload as { materialized_apply_event_id?: unknown }).materialized_apply_event_id
      : undefined;
  if (typeof applyEventId === 'string' && applyEventId.length > 0) {
    await undoNoteRefineApplyEvent(ownerDb, { applyEventId });
  }
};

export interface NoteUpdateAcceptResult {
  kind: 'note_update';
  rate_event_id: string;
  artifact_id: string;
  apply_event_id: string | null;
  artifact_version: number | null;
  idempotent?: boolean;
}

type NoteUpdateApplierOpts = {
  decision?: string;
  user_note?: string;
};

function inboxView(input: ProposalAcceptInput): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

async function acceptNoteUpdateProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: NoteUpdateApplierOpts,
): Promise<NoteUpdateAcceptResult> {
  ensureAcceptOnly('note_update', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const artifactId = requiredString(
    change.artifact_id ?? proposal.target.subject_id,
    'artifact_id',
    proposalId,
  );
  const patchParsed = NotePatch.safeParse(change.patch);
  if (!patchParsed.success) {
    throw new ApiError(
      'validation_error',
      `note_update proposal ${proposalId} has invalid proposed_change.patch: ${patchParsed.error.issues.map((issue) => issue.message).join('; ')}`,
      400,
    );
  }

  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'in_transaction',
    replay: async (rate: RecordedProposalRate): Promise<NoteUpdateAcceptResult> => {
      const payload = rate.payload as {
        materialized_apply_event_id?: unknown;
        materialized_artifact_version?: unknown;
      };
      return {
        kind: 'note_update',
        rate_event_id: rate.id,
        artifact_id: artifactId,
        apply_event_id:
          typeof payload.materialized_apply_event_id === 'string'
            ? payload.materialized_apply_event_id
            : null,
        artifact_version:
          typeof payload.materialized_artifact_version === 'number'
            ? payload.materialized_artifact_version
            : null,
        idempotent: true,
      };
    },
    // The kernel takes the decision lock before this effect touches the artifact row, so a
    // racing decision on this proposal is seen instead of landing beside this accept.
    effect: async ({
      tx,
      writeRate,
    }): Promise<ProposalAcceptEffectOutcome<NoteUpdateAcceptResult>> => {
      const now = new Date();
      const applyResult = await persistNoteRefineApply({
        db: tx,
        artifactId,
        patch: patchParsed.data,
        triggerEventId: proposalId,
        actorRef: NOTE_REFINE_ACCEPT_ACTOR,
        now,
      });
      if (applyResult.status !== 'applied') {
        throw new ApiError(
          'conflict',
          `note_update proposal ${proposalId} could not apply patch (${applyResult.status})`,
          409,
        );
      }
      const applyEventId = applyResult.event_id ?? null;
      const artifactVersion = applyResult.artifact_version ?? null;
      const rateEventId = await writeRate({
        created_at: now,
        payload: {
          materialized_artifact_id: artifactId,
          materialized_apply_event_id: applyEventId,
          materialized_artifact_version: artifactVersion,
        },
      });
      return {
        status: 'accepted',
        result: {
          kind: 'note_update',
          rate_event_id: rateEventId,
          artifact_id: artifactId,
          apply_event_id: applyEventId,
          artifact_version: artifactVersion,
        },
      };
    },
  });
  return result;
}

export const noteUpdateProposalAcceptApplier: ProposalAcceptApplier = async (db, input) => {
  const result = await acceptNoteUpdateProposal(db as Db, input.proposalId, inboxView(input), {
    decision: input.decision,
    user_note: input.user_note,
  });
  return {
    kind: 'note_update',
    result: toProposalLifecycleResult(result),
  } satisfies ProposalAcceptResult;
};
