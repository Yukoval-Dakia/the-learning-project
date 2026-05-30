import { describe, expect, it } from 'vitest';

import { getDefaultRegistry } from '@/core/capability/judges';
import { CapabilityRegistry } from '@/core/capability/registry';
import { fsrsSchedulerCapability } from '@/core/capability/schedulers/fsrs';
import type { SchedulerCapabilityRunner } from '@/core/capability/schedulers/types';
import { validateProfile } from '@/core/capability/validate-profile';
import { mathProfile } from '@/subjects/math/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';

function withPolicy(policy: string): SubjectProfile {
  return { ...mathProfile, schedulingHints: { default_policy: policy } };
}

describe('validateProfile — scheduling policy (T-QP)', () => {
  it('accepts a profile whose default_policy resolves to a registered scheduler', () => {
    const result = validateProfile(withPolicy('fsrs'), getDefaultRegistry());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a default_policy with no registered scheduler', () => {
    const result = validateProfile(withPolicy('cadence'), getDefaultRegistry());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("default_policy 'cadence' not found"))).toBe(true);
  });

  it("rejects a scheduler that explicitly excludes the 'question' activity kind", () => {
    const registry = new CapabilityRegistry();
    // re-register the default judges by copying the default registry's judges is
    // overkill; build a fresh registry with a question-less scheduler under 'fsrs'
    // plus the judges math needs.
    for (const judge of ['exact', 'keyword', 'semantic', 'steps']) {
      const runner = getDefaultRegistry().resolveJudge(judge);
      if (runner) registry.registerJudge(runner);
    }
    const recordOnlyScheduler: SchedulerCapabilityRunner = {
      manifest: {
        ...fsrsSchedulerCapability.manifest,
        supports_activity_kinds: ['record'],
      },
      run: fsrsSchedulerCapability.run,
    };
    registry.registerScheduler(recordOnlyScheduler);
    const result = validateProfile(withPolicy('fsrs'), registry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not support 'question'"))).toBe(true);
  });
});
