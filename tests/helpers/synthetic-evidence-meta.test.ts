// YUK-1341 — no-network metadata behavior for the synthetic harnesses.
// Guards the correction: binding state must be OBSERVED, never hardcoded, and
// phase labels must stay neutral (the old 'pre-binding' labels were false for
// the 2026-10-06T18:07Z post-binding reseal).

import { describe, expect, it } from 'vitest';
import {
  type ObservedCapabilityProfile,
  SYNTHETIC_TOOL_PHASE,
  SYNTHETIC_VISION_PHASE,
  describeObservedBindingState,
} from './synthetic-evidence-meta';

function profileOf(
  overrides: Partial<ObservedCapabilityProfile> & Pick<ObservedCapabilityProfile, 'capabilities'>,
): ObservedCapabilityProfile {
  return {
    provider: 'opencode-go',
    model: 'mimo-v2.6-pro',
    source: 'binding',
    ...overrides,
  };
}

describe('synthetic evidence metadata (YUK-1341 correction)', () => {
  it('phase labels are neutral — no binding-ordering claim', () => {
    for (const phase of [SYNTHETIC_TOOL_PHASE, SYNTHETIC_VISION_PHASE]) {
      expect(phase).toMatch(/^A-synthetic-(tool|vision)-ability$/);
      expect(phase).not.toMatch(/pre-binding|post-binding|NOT yet declared/);
    }
  });

  it('binding state echoes observed profile values, not a hardcoded narrative', () => {
    const declared = describeObservedBindingState(
      profileOf({ capabilities: { toolCalling: true, vision: true } }),
      'toolCalling',
    );
    expect(declared).toContain('resolveModelProfile(opencode-go, mimo-v2.6-pro)');
    expect(declared).toContain('observed before this call');
    expect(declared).toContain('toolCalling=true');
    expect(declared).toContain('profile source: binding');
    expect(declared).not.toMatch(/NOT yet declared|pre-binding|only after this seal/);

    const undeclared = describeObservedBindingState(
      profileOf({ source: 'defaults', capabilities: { toolCalling: false, vision: 'unknown' } }),
      'toolCalling',
    );
    expect(undeclared).toContain('toolCalling=false');
    expect(undeclared).toContain('profile source: defaults');
    expect(undeclared).not.toMatch(/NOT yet declared|pre-binding/);
  });

  it('vision probes report the observed vision tri-state', () => {
    const vision = describeObservedBindingState(
      profileOf({ capabilities: { toolCalling: true, vision: 'unknown' } }),
      'vision',
    );
    expect(vision).toContain('vision=unknown');
    expect(vision).toContain('observed state only, no binding-ordering claim');
  });
});
