import { describe, expect, it } from 'vitest';

import { resolveProbeResolution } from './probe-resolution';

describe('resolveProbeResolution (YUK-787)', () => {
  it('keeps the first incorrect probe preliminary', () => {
    expect(resolveProbeResolution(0, 'probe_1', [])).toBe('evidence_for');
  });

  it('confirms only after a distinct prior probe matched the same conjecture', () => {
    expect(
      resolveProbeResolution(0, 'probe_2', [
        { probe_question_id: 'probe_1', outcome: 0, resolution: 'evidence_for' },
      ]),
    ).toBe('confirmed');
  });

  it('does not count a replay of the same probe as independent evidence', () => {
    expect(
      resolveProbeResolution(0, 'probe_1', [
        { probe_question_id: 'probe_1', outcome: 0, resolution: 'evidence_for' },
      ]),
    ).toBe('evidence_for');
  });

  it('keeps correct → retired regardless of prior evidence', () => {
    expect(
      resolveProbeResolution(1, 'probe_2', [
        { probe_question_id: 'probe_1', outcome: 0, resolution: 'confirmed' },
      ]),
    ).toBe('retired');
  });
});
