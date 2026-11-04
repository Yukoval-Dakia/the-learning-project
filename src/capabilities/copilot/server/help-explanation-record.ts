import { eq } from 'drizzle-orm';
import { helpCost } from '@/ai/help-latency';
import type {
  HelpExplanationEvidence,
  SealedHelpExplanationReceipt,
} from '@/ai/help-reply-grounding';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

export async function loadHelpExplanationEvidence(
  db: Db,
  ran: {
    task_run_id?: string | null;
    cost_basis?: 'reported' | 'estimated' | 'unknown';
    cost_usd?: number;
  },
): Promise<HelpExplanationEvidence> {
  let provider: string | null = null;
  let model: string | null = null;
  const taskRunId = ran.task_run_id ?? null;
  if (taskRunId) {
    const [row] = await db
      .select({ provider: ai_task_runs.provider, model: ai_task_runs.model })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId))
      .limit(1);
    provider = row?.provider ?? null;
    model = row?.model ?? null;
  }
  return {
    task_run_id: taskRunId,
    provider,
    model,
    cost: helpCost(ran.cost_basis, ran.cost_usd),
  };
}

export async function persistHelpExplanationReceipt(
  db: Db,
  input: {
    sessionId?: string | null;
    subjectKind: string;
    subjectId: string;
    receipt: SealedHelpExplanationReceipt;
  },
): Promise<void> {
  await writeEvent(db, {
    id: `help_explanation_${newId()}`,
    session_id: input.sessionId ?? null,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'experimental:help_explanation_receipt',
    subject_kind: input.subjectKind,
    subject_id: input.subjectId,
    outcome: 'success',
    payload: { reply_grounding: input.receipt },
    task_run_id: input.receipt.task_run_id,
  });
}
