import type { AgentNoteBoardDto } from '@/capabilities/agency/public';

export const agentNoteNow = new Date('2026-10-09T12:34:56.789Z');
export const agentNoteText = '# 观察原文\n条件、歧义、α🙂与证据。\n'.repeat(200);
export const agentNoteBoard = {
  rows: [
    {
      id: 'rich-note',
      created_at: '2026-10-09T12:34:56.001Z',
      source_task_kind: 'verification/中文',
      source_task_run_id: 'original-run',
      target_agents: ['maintenance', 'research_meeting'],
      summary_md: agentNoteText,
      signal_kind: 'future_signal',
      confidence: 0,
      expires_at: '2026-10-09T12:34:56.790Z',
      caused_by_event_id: 'column-cause',
      refs: [
        {
          kind: 'knowledge',
          id: 'k-resolved',
          label: '已核实条件',
          resolution_state: 'resolved',
          usable_question_count: 3,
        },
        {
          kind: 'knowledge',
          id: 'k-open',
          label: '缺少可用题',
          resolution_state: 'open',
          usable_question_count: 0,
        },
        { kind: 'question', id: 'q-missing', label: '相关题目', resolution_state: 'unknown' },
        {
          kind: 'future_ref',
          id: 'α/未知',
          label: '相关证据',
          resolution_state: 'unknown',
          provenance: {
            excerpts: [agentNoteText],
            alternatives: [null, false, { reason: '歧义未决', confidence: 0 }],
          },
        },
      ],
    },
    {
      id: 'no-expiry',
      created_at: '2026-10-08T23:59:59.001Z',
      target_agents: [],
      source_task_kind: 'actor-fallback',
      refs: [],
      summary_md: '永久观察，不是已接受事实。',
      signal_kind: 'observation',
      caused_by_event_id: 'fallback-evidence',
    },
  ],
} satisfies AgentNoteBoardDto & { rows: Array<{ refs: Array<{ provenance?: unknown }> }> };
