import { newId } from '@/core/ids';
import {
  type AiProposalPayloadInputT,
  type AiProposalPayloadT,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { costUsdToMicroUsd } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
// YUK-15 — record→proposal evidence loop: flip records cited as evidence
// from raw → linked in the same DbLike scope as the propose event so the
// projection stays consistent (caller can pass a tx to make this atomic).
import {
  extractRecordEvidenceIds,
  markRecordsLinked,
} from '@/server/records/record_processing';

type DbLike = Db | Tx;

export interface WriteAiProposalInput {
  id?: string;
  session_id?: string | null;
  actor_ref?: string;
  outcome?: 'success' | 'partial';
  payload: AiProposalPayloadInputT;
  event_override?: {
    action: string;
    subject_kind: string;
    subject_id?: string;
    payload?: Record<string, unknown>;
  };
  caused_by_event_id?: string | null;
  task_run_id?: string | null;
  cost_usd?: number;
  created_at?: Date;
}

function defaultOutcome(payload: AiProposalPayloadT): 'success' | 'partial' {
  return payload.kind === 'knowledge_edge' ? 'success' : 'partial';
}

function proposalSubjectId(payload: AiProposalPayloadT): string {
  return payload.target.subject_id ?? newId();
}

function eventShapeForProposal(payload: AiProposalPayloadT): {
  action: string;
  subject_kind: string;
  subject_id: string;
  event_payload: Record<string, unknown>;
} {
  switch (payload.kind) {
    case 'knowledge_node':
      return {
        action: 'propose',
        subject_kind: 'knowledge',
        subject_id: proposalSubjectId(payload),
        event_payload: {
          name: payload.proposed_change.name,
          parent_id: payload.proposed_change.parent_id,
          reasoning: payload.reason_md,
          ai_proposal: payload,
        },
      };
    case 'knowledge_edge':
      return {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        subject_id: proposalSubjectId(payload),
        event_payload: {
          from_knowledge_id: payload.proposed_change.from_knowledge_id,
          to_knowledge_id: payload.proposed_change.to_knowledge_id,
          relation_type: payload.proposed_change.relation_type,
          weight: payload.proposed_change.weight,
          reasoning: payload.reason_md,
          ai_proposal: payload,
        },
      };
    default:
      return {
        action: 'experimental:proposal',
        subject_kind: payload.target.subject_kind,
        subject_id: proposalSubjectId(payload),
        event_payload: {
          ai_proposal: payload,
        },
      };
  }
}

export async function writeAiProposal(db: DbLike, input: WriteAiProposalInput): Promise<string> {
  const payload = parseAiProposalPayload(input.payload);
  const eventId = input.id ?? newId();
  const eventShape = input.event_override
    ? {
        action: input.event_override.action,
        subject_kind: input.event_override.subject_kind,
        subject_id: input.event_override.subject_id ?? proposalSubjectId(payload),
        event_payload: {
          ...(input.event_override.payload ?? {}),
          ai_proposal: payload,
        },
      }
    : eventShapeForProposal(payload);

  await writeEvent(db, {
    id: eventId,
    session_id: input.session_id ?? null,
    actor_kind: 'agent',
    actor_ref: input.actor_ref ?? 'dreaming',
    action: eventShape.action,
    subject_kind: eventShape.subject_kind,
    subject_id: eventShape.subject_id,
    outcome: input.outcome ?? defaultOutcome(payload),
    payload: eventShape.event_payload,
    caused_by_event_id: input.caused_by_event_id ?? null,
    task_run_id: input.task_run_id ?? null,
    cost_micro_usd: costUsdToMicroUsd(input.cost_usd),
    created_at: input.created_at,
  });

  // YUK-15 — flip cited records raw→linked. Safe no-op when no record refs;
  // shares db scope with the writeEvent call above (tx-aware via DbLike).
  const recordIds = extractRecordEvidenceIds(payload.evidence_refs);
  if (recordIds.length > 0) {
    await markRecordsLinked(db, recordIds);
  }

  return eventId;
}
