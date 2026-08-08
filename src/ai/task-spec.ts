import type { SubjectProfile } from '@/subjects/profile';
import type { ZodTypeAny } from 'zod';

export type Provider =
  | 'anthropic'
  | 'xiaomi'
  | 'zhipu'
  | 'openrouter'
  | 'gateway'
  | 'openai'
  | 'anthropic-sub';

export type ModelId = string;

export interface TaskBudget {
  maxIterations: number;
  maxCost: number;
  transientRetries: number;
  timeout: number;
}

export type TaskPrompt =
  | { kind: 'inline'; text: string }
  | { kind: 'profile'; build: (profile: SubjectProfile) => string };

/** Runtime-neutral task definition projected into the central registry. */
export interface TaskDefinition {
  kind: string;
  description: string;
  defaultProvider: Provider;
  defaultModel: ModelId;
  budget: TaskBudget;
  needsToolCall: boolean;
  isMultimodal: boolean;
  allowedTools: string[];
  prompt: TaskPrompt;
  invocation?: 'auto' | 'manual_rescue_only';
  structuredOutputSchema?: ZodTypeAny;
}

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxIterations: 6,
  maxCost: 0.5,
  transientRetries: 0,
  timeout: 60_000,
};

export interface TaskParseContext<Input> {
  input: Input;
  subjectProfile: SubjectProfile;
}

/** Capability-owned model-task semantics; registry composition uses `definition`. */
export interface TaskSpec<Input, Output> {
  definition: TaskDefinition;
  parseText(text: string, context: TaskParseContext<Input>): Output;
}
