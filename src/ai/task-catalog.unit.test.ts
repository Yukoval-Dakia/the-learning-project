/**
 * task-catalog.unit.test.ts — YUK-863 / F3.2
 *
 * Verifies the composition contract for the central task catalog:
 *  - Exactly 51 tasks, one per census entry
 *  - Each definition passes defineOwnedTaskSpecs validation
 *  - composeTaskCatalog rejects duplicates, key/kind mismatches
 *  - The frozen catalog is read-only at runtime
 */

import { describe, expect, it } from 'vitest';
import {
  type TaskOwner,
  composeTaskCatalog,
  defineOwnedTaskSpecs,
  taskCatalog,
} from './task-catalog';
import type { TaskDefinition } from './task-spec';

describe('taskCatalog', () => {
  it('contains exactly 51 TaskDefinitions', () => {
    expect(Object.keys(taskCatalog)).toHaveLength(51);
  });

  it('is frozen at module load (mutation after freeze is rejected)', () => {
    expect(Object.isFrozen(taskCatalog)).toBe(true);
    expect(() => {
      // @ts-expect-error intentional mutation test
      taskCatalog.AttributionTask = {} as TaskDefinition;
    }).toThrow();
  });

  it('every key equals the definition kind', () => {
    for (const [key, def] of Object.entries(taskCatalog)) {
      expect(def.kind, `key "${key}" must equal def.kind`).toBe(key);
    }
  });

  it('every definition has a non-empty prompt', () => {
    for (const [key, def] of Object.entries(taskCatalog)) {
      if (def.prompt.kind === 'inline') {
        expect(def.prompt.text.trim(), `${key} inline prompt is empty`).not.toBe('');
      } else {
        expect(def.prompt.build, `${key} profile prompt.build is not a function`).toBeTypeOf(
          'function',
        );
      }
    }
  });

  it('every definition has required metadata fields', () => {
    for (const [key, def] of Object.entries(taskCatalog)) {
      expect(def.defaultProvider, `${key} missing defaultProvider`).toBeTruthy();
      expect(def.defaultModel, `${key} missing defaultModel`).toBeTruthy();
      expect(def.budget, `${key} missing budget`).toBeTruthy();
      expect(typeof def.budget.maxIterations, `${key} budget.maxIterations not a number`).toBe(
        'number',
      );
      expect(Array.isArray(def.allowedTools), `${key} allowedTools not an array`).toBe(true);
    }
  });

  it('covers all 51 expected TaskKinds from the census', () => {
    const expectedKinds = [
      'AttributionTask',
      'AttributionRerankTask',
      'VisionExtractTask',
      'VisionExtractTaskHeavy',
      'StructureTask',
      'MistakeEnrollTask',
      'KnowledgeEdgeProposeTask',
      'FrontierPrerequisiteTask',
      'SessionSummaryTask',
      'LearningIntentOutlineTask',
      'NoteGenerateTask',
      'NoteVerifyTask',
      'NoteRefineTask',
      'SemanticJudgeTask',
      'UnitDimensionFallback',
      'StepsJudgeTask',
      'MultimodalDirectJudgeTask',
      'SourceGroundingVerifyTask',
      'VariantVerifyTask',
      'VariantGenTask',
      'TeachingTurnTask',
      'ProfileCriticTask',
      'DreamingTask',
      'CoachTask',
      'CopilotDispatchTask',
      'CopilotEvidenceReviewTask',
      'CopilotEvidenceVerificationTask',
      'CopilotTask',
      'KnowledgeReviewTask',
      'GoalScopeTask',
      'MindModelInductionTask',
      'ConjectureGroupingTask',
      'ConjectureProbeAuthorTask',
      'ConjectureProbeReviewTask',
      'InterventionRecommendationTask',
      'InterventionPackageAuthorTask',
      'InterventionPackageReviewTask',
      'ResearchMeetingDirectorTask',
      'MemoryBriefTask',
      'TaggingTask',
      'ColdStartPlacementBridgeTask',
      'SolutionGenerateTask',
      'SolutionGenerateVisionTask',
      'QuizGenTask',
      'QuizVerifyTask',
      'TeachingQualityTask',
      'QuestionAuthorTask',
      'ItemPriorTask',
      'SelectionOrchestratorTask',
      'SourcingTask',
      'BlockAssemblyTask',
    ] as const;

    expect(expectedKinds).toHaveLength(51);
    for (const kind of expectedKinds) {
      expect(taskCatalog[kind], `${kind} missing from catalog`).toBeDefined();
    }
    expect(Object.keys(taskCatalog)).toHaveLength(expectedKinds.length);
  });
});

describe('defineOwnedTaskSpecs', () => {
  it('returns the map unchanged when valid', () => {
    const spec: TaskDefinition = {
      kind: 'TestTask',
      description: 'test',
      defaultProvider: 'xiaomi',
      defaultModel: 'mimo-v2.5-pro',
      budget: { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
      needsToolCall: false,
      isMultimodal: false,
      allowedTools: [],
      prompt: { kind: 'inline', text: 'hello' },
    };
    const result = defineOwnedTaskSpecs('practice', { TestTask: spec });
    expect(result.TestTask).toBe(spec);
  });

  it('throws when key does not match spec.kind', () => {
    expect(() =>
      defineOwnedTaskSpecs('practice', {
        WrongKey: {
          kind: 'RightKind',
          description: 'test',
          defaultProvider: 'xiaomi',
          defaultModel: 'mimo-v2.5',
          budget: { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
          needsToolCall: false,
          isMultimodal: false,
          allowedTools: [],
          prompt: { kind: 'inline', text: 'x' },
        },
      }),
    ).toThrow('key "WrongKey" does not match spec.kind "RightKind"');
  });

  it('throws when inline prompt text is empty', () => {
    expect(() =>
      defineOwnedTaskSpecs('practice', {
        EmptyTask: {
          kind: 'EmptyTask',
          description: 'test',
          defaultProvider: 'xiaomi',
          defaultModel: 'mimo-v2.5',
          budget: { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
          needsToolCall: false,
          isMultimodal: false,
          allowedTools: [],
          prompt: { kind: 'inline', text: '   ' },
        },
      }),
    ).toThrow('empty inline prompt text');
  });

  it('throws when defaultProvider is missing', () => {
    expect(() =>
      defineOwnedTaskSpecs('practice', {
        NoProvider: {
          kind: 'NoProvider',
          description: 'test',
          defaultProvider: '' as unknown as 'xiaomi',
          defaultModel: 'mimo-v2.5',
          budget: { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
          needsToolCall: false,
          isMultimodal: false,
          allowedTools: [],
          prompt: { kind: 'inline', text: 'x' },
        },
      }),
    ).toThrow('missing defaultProvider');
  });
});

describe('composeTaskCatalog', () => {
  const makeSpec = (kind: string, owner: TaskOwner): { specs: Record<string, TaskDefinition> } => ({
    specs: {
      [kind]: {
        kind,
        description: `${kind} test`,
        defaultProvider: 'xiaomi',
        defaultModel: 'mimo-v2.5',
        budget: { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
        needsToolCall: false,
        isMultimodal: false,
        allowedTools: [],
        prompt: { kind: 'inline', text: `prompt for ${kind}` },
      },
    },
  });

  it('merges disjoint owner maps correctly', () => {
    const catalog = composeTaskCatalog([
      { owner: 'practice', ...makeSpec('TaskA', 'practice') },
      { owner: 'notes', ...makeSpec('TaskB', 'notes') },
    ]);
    expect(Object.keys(catalog)).toHaveLength(2);
    expect(catalog.TaskA?.kind).toBe('TaskA');
    expect(catalog.TaskB?.kind).toBe('TaskB');
  });

  it('throws on duplicate kind across owners', () => {
    expect(() =>
      composeTaskCatalog([
        { owner: 'practice', ...makeSpec('TaskDup', 'practice') },
        { owner: 'notes', ...makeSpec('TaskDup', 'notes') },
      ]),
    ).toThrow('duplicate kind "TaskDup"');
  });

  it('returns a frozen catalog', () => {
    const catalog = composeTaskCatalog([
      { owner: 'practice', ...makeSpec('ImmutableTask', 'practice') },
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
  });
});
