import { createContext, useContext } from 'react';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import { type ApiOperationJsonResponse, apiFetch, apiJson } from '@/ui/lib/api';
import type { ReplayTurn } from './replay';

// Copilot transport (YUK-1473). The protocol stays with the consumers: the companion (and the new
// practice companion) parse the 202 acceptance, fold run frames with consumeDurableCopilotRun and
// reconcile replays. This seam only moves bytes, so the Start shell can provide its own transport
// without copying the protocol. The HTTP default is what the Dock always called.

export type CopilotSessionsResponse = ApiOperationJsonResponse<'listCopilotSessions'>;
export type CopilotCreateSessionResponse = ApiOperationJsonResponse<'createCopilotSession'>;

/** GET /api/copilot/turns — see src/capabilities/copilot/server/turns.ts. */
export interface CopilotTurnsResponse {
  session_id: string | null;
  turns: ReplayTurn[];
  active_runs: Array<{
    run_id: string;
    session_id: string;
    status: 'queued' | 'started' | 'running' | 'cancel_requested';
    events_url: string;
    derivation_policy?: DerivationPolicyT;
  }>;
}

export interface CopilotCancelResult {
  ok: true;
  run_id: string;
  status: 'cancel_requested' | 'cancelled' | 'already_requested' | 'already_settled';
}

export type CopilotClient = {
  getSummary: () => Promise<ApiOperationJsonResponse<'getTodayCopilotSummary'>>;
  /** Fresh server capabilities, including before restricted sends; never a cached snapshot. */
  listSessions: (signal?: AbortSignal) => Promise<CopilotSessionsResponse>;
  createSession: () => Promise<CopilotCreateSessionResponse>;
  listTurns: (sessionId: string, limit: number) => Promise<CopilotTurnsResponse>;
  /** POST /api/copilot/chat; resolves with the raw response (202 + Location) for the caller. */
  sendChat: (body: unknown, idempotencyKey: string) => Promise<Response>;
  /** Fetch used to read a run's event stream (`fetchResponse` of consumeDurableCopilotRun). */
  fetchRunEvents: (input: string, init?: RequestInit) => Promise<Response>;
  cancelRun: (runId: string) => Promise<CopilotCancelResult>;
  revertCheckpoint: (checkpointEventId: string) => Promise<unknown>;
};

export const httpCopilotClient: CopilotClient = {
  getSummary: () =>
    apiJson<ApiOperationJsonResponse<'getTodayCopilotSummary'>>('/api/today/copilot-summary'),
  listSessions: (signal) =>
    apiJson<CopilotSessionsResponse>('/api/copilot/sessions', { signal, cache: 'no-store' }),
  createSession: () =>
    apiJson<CopilotCreateSessionResponse>('/api/copilot/sessions', { method: 'POST' }),
  listTurns: (sessionId, limit) =>
    apiJson<CopilotTurnsResponse>(
      `/api/copilot/turns?limit=${limit}&session_id=${encodeURIComponent(sessionId)}`,
    ),
  sendChat: (body, idempotencyKey) =>
    apiFetch('/api/copilot/chat', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
  fetchRunEvents: (input, init) => apiFetch(input, init),
  cancelRun: (runId) =>
    apiJson<CopilotCancelResult>(`/api/copilot/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
  revertCheckpoint: (checkpointEventId) =>
    apiJson(`/api/copilot/checkpoints/${encodeURIComponent(checkpointEventId)}/revert`, {
      method: 'POST',
    }),
};

const CopilotClientContext = createContext<CopilotClient | undefined>(undefined);
export const CopilotClientProvider = CopilotClientContext.Provider;
export function useCopilotClient(): CopilotClient {
  return useContext(CopilotClientContext) ?? httpCopilotClient;
}
