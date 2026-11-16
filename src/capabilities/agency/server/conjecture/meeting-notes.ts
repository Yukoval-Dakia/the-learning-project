// Research-meeting rank weight for agent notes. A ref that names the cell's
// knowledge point or one of its failure attempts raises that cell. The note text
// is injected separately; this weight does not change cells the note does not name.

import type { AgentNote } from '@/kernel/read-models/agent-note-hints';

/** Rank multiplier when a research-meeting note points at the cell. 1 leaves order unchanged. */
export const RESEARCH_MEETING_NOTE_RANK_WEIGHT = 1.25;

export function researchMeetingNoteWeight(
  cell: { knowledge_id: string; evidence_event_ids: readonly string[] },
  notes: readonly Pick<AgentNote, 'refs'>[],
): number {
  const ids = new Set<string>([cell.knowledge_id, ...cell.evidence_event_ids]);
  for (const note of notes) {
    if (note.refs.some((ref) => ids.has(ref.id))) return RESEARCH_MEETING_NOTE_RANK_WEIGHT;
  }
  return 1;
}
