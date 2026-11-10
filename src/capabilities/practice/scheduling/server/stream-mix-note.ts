// Backlog / unmet new-learning floor, written as an existing agent-note event so the
// coach prompt and the companion's note read already surface it. Not a new event type.

import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import type { LearningMixDiagnostic } from './post-filter';

type DbLike = Db | Tx;

const SIGNAL_KIND = 'practice_stream_mix';
const NOTE_TTL_MS = 36 * 60 * 60 * 1000;

export function streamMixNoteSummary(input: {
  diagnostics?: readonly LearningMixDiagnostic[];
  deferredDueCount?: number;
}): { reason: string; summary: string } | null {
  const floor = input.diagnostics?.find((item) => item.kind === 'anti_comfort_floor_unmet');
  const deferred = input.deferredDueCount ?? 0;
  if (floor?.reason === 'budget_truncated') {
    return {
      reason: floor.reason,
      summary:
        '今天复习很多，是因为到期题积压。新学保底被时间预算截断，已把最不容易忘的到期项延后。',
    };
  }
  if (floor?.reason === 'not_selected') {
    return {
      reason: floor.reason,
      summary: '今天复习很多，是因为到期题积压。有新学候选，但没有被选进今天的练习。',
    };
  }
  // no_candidate on a day that still fits is the steady state (nothing new to schedule).
  // Say it only when due items were actually pushed out.
  if (deferred > 0 && floor?.reason === 'no_candidate') {
    return {
      reason: floor.reason,
      summary:
        '今天复习很多，是因为到期题积压。已按可回忆概率先排快忘的，最不容易忘的到期项延后。没有可排的新学前沿。',
    };
  }
  if (deferred > 0) {
    return {
      reason: 'due_backlog',
      summary: '今天复习很多，是因为到期题积压。已按可回忆概率先排快忘的；最不容易忘的到期项延后。',
    };
  }
  return null;
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
