import type { ZodTypeAny } from 'zod';
import type { SubjectProfile } from '@/subjects/profile';

export type Provider =
  | 'anthropic'
  | 'xiaomi'
  | 'zhipu'
  | 'openrouter'
  | 'gateway'
  | 'openai'
  | 'anthropic-sub';

export type ModelId = string;

/**
 * YUK-923 — SDK-native reasoning effort tier. Mirrors the Agent SDK
 * `Options['effort']` string-literal union 1:1 without widening the SDK type
 * onto this runtime-neutral surface.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  /**
   * YUK-923 — optional reasoning effort tier threaded to the Agent SDK `effort`
   * option. Absent ⇒ the runner does not pass the key (endpoint default; the
   * mimo/default path stays byte-identical to pre-seam).
   */
  readonly reasoningEffort?: EffortLevel;
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
