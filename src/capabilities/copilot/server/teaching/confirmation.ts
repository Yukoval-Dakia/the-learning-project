// Owns confirmation occurrences and explicit learner choices. Assessment facts
// remain in Practice; a recovery read never repeats an assessment operation.
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  issueConversationConfirmation,
  readConversationConfirmation,
  submitConversationConfirmation,
} from '@/capabilities/practice/public';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { event, job_events, learning_session } from '@/db/schema';
import { getCorrectionStatus, writeEvent } from '@/kernel/events';
import { lockEventCorrectionSource } from '@/kernel/events/correction-lock';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import { ApiError } from '@/kernel/http';
import {
  ConfirmationCommand,
  type ConfirmationCommandT,
  ConfirmationOccurrence,
  type ConfirmationOccurrenceT,
} from '../../confirmation-contract';
import { acquireCopilotExecutionSettlementLock } from '../copilot-run-coordination';
import { COPILOT_RUN_TABLE, hasCancelRequest } from '../copilot-run-status';

const AcceptedCommand = z
  .object({
    version: z.literal(1),
    command_digest: z.string(),
    command: ConfirmationCommand,
    source_ask_id: z.string(),
  })
  .strict();
const CommandResult = z.object({ version: z.literal(1), occurrence_id: z.string() }).strict();
const ACTION = 'experimental:conversation_confirmation';
const COMMAND = 'experimental:confirmation_command';
const occurrenceId = (sessionId: string, li: string, previous = 'default') =>
  `confirmation_${canonicalHash([sessionId, li, previous])}`;
const commandEventId = (session: string, command: string) =>
  `confirmation_command_${canonicalHash([session, command])}`;

async function lockSession(tx: Tx, sessionId: string) {
  const [session] = await tx
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .for('update');
  if (session?.type !== 'conversation' || !['active', 'idle'].includes(session.status))
    throw new ApiError('confirmation_revoked', 'conversation is no longer open', 409);
}

async function readOccurrence(db: Db | Tx, id: string): Promise<ConfirmationOccurrenceT | null> {
  const [row] = await db
    .select()
    .from(event)
    .where(and(eq(event.action, ACTION), eq(event.subject_id, id)))
    .orderBy(
      desc(
        sql`CASE WHEN ${event.payload}->>'sequence' ~ '^[0-9]+$' THEN (${event.payload}->>'sequence')::numeric ELSE 1e30 END`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = ConfirmationOccurrence.safeParse(row.payload);
  if (!parsed.success)
    throw new ApiError('confirmation_incompatible', 'unsupported confirmation state/version', 409);
  return parsed.data;
}

async function save(tx: Tx, state: ConfirmationOccurrenceT) {
  await writeEvent(tx, {
    id: `${state.occurrence_id}:${state.sequence}`,
    session_id: state.session_id,
    actor_kind: 'system',
    actor_ref: 'conversation-confirmation',
    action: ACTION,
    subject_kind: 'query',
    subject_id: state.occurrence_id,
    payload: state,
    caused_by_event_id: state.trigger_ask_id,
  });
}

/** Same lock order as Stop/retraction; called again immediately before activation. */
async function authorize(tx: Tx, sessionId: string, sources: string[], signal?: AbortSignal) {
  for (const id of [...new Set(sources)].sort()) {
    await acquireCopilotExecutionSettlementLock(tx, id);
    await lockEventCorrectionSource(tx, id);
    const [ask] = await tx.select().from(event).where(eq(event.id, id));
    if (
      !ask ||
      ask.session_id !== sessionId ||
      ask.action !== 'experimental:copilot_user_ask' ||
      ask.actor_kind !== 'user' ||
      ask.actor_ref !== 'user:self' ||
      (await readEventDerivationPolicy(tx, id)) !== 'allow' ||
      (await getCorrectionStatus(tx, id)).state !== 'active'
    )
      throw new ApiError(
        'confirmation_revoked',
        'confirmation source is no longer authorized',
        409,
      );
    const statuses = await tx
      .select()
      .from(job_events)
      .where(and(eq(job_events.business_table, COPILOT_RUN_TABLE), eq(job_events.business_id, id)));
    if (hasCancelRequest(statuses))
      throw new ApiError('confirmation_revoked', 'confirmation was stopped', 409);
  }
  await lockSession(tx, sessionId);
  signal?.throwIfAborted();
}

/** Runs in the original teaching reply transaction. */
export async function offerConversationConfirmation(
  tx: Tx,
  input: {
    sessionId: string;
    learningItemId: string;
    triggerAskId: string;
    replyId: string;
  },
) {
  await authorize(tx, input.sessionId, [input.triggerAskId]);
  const id = occurrenceId(input.sessionId, input.learningItemId);
  const prior = await readOccurrence(tx, id);
  if (prior) return prior;
  const state = ConfirmationOccurrence.parse({
    version: 1,
    sequence: 0,
    occurrence_id: id,
    session_id: input.sessionId,
    learning_item_id: input.learningItemId,
    trigger_ask_id: input.triggerAskId,
    offer_reply_id: input.replyId,
    state: 'offered',
    accept_ask_id: null,
    issuance_id: null,
    blocked_reason: null,
  });
  await save(tx, state);
  return state;
}

/** Validate at chat acceptance, before QUEUED/provider work, including cross-key conflicts. */
export async function acceptConfirmationCommand(
  tx: Tx,
  input: {
    sessionId: string;
    askId: string;
    command: ConfirmationCommandT;
  },
) {
  const command = ConfirmationCommand.parse(input.command);
  await lockSession(tx, input.sessionId);
  const state = await readOccurrence(tx, command.occurrence_id);
  if (!state || state.session_id !== input.sessionId)
    throw new ApiError('confirmation_unbound', 'confirmation belongs to another conversation', 409);
  const id = commandEventId(input.sessionId, command.command_id);
  const [prior] = await tx.select().from(event).where(eq(event.id, id));
  if (prior && !AcceptedCommand.safeParse(prior.payload).success)
    throw new ApiError('confirmation_incompatible', 'unsupported accepted command', 409);
  if (prior && prior.payload.command_digest !== canonicalHash(command))
    throw new ApiError('confirmation_conflict', 'command id has different bytes', 409);
  if (!prior)
    await writeEvent(tx, {
      id,
      session_id: input.sessionId,
      actor_kind: 'user',
      actor_ref: 'user:self',
      action: COMMAND,
      subject_kind: 'query',
      subject_id: command.occurrence_id,
      payload: {
        version: 1,
        command_digest: canonicalHash(command),
        command,
        source_ask_id: input.askId,
      },
    });
}

export async function runConversationConfirmation(
  db: Db | Tx,
  input: {
    sessionId: string;
    askId: string;
    command: ConfirmationCommandT;
    signal: AbortSignal;
  },
) {
  const command = ConfirmationCommand.parse(input.command);
  const selected = await db.transaction(async (tx) => {
    const [accepted] = await tx
      .select()
      .from(event)
      .where(eq(event.id, commandEventId(input.sessionId, command.command_id)));
    if (
      !accepted ||
      !AcceptedCommand.safeParse(accepted.payload).success ||
      accepted.payload.command_digest !== canonicalHash(command)
    )
      throw new ApiError('confirmation_unbound', 'command has no accepted original', 409);
    const state = await readOccurrence(tx, command.occurrence_id);
    if (!state || state.session_id !== input.sessionId)
      throw new ApiError(
        'confirmation_unbound',
        'confirmation belongs to another conversation',
        409,
      );
    await authorize(
      tx,
      input.sessionId,
      [state.trigger_ask_id, ...(state.accept_ask_id ? [state.accept_ask_id] : []), input.askId],
      input.signal,
    );
    const [source] = await tx.select().from(event).where(eq(event.id, input.askId));
    if (
      canonicalHash(source?.payload.confirmation) !== canonicalHash(command) ||
      (await getCorrectionStatus(tx, state.offer_reply_id)).state !== 'active'
    )
      throw new ApiError('confirmation_revoked', 'confirmation command or offer changed', 409);
    const resultId = `${commandEventId(input.sessionId, command.command_id)}:result`;
    const [prior] = await tx.select().from(event).where(eq(event.id, resultId));
    if (prior) {
      if (command.kind === 'accept' && ['declined', 'deferred'].includes(state.state))
        throw new ApiError('confirmation_closed', 'confirmation was declined or deferred', 409);
      if (
        !CommandResult.safeParse(prior.payload).success ||
        typeof prior.payload.occurrence_id !== 'string'
      )
        throw new ApiError('confirmation_incompatible', 'command result has no occurrence', 409);
      const previous = await readOccurrence(tx, prior.payload.occurrence_id);
      if (!previous)
        throw new ApiError('confirmation_incompatible', 'command occurrence missing', 409);
      return previous;
    }
    let next = state;
    if (command.kind === 'request_again') {
      const previousAssessment = await readConversationConfirmation(tx, state.occurrence_id);
      if (
        !['declined', 'deferred', 'blocked'].includes(state.state) &&
        !previousAssessment?.submission
      )
        throw new ApiError(
          'confirmation_closed_required',
          'close this confirmation before requesting another',
          409,
        );
      next = {
        ...state,
        sequence: 0,
        occurrence_id: occurrenceId(input.sessionId, state.learning_item_id, command.command_id),
        trigger_ask_id: input.askId,
        offer_reply_id: `confirmation_reply_${input.askId}`,
        state: 'offered',
        accept_ask_id: null,
        issuance_id: null,
        blocked_reason: null,
      };
    } else if (command.kind === 'accept') {
      if (state.state !== 'offered' && state.state !== 'issued' && state.state !== 'blocked')
        throw new ApiError('confirmation_closed', 'confirmation was declined or deferred', 409);
      if (state.state === 'offered') {
        const issued = await issueConversationConfirmation(tx, {
          occurrenceId: state.occurrence_id,
          sessionId: state.session_id,
          learningItemId: state.learning_item_id,
        });
        next = {
          ...state,
          sequence: state.sequence + 1,
          state: issued.status,
          accept_ask_id: input.askId,
          issuance_id: issued.status === 'issued' ? issued.issuance_id : null,
          blocked_reason: issued.status === 'blocked' ? issued.reason : null,
        };
      }
    } else if (command.kind === 'decline' || command.kind === 'defer') {
      const snapshot = await readConversationConfirmation(tx, state.occurrence_id);
      if (snapshot?.submission)
        throw new ApiError(
          'confirmation_already_submitted',
          'accepted original cannot be declined',
          409,
        );
      if (!['offered', 'issued'].includes(state.state))
        throw new ApiError('confirmation_closed', 'confirmation is already closed', 409);
      next = {
        ...state,
        sequence: state.sequence + 1,
        state: command.kind === 'decline' ? 'declined' : 'deferred',
      };
    } else if (state.state !== 'issued') {
      throw new ApiError('confirmation_not_issued', 'confirmation must be accepted first', 409);
    }
    if (next !== state) await save(tx, next);
    // Submit reserves its original and recovery fence in Practice, outside this
    // short lifecycle transaction; no provider call is made while locks are held.
    if (command.kind !== 'submit')
      await writeEvent(tx, {
        id: resultId,
        session_id: input.sessionId,
        actor_kind: 'system',
        actor_ref: 'conversation-confirmation',
        action: 'experimental:confirmation_command_result',
        subject_kind: 'query',
        subject_id: state.occurrence_id,
        payload: { version: 1, occurrence_id: next.occurrence_id },
      });
    return next;
  });
  if (command.kind === 'submit')
    await submitConversationConfirmation(db as Db, {
      occurrenceId: selected.occurrence_id,
      sessionId: input.sessionId,
      commandId: command.command_id,
      responseSet: command.response_set,
      groupEvidence: command.group_evidence,
      signal: input.signal,
      authorize: async (tx) => {
        await authorize(
          tx,
          input.sessionId,
          [
            selected.trigger_ask_id,
            ...(selected.accept_ask_id ? [selected.accept_ask_id] : []),
            input.askId,
          ],
          input.signal,
        );
        const current = await readOccurrence(tx, selected.occurrence_id);
        if ((await getCorrectionStatus(tx, selected.offer_reply_id)).state !== 'active')
          throw new ApiError('confirmation_revoked', 'confirmation offer was withdrawn', 409);
        if (current?.state !== 'issued')
          throw new ApiError('confirmation_closed', 'confirmation is no longer issued', 409);
      },
    });
  return {
    occurrence: selected,
    assessment: await readConversationConfirmation(db, selected.occurrence_id),
  };
}

/** Reuse turns' existing causal reply anchor; no second conversation reader. */
export async function readConfirmationProjection(db: Db | Tx, raw: unknown) {
  const parsed = ConfirmationOccurrence.safeParse(raw);
  if (!parsed.success)
    throw new ApiError('confirmation_incompatible', 'unsupported confirmation state/version', 409);
  const latest = await readOccurrence(db, parsed.data.occurrence_id);
  if (!latest || latest.session_id !== parsed.data.session_id)
    throw new ApiError('confirmation_unbound', 'confirmation history no longer matches', 409);
  return {
    occurrence: latest,
    assessment: await readConversationConfirmation(db, latest.occurrence_id),
  };
}

/** A genuine teaching end closes outstanding invitations without erasing originals. */
export async function endConversationConfirmation(
  tx: Tx,
  sessionId: string,
  learningItemId: string,
) {
  await lockSession(tx, sessionId);
  const rows = await tx
    .select({ id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.action, ACTION),
        eq(event.session_id, sessionId),
        sql`${event.payload}->>'learning_item_id' = ${learningItemId}`,
      ),
    );
  for (const id of new Set(rows.map((r) => r.id))) {
    const state = await readOccurrence(tx, id);
    if (!state || !['offered', 'issued'].includes(state.state)) continue;
    const assessment = await readConversationConfirmation(tx, id);
    if (!assessment?.submission)
      await save(tx, { ...state, sequence: state.sequence + 1, state: 'declined' });
  }
}

export function confirmationTeachingIntent(text: string): 'offer' | 'end' | null {
  if (/(结束|够了|不做|不想做|停止|不学了|今天到这|stop)/i.test(text)) return 'end';
  if (!/(没懂|不懂|没明白|不明白|没理解)/.test(text) && /(懂了|明白了|理解了|学会了)/.test(text))
    return 'offer';
  return null;
}
