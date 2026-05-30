import { CapabilityRegistry } from '../registry';
import { fsrsSchedulerCapability } from '../schedulers/fsrs';
import { exactJudgeCapability } from './exact';
import { keywordJudgeCapability } from './keyword';
import { semanticJudgeCapability } from './semantic';
import { stepsV1Capability } from './steps';
import { unitDimensionV1Capability } from './unit_dimension';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerJudge(exactJudgeCapability);
  registry.registerJudge(keywordJudgeCapability);
  registry.registerJudge(semanticJudgeCapability);
  // steps@1 is registered for profile validation and route resolution. Server
  // execution goes through JudgeInvoker, which supplies DB/runtime context to
  // runStepsJudge instead of calling the core registry runner directly.
  registry.registerJudge(stepsV1Capability);
  registry.registerJudge(unitDimensionV1Capability);
  // T-QP (YUK-165, ADR-0014 §5) — register the `fsrs` scheduling policy. Like
  // steps@1, this is for profile validation + route resolution: the live
  // review/due path schedules questions (and parts, which ARE questions) via
  // `scheduleReview` directly. The capability declares fsrs serves both
  // 'question' and 'question_part'. validateProfile asserts each profile's
  // schedulingHints.default_policy resolves to a registered scheduler.
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
export { semanticJudgeCapability } from './semantic';
export { stepsV1Capability } from './steps';
export { unitDimensionV1Capability } from './unit_dimension';
