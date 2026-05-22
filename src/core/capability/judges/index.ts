import { CapabilityRegistry } from '../registry';
import { exactJudgeCapability } from './exact';
import { keywordJudgeCapability } from './keyword';
import { stepsV1Capability } from './steps';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerJudge(exactJudgeCapability);
  registry.registerJudge(keywordJudgeCapability);
  // M2.1 (2026-05-22): steps@1 skeleton — run() returns 'unsupported' until
  // M2.2 wires the vision LLM call. Registration is required so
  // mathProfile.judgeCapabilities = [..., 'steps'] passes validateProfile.
  registry.registerJudge(stepsV1Capability);
  return registry;
}

let defaultRegistry: CapabilityRegistry | null = null;

export function getDefaultRegistry(): CapabilityRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createDefaultRegistry();
  }
  return defaultRegistry;
}

export { exactJudgeCapability } from './exact';
export { keywordJudgeCapability } from './keyword';
export { stepsV1Capability } from './steps';
