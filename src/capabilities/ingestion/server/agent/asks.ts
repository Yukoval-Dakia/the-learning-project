import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  writeAgentAskEvent,
  writeAgentAskResolvedEvent,
  writeAgentRunSegment,
  writeAskAnswerClaimed,
  writeAskCreated,
  writeAskResolved,
} from '../events/agent-progress';
import {
  ASK_ANSWER_CLAIMED,
  ASK_CREATED,
  ASK_RESOLVED,
  AskCreatedPayload,
  type AskCreatedPayloadT,
  AskResolvedPayload,
  type AskResolvedPayloadT,
  INGESTION_AGENT_RUN_TABLE,
  INGESTION_ASK_ANSWER_TEXT_MAX,
  INGESTION_ASK_TABLE,
  IngestionAgentAskPayload,
  type IngestionAskAnswerPostT,
  type IngestionAskAnswerT,
} from './contract';
import { enqueueAgentResume } from './dispatch';

// YUK-1522 (R8) — durable ask lifecycle for the ingestion agent.
//
// Asks are projected from job_events rows on the per-ask stream
// (business_table='ingestion_ask', business_id=ask_id):
//   ask.created         — the durable prompt (options/kind/expiry/context)
//   ask.answer_claimed  — idempotency receipt for an accepted answer POST
//   ask.resolved        — terminal truth ({answer, via}) written in the SAME tx
//                         as the session-stream `ingestion_agent.ask_resolved`
//
// A resolved ask additionally records an internal `resume_requested` segment
// marker on the run stream; the enqueue is best-effort and the ask sweeper
// re-dispatches any resume_requested marker that no `running` segment followed.
// No worker thread ever blocks waiting for an answer.

// ---------- read ----------

type AskEventRow = {
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
};

export interface AskState {
  readonly created: AskCreatedPayloadT;
  readonly claimed: { idempotency_key: string; fingerprint: string } | null;
  readonly resolved: AskResolvedPayloadT | null;
}

async function readAskRows(db: Db | Tx, askId: string): Promise<AskEventRow[]> {
  const rows = await db.execute<AskEventRow>(sql`
    SELECT event_type, payload
    FROM job_events
    WHERE business_table = ${INGESTION_ASK_TABLE}
      AND business_id = ${askId}
    ORDER BY id ASC
  `);
  return rows;
}

export async function readAskState(db: Db | Tx, askId: string): Promise<AskState | null> {
  const rows = await readAskRows(db, askId);
  const createdRow = rows.find((row) => row.event_type === ASK_CREATED);
  if (!createdRow) return null;
  const claimedRow = rows.find((row) => row.event_type === ASK_ANSWER_CLAIMED);
  const resolvedRow = rows.find((row) => row.event_type === ASK_RESOLVED);
  return {
    created: AskCreatedPayload.parse(createdRow.payload),
    claimed:
      claimedRow != null
        ? {
            idempotency_key: String(claimedRow.payload.idempotency_key),
            fingerprint: String(claimedRow.payload.fingerprint),
          }
        : null,
    resolved: resolvedRow != null ? AskResolvedPayload.parse(resolvedRow.payload) : null,
  };
}

/** All asks created under a session (resolved or not), for the resume ledger. */
export interface SessionAskRow {
  readonly ask_id: string;
  readonly created: AskCreatedPayloadT;
  readonly resolved: AskResolvedPayloadT | null;
}

export async function readSessionAsks(db: Db | Tx, sessionId: string): Promise<SessionAskRow[]> {
  const createdRows = await db.execute<{ business_id: string; payload: unknown }>(sql`
    SELECT business_id, payload
    FROM job_events
    WHERE business_table = ${INGESTION_ASK_TABLE}
      AND event_type = ${ASK_CREATED}
      AND payload ->> 'session_id' = ${sessionId}
    ORDER BY id ASC
  `);
  const out: SessionAskRow[] = [];
  for (const row of createdRows) {
    const state = await readAskState(db, row.business_id);
    if (state == null) continue;
    out.push({ ask_id: row.business_id, created: state.created, resolved: state.resolved });
  }
  return out;
}

// ---------- create ----------

export interface CreateAskInput {
  readonly sessionId: string;
  readonly item_id: string;
  readonly question_no: string;
  readonly prompt_md: string;
  readonly answer_kind: 'choice' | 'short';
  readonly options?: { id: string; label_md: string }[];
  /** Contract-required; the caller (tool boundary) fills the default. */
  readonly placeholder: string;
  /** Seconds until the system resolves the ask as skipped-by-timeout. */
  readonly expires_in_seconds?: number | null;
  readonly context_md?: string;
}

/** Open ask for a session item — idempotent-create guard against re-segment duplication. */
export async function findOpenAskForItem(
  db: Db | Tx,
  sessionId: string,
  itemId: string,
): Promise<{ ask_id: string; expires_at: string | null } | null> {
  const rows = await db.execute<{ business_id: string }>(sql`
    SELECT business_id
    FROM job_events
    WHERE business_table = ${INGESTION_ASK_TABLE}
      AND event_type = ${ASK_CREATED}
      AND payload ->> 'session_id' = ${sessionId}
      AND payload ->> 'item_id' = ${itemId}
      AND NOT EXISTS (
        SELECT 1 FROM job_events r
        WHERE r.business_table = ${INGESTION_ASK_TABLE}
          AND r.business_id = job_events.business_id
          AND r.event_type = ${ASK_RESOLVED}
      )
    ORDER BY id DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (row == null) return null;
  const state = await readAskState(db, row.business_id);
  if (state == null || state.resolved != null) return null;
  return { ask_id: row.business_id, expires_at: state.created.expires_at };
}

export interface CreateAskResult {
  readonly ask_id: string;
  readonly expires_at: string | null;
  /** false = an open ask for this item already existed (its id is returned). */
  readonly created: boolean;
}

/**
 * Atomic create-or-adopt: the uniqueness check and the create write run inside
 * one transaction under a per-(session,item) advisory lock, so two parallel
 * callers (replayed segment, double tool call) can never mint two open asks
 * for the same item. `placeholder` is already defaulted by the caller.
 */
export async function createAsk(
  db: Db,
  input: CreateAskInput,
  now: Date = new Date(),
): Promise<CreateAskResult> {
  const expiresAt =
    input.expires_in_seconds == null
      ? null
      : new Date(now.getTime() + input.expires_in_seconds * 1000).toISOString();
  const askId = `ask_${newId()}`;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`ingestion-ask:${input.sessionId}:${input.item_id}`}))`,
    );
    const existing = await findOpenAskForItem(tx, input.sessionId, input.item_id);
    if (existing != null) {
      return { ask_id: existing.ask_id, expires_at: existing.expires_at, created: false };
    }
    await writeAskCreated(tx, askId, {
      session_id: input.sessionId,
      item_id: input.item_id,
      question_no: input.question_no,
      prompt_md: input.prompt_md,
      answer_kind: input.answer_kind,
      ...(input.options != null ? { options: input.options } : {}),
      placeholder: input.placeholder,
      expires_at: expiresAt,
      ...(input.context_md != null ? { context_md: input.context_md } : {}),
    });
    await writeAgentAskEvent(
      tx,
      input.sessionId,
      IngestionAgentAskPayload.parse({
        kind: 'ingestion_agent.ask',
        ask_id: askId,
        item_id: input.item_id,
        question_no: input.question_no,
        prompt_md: input.prompt_md,
        answer_kind: input.answer_kind,
        ...(input.options != null ? { options: input.options } : {}),
        placeholder: input.placeholder,
        expires_at: expiresAt,
      }),
    );
    return { ask_id: askId, expires_at: expiresAt, created: true };
  });
}

// ---------- answer validation ----------

/**
 * Contract 422 validation. Returns the normalized durable answer (with
 * `via_option` kept only where meaningful) or throws ApiError with one of the
 * four contract codes.
 */
export function validateAskAnswer(
  created: AskCreatedPayloadT,
  answer: IngestionAskAnswerPostT,
): IngestionAskAnswerT {
  if (answer.kind === 'skipped') {
    return { kind: 'skipped', by: 'learner' };
  }
  if (answer.kind === 'choice') {
    if (created.answer_kind !== 'choice') {
      throw new ApiError(
        'answer_kind_mismatch',
        `ask expects a '${created.answer_kind}' answer, got 'choice'`,
        422,
      );
    }
    const found = (created.options ?? []).some((option) => option.id === answer.option_id);
    if (!found) {
      throw new ApiError('option_not_found', `option '${answer.option_id}' is not on the ask`, 422);
    }
    return { kind: 'choice', option_id: answer.option_id };
  }
  // answer.kind === 'text'
  const trimmed = answer.text.trim();
  if (trimmed.length === 0) {
    throw new ApiError('answer_empty', 'answer text must not be empty', 422);
  }
  if (trimmed.length > INGESTION_ASK_ANSWER_TEXT_MAX) {
    throw new ApiError(
      'answer_too_long',
      `answer text exceeds ${INGESTION_ASK_ANSWER_TEXT_MAX} characters`,
      422,
    );
  }
  if (answer.via_option === 'none_of_these') {
    if (created.answer_kind !== 'choice') {
      throw new ApiError(
        'answer_kind_mismatch',
        `ask expects a '${created.answer_kind}' answer; via_option applies only to choice asks`,
        422,
      );
    }
    return { kind: 'text', text: trimmed, via_option: 'none_of_these' };
  }
  if (created.answer_kind !== 'short') {
    throw new ApiError(
      'answer_kind_mismatch',
      `ask expects a '${created.answer_kind}' answer, got 'text'`,
      422,
    );
  }
  return { kind: 'text', text: trimmed };
}

// ---------- resolve ----------

function answerFingerprint(answer: IngestionAskAnswerPostT): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(answer)).digest('hex')}`;
}

async function lockAsk(tx: Tx, askId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ingestion-ask:${askId}`}))`);
}

/** Returns the durable resume marker's row id — the intent's identity. */
async function writeResolution(
  tx: Tx,
  input: { askId: string; state: AskState; answer: IngestionAskAnswerT; via: 'answer' | 'timeout' },
): Promise<number> {
  await writeAskResolved(tx, input.askId, { answer: input.answer, via: input.via });
  await writeAgentAskResolvedEvent(tx, input.state.created.session_id, {
    kind: 'ingestion_agent.ask_resolved',
    ask_id: input.askId,
    answer: input.answer,
  });
  return writeAgentRunSegment(tx, input.state.created.session_id, {
    segment: 0,
    trigger: 'resume',
    outcome: 'resume_requested',
  });
}

export interface AnswerAskResult {
  readonly accepted: true;
  readonly replayed: boolean;
}

/**
 * POST /asks/:ask_id/answers — idempotent acceptance. One tx: advisory lock →
 * idempotency replay → already-resolved 409 → 422 validation → claim +
 * resolved + session ask_resolved + resume_requested marker. The resume
 * enqueue is post-commit best-effort (the sweeper re-dispatches the marker).
 */
export async function acceptAskAnswer(
  db: Db,
  input: {
    sessionId: string;
    askId: string;
    idempotencyKey: string;
    answer: IngestionAskAnswerPostT;
  },
): Promise<AnswerAskResult> {
  const { sessionId, askId, idempotencyKey, answer } = input;
  const fingerprint = answerFingerprint(answer);
  const outcome = await db.transaction(
    async (tx): Promise<{ result: AnswerAskResult; markerId: number | null }> => {
      await lockAsk(tx, askId);
      const state = await readAskState(tx, askId);
      if (state == null || state.created.session_id !== sessionId) {
        throw new ApiError('not_found', `ask '${askId}' not found`, 404);
      }
      if (state.claimed != null) {
        if (state.claimed.idempotency_key === idempotencyKey) {
          if (state.claimed.fingerprint === fingerprint) {
            return { result: { accepted: true, replayed: true }, markerId: null };
          }
          throw new ApiError(
            'idempotency_conflict',
            `Idempotency-Key '${idempotencyKey}' was used with a different answer`,
            409,
          );
        }
      }
      if (state.resolved != null) {
        throw new ApiError('ask_already_resolved', `ask '${askId}' is already resolved`, 409);
      }
      const normalized = validateAskAnswer(state.created, answer);
      await writeAskAnswerClaimed(tx, askId, {
        idempotency_key: idempotencyKey,
        fingerprint,
      });
      const markerId = await writeResolution(tx, {
        askId,
        state,
        answer: normalized,
        via: 'answer',
      });
      return { result: { accepted: true, replayed: false }, markerId };
    },
  );
  if (!outcome.result.replayed) {
    // Per-intent job id (R3-4): a duplicate send of THIS resume marker no-ops;
    // a later marker gets a fresh id.
    await enqueueAgentResume(sessionId, outcome.markerId ?? undefined).catch((err) =>
      console.error('[ingestion-agent] resume enqueue after answer failed', {
        session_id: sessionId,
        error: err,
      }),
    );
  }
  return outcome.result;
}

/**
 * Timeout resolution — same lock + terminal write as an answer. Returns false
 * when the ask was already resolved (first-writer-wins with a racing answer).
 */
export async function resolveAskByTimeout(db: Db, askId: string): Promise<boolean> {
  const resolved = await db.transaction(
    async (tx): Promise<{ sessionId: string; markerId: number } | null> => {
      await lockAsk(tx, askId);
      const state = await readAskState(tx, askId);
      if (state == null || state.resolved != null) return null;
      const markerId = await writeResolution(tx, {
        askId,
        state,
        answer: { kind: 'skipped', by: 'timeout' },
        via: 'timeout',
      });
      return { sessionId: state.created.session_id, markerId };
    },
  );
  if (resolved == null) return false;
  await enqueueAgentResume(resolved.sessionId, resolved.markerId).catch((err) =>
    console.error('[ingestion-agent] resume enqueue after timeout failed', {
      session_id: resolved.sessionId,
      error: err,
    }),
  );
  return true;
}

// ---------- sweep queries ----------

/** Open asks whose expires_at has passed (and never resolved). */
export async function listExpiredOpenAsks(db: Db, limit = 50): Promise<string[]> {
  const rows = await db.execute<{ business_id: string }>(sql`
    SELECT business_id
    FROM job_events
    WHERE business_table = ${INGESTION_ASK_TABLE}
      AND event_type = ${ASK_CREATED}
      AND payload ->> 'expires_at' IS NOT NULL
      AND (payload ->> 'expires_at')::timestamptz < clock_timestamp()
      AND occurred_at > clock_timestamp() - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM job_events r
        WHERE r.business_table = ${INGESTION_ASK_TABLE}
          AND r.business_id = job_events.business_id
          AND r.event_type = ${ASK_RESOLVED}
      )
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => row.business_id);
}

/**
 * Sessions with a `resume_requested` marker that no later `running` segment
 * followed — the durable backstop for post-commit enqueue failures and the
 * active-run dedup window. Caller still enqueues via a session singleton.
 */
export async function listPendingResumeSessions(
  db: Db,
  limit = 25,
): Promise<{ session_id: string; marker_id: number }[]> {
  const rows = await db.execute<{ business_id: string; marker_id: number }>(sql`
    SELECT business_id, id AS marker_id
    FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND event_type = ${'agent.run_segment'}
      AND payload ->> 'outcome' = 'resume_requested'
      AND occurred_at > clock_timestamp() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM job_events s
        WHERE s.business_table = ${INGESTION_AGENT_RUN_TABLE}
          AND s.business_id = job_events.business_id
          AND s.event_type = ${'agent.run_segment'}
          AND s.payload ->> 'outcome' = 'running'
          AND s.id > job_events.id
      )
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ session_id: row.business_id, marker_id: row.marker_id }));
}

/**
 * Sessions with a `continue_requested` marker (written in the same tx as the
 * early_exit close) that no later `running` segment followed — durable
 * backstop when the continuation enqueue failed (R2-4).
 */
export async function listPendingContinuationSessions(
  db: Db,
  limit = 25,
): Promise<{ session_id: string; marker_id: number }[]> {
  const rows = await db.execute<{ business_id: string; marker_id: number }>(sql`
    SELECT business_id, id AS marker_id
    FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND event_type = ${'agent.run_segment'}
      AND payload ->> 'outcome' = 'continue_requested'
      AND occurred_at > clock_timestamp() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM job_events s
        WHERE s.business_table = ${INGESTION_AGENT_RUN_TABLE}
          AND s.business_id = job_events.business_id
          AND s.event_type = ${'agent.run_segment'}
          AND s.payload ->> 'outcome' = 'running'
          AND s.id > job_events.id
      )
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ session_id: row.business_id, marker_id: row.marker_id }));
}

/**
 * Sessions whose latest numbered 'running' segment has no same-segment closer
 * and is older than `staleBeforeMs` — a segment whose worker died mid-model or
 * whose post-model bookkeeping crashed (deliberately never retried as a paid
 * re-run). `paid_attempt_sent` tells the sweeper whether a paid model call was
 * already dispatched for the segment: if so its provider outcome is unknown
 * and the session fails (worker_lost, explicitly retryable) instead of
 * silently re-paying (R2-5).
 */
export async function listStaleRunningSessions(
  db: Db,
  staleBeforeMs: number,
  limit = 25,
): Promise<{ session_id: string; segment: number; paid_attempt_sent: boolean }[]> {
  const rows = await db.execute<{
    business_id: string;
    segment: number;
    paid_attempt_sent: boolean;
  }>(sql`
    SELECT business_id, (payload ->> 'segment')::int AS segment,
      EXISTS (
        SELECT 1 FROM job_events p
        WHERE p.business_table = ${INGESTION_AGENT_RUN_TABLE}
          AND p.business_id = job_events.business_id
          AND p.event_type = ${'agent.paid_attempt'}
          AND p.payload ->> 'phase' = 'sent'
          AND (p.payload ->> 'segment')::int = (job_events.payload ->> 'segment')::int
      ) AS paid_attempt_sent
    FROM job_events
    WHERE business_table = ${INGESTION_AGENT_RUN_TABLE}
      AND event_type = ${'agent.run_segment'}
      AND payload ->> 'outcome' = 'running'
      AND (payload ->> 'segment')::int >= 1
      AND occurred_at < clock_timestamp() - (make_interval(secs => ${staleBeforeMs / 1000}))
      AND NOT EXISTS (
        SELECT 1 FROM job_events s
        WHERE s.business_table = ${INGESTION_AGENT_RUN_TABLE}
          AND s.business_id = job_events.business_id
          AND s.event_type = ${'agent.run_segment'}
          AND s.payload ->> 'segment' = job_events.payload ->> 'segment'
          AND s.id > job_events.id
      )
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    session_id: row.business_id,
    segment: row.segment,
    paid_attempt_sent: row.paid_attempt_sent,
  }));
}
