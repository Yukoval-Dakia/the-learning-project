import { describe, expect, it, vi } from 'vitest';

import {
  assembleConversationHistory,
  assembleCopilotRunInput,
} from '@/capabilities/copilot/server/copilot-run-input';
import type { LearnerStateHeader } from '@/capabilities/copilot/server/learner-state';
import type { CopilotTurn } from '@/capabilities/copilot/server/turns';

const turn = (role: 'user' | 'ai' | 'tombstone', text: string, event_id?: string) =>
  ({
    role,
    text,
    event_id,
    at: '2026-09-01T00:00:00.000Z',
    skill_context: { skill: 'quiz' },
    proposal_feedback: [{ marker: 'must-not-replay' }],
    ambient_context: { route: '/private' },
    primary_view: {
      source: 'tool_result',
      ref: { kind: 'query_knowledge', id: 'read-private' },
      snapshot: {
        version: 1,
        state: 'available',
        value: { text: 'must-not-replay'.repeat(500) },
        sha256: 'a'.repeat(64),
        byte_length: new TextEncoder().encode(
          JSON.stringify({ text: 'must-not-replay'.repeat(500) }),
        ).byteLength,
        completeness: 'complete',
        omissions: [],
      },
    },
  }) as unknown as CopilotTurn;

describe('assembleConversationHistory', () => {
  it('projects only conversational roles and preserves AI identity while removing polluted fields', () => {
    const result = assembleConversationHistory(
      [
        turn('tombstone', 'deleted'),
        turn('user', '请解释这个嵌套结构', 'ignored-user-id'),
        turn('ai', '结论来自已验证的关系。', 'reply_42'),
      ],
      { maxTurns: 10, perTurnChars: 200, totalChars: 2_000 },
    );

    expect(result).toEqual([
      { role: 'user', text: '请解释这个嵌套结构' },
      { role: 'ai', text: '结论来自已验证的关系。', event_id: 'reply_42' },
    ]);
  });

  it('applies per-turn and total budgets, dropping oldest turns first', () => {
    const result = assembleConversationHistory(
      Array.from({ length: 5 }, (_, index) => turn('user', `${index}-${'长文本'.repeat(80)}`)),
      { maxTurns: 4, perTurnChars: 48, totalChars: 150 },
    );

    expect(result.length).toBeLessThan(4);
    expect(result.at(-1)?.text.startsWith('4-')).toBe(true);
    expect(result.every((entry) => entry.text.length <= 48)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(150);
  });

  it('enforces maxTurns independently of the character budget', () => {
    const result = assembleConversationHistory(
      [turn('user', 'zero'), turn('user', 'one'), turn('user', 'two')],
      { maxTurns: 2, perTurnChars: 200, totalChars: 2_000 },
    );
    expect(result.map((entry) => entry.text)).toEqual(['one', 'two']);
  });

  it('pins a learner header, but drops an impossible orphan header', () => {
    const pinned = assembleConversationHistory(
      Array.from({ length: 8 }, (_, index) => turn('user', `${index}-${'旧内容'.repeat(30)}`)),
      { maxTurns: 10, perTurnChars: 200, totalChars: 200 },
      '学习者状态：待复习 3 项',
    );
    expect(pinned[0]).toEqual({ role: 'context', text: '学习者状态：待复习 3 项' });
    expect(pinned.some((entry) => entry.role === 'user')).toBe(true);
    expect(pinned.length).toBeLessThan(9);

    expect(
      assembleConversationHistory(
        [],
        { maxTurns: 10, perTurnChars: 200, totalChars: 20 },
        'x'.repeat(100),
      ),
    ).toEqual([]);
    expect(
      assembleConversationHistory(
        [turn('user', 'kept')],
        { maxTurns: 10, perTurnChars: 200, totalChars: 100 },
        '',
      ),
    ).toEqual([{ role: 'user', text: 'kept' }]);
  });
});

describe('assembleCopilotRunInput degradation', () => {
  const now = new Date('2026-09-01T00:00:00.000Z');
  const base = {
    sessionId: 'session_unit',
    userMessage: '继续这个证明',
    triggeredBy: 'chat' as const,
    now,
    historyAnchorEventId: 'anchor_unit',
    ambient: { route: '/knowledge/demo', focused_entity: { kind: 'knowledge', id: 'k1' } },
  };
  const state = (
    header_md: string,
    proposal_feedback: LearnerStateHeader['proposal_feedback'],
  ) => ({ header_md, proposal_feedback });

  it('keeps proposal feedback separate from history and carries ambient context once', async () => {
    const feedback = [
      {
        kind: 'knowledge_edge' as const,
        relation: 'related_to' as const,
        acceptance_rate: 0.8,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
    ];
    const result = await assembleCopilotRunInput({} as never, base, {
      resolveLearnerStateHeaderFn: vi.fn(async () => state('状态：待复习', feedback)),
      loadAnchoredHistoryFn: vi.fn(async () => [
        turn('user', '旧问题'),
        turn('ai', '旧回答', 'reply_old'),
      ]),
    });
    expect(result.proposal_feedback).toEqual(feedback);
    expect(result.conversation_history[0]).toEqual({ role: 'context', text: '状态：待复习' });
    expect(result.correction_contract.available_prior_turn_ids).toEqual(['reply_old']);
    expect(result.ambient_context).toEqual(base.ambient);
    expect(JSON.stringify(result.conversation_history)).not.toContain('must-not-replay');
  });

  it('degrades resolver failure to empty header/digest without losing the run', async () => {
    const result = await assembleCopilotRunInput({} as never, base, {
      resolveLearnerStateHeaderFn: async () => {
        throw new Error('state unavailable');
      },
      loadAnchoredHistoryFn: async () => [turn('user', '可保留的旧问题')],
    });
    expect(result.learner_state_header).toBe('');
    expect(result.proposal_feedback).toEqual([]);
    expect(result.conversation_history).toEqual([{ role: 'user', text: '可保留的旧问题' }]);
  });

  it('degrades history failure to a pinned header only', async () => {
    const result = await assembleCopilotRunInput({} as never, base, {
      resolveLearnerStateHeaderFn: async () => state('状态：目标是边界条件', []),
      loadAnchoredHistoryFn: async () => {
        throw new Error('history unavailable');
      },
    });
    expect(result.conversation_history).toEqual([
      { role: 'context', text: '状态：目标是边界条件' },
    ]);
    expect(result.validator_context_history).toEqual([
      { role: 'context', text: '状态：目标是边界条件' },
    ]);
  });
});
