// YUK-1341 — evidence-metadata builders for the synthetic harnesses. Pure and
// network-free: these strings describe capability/binding state OBSERVED at
// capture time and a neutral phase label, never an ordering narrative about
// providers.ts. (The pre-binding narrative this replaced was false for the
// 2026-10-06T18:07Z final-tree reseal — see the `correction` records on
// docs/planning/evidence/2026-10-07-yuk1341-synthetic-*-actual.json.)

/** Neutral phases: never claim pre/post binding ordering from a label. */
export const SYNTHETIC_TOOL_PHASE = 'A-synthetic-tool-ability';
export const SYNTHETIC_VISION_PHASE = 'A-synthetic-vision-ability';

/** Structural slice of ModelProfile the metadata strings actually read. */
export interface ObservedCapabilityProfile {
  provider: string;
  model: string;
  capabilities: {
    toolCalling: true | false | 'unknown';
    vision: true | false | 'unknown';
  };
  source: string;
}

/**
 * Describe the capability state observed from `resolveModelProfile` BEFORE the
 * paid call. The value echoes the observed tri-state and profile source — it
 * must never be replaced by a hardcoded narrative such as 'NOT yet declared'.
 */
export function describeObservedBindingState(
  profile: ObservedCapabilityProfile,
  capability: 'toolCalling' | 'vision',
): string {
  return (
    `resolveModelProfile(${profile.provider}, ${profile.model}) observed before this call: ` +
    `${capability}=${String(profile.capabilities[capability])} (profile source: ${profile.source}) — ` +
    'observed state only, no binding-ordering claim'
  );
}
