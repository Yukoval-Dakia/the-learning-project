import { describe, expect, it } from 'vitest';

import { assertAgentSdkRuntimeUser } from '@/server/ai/runtime-preflight';

describe('assertAgentSdkRuntimeUser', () => {
  it('accepts a non-root runtime user', () => {
    expect(() => assertAgentSdkRuntimeUser(() => 1000)).not.toThrow();
  });

  it('fails fast with an actionable error for uid 0', () => {
    expect(() => assertAgentSdkRuntimeUser(() => 0)).toThrow(
      /must not run as root.*Run the container as the node user/,
    );
  });
});
