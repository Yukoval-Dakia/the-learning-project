// Companion startup segment: the agent-note unit. Notes are AI-to-AI hints with
// provenance and expiry — attention priors, never learner facts — so the unit
// shows the count plus one bounded line each and says where the rest is read.

import type { Db, Tx } from '@/db/client';
import { type AgentNote, readAgentNotes } from '@/kernel/read-models/agent-note-hints';

type DbLike = Db | Tx;

/** 便条单元最多展开的条数；未展开的只进标题计数。 */
const AGENT_NOTE_LINE_LIMIT = 5;
/** 读取上限：标题里的「N 条未过期」要覆盖到所有当前有效便条。 */
const AGENT_NOTE_READ_LIMIT = 20;
const AGENT_NOTE_SUMMARY_MAX_CHARS = 70;

/**
 * Unexpired notes another worker left for the companion. A copilot-authored note
 * is excluded: re-reading its own hints would reinforce them as evidence.
 */
export function readCompanionAgentNotes(db: DbLike, now: Date): Promise<AgentNote[]> {
  return readAgentNotes(db, {
    for_agent: 'copilot',
    now,
    limit: AGENT_NOTE_READ_LIMIT,
    excludeSourceKinds: ['copilot'],
  });
}

export function renderAgentNotes(notes: readonly AgentNote[]): string | null {
  if (notes.length === 0) return null;
  const shown = notes.slice(0, AGENT_NOTE_LINE_LIMIT);
  const body = shown
    .map(
      (note) =>
        `· [${note.signal_kind}] ${note.summary_md
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, AGENT_NOTE_SUMMARY_MAX_CHARS)}`,
    )
    .join('\n');
  const capped = notes.length >= AGENT_NOTE_READ_LIMIT;
  const count = `${notes.length}${capped ? '+' : ''}`;
  // 读满上限时总数未知：只说要还有更多可读取，不编一个精确的剩余条数。
  const more = capped
    ? '（还有未展开的，可用 read_agent_notes 查看）'
    : notes.length > shown.length
      ? `（另 ${notes.length - shown.length} 条未展开，可用 read_agent_notes 查看）`
      : null;
  return [`便条 ${count} 条（AI 线索，非事实）：`, body, more]
    .filter((line): line is string => line !== null)
    .join('\n');
}
