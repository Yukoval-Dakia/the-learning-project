// YUK-1049 — Jev typed scoring task (OpenRouter native decisions endpoint).
//
// This is a TYPED task spec (execution:'typed'), not a chat task: the typed
// runner (src/server/ai/typed-primitive-runner.ts) derives the canonical
// POST /api/v1/systemone body from the schema-parsed input and parses the
// response directly — no prompt, no tools, no free-text JSON extraction.
//
// Wire contract lives in src/core/schema/jev-systemone.ts (subject-agnostic
// transport); this file owns the TASK definition + spec registration only,
// keeping server→capability import edges at zero (capability-boundaries).

import { DEFAULT_TASK_BUDGET, type TaskDefinition, type TypedTaskSpec } from '@/ai/task-spec';
import { JevScoringDecisionInput, JevSystemOneResponse } from '@/core/schema/jev-systemone';

export type {
  JevAnswerT,
  JevQuestionT,
  JevScoringDecisionInputT,
  JevSystemOneResponseT,
} from '@/core/schema/jev-systemone';

export const jevScoringDecisionTaskDefinition = {
  kind: 'JevScoringDecisionTask',
  description:
    'OpenRouter native decisions (POST /api/v1/systemone) typed scorer — TypeSafe Jev 1.13 pin; rule-reference and holistic-level scoring units',
  execution: 'typed',
  defaultProvider: 'openrouter',
  defaultModel: 'typesafe/jev-1.13',
  // Typed lane enforces maxCost itself (reserve-per-unknown-cost-call): the
  // SDK-era maxBudgetUsd wiring died with Adapter A. One Jev call ≈$0.00002,
  // worst observed 401ms; timeout/retries sized for the durable funnel, not
  // the 60s sync route. transientRetries=1 mirrors the durable single-
  // transient-layer precedent (the queue re-drive is the second layer).
  budget: {
    ...DEFAULT_TASK_BUDGET,
    maxIterations: 1,
    timeout: 15_000,
    transientRetries: 1,
    maxCost: 0.02,
  },
  needsToolCall: false,
  isMultimodal: false,
  allowedTools: [],
  prompt: { kind: 'none' },
} satisfies TaskDefinition;

export const jevScoringDecisionTaskSpec = {
  ownership: 'owned',
  definition: jevScoringDecisionTaskDefinition,
  outputSchema: JevSystemOneResponse,
  typed: { inputSchema: JevScoringDecisionInput },
} satisfies TypedTaskSpec;
