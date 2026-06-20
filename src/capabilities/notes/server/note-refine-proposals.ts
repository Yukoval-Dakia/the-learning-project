import type { NotePatchSummary, NotePatchT } from '@/core/schema/note-patch';
import type { Db, Tx } from '@/db/client';
import type { TaskTextResult } from '@/server/ai/provenance';
import { writeAiProposal } from '@/server/proposals/writer';

type DbLike = Db | Tx;

export interface WriteNoteRefineProposalParams {
  db: DbLike;
  artifactId: string;
  patch: NotePatchT;
  summary: NotePatchSummary;
  triggerEventId?: string | null;
  taskResult?: TaskTextResult;
  // YUK-358 (ADR-0040 决定1) — set when this proposal is the A-track rate
  // breaker's fallback (auto-apply rate tripped the hard cap), not the normal
  // count/user_verified divert. Stamps `breaker_tripped: true` into
  // proposed_change so the inbox / audit can tell a runaway-rate fallback from a
  // routine over-threshold propose. The user can still accept it (退回人审 NOT
  // block); the reason_md explains why it landed in the inbox.
  breakerTripped?: boolean;
}

export async function writeNoteRefineProposal(
  params: WriteNoteRefineProposalParams,
): Promise<string> {
  const { db, artifactId, patch, summary, triggerEventId, taskResult, breakerTripped } = params;
  const reasonMd = breakerTripped
    ? `Living Note auto-apply 速率在单位时间内超限，熔断退回人工审批（本次 ${summary.ops_count} 个 patch op，新增 ${summary.new_blocks} 个 block）。可在收件箱直接采纳。`
    : `Living Note 建议 ${summary.ops_count} 个 patch op（新增 ${summary.new_blocks} 个 block），超过 mutator v0 阈值，转入人工审批。`;
  return writeAiProposal(db, {
    actor_ref: 'note_refine',
    payload: {
      kind: 'note_update',
      target: { subject_kind: 'artifact', subject_id: artifactId },
      reason_md: reasonMd,
      evidence_refs: [
        { kind: 'artifact', id: artifactId },
        ...(triggerEventId ? [{ kind: 'event' as const, id: triggerEventId }] : []),
      ],
      proposed_change: {
        artifact_id: artifactId,
        source: 'note_refine',
        patch,
        summary,
        trigger_event_id: triggerEventId ?? null,
        ...(breakerTripped ? { breaker_tripped: true } : {}),
      },
      rollback_plan: {
        action: 'dismiss proposal; no artifact mutation has been applied yet',
      },
      cooldown_key: `note_update:${artifactId}`,
    },
    caused_by_event_id: triggerEventId ?? null,
    task_run_id: taskResult?.task_run_id ?? null,
    cost_usd: taskResult?.cost_usd,
  });
}
