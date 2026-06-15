// YUK-364 — durable copilot run 状态派生纯函数单测（unit 分区，无 DB）。

import { describe, expect, it } from 'vitest';

import { COPILOT_RUN_EVENTS, deriveCopilotRunStatus, hasCancelRequest } from './copilot-run-status';

describe('deriveCopilotRunStatus', () => {
  it('empty序列 → queued（最保守初态）', () => {
    expect(deriveCopilotRunStatus([])).toBe('queued');
  });

  it('只有 queued → queued', () => {
    expect(deriveCopilotRunStatus([{ event_type: COPILOT_RUN_EVENTS.QUEUED }])).toBe('queued');
  });

  it('queued → started → running 推进', () => {
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.STARTED },
      ]),
    ).toBe('started');
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.STARTED },
        { event_type: COPILOT_RUN_EVENTS.STEP },
      ]),
    ).toBe('running');
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.STARTED },
        { event_type: COPILOT_RUN_EVENTS.REPLY },
      ]),
    ).toBe('running');
  });

  it('done 终态 last-writer wins', () => {
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.STARTED },
        { event_type: COPILOT_RUN_EVENTS.REPLY },
        { event_type: COPILOT_RUN_EVENTS.DONE },
      ]),
    ).toBe('done');
  });

  it('failed 终态', () => {
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.STARTED },
        { event_type: COPILOT_RUN_EVENTS.FAILED },
      ]),
    ).toBe('failed');
  });

  it('cancel_requested 在未到终态时浮出', () => {
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED },
      ]),
    ).toBe('cancel_requested');
  });

  it('终态优先于 cancel_requested（取消后仍跑完则以 done/failed 为准）', () => {
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED },
        { event_type: COPILOT_RUN_EVENTS.FAILED },
      ]),
    ).toBe('failed');
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED },
        { event_type: COPILOT_RUN_EVENTS.DONE },
      ]),
    ).toBe('done');
  });

  it('未知 event_type 被忽略（forward-compat）', () => {
    expect(
      deriveCopilotRunStatus([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: 'copilot_run.some_future_event' },
        { event_type: COPILOT_RUN_EVENTS.STARTED },
      ]),
    ).toBe('started');
  });
});

describe('hasCancelRequest', () => {
  it('检出取消请求事件', () => {
    expect(hasCancelRequest([{ event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED }])).toBe(true);
  });
  it('无取消请求 → false', () => {
    expect(
      hasCancelRequest([
        { event_type: COPILOT_RUN_EVENTS.QUEUED },
        { event_type: COPILOT_RUN_EVENTS.DONE },
      ]),
    ).toBe(false);
  });
});
