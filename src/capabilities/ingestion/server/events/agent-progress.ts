import type { Db, Tx } from '@/db/client';
import { writeJobEvent } from '@/server/events/writer';
import {
  AGENT_ITEM_STATE,
  AGENT_PAID_ATTEMPT,
  AGENT_RUN_SEGMENT,
  AGENT_TERMINAL_REQUEST,
  ASK_ANSWER_CLAIMED,
  ASK_CREATED,
  ASK_RESOLVED,
  AgentItemStatePayload,
  type AgentItemStatePayloadT,
  AgentPaidAttemptPayload,
  type AgentPaidAttemptPayloadT,
  AgentRunSegmentPayload,
  type AgentRunSegmentPayloadT,
  AgentTerminalRequestPayload,
  type AgentTerminalRequestPayloadT,
  AskCreatedPayload,
  type AskCreatedPayloadT,
  AskResolvedPayload,
  type AskResolvedPayloadT,
  INGESTION_AGENT_RUN_TABLE,
  INGESTION_ASK_TABLE,
  IngestionAgentAskPayload,
  type IngestionAgentAskPayloadT,
  IngestionAgentAskResolvedPayload,
  type IngestionAgentAskResolvedPayloadT,
  IngestionAgentErrorPayload,
  type IngestionAgentErrorPayloadT,
  IngestionAgentItemPayload,
  type IngestionAgentItemPayloadT,
  IngestionAgentStagePayload,
  type IngestionAgentStagePayloadT,
} from '../agent/contract';

// YUK-1522 (R8) — durable emitters for the ingestion-agent contract events.
// Every call lands a job_events row; the existing
// GET /api/ingestion/[id]/events SSE route replays + live-subscribes them with
// Last-Event-ID semantics. Payloads are validated here so a malformed event
// can never reach the stream.

const SESSION_TABLE = 'ingestion_session' as const;

async function writeAgentEvent(
  tx: Db | Tx,
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: eventType,
    payload,
  });
}

export async function writeAgentStageEvent(
  tx: Db | Tx,
  sessionId: string,
  payload: IngestionAgentStagePayloadT,
): Promise<number> {
  const parsed = IngestionAgentStagePayload.parse(payload);
  return writeAgentEvent(tx, sessionId, parsed.kind, parsed);
}

export async function writeAgentItemEvent(
  tx: Db | Tx,
  sessionId: string,
  payload: IngestionAgentItemPayloadT,
): Promise<number> {
  const parsed = IngestionAgentItemPayload.parse(payload);
  return writeAgentEvent(tx, sessionId, parsed.kind, parsed);
}

export async function writeAgentErrorEvent(
  tx: Db | Tx,
  sessionId: string,
  payload: IngestionAgentErrorPayloadT,
): Promise<number> {
  const parsed = IngestionAgentErrorPayload.parse(payload);
  return writeAgentEvent(tx, sessionId, parsed.kind, parsed);
}

export async function writeAgentAskEvent(
  tx: Db | Tx,
  sessionId: string,
  payload: IngestionAgentAskPayloadT,
): Promise<number> {
  const parsed = IngestionAgentAskPayload.parse(payload);
  return writeAgentEvent(tx, sessionId, parsed.kind, parsed);
}

export async function writeAgentAskResolvedEvent(
  tx: Db | Tx,
  sessionId: string,
  payload: IngestionAgentAskResolvedPayloadT,
): Promise<number> {
  const parsed = IngestionAgentAskResolvedPayload.parse(payload);
  return writeAgentEvent(tx, sessionId, parsed.kind, parsed);
}

// ---------- durable ask rows (per-ask stream) ----------

async function writeAskEvent(
  tx: Db | Tx,
  askId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return writeJobEvent(tx, {
    business_table: INGESTION_ASK_TABLE,
    business_id: askId,
    event_type: eventType,
    payload,
  });
}

export async function writeAskCreated(
  tx: Db | Tx,
  askId: string,
  payload: AskCreatedPayloadT,
): Promise<number> {
  const parsed = AskCreatedPayload.parse(payload);
  return writeAskEvent(tx, askId, ASK_CREATED, parsed);
}

export async function writeAskAnswerClaimed(
  tx: Db | Tx,
  askId: string,
  payload: { idempotency_key: string; fingerprint: string },
): Promise<number> {
  return writeAskEvent(tx, askId, ASK_ANSWER_CLAIMED, payload);
}

export async function writeAskResolved(
  tx: Db | Tx,
  askId: string,
  payload: AskResolvedPayloadT,
): Promise<number> {
  const parsed = AskResolvedPayload.parse(payload);
  return writeAskEvent(tx, askId, ASK_RESOLVED, parsed);
}

// ---------- internal run bookkeeping (not a UI contract) ----------

async function writeRunEvent(
  tx: Db | Tx,
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return writeJobEvent(tx, {
    business_table: INGESTION_AGENT_RUN_TABLE,
    business_id: sessionId,
    event_type: eventType,
    payload,
  });
}

export async function writeAgentItemState(
  tx: Db | Tx,
  sessionId: string,
  payload: AgentItemStatePayloadT,
): Promise<number> {
  const parsed = AgentItemStatePayload.parse(payload);
  return writeRunEvent(tx, sessionId, AGENT_ITEM_STATE, parsed);
}

export async function writeAgentRunSegment(
  tx: Db | Tx,
  sessionId: string,
  payload: AgentRunSegmentPayloadT,
): Promise<number> {
  const parsed = AgentRunSegmentPayload.parse(payload);
  return writeRunEvent(tx, sessionId, AGENT_RUN_SEGMENT, parsed);
}

/** R2-6: model-declared run-stop marker — the orchestrator owns the session error. */
export async function writeAgentTerminalRequest(
  tx: Db | Tx,
  sessionId: string,
  payload: AgentTerminalRequestPayloadT,
): Promise<number> {
  const parsed = AgentTerminalRequestPayload.parse(payload);
  return writeRunEvent(tx, sessionId, AGENT_TERMINAL_REQUEST, parsed);
}

/** R2-5: paid-attempt identity — 'sent' before the call, 'settled' after. */
export async function writeAgentPaidAttempt(
  tx: Db | Tx,
  sessionId: string,
  payload: AgentPaidAttemptPayloadT,
): Promise<number> {
  const parsed = AgentPaidAttemptPayload.parse(payload);
  return writeRunEvent(tx, sessionId, AGENT_PAID_ATTEMPT, parsed);
}
