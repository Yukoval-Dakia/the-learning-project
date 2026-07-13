import { type ReactElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  agentNoteGroupSummary,
  agentNoteRunLabel,
  anInlineMd,
  dayGroupOf,
  deriveTtl,
  groupAgentNotes,
  humanAgentNoteSummary,
  isFresh,
  resolveEvidence,
} from './derive';
import type { BoardAgentNote } from './types';

const NOW = new Date('2026-06-08T12:00:00.000Z');

describe('isFresh', () => {
  it('is true just under 24h old', () => {
    expect(isFresh(new Date(NOW.getTime() - (24 * 3600_000 - 60_000)), NOW)).toBe(true);
  });
  it('is false just over 24h old', () => {
    expect(isFresh(new Date(NOW.getTime() - (24 * 3600_000 + 60_000)), NOW)).toBe(false);
  });
  it('accepts ISO string input', () => {
    expect(isFresh(new Date(NOW.getTime() - 3600_000).toISOString(), NOW)).toBe(true);
  });
  it('returns false for an unparseable date', () => {
    expect(isFresh('not-a-date', NOW)).toBe(false);
  });
});

describe('deriveTtl', () => {
  it('returns null when there is no expires_at', () => {
    expect(deriveTtl(undefined, NOW)).toBeNull();
  });
  it('flags soon when expiring within 48h', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() + 47 * 3600_000).toISOString(), NOW);
    expect(ttl?.soon).toBe(true);
  });
  it('does not flag soon when expiring beyond 48h', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() + 49 * 3600_000).toISOString(), NOW);
    expect(ttl?.soon).toBe(false);
    expect(ttl?.text).toContain('天后过期');
  });
  it('uses hours phrasing under a day', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() + 5 * 3600_000).toISOString(), NOW);
    expect(ttl?.text).toContain('小时后过期');
    expect(ttl?.soon).toBe(true);
  });
  it('treats an already-expired note as soon/即将过期', () => {
    const ttl = deriveTtl(new Date(NOW.getTime() - 3600_000).toISOString(), NOW);
    expect(ttl).toEqual({ text: '即将过期', soon: true });
  });
  it('returns null for an unparseable expires_at', () => {
    expect(deriveTtl('garbage', NOW)).toBeNull();
  });
});

describe('dayGroupOf', () => {
  it('groups same-day as today', () => {
    const sameDay = new Date('2026-06-08T01:00:00.000Z');
    expect(dayGroupOf(sameDay, NOW).group).toBe('today');
    expect(dayGroupOf(sameDay, NOW).label).toBe('今天');
  });
  it('groups previous calendar day as yesterday', () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3600_000);
    const info = dayGroupOf(yesterday, NOW);
    // boundary depends on local midnight; one day back is today-1 ⇒ yesterday or today
    expect(['yesterday', 'today']).toContain(info.group);
  });
  it('groups well-past dates as earlier', () => {
    const old = new Date('2026-06-01T12:00:00.000Z');
    expect(dayGroupOf(old, NOW).group).toBe('earlier');
    expect(dayGroupOf(old, NOW).label).toBe('更早');
  });
  it('falls back to earlier for an unparseable date', () => {
    expect(dayGroupOf('nope', NOW).group).toBe('earlier');
  });
});

describe('anInlineMd', () => {
  it('passes plain text through unchanged', () => {
    expect(anInlineMd('hello world')).toEqual(['hello world']);
  });
  it('wraps **bold** in a <b>', () => {
    const out = anInlineMd('a **b** c');
    const bold = out.find(
      (n): n is ReactElement<{ children: string }> => isValidElement(n) && n.type === 'b',
    );
    expect(bold).toBeDefined();
    expect(bold?.props.children).toBe('b');
  });
  it('wraps `code` in a <code>', () => {
    const out = anInlineMd('see `k_zhi` here');
    const code = out.find(
      (n): n is ReactElement<{ children: string }> => isValidElement(n) && n.type === 'code',
    );
    expect(code).toBeDefined();
    expect(code?.props.children).toBe('k_zhi');
  });
  it('handles mixed bold + code', () => {
    const out = anInlineMd('**A** and `B`');
    const els = out.filter(isValidElement);
    expect(els.map((e) => e.type)).toEqual(['b', 'code']);
  });
  it('leaves an unclosed token as plain text (no crash)', () => {
    expect(anInlineMd('a **b c')).toEqual(['a **b c']);
  });
});

describe('resolveEvidence', () => {
  it('navigates an event ref to /events/:id', () => {
    const ev = resolveEvidence({ refs: [{ kind: 'event', id: 'evt_9' }] });
    expect(ev).toEqual({ label: '事件证据', href: '/events/evt_9', kind: 'event' });
  });
  it('renders an unsupported ref with a safe label and no href', () => {
    const ev = resolveEvidence({ refs: [{ kind: 'note', id: 'note_judge' }] });
    expect(ev).toEqual({ label: '相关证据', href: null, kind: 'note' });
  });
  it('navigates labelled knowledge without exposing its raw id', () => {
    const ev = resolveEvidence({
      refs: [{ kind: 'knowledge', id: 'spike:math:erci-tuxiang', label: '二次函数' }],
    });
    expect(ev).toEqual({
      label: '二次函数',
      href: '/knowledge/spike%3Amath%3Aerci-tuxiang',
      kind: 'knowledge',
    });
  });
  it('falls back to caused_by_event_id when refs is empty', () => {
    const ev = resolveEvidence({ refs: [], caused_by_event_id: 'evt_trigger' });
    expect(ev).toEqual({ label: '事件证据', href: '/events/evt_trigger', kind: 'event' });
  });
  it('returns null when there is no ref and no caused_by_event_id', () => {
    expect(resolveEvidence({ refs: [] })).toBeNull();
  });
  it('prefers refs[0] over caused_by_event_id', () => {
    const ev = resolveEvidence({
      refs: [{ kind: 'event', id: 'evt_primary' }],
      caused_by_event_id: 'evt_fallback',
    });
    expect(ev?.href).toBe('/events/evt_primary');
  });
});

function boardNote(overrides: Partial<BoardAgentNote> = {}): BoardAgentNote {
  return {
    id: 'note_1',
    created_at: '2026-07-13T08:00:00Z',
    target_agents: ['coach'],
    source_task_kind: 'quiz_verify',
    source_task_run_id: 'run_1',
    refs: [
      {
        kind: 'knowledge',
        id: 'spike:math:erci-tuxiang',
        label: '二次函数·图像与性质',
        resolution_state: 'open',
        usable_question_count: 0,
      },
    ],
    summary_md:
      'Generated question abcdefghijklmnopqrstuv did not enter the review pool (verification needs_review).',
    signal_kind: 'question_pool_gap',
    confidence: 0.8,
    caused_by_event_id: 'evt_1',
    ...overrides,
  };
}

describe('agent-note learner grouping', () => {
  it('collapses repeated signals by knowledge point and preserves every real run', () => {
    const notes = [
      boardNote(),
      boardNote({
        id: 'note_2',
        source_task_run_id: 'run_2',
        created_at: '2026-07-13T09:00:00Z',
        caused_by_event_id: 'evt_2',
      }),
      boardNote({
        id: 'note_3',
        source_task_run_id: 'run_3',
        created_at: '2026-07-13T10:00:00Z',
        caused_by_event_id: 'evt_3',
      }),
    ];

    const groups = groupAgentNotes(notes);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      run_count: 3,
      resolution_state: 'open',
      attention: 'medium',
    });
    expect(groups[0].notes.map((note) => note.id)).toEqual(['note_3', 'note_2', 'note_1']);
    expect(agentNoteGroupSummary(groups[0])).toBe(
      '3 次候选题校验没有进入题池，这个知识点目前仍缺可用练习。',
    );
  });

  it('marks a historical group resolved when the read model finds usable questions', () => {
    const groups = groupAgentNotes([
      boardNote({
        refs: [
          {
            kind: 'knowledge',
            id: 'spike:math:erci-tuxiang',
            label: '二次函数·图像与性质',
            resolution_state: 'resolved',
            usable_question_count: 4,
          },
        ],
      }),
    ]);
    expect(groups[0].resolution_state).toBe('resolved');
    expect(groups[0].attention).toBe('resolved');
    expect(agentNoteGroupSummary(groups[0])).toContain('当前已有 4 道可用练习');
  });

  it('translates stored machine templates and run outcomes without leaking ids', () => {
    const note = boardNote();
    const text = humanAgentNoteSummary(note, 'open');
    expect(text).toBe('有候选题未通过校验，这个知识点仍需要补充可用练习。');
    expect(text).not.toMatch(/Generated|needs_review|abcdefghijkl|spike:/);
    expect(agentNoteRunLabel(note)).toBe('等待人工复核');
    expect(
      agentNoteRunLabel(boardNote({ summary_md: 'Generated question x (verification failed).' })),
    ).toBe('未通过校验');
  });

  it('groups subject-less observations by a shared run instead of merging unrelated runs', () => {
    const groups = groupAgentNotes([
      boardNote({ id: 'a', refs: [], signal_kind: 'quality', source_task_run_id: 'same' }),
      boardNote({ id: 'b', refs: [], signal_kind: 'quality', source_task_run_id: 'same' }),
      boardNote({ id: 'c', refs: [], signal_kind: 'quality', source_task_run_id: 'other' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.run_count).sort()).toEqual([1, 1]);
    expect(groups.map((group) => group.notes.length).sort()).toEqual([1, 2]);
  });
});
