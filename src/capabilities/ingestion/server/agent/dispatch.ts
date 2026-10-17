import { getStartedBoss } from '@/server/boss/client';

// YUK-1522 (R8) — pg-boss dispatch seam for the ingestion agent lane. All
// sends funnel here so the capability keeps exactly one boss edge: initial
// dispatch goes through Ingestion.enqueueAgentRun (session guard); resume and
// self-continuation go through the functions below with a per-session
// singleton so a burst of answers/timeouts cannot stack duplicate runs.

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
}

export async function sendAgentRun(payload: AgentRunJobPayload): Promise<string | null> {
  const boss = await getStartedBoss();
  return boss.send(INGESTION_AGENT_RUN_QUEUE, payload, {
    singletonKey: `ingestion_agent_run:${payload.sessionId}`,
    singletonSeconds: RESUME_SINGLETON_SECONDS,
  });
}

/** Enqueue a resume segment for a session whose asks just resolved. */
export async function enqueueAgentResume(sessionId: string): Promise<string | null> {
  return sendAgentRun({ sessionId, trigger: 'resume' });
}

/** Enqueue the next segment when a run ended early without open asks. */
export async function enqueueAgentContinuation(sessionId: string): Promise<string | null> {
  return sendAgentRun({ sessionId, trigger: 'continue' });
}
