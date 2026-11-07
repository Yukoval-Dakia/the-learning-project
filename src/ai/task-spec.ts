import type { ZodTypeAny } from 'zod';
import type { SubjectProfile } from '@/subjects/profile';

export type KnownProvider =
  | 'anthropic'
  | 'xiaomi'
  | 'xiaomi-token-plan'
  | 'zhipuai-coding-plan'
  | 'openrouter'
  | 'gateway'
  | 'openai'
  | 'anthropic-sub'
  | 'opencode-go';

/** Custom providers configured at runtime (YUK-1563 part 4): `custom:<name>`. */
export type CustomProviderId = `custom:${string}`;

export type Provider = KnownProvider | CustomProviderId;

const LEGACY_PROVIDER_IDS = {
  'zai-coding-cn': 'zhipuai-coding-plan',
} as const satisfies Record<string, Provider>;

/** Stored config, env, and queued jobs may still name the previous id. */
export function canonicalProviderName(name: string): string {
  return LEGACY_PROVIDER_IDS[name as keyof typeof LEGACY_PROVIDER_IDS] ?? name;
}

export type ModelId = string;

/**
 * YUK-923 — SDK-native reasoning effort tier. Mirrors the Agent SDK
 * `Options['effort']` string-literal union 1:1 without widening the SDK type
 * onto this runtime-neutral surface.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TaskBudget {
  // 'unbounded' is reachable only via a caller TaskBudgetOverride (durable
  // copilot); registry defaults and config overrides are always finite.
  readonly maxIterations: number | 'unbounded';
  readonly maxCost: number;
  readonly transientRetries: number;
  readonly timeout: number;
}

export type TaskPrompt =
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'profile'; readonly build: (profile: SubjectProfile) => string }
  /**
   * YUK-1049 — typed-execution tasks have NO chat prompt: the typed runner
   * (src/server/ai/typed-primitive-runner.ts) derives the canonical request
   * body from the schema-parsed typed input. `kind:'none'` is legal ONLY on
   * definitions with execution='typed' (owned-task-specs enforces); chat entry
   * points reject such tasks before reaching getTaskSystemPrompt.
   */
  | { readonly kind: 'none' };

/**
 * YUK-1794 — Context 模块消费声明（audit:context-consumers）。每个 TaskSpec 必须
 * 声明它消费哪个 learner-context view，或显式 `view:'none'` 加理由（如判分只评
 * 本次作答、有意不读历史）。已登记 view 的词表只在 CONTEXT_VIEWS 一处扩。
 */
export const CONTEXT_VIEWS = ['companion', 'curator'] as const;
export type ContextViewName = (typeof CONTEXT_VIEWS)[number];
export type TaskContextDeclaration =
  | { readonly view: ContextViewName }
  | { readonly view: 'none'; readonly reason: string };

/**
 * YUK-1904 — per-unit structured submit. The model submits ONE unit per submit
 * call; the submit loop accepts units individually, seals a unit on its third
 * identical shape error, and assembles the full output in expectedUnitIds order
 * only when every expected unit was accepted. Injection stays shape/field-only:
 * validators return authored field diagnostics, never values or judgments.
 */
export interface StructuredSubmitUnitPlan {
  /** Expected unit ids in input order; assembly order is exactly this order. */
  readonly expectedUnitIds: readonly string[];
  /** Reads the submitted unit and its id off submit arguments (pre- or post-parse). */
  readonly unitOf: (submitted: unknown) => { id: unknown; unit: unknown };
  /** Wraps the schema-parsed submit arguments (expectedUnitIds order) into the full output. */
  readonly assemble: (units: readonly unknown[]) => unknown;
  /** Field-level checks for one parsed submit; unit coverage is owned by the submit loop. */
  readonly validateUnit?: (submitted: unknown, input: unknown) => readonly string[];
}

/** Runtime-neutral task definition projected into the central registry. */
export interface TaskDefinition {
  readonly kind: string;
  readonly description: string;
  /**
   * YUK-1049 — execution transport discriminant. Absent/'chat' = the pi
   * chat-façade path (prompt required, runTask/streamTask). 'typed' = the
   * restricted typed-primitive runner (prompt must be {kind:'none'}; input /
   * output are schema-parsed, never free-text JSON extraction). The catalog
   * validator and the runner both reject mismatched combinations.
   */
  readonly execution?: 'chat' | 'typed';
  readonly defaultProvider: Provider;
  readonly defaultModel: ModelId;
  readonly budget: TaskBudget;
  /**
   * Opt-in: the pi lane stops the agent loop once the run's priced spend reaches
   * `budget.maxCost`. Off by default because every chat kind inherits
   * DEFAULT_TASK_BUDGET.maxCost, and enforcing it everywhere would cut runs that
   * today end only at maxIterations or the timeout.
   */
  readonly enforceMaxCost?: boolean;
  readonly needsToolCall: boolean;
  readonly isMultimodal: boolean;
  readonly allowedTools: readonly string[];
  readonly context: TaskContextDeclaration;
  readonly prompt: TaskPrompt;
  /** Explicit caller effort conflicts with configured reasoning: one wire writer. */
  readonly reasoningEffort?: EffortLevel;
  readonly invocation?: 'auto' | 'manual_rescue_only';
  /** Dedicated route: env/DB global pins must not repoint this task. */
  readonly ignoreGlobalPin?: boolean;
  readonly structuredOutputSchema?: ZodTypeAny;
  /** Submit schema-constrained tool arguments, correcting failures within one run. */
  readonly structuredOutputMode?: 'tool';
  /** Input mode may narrow the wire schema; it must not depend on answer evidence. */
  readonly structuredSubmitSchema?: (input: unknown) => ZodTypeAny;
  /** YUK-1904 — declare a unit plan to submit one unit per submit call. */
  readonly structuredSubmitUnits?: (input: unknown) => StructuredSubmitUnitPlan | undefined;
}

/**
 * The single mount-selection rule for the structured submit tool. The pi adapter
 * mounts the returned schema and audit:tool-params checks the same value, so the
 * gate cannot drift from the wire (YUK-1904).
 */
export function resolveStructuredSubmitSchema(
  definition: Pick<
    TaskDefinition,
    'structuredOutputMode' | 'structuredSubmitSchema' | 'structuredOutputSchema'
  >,
  input?: unknown,
): ZodTypeAny | undefined {
  return definition.structuredOutputMode === 'tool'
    ? (definition.structuredSubmitSchema?.(input) ?? definition.structuredOutputSchema)
    : undefined;
}

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxIterations: 6,
  maxCost: 0.5,
  transientRetries: 0,
  // Loop guard, not a cost lever (owner 2026-11-07, YUK-1983): must sit above
  // the slowest real completion. Measured: TEST 4710 runs 2026-10-07→11-05
  // (tlp-audit-artifacts/test-to-nas/route-c-plus-counts-20261106.txt) put the
  // tier's worst completion at 82s (SemanticJudgeTask; QuizVerify 77s), so 120s
  // is 1.46× the measured longest. Tasks with longer measured tails declare
  // their own timeout instead of widening this default.
  timeout: 120_000,
};

export interface TaskParseContext<Input> {
  input: Input;
  subjectProfile: SubjectProfile;
}

export const DEFAULT_TASK_MODEL = Object.freeze({
  defaultProvider: 'opencode-go',
  defaultModel: 'deepseek-v4.1-flash',
} as const);

export type TaskDefinitionInput = Omit<TaskDefinition, 'defaultProvider' | 'defaultModel'> &
  Partial<Pick<TaskDefinition, 'defaultProvider' | 'defaultModel'>>;

/** Capability-owned model-task semantics; registry composition uses `definition`. */
export interface TaskSpec<Input, Output> {
  readonly ownership: 'owned';
  readonly definition: TaskDefinitionInput;
  readonly outputSchema: ZodTypeAny;
  readonly parseText: (text: string, context: TaskParseContext<Input>) => Output;
}

/**
 * YUK-1049 — capability-owned TYPED task semantics (typed execution kind).
 * No parseText: outputs are parsed directly from the provider's typed
 * response by `outputSchema` — free-text JSON extraction is the forbidden
 * pattern on this lane. `typed.inputSchema` parses the caller-supplied typed
 * input BEFORE the runner builds the canonical request body (its hash is the
 * lifecycle input provenance).
 */
export interface TypedTaskSpec {
  readonly ownership: 'owned';
  readonly definition: TaskDefinitionInput;
  readonly outputSchema: ZodTypeAny;
  readonly typed: { readonly inputSchema: ZodTypeAny };
}

/** An owned spec entry: chat TaskSpec or typed TypedTaskSpec. */
export type OwnedTaskSpecEntry = TaskSpec<never, unknown> | TypedTaskSpec;
