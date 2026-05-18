import { CapabilityRegistry } from '../registry';
import { exactJudgeCapability } from './exact';
import { keywordJudgeCapability } from './keyword';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerJudge(exactJudgeCapability);
  registry.registerJudge(keywordJudgeCapability);
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
