import { createHash } from 'node:crypto';

import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { agentIntentPayload } from './ownership';

// Single pg-boss dispatch seam for the agent lane. Initial dispatch goes through
// Ingestion.enqueueAgentRun; resumes and self-continuation use a per-session
// singleton so bursts of answers or timeouts cannot stack duplicate runs.

export const INGESTION_AGENT_RUN_QUEUE = 'ingestion_agent_run' as const;
export const INGESTION_ASK_SWEEP_QUEUE = 'ingestion_ask_sweep' as const;

/**
 * Two-minute resume dedup window: collapses multiple ask resolutions inside
 * one resume send, and swallows the race where an in-flight segment ends
 * suspended right as the resolution lands (the segment-start sweep +
 * resume_requested marker cover that window).
 */
const RESUME_SINGLETON_SECONDS = 120;

export interface AgentRunJobPayload {
  readonly sessionId: string;
  readonly trigger: 'start' | 'resume' | 'continue';
  readonly operationId?: string;
  readonly runRef?: string;
}

export async function sendAgentRun(payload: AgentRunJobPayload): Promise<string | null> {
  const boss = await getStartedBoss();
  return boss.send(INGESTION_AGENT_RUN_QUEUE, payload, {
    singletonKey: `ingestion_agent_run:${payload.sessionId}`,
    singletonSeconds: RESUME_SINGLETON_SECONDS,
  });
}

/** Deterministic uuid-shaped id — a duplicate send is a true no-op (R2-4/R3-4). */
function deterministicJobId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Enqueue a resume segment. `intentId` is the durable resume marker's row id
 * (R3-4): the job id is derived from it, so a duplicate send of the SAME
 * intent is a no-op while a NEW intent gets a fresh id — the previous
 * per-session id collided with its retained predecessor.
 */
export async function enqueueAgentResume(
  sessionId: string,
  intentId?: number,
): Promise<string | null> {
  const boss = await getStartedBoss();
  // No session-level singleton here: the per-intent id is the dedup, and a
  // shared singletonKey throttles/strands a DISTINCT pending intent. The
  // segment claim guards double delivery.
  return boss.send(
    INGESTION_AGENT_RUN_QUEUE,
    await agentIntentPayload(db, sessionId, 'resume', intentId),
    intentId != null
      ? { id: deterministicJobId(`ingestion-agent-resume:${sessionId}:${intentId}`) }
      : undefined,
  );
}

/** Enqueue the next segment; `intentId` is the continue_requested marker's row id. */
export async function enqueueAgentContinuation(
  sessionId: string,
  intentId: number,
): Promise<string | null> {
  const boss = await getStartedBoss();
  return boss.send(
    INGESTION_AGENT_RUN_QUEUE,
    await agentIntentPayload(db, sessionId, 'continue', intentId),
    {
      id: deterministicJobId(`ingestion-agent-continue:${sessionId}:${intentId}`),
    },
  );
}
