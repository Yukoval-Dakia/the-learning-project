import { describe, expect, it } from 'vitest';

import {
  type OvernightDigest,
  formatOvernightHandoffSentence,
} from '@/server/today/overnight-digest';

function digest(over: Partial<OvernightDigest> = {}): OvernightDigest {
  return {
    window: {
      from: '2026-07-15T16:00:00.000Z',
      to: '2026-07-16T16:00:00.000Z',
    },
    has_overnight_activity: false,
    runs: [],
    note_changes_count: 0,
    new_proposals_count: 0,
    new_conjectures_count: 0,
    agent_notes_count: 0,
    degraded_kinds: [],
    ...over,
  };
}

describe('formatOvernightHandoffSentence', () => {
  it('returns null for the same explicit quiet-night state used by Today', () => {
    expect(formatOvernightHandoffSentence(digest())).toBeNull();
  });

  it('summarizes the five-source digest and surfaces degradation explicitly', () => {
    expect(
      formatOvernightHandoffSentence(
        digest({
          has_overnight_activity: true,
          runs: [
            { task_kind: 'dreaming', count: 2, status_breakdown: { success: 2 } },
            { task_kind: 'coach', count: 1, status_breakdown: { failure: 1 } },
          ],
          note_changes_count: 2,
          new_proposals_count: 1,
          agent_notes_count: 4,
          degraded_kinds: [
            {
              task_kind: 'coach',
              error_count: 2,
              recent_error_messages: ['provider unavailable'],
            },
          ],
        }),
      ),
    ).toBe('1 类夜间任务降级；夜间任务 3 次，笔记精炼 2 次，图谱提议 1 条，AI 观察 4 条。');
  });
});
