import { CapabilityRegistry } from '../registry';
import { fsrsSchedulerCapability } from '../schedulers/fsrs';
import { exactJudgeCapability } from './exact';
import { keywordJudgeCapability } from './keyword';
import { multimodalDirectV1Capability } from './multimodal_direct';
import { semanticJudgeCapability } from './semantic';
import { stepsV1Capability } from './steps';
import { unitDimensionV1Capability } from './unit_dimension';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerJudge(exactJudgeCapability);
  registry.registerJudge(keywordJudgeCapability);
  registry.registerJudge(semanticJudgeCapability);
  // Server-runtime judges are registered for validation and route resolution;
  // execution goes through JudgeInvoker, not the core runner.
  registry.registerJudge(stepsV1Capability);
  registry.registerJudge(unitDimensionV1Capability);
  registry.registerJudge(multimodalDirectV1Capability);
  // Declaration only: the live review path schedules through scheduleReview.
  registry.registerScheduler(fsrsSchedulerCapability);
  return registry;
}

let defaultRegistry: CapabilityRegistry | null = null;

export function getDefaultRegistry(): CapabilityRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createDefaultRegistry();
  }
  return defaultRegistry;
}

export { fsrsSchedulerCapability } from '../schedulers/fsrs';
export { exactJudgeCapability } from './exact';
export { keywordJudgeCapability } from './keyword';
export { multimodalDirectV1Capability } from './multimodal_direct';
export { semanticJudgeCapability } from './semantic';
export { stepsV1Capability } from './steps';
export { unitDimensionV1Capability } from './unit_dimension';
