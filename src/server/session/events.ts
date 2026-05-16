// Phase 1c.1 Step 5 — single-point session → event mapper.
//
// `writeSessionEvent` is the only place inside src/server/session/* that writes
// domain `event` rows for state transitions. Delegates to Step 4's `writeEvent`
// (the single-owner INSERT path per ADR-0005). Constrained to action='extract'
// for Phase 1c.1 — review/conversation domain events are written by route
// handlers (Step 6+), not by session transitions.
//
// Why constrain to extract here? Other state transitions (initiateUpload /
// enqueueExtraction / markExtractionStarted / markReviewed / commitImport) are
// state-only — job_events (Sub 0c pg-boss SSE plumbing) covers async
// observability. Domain event log is for user-/agent-facing actions. Per spec
// §"Locked contract": reconsider in Phase 1d when user-facing event timeline
// surfaces a need.

import { createId } from '@paralleldrive/cuid2';

import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';

export type WriteSessionEventInput = {
  /** Required: chains the event to a learning_session row via event.session_id. */
  session_id: string;
  /** Currently locked to 'extract' for Phase 1c.1. Expand in Phase 1d. */
  action: 'extract';
  /** Locked to 'source_document' for action='extract'. */
  subject_kind: 'source_document';
  subject_id: string;
  /** Locked to 'agent' for action='extract'. */
  actor_kind: 'agent';
  /** e.g. 'tencent_ocr' | 'vision_rescue' — free-form per agent identity. */
  actor_ref: string;
  outcome: 'success' | 'partial' | 'failure';
  /** Shape must satisfy ExtractSourceDocument from src/core/schema/event/known.ts. */
  payload: {
    structured_block_ids: string[];
    layout_quality: 'structured' | 'partial' | 'text_only';
    warnings: string[];
  };
  caused_by_event_id?: string | null;
  task_run_id?: string | null;
  cost_micro_usd?: number | null;
  /** Optional explicit timestamp; default = now (matches writeEvent default). */
  created_at?: Date;
};

/**
 * Write a session-scoped domain event. Constructs a row matching the
 * `ExtractSourceDocument` shape in Lane B and delegates to `writeEvent` for
 * the actual INSERT + Zod validation.
 *
 * MUST be called within the same transaction as the corresponding
 * `learning_session` status UPDATE — otherwise a partial commit can leave the
 * session transitioned but no event recorded (or vice versa). Callers pass `tx`
 * (the transaction handle from `db.transaction(...)`).
 *
 * @returns the assigned event id (deterministic — generated here so the caller
 *   can capture it for caused_by chains).
 */
export async function writeSessionEvent(
  tx: Db | Tx,
  input: WriteSessionEventInput,
): Promise<string> {
  const id = createId();
  await writeEvent(tx, {
    id,
    session_id: input.session_id,
    actor_kind: input.actor_kind,
    actor_ref: input.actor_ref,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    outcome: input.outcome,
    payload: input.payload,
    caused_by_event_id: input.caused_by_event_id ?? null,
    task_run_id: input.task_run_id ?? null,
    cost_micro_usd: input.cost_micro_usd ?? null,
    created_at: input.created_at,
  });
  return id;
}
