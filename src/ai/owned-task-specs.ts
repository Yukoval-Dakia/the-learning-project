import type { TaskDefinition, TaskSpec } from './task-spec';

export type TaskOwner = 'practice' | 'ingestion' | 'knowledge' | 'notes' | 'agency' | 'copilot';

type OwnedTaskSpec = TaskSpec<never, unknown>;

// YUK-885 — the transitional entry kind and the central quarry are deleted:
// every owner entry is a full TaskSpec (definition + parseText + outputSchema).
export type TaskOwnerEntry = OwnedTaskSpec;

const EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

const PROVIDERS = new Set<string>([
  'anthropic',
  'xiaomi',
  'zhipu',
  'openrouter',
  'gateway',
  'openai',
  'anthropic-sub',
]);

function assertPositiveFinite(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid budget.${field}`);
  }
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid budget.${field}`);
  }
}

function assertNonNegativeFinite(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid budget.${field}`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid budget.${field}`);
  }
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  );
}

function validateDefinition(owner: TaskOwner, key: string, definition: TaskDefinition): void {
  if (key !== definition.kind) {
    throw new Error(
      `defineOwnedTaskSpecs(${owner}): key "${key}" does not match spec.kind "${definition.kind}"`,
    );
  }
  if (typeof definition.description !== 'string' || !definition.description.trim()) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing description`);
  }
  if (
    typeof definition.defaultProvider !== 'string' ||
    !PROVIDERS.has(definition.defaultProvider)
  ) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid defaultProvider`);
  }
  if (typeof definition.defaultModel !== 'string' || !definition.defaultModel.trim()) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing defaultModel`);
  }
  if (typeof definition.budget !== 'object' || definition.budget === null) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing or invalid budget`);
  }
  assertPositiveInteger(definition.budget.maxIterations, 'maxIterations');
  assertNonNegativeFinite(definition.budget.maxCost, 'maxCost');
  assertNonNegativeInteger(definition.budget.transientRetries, 'transientRetries');
  assertPositiveFinite(definition.budget.timeout, 'timeout');
  if (
    typeof definition.needsToolCall !== 'boolean' ||
    typeof definition.isMultimodal !== 'boolean'
  ) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid task flags`);
  }
  if (!Array.isArray(definition.allowedTools)) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid allowedTools`);
  }
  if (definition.allowedTools.some((tool) => typeof tool !== 'string' || !tool.trim())) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid allowedTools entry`);
  }
  if (!definition.needsToolCall && definition.allowedTools.length > 0) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" has tools without tool calls`);
  }
  if (definition.reasoningEffort !== undefined && !EFFORT_LEVELS.has(definition.reasoningEffort)) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid reasoningEffort`);
  }
  if (
    definition.invocation !== undefined &&
    definition.invocation !== 'auto' &&
    definition.invocation !== 'manual_rescue_only'
  ) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid invocation`);
  }
  const prompt = definition.prompt;
  if (typeof prompt !== 'object' || prompt === null || !('kind' in prompt)) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" missing prompt`);
  }
  switch (prompt.kind) {
    case 'inline':
      if (
        !hasExactKeys(prompt, ['kind', 'text']) ||
        typeof prompt.text !== 'string' ||
        !prompt.text.trim()
      ) {
        throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" has invalid inline prompt`);
      }
      break;
    case 'profile':
      if (!hasExactKeys(prompt, ['build', 'kind']) || typeof prompt.build !== 'function') {
        throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" has invalid profile prompt`);
      }
      break;
    default:
      throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid prompt discriminant`);
  }
  if (
    definition.structuredOutputSchema !== undefined &&
    (typeof definition.structuredOutputSchema !== 'object' ||
      definition.structuredOutputSchema === null ||
      typeof definition.structuredOutputSchema.safeParse !== 'function')
  ) {
    throw new Error(`defineOwnedTaskSpecs(${owner}): "${key}" invalid structuredOutputSchema`);
  }
}

function freezeDefinition(definition: TaskDefinition): void {
  Object.freeze(definition.budget);
  Object.freeze(definition.allowedTools);
  Object.freeze(definition.prompt);
  Object.freeze(definition);
}

export function defineOwnedTaskSpecs<
  const Specs extends { readonly [Kind in keyof Specs]: TaskOwnerEntry },
>(owner: TaskOwner, specs: Specs): Readonly<Specs> {
  for (const [key, value] of Object.entries(specs)) {
    const entry = value as TaskOwnerEntry;
    validateDefinition(owner, key, entry.definition);
    if (typeof entry.parseText !== 'function') {
      throw new Error(`defineOwnedTaskSpecs(${owner}): owned "${key}" missing parseText`);
    }
    if (
      typeof entry.outputSchema !== 'object' ||
      entry.outputSchema === null ||
      typeof entry.outputSchema.safeParse !== 'function'
    ) {
      throw new Error(`defineOwnedTaskSpecs(${owner}): owned "${key}" missing outputSchema`);
    }
    freezeDefinition(entry.definition);
    Object.freeze(entry);
  }
  return Object.freeze(specs);
}
