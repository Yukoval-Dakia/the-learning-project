import { beforeEach, describe, expect, it } from 'vitest';
import { openCopilot, useCopilotOpenSignal } from './use-copilot-dwell';

describe('free-form Copilot cross-surface handoff (YUK-626)', () => {
  beforeEach(() => {
    useCopilotOpenSignal.setState({ request: null, nextSeq: 0 });
  });

  it('opens with a prefill and does not fabricate a skill/entity context', () => {
    openCopilot('来份判断句专项卷');

    expect(useCopilotOpenSignal.getState().request).toEqual({
      seq: 1,
      prefill: '来份判断句专项卷',
    });
  });

  it('keeps a monotonic sequence across repeated handoffs', () => {
    openCopilot('第一份');
    useCopilotOpenSignal.getState().clearRequest();
    openCopilot('第二份');
    expect(useCopilotOpenSignal.getState().request?.seq).toBe(2);
  });
});
