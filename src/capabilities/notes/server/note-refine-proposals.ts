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
}

export async function writeNoteRefineProposal(
  params: WriteNoteRefineProposalParams,
): Promise<string> {
  const { db, artifactId, patch, summary, triggerEventId, taskResult } = params;
  return writeAiProposal(db, {
    actor_ref: 'note_refine',
    payload: {
      kind: 'note_update',
      target: { subject_kind: 'artifact', subject_id: artifactId },
      reason_md: `Living Note 建议 ${summary.ops_count} 个 patch op（新增 ${summary.new_blocks} 个 block），超过 mutator v0 阈值，转入人工审批。`,
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
