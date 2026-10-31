import { eq } from 'drizzle-orm';
import { helpCost } from '@/ai/help-latency';
import { type HelpExplanationEvidence, replayHelpExplanation } from '@/ai/help-reply-grounding';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';

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

export async function groundHintExplanation(
  db: Db,
  prompt: string,
  explanation: string,
  hintIndex: number,
  ran: {
    task_run_id?: string;
    cost_basis?: 'reported' | 'estimated' | 'unknown';
    cost_usd?: number;
  },
) {
  return replayHelpExplanation({
    prompt,
    explanation,
    hintIndex,
    evidence: await loadHelpExplanationEvidence(db, ran),
  });
}
