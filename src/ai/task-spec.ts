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
  readonly maxIterations: number;
  readonly maxCost: number;
  readonly transientRetries: number;
  readonly timeout: number;
}

export type TaskPrompt =
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'profile'; readonly build: (profile: SubjectProfile) => string };

/** Runtime-neutral task definition projected into the central registry. */
export interface TaskDefinition {
  readonly kind: string;
  readonly description: string;
  readonly defaultProvider: Provider;
  readonly defaultModel: ModelId;
  readonly budget: TaskBudget;
  readonly needsToolCall: boolean;
  readonly isMultimodal: boolean;
  readonly allowedTools: readonly string[];
  readonly prompt: TaskPrompt;
  readonly invocation?: 'auto' | 'manual_rescue_only';
  readonly structuredOutputSchema?: ZodTypeAny;
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
  readonly ownership: 'owned';
  readonly definition: TaskDefinition;
  readonly outputSchema: ZodTypeAny;
  readonly parseText: (text: string, context: TaskParseContext<Input>) => Output;
}
