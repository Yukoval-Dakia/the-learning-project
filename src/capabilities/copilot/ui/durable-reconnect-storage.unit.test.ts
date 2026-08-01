// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DURABLE_COPILOT_RECONNECT_STORAGE_KEY,
  clearPersistedDurableCopilotReconnect,
  durableRunIdFromLocation,
  loadPersistedDurableCopilotReconnect,
  persistDurableCopilotReconnect,
} from './durable-reconnect-storage';

const richHandle = {
  v: 1 as const,
  runId: 'copilot_user_ask_gradient_transfer_42',
  location: '/api/jobs/copilot_run/copilot_user_ask_gradient_transfer_42/events',
  userMessageId: 'm_2000000_owner',
  aiMessageId: 'm_2000001_loom',
  userMessage: '请后台核对 36 道跨章节练习、两轮延迟复习和四个未教学探针，再生成三档迁移梯度。',
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
});
