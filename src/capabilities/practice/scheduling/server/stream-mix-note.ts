// Backlog note for the coach prompt and the companion startup segment.
// Written as an existing agent-note event. Not a new event type.
// The text comes from what this compose actually kept, not from the frontier diagnostic.
// Readers drop notes whose refs cannot be derived, so the note cites questions it actually
// scheduled (a date marker is not a source). One note per learner day stays active: a
// same-day recompose supersedes the earlier text, and a day that now fits retracts it, so
// readers never keep numbers from a plan that no longer exists.

import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { learnerDayWindowUtc } from '@/core/learner-day';
import { ActivityKind, type ActivityRefT } from '@/core/schema/activity';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses, writeEvent } from '@/kernel/events';
import { allowedQuestionIds } from '@/kernel/read-models/usage-policy';
import type { StreamPlan } from './stream-composer';

type DbLike = Db | Tx;

const SIGNAL_KIND = 'practice_stream_mix';
const ACTOR_REF = 'practice_stream';
const NOTE_ID_PREFIX = 'agent_note_stream_mix';
const NEW_LEARNING_SOURCES = new Set(['new_check', 'frontier']);
const MAX_NOTE_REFS = 3;

/** What this compose did with the day. `fits` means no due item was pushed out. */
export type StreamMixResult =
  | { kind: 'fits' }
  | { kind: 'backlog'; deferredDueCount: number; newLearningScheduled: number };

/** What the stream now says about the day; `fits` withdraws an earlier same-day note. */
export type StreamMixNote =
  | { kind: 'fits' }
  | { kind: 'backlog'; reason: string; summary: string; refs: ActivityRefT[] };

export function streamMixResult(
  plan: Pick<StreamPlan, 'items' | 'deferredDueCount'>,
): StreamMixResult {
  const deferredDueCount = plan.deferredDueCount ?? 0;
  if (deferredDueCount <= 0) return { kind: 'fits' };
  const newLearningScheduled = plan.items.filter((item) =>
    NEW_LEARNING_SOURCES.has(item.source),
  ).length;
  return { kind: 'backlog', deferredDueCount, newLearningScheduled };
}

function backlogSummary(result: Extract<StreamMixResult, { kind: 'backlog' }>): string {
  const deferred = `最不容易忘的 ${result.deferredDueCount} 项到期复习延后`;
  const scheduled =
    result.newLearningScheduled > 0 ? `，并排进了 ${result.newLearningScheduled} 道新学` : '';
  return `今天复习很多，是因为到期题积压。已按可回忆概率先排快忘的${scheduled}；${deferred}。`;
}

/** Scheduled questions, easiest-to-forget first: the evidence behind the note's text. */
function scheduledQuestionIds(items: StreamPlan['items']): string[] {
  const questions = items.filter((item) => item.item_kind === 'question');
  const ordered = [
    ...questions.filter((item) => item.source === 'decay'),
    ...questions.filter((item) => item.source !== 'decay'),
  ];
  return [...new Set(ordered.map((item) => item.ref_id))].slice(0, MAX_NOTE_REFS);
}

export function streamMixNote(plan: Pick<StreamPlan, 'items' | 'deferredDueCount'>): StreamMixNote {
  const result = streamMixResult(plan);
  if (result.kind === 'fits') return result;
  const refs: ActivityRefT[] = scheduledQuestionIds(plan.items).map((id) => ({
    kind: 'question',
    id,
  }));
  // Nothing to cite means nothing a reader could act on; publish no note.
  if (refs.length === 0) return { kind: 'fits' };
  return { kind: 'backlog', reason: 'due_backlog', summary: backlogSummary(result), refs };
}

/** Content-addressed id: recomposing the same plan refreshes one note instead of adding one. */
function noteId(date: string, note: Extract<StreamMixNote, { kind: 'backlog' }>): string {
  const ids = note.refs.map((ref) => ref.id).join(',');
  const digest = createHash('sha256').update(`${note.summary}\n${ids}`).digest('hex').slice(0, 10);
  return `${NOTE_ID_PREFIX}_${date}_${note.reason}_${digest}`;
}

/**
 * Publish this compose's note for `date`, retiring whatever it replaces. Runs after the
 * stream commits — a hint must never roll the stream back. Retiring the previous note is
 * what keeps the coach prompt and the companion segment aligned with the current plan.
 */
export async function writeStreamMixNote(
  db: DbLike,
  date: string,
  note: StreamMixNote,
): Promise<void> {
  // A note carrying a ref the derivation policy rejects reaches no reader at all, so keep
  // only the refs every reader may follow.
  const derivable =
    note.kind === 'backlog'
      ? await allowedQuestionIds(
          db,
          note.refs.map((ref) => ref.id),
        )
      : new Set<string>();
  const published: StreamMixNote =
    note.kind === 'backlog'
      ? { ...note, refs: note.refs.filter((ref) => derivable.has(ref.id)) }
      : note;
  const nextId =
    published.kind === 'backlog' && published.refs.length > 0 ? noteId(date, published) : null;
  const day = learnerDayWindowUtc(date, date);

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: event.id, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:agent_note'),
          gte(event.created_at, day.from),
          lt(event.created_at, day.to),
          sql`${event.payload}->>'signal_kind' = ${SIGNAL_KIND}`,
        ),
      );
    const states = await getCorrectionStatuses(
      tx,
      rows.map((row) => row.id),
    );
    const isActive = (id: string) => (states.get(id)?.state ?? 'active') === 'active';
    const previous = rows.find((row) => row.id === nextId);

    if (published.kind === 'backlog' && nextId !== null) {
      if (!previous) {
        await writeEvent(tx, {
          id: nextId,
          actor_kind: 'system',
          actor_ref: ACTOR_REF,
          action: 'experimental:agent_note',
          subject_kind: 'query',
          subject_id: nextId,
          outcome: null,
          payload: {
            target_agents: ['coach', 'copilot'],
            refs: published.refs,
            summary_md: published.summary,
            signal_kind: SIGNAL_KIND,
            // This learner day only: yesterday's backlog must not explain today's plan.
            expires_at: day.to.toISOString(),
            source_task_kind: ACTOR_REF,
          },
        });
      } else if (!isActive(nextId)) {
        // The plan returned to text this day already published; restoring beats a duplicate.
        await correctNote(tx, nextId, previous.payload, 'restore', null);
      }
    }

    for (const row of rows) {
      if (row.id === nextId || !isActive(row.id)) continue;
      await correctNote(tx, row.id, row.payload, nextId ? 'supersede' : 'retract', nextId);
    }
  });
}

/** Retire a same-day note, pointing readers at the replacement when there is one. */
async function correctNote(
  tx: Tx,
  targetId: string,
  payload: unknown,
  correctionKind: 'supersede' | 'retract' | 'restore',
  replacementId: string | null,
): Promise<void> {
  const affected = activityRefs(payload);
  // A correction carries typed activity refs; a note without them cannot be retired.
  if (affected.length === 0) return;
  await writeEvent(tx, {
    id: `${targetId}~${correctionKind}~${createId()}`,
    actor_kind: 'agent',
    actor_ref: ACTOR_REF,
    action: 'correct',
    subject_kind: 'event',
    subject_id: targetId,
    outcome: 'success',
    payload: {
      correction_kind: correctionKind,
      ...(correctionKind === 'supersede' && replacementId
        ? { replacement_event_id: replacementId }
        : {}),
      reason_md:
        correctionKind === 'restore'
          ? 'the recomposed day published the stream mix note again'
          : correctionKind === 'supersede'
            ? 'same-day recompose replaced the stream mix note'
            : 'the recomposed day fits the minute budget',
      affected_refs: affected,
    },
    caused_by_event_id: targetId,
  });
}

function activityRefs(payload: unknown): ActivityRefT[] {
  const refs = (payload as { refs?: unknown } | null)?.refs;
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref) => {
    const { kind, id } = (ref ?? {}) as { kind?: unknown; id?: unknown };
    if (typeof kind !== 'string' || !ActivityKind.safeParse(kind).success) return [];
    if (typeof id !== 'string' || id.length === 0) return [];
    return [{ kind: kind as ActivityRefT['kind'], id }];
  });
}
