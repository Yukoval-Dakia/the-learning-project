// Backlog note for the coach prompt and the companion startup segment.
// Written as an existing agent-note event. Not a new event type.
// The text comes from what this compose actually kept, not from the frontier diagnostic.

import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import type { StreamPlan } from './stream-composer';

type DbLike = Db | Tx;

const SIGNAL_KIND = 'practice_stream_mix';
const NOTE_TTL_MS = 36 * 60 * 60 * 1000;
const NEW_LEARNING_SOURCES = new Set(['new_check', 'frontier']);

/** What this compose did with the day. `fits` means no due item was pushed out. */
export type StreamMixResult =
  | { kind: 'fits' }
  | { kind: 'backlog'; deferredDueCount: number; newLearningScheduled: number };

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

export function streamMixNoteSummary(
  plan: Pick<StreamPlan, 'items' | 'deferredDueCount'>,
): { reason: string; summary: string } | null {
  const result = streamMixResult(plan);
  switch (result.kind) {
    case 'fits':
      return null;
    case 'backlog':
      return { reason: 'due_backlog', summary: backlogSummary(result) };
  }
}

/** One note per date and reason. A repeat compose keeps the first write. */
export async function writeStreamMixNote(
  db: DbLike,
  date: string,
  note: { reason: string; summary: string },
): Promise<void> {
  const id = `agent_note_stream_mix_${date}_${note.reason}`;
  await writeEvent(db, {
    id,
    actor_kind: 'system',
    actor_ref: 'practice_stream',
    action: 'experimental:agent_note',
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: {
      target_agents: ['coach', 'copilot'],
      refs: [{ kind: 'practice_stream_date', id: date }],
      summary_md: note.summary,
      signal_kind: SIGNAL_KIND,
      expires_at: new Date(Date.now() + NOTE_TTL_MS).toISOString(),
      source_task_kind: 'practice_stream',
    },
  });
}
