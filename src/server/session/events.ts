// Session-scoped domain-event writer.
//
// `writeSessionEvent` is the only place in this directory that writes domain
// `event` rows; it delegates to `writeEvent` (ADR-0005 single owner). Action is
// locked to 'extract' because the other transitions are state-only: their async
// observability already rides on job_events. Review/conversation domain events
// belong to their route handlers, not to session transitions.

import { createId } from '@paralleldrive/cuid2';

import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';

export type WriteSessionEventInput = {
  /** Required: chains the event to a learning_session row via event.session_id. */
  session_id: string;
  /** Locked to 'extract'. */
  action: 'extract';
  /** Locked to 'source_document'. */
  subject_kind: 'source_document';
  subject_id: string;
  /** Locked to 'agent'. */
  actor_kind: 'agent';
  /** e.g. 'tencent_ocr' | 'vision_rescue' — free-form per agent identity. */
  actor_ref: string;
  outcome: 'success' | 'partial' | 'failure';
  /** Shape must satisfy ExtractSourceDocument from src/core/schema/event/known.ts. */
  payload: {
    structured_block_ids: string[];
    layout_quality: 'structured' | 'partial' | 'text_only';
    warnings: string[];
    /**
     * YUK-1408 — resolved from the session's usage policy automatically; pass
     * explicitly only when the caller already holds it (avoids lookup in loops).
     */
    derivation_policy?: 'allow' | 'answer_only';
  };
  caused_by_event_id?: string | null;
  task_run_id?: string | null;
  cost_micro_usd?: number | null;
  /** Optional explicit timestamp; default = now (matches writeEvent default). */
  created_at?: Date;
};

/**
 * Write a session-scoped ExtractSourceDocument event through `writeEvent`
 * (INSERT + Zod validation).
 *
 * Must run in the same transaction as the session status UPDATE; a partial commit
 * could otherwise leave the status and the event out of sync.
 *
 * @returns the generated event id, so callers can chain caused_by.
 */
export async function writeSessionEvent(
  tx: Db | Tx,
  input: WriteSessionEventInput,
): Promise<string> {
  const id = createId();
  // YUK-1408 — ingestion-derived events inherit the document's consented usage;
  // answer_only keeps the event out of memory/brief channels. Explicit payload
  // wins; an absent policy resolves to the legacy 'allow' default.
  const derivationPolicy =
    input.payload.derivation_policy ?? (await resolveSessionDerivationPolicy(tx, input.session_id));
  const payload =
    derivationPolicy === 'allow'
      ? input.payload
      : { ...input.payload, derivation_policy: derivationPolicy };
  await writeEvent(tx, {
    id,
    session_id: input.session_id,
    actor_kind: input.actor_kind,
    actor_ref: input.actor_ref,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    outcome: input.outcome,
    payload,
    caused_by_event_id: input.caused_by_event_id ?? null,
    task_run_id: input.task_run_id ?? null,
    cost_micro_usd: input.cost_micro_usd ?? null,
    created_at: input.created_at,
  });
  return id;
}
