// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PENDING_COPILOT_TURN_STORAGE_KEY,
  clearPersistedPendingCopilotTurn,
  discardLegacyDurableCopilotReconnect,
  durableRunIdFromLocation,
  loadPersistedPendingCopilotTurns,
  persistPendingCopilotTurn,
} from './durable-reconnect-storage';

function pending(sequence: number) {
  return {
    v: 2 as const,
    idempotencyKey: `turn-gradient-transfer-${sequence}`,
    userMessageId: `m_${sequence}_owner`,
    aiMessageId: `m_${sequence}_loom`,
    userMessage: `请核对第 ${sequence} 组含参函数作答、延迟复习和未教学探针。`,
    requestBody: {
      session_id: 'copilot-session-gradient-transfer',
      user_message: `请核对第 ${sequence} 组含参函数作答、延迟复习和未教学探针。`,
      triggered_by: 'chat' as const,
      skill_context: {
        skill: 'teaching' as const,
        ref: { kind: 'knowledge', id: 'kc_parametric_domain_transfer' },
      },
      ambient_context: {
        route: '/subjects/math/mistakes?window=45d',
        focused_entity: { kind: 'knowledge', id: 'kc_parametric_domain_transfer' },
      },
    },
  };
}

describe('pending Copilot acceptance storage', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('round-trips multiple exact key/body tuples and clears only the accepted turn', () => {
    const first = pending(1);
    const second = {
      ...pending(2),
      requestBody: {
        ...pending(2).requestBody,
        correction_target_turn_id: 'copilot_reply_prior_42',
      },
    };

    expect(persistPendingCopilotTurn(first)).toBe(true);
    expect(persistPendingCopilotTurn(second)).toBe(true);
    expect(loadPersistedPendingCopilotTurns()).toEqual([first, second]);

    clearPersistedPendingCopilotTurn(first.idempotencyKey);
    expect(loadPersistedPendingCopilotTurns()).toEqual([second]);
    expect(
      JSON.parse(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY) ?? '{}'),
    ).toEqual({ v: 2, turns: [second] });
  });

  it('upserts a same-key retry without overwriting another pending message', () => {
    const first = pending(1);
    const second = pending(2);
    persistPendingCopilotTurn(first);
    persistPendingCopilotTurn(second);

    expect(persistPendingCopilotTurn({ ...first, aiMessageId: 'm_1_loom_restored' })).toBe(true);
    expect(loadPersistedPendingCopilotTurns()).toEqual([
      { ...first, aiMessageId: 'm_1_loom_restored' },
      second,
    ]);
  });

  it('migrates one bounded v1 pending tuple and discards obsolete accepted-handle cache', () => {
    const legacy = pending(3);
    const { aiMessageId: _aiMessageId, ...legacyWithoutAi } = legacy;
    window.sessionStorage.setItem(
      'loom:copilot:pending-turn:v1',
      JSON.stringify({ ...legacyWithoutAi, v: 1 }),
    );
    window.sessionStorage.setItem(
      'loom:copilot:durable-reconnect:v1',
      JSON.stringify({ runId: 'obsolete-local-authority' }),
    );

    expect(loadPersistedPendingCopilotTurns()).toEqual([
      { ...legacy, aiMessageId: `${legacy.userMessageId}_reply` },
    ]);
    discardLegacyDurableCopilotReconnect();
    expect(window.sessionStorage.getItem('loom:copilot:pending-turn:v1')).toBeNull();
    expect(window.sessionStorage.getItem('loom:copilot:durable-reconnect:v1')).toBeNull();
  });

  it('rejects divergent visible/body content and removes a corrupt collection', () => {
    const corrupted = {
      ...pending(4),
      requestBody: { ...pending(4).requestBody, user_message: '被篡改的另一条请求' },
    };
    window.sessionStorage.setItem(
      PENDING_COPILOT_TURN_STORAGE_KEY,
      JSON.stringify({ v: 2, turns: [corrupted] }),
    );

    expect(loadPersistedPendingCopilotTurns()).toEqual([]);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('rejects duplicate keys and malformed JSON rather than choosing one silently', () => {
    const turn = pending(5);
    window.sessionStorage.setItem(
      PENDING_COPILOT_TURN_STORAGE_KEY,
      JSON.stringify({ v: 2, turns: [turn, turn] }),
    );
    expect(loadPersistedPendingCopilotTurns()).toEqual([]);

    window.sessionStorage.setItem(PENDING_COPILOT_TURN_STORAGE_KEY, '{broken json');
    expect(loadPersistedPendingCopilotTurns()).toEqual([]);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('accepts only the canonical same-origin run events location', () => {
    expect(durableRunIdFromLocation('/api/jobs/copilot_run/copilot_user_ask_42/events')).toBe(
      'copilot_user_ask_42',
    );
    expect(durableRunIdFromLocation('https://evil.example/jobs/run/events')).toBeNull();
    expect(durableRunIdFromLocation('/api/jobs/other/run/events')).toBeNull();
    expect(durableRunIdFromLocation('/api/jobs/copilot_run/%ZZ/events')).toBeNull();
  });
});
