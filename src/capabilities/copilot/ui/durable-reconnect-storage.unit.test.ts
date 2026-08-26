// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DURABLE_COPILOT_RECONNECT_STORAGE_KEY,
  PENDING_COPILOT_TURN_STORAGE_KEY,
  clearPersistedDurableCopilotReconnect,
  clearPersistedPendingCopilotTurn,
  durableRunIdFromLocation,
  loadPersistedDurableCopilotReconnect,
  loadPersistedPendingCopilotTurn,
  persistDurableCopilotReconnect,
  persistPendingCopilotTurn,
} from './durable-reconnect-storage';

const richHandle = {
  v: 1 as const,
  sessionId: 'copilot-session-gradient-transfer',
  runId: 'copilot_user_ask_gradient_transfer_42',
  location: '/api/jobs/copilot_run/copilot_user_ask_gradient_transfer_42/events',
  userMessageId: 'm_2000000_owner',
  aiMessageId: 'm_2000001_loom',
  userMessage: '请后台核对 36 道跨章节练习、两轮延迟复习和四个未教学探针，再生成三档迁移梯度。',
};

const richPendingTurn = {
  v: 1 as const,
  idempotencyKey: 'turn-gradient-transfer-42',
  userMessageId: 'm_1999999_owner',
  userMessage:
    '请交叉核对 42 次含参函数作答、三轮延迟复习和五个未教学探针，再生成三档迁移题并保留 validator 证据。',
  requestBody: {
    session_id: 'copilot-session-gradient-transfer',
    user_message:
      '请交叉核对 42 次含参函数作答、三轮延迟复习和五个未教学探针，再生成三档迁移题并保留 validator 证据。',
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

describe('durable Copilot reconnect storage', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('round-trips only the bounded same-origin handle and clears the matching terminal run', () => {
    const runtimeHandle = {
      ...richHandle,
      view: {
        frames: [
          {
            event_id: 42,
            event_type: 'copilot_run.delta',
            payload: { text: '这段进度只能留在内存，不能写入 sessionStorage。' },
          },
        ],
      },
    };
    expect(persistDurableCopilotReconnect(runtimeHandle)).toBe(true);
    expect(loadPersistedDurableCopilotReconnect()).toEqual(richHandle);
    expect(
      JSON.parse(window.sessionStorage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY) ?? '{}'),
    ).toEqual(richHandle);

    clearPersistedDurableCopilotReconnect('a_newer_run_must_not_clear_it');
    expect(loadPersistedDurableCopilotReconnect()).toEqual(richHandle);
    clearPersistedDurableCopilotReconnect(richHandle.runId);
    expect(loadPersistedDurableCopilotReconnect()).toBeNull();
  });

  it('rejects cross-route/tampered Locations and removes a corrupt record', () => {
    expect(durableRunIdFromLocation('https://evil.example/jobs/run/events')).toBeNull();
    expect(durableRunIdFromLocation('/api/jobs/other/run/events')).toBeNull();
    expect(
      persistDurableCopilotReconnect({
        ...richHandle,
        location: '/api/jobs/copilot_run/a_different_run/events',
      }),
    ).toBe(false);

    window.sessionStorage.setItem(
      DURABLE_COPILOT_RECONNECT_STORAGE_KEY,
      JSON.stringify({ ...richHandle, userMessage: 'x'.repeat(4_001) }),
    );
    expect(loadPersistedDurableCopilotReconnect()).toBeNull();
    expect(window.sessionStorage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY)).toBeNull();
  });

  it('round-trips the exact bounded pre-acceptance key/body and clears only the matching turn', () => {
    expect(persistPendingCopilotTurn(richPendingTurn)).toBe(true);
    expect(loadPersistedPendingCopilotTurn()).toEqual(richPendingTurn);
    expect(
      JSON.parse(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY) ?? '{}'),
    ).toEqual(richPendingTurn);

    clearPersistedPendingCopilotTurn('a-newer-logical-turn-must-not-clear-it');
    expect(loadPersistedPendingCopilotTurn()).toEqual(richPendingTurn);
    clearPersistedPendingCopilotTurn(richPendingTurn.idempotencyKey);
    expect(loadPersistedPendingCopilotTurn()).toBeNull();
  });

  it('preserves an explicit correction target in the exact retry body', () => {
    const correctionTurn = {
      ...richPendingTurn,
      requestBody: {
        session_id: richPendingTurn.requestBody.session_id,
        user_message: richPendingTurn.requestBody.user_message,
        triggered_by: 'chat' as const,
        ambient_context: richPendingTurn.requestBody.ambient_context,
        correction_target_turn_id: 'copilot_reply_parametric_domain_41',
      },
    };

    expect(persistPendingCopilotTurn(correctionTurn)).toBe(true);
    expect(loadPersistedPendingCopilotTurn()).toEqual(correctionTurn);
  });

  it('rejects a pending record whose visible message and replay body diverge', () => {
    window.sessionStorage.setItem(
      PENDING_COPILOT_TURN_STORAGE_KEY,
      JSON.stringify({
        ...richPendingTurn,
        requestBody: {
          ...richPendingTurn.requestBody,
          user_message: '被篡改成另一道题，不得与原 key 重放。',
        },
      }),
    );

    expect(loadPersistedPendingCopilotTurn()).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('rejects a legacy pending record without a session binding', () => {
    const { session_id: _sessionId, ...legacyBody } = richPendingTurn.requestBody;
    window.sessionStorage.setItem(
      PENDING_COPILOT_TURN_STORAGE_KEY,
      JSON.stringify({ ...richPendingTurn, requestBody: legacyBody }),
    );

    expect(loadPersistedPendingCopilotTurn()).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('removes malformed JSON instead of reparsing it on every Dock mount', () => {
    window.sessionStorage.setItem(PENDING_COPILOT_TURN_STORAGE_KEY, '{broken pending json');
    window.sessionStorage.setItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY, '{broken handle json');

    expect(loadPersistedPendingCopilotTurn()).toBeNull();
    expect(loadPersistedDurableCopilotReconnect()).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY)).toBeNull();
  });
});
