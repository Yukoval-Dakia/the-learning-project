// allow: SIZE_OK — central 51-task catalog contract suite.
import { readFileSync } from 'node:fs';
import { coachTaskSpec } from '@/capabilities/agency/tasks/coach';
import {
  conjectureGroupingTaskSpec,
  mindModelInductionTaskSpec,
} from '@/capabilities/agency/tasks/conjecture-induction';
import {
  conjectureProbeAuthorTaskSpec,
  conjectureProbeReviewTaskSpec,
} from '@/capabilities/agency/tasks/conjecture-probe';
import { dreamingTaskSpec } from '@/capabilities/agency/tasks/dreaming';
import { goalScopeTaskSpec } from '@/capabilities/agency/tasks/goal-scope';
import { agencyTaskSpecs } from '@/capabilities/agency/tasks/index';
import {
  interventionPackageAuthorTaskSpec,
  interventionPackageReviewTaskSpec,
  interventionRecommendationTaskSpec,
} from '@/capabilities/agency/tasks/intervention';
import { learningIntentOutlineTaskSpec } from '@/capabilities/agency/tasks/learning-intent';
import { memoryBriefTaskSpec } from '@/capabilities/agency/tasks/memory-brief';
import { researchMeetingDirectorTaskSpec } from '@/capabilities/agency/tasks/research-meeting-director';
import { copilotTaskSpec } from '@/capabilities/copilot/tasks/agent';
import { copilotDispatchTaskSpec } from '@/capabilities/copilot/tasks/dispatch';
import {
  copilotEvidenceReviewTaskSpec,
  copilotEvidenceVerificationTaskSpec,
} from '@/capabilities/copilot/tasks/evidence';
import { copilotTaskSpecs } from '@/capabilities/copilot/tasks/index';
import { teachingTurnTaskSpec } from '@/capabilities/copilot/tasks/teaching-turn';
import { blockAssemblyTaskSpec } from '@/capabilities/ingestion/tasks/block-assembly';
import { coldStartPlacementBridgeTaskSpec } from '@/capabilities/ingestion/tasks/cold-start-bridge';
import { ingestionTaskSpecs } from '@/capabilities/ingestion/tasks/index';
import { mistakeEnrollTaskSpec } from '@/capabilities/ingestion/tasks/mistake-enroll';
import { profileCriticTaskSpec } from '@/capabilities/ingestion/tasks/profile-critic';
import { structureTaskSpec } from '@/capabilities/ingestion/tasks/structure';
import { taggingTaskSpec } from '@/capabilities/ingestion/tasks/tagging';
import {
  visionExtractTaskHeavySpec,
  visionExtractTaskSpec,
} from '@/capabilities/ingestion/tasks/vision';
import {
  frontierPrerequisiteTaskSpec,
  knowledgeEdgeProposeTaskSpec,
  knowledgeReviewTaskSpec,
  knowledgeTaskSpecs,
} from '@/capabilities/knowledge/tasks/index';
import { notesTaskSpecs } from '@/capabilities/notes/tasks/index';
import { noteRefineTaskSpec } from '@/capabilities/notes/tasks/note-refine';
import { noteGenerateTaskSpec, noteVerifyTaskSpec } from '@/capabilities/notes/tasks/note-tasks';
import {
  attributionRerankTaskSpec,
  attributionTaskSpec,
} from '@/capabilities/practice/tasks/attribution';
import { practiceTaskSpecs } from '@/capabilities/practice/tasks/index';
import { itemPriorTaskSpec } from '@/capabilities/practice/tasks/item-prior';
import { questionAuthorTaskSpec } from '@/capabilities/practice/tasks/question-author';
import { quizGenTaskSpec } from '@/capabilities/practice/tasks/quiz-generation';
import { quizVerifyTaskSpec } from '@/capabilities/practice/tasks/quiz-verify';
import { selectionOrchestratorTaskSpec } from '@/capabilities/practice/tasks/selection-orchestrator';
import {
  solutionGenerateTaskSpec,
  solutionGenerateVisionTaskSpec,
} from '@/capabilities/practice/tasks/solution-generation';
import { sourceGroundingVerifyTaskSpec } from '@/capabilities/practice/tasks/source-grounding-verify';
import { sourcingTaskSpec } from '@/capabilities/practice/tasks/sourcing';
import { teachingQualityTaskSpec } from '@/capabilities/practice/tasks/teaching-quality';
import { variantGenTaskSpec } from '@/capabilities/practice/tasks/variant-gen';
import { variantVerifyTaskSpec } from '@/capabilities/practice/tasks/variant-verify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { legacyTaskDefinitions } from './legacy-task-definitions';
import type { TaskKind } from './registry';
import {
  type TaskOwner,
  composeTaskCatalog,
  defineOwnedTaskSpecs,
  defineTransitionalTask,
  taskCatalog,
} from './task-catalog';
import type { TaskDefinition, TaskSpec } from './task-spec';

const EXPECTED_KINDS = [
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

type ExpectedTaskKind = (typeof EXPECTED_KINDS)[number];
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type Assert<Condition extends true> = Condition;
type TaskKindIsClosed = Assert<Equal<TaskKind, ExpectedTaskKind>>;
const TASK_KIND_IS_CLOSED: TaskKindIsClosed = true;

const OWNER_MAPS = {
  practice: practiceTaskSpecs,
  notes: notesTaskSpecs,
  ingestion: ingestionTaskSpecs,
  knowledge: knowledgeTaskSpecs,
  agency: agencyTaskSpecs,
  copilot: copilotTaskSpecs,
} as const;

const EXPECTED_OWNER_COUNTS = {
  practice: 18,
  notes: 3,
  ingestion: 8,
  knowledge: 4,
  agency: 13,
  copilot: 5,
} as const;

const OWNED_SPECS: ReadonlySet<object> = new Set([
  attributionTaskSpec,
  attributionRerankTaskSpec,
  variantGenTaskSpec,
  solutionGenerateTaskSpec,
  solutionGenerateVisionTaskSpec,
  quizGenTaskSpec,
  questionAuthorTaskSpec,
  itemPriorTaskSpec,
  selectionOrchestratorTaskSpec,
  sourcingTaskSpec,
  copilotDispatchTaskSpec,
  copilotEvidenceReviewTaskSpec,
  copilotEvidenceVerificationTaskSpec,
  copilotTaskSpec,
  teachingTurnTaskSpec,
  noteGenerateTaskSpec,
  noteRefineTaskSpec,
  noteVerifyTaskSpec,
  quizVerifyTaskSpec,
  sourceGroundingVerifyTaskSpec,
  variantVerifyTaskSpec,
  teachingQualityTaskSpec,
  visionExtractTaskSpec,
  visionExtractTaskHeavySpec,
  structureTaskSpec,
  mistakeEnrollTaskSpec,
  taggingTaskSpec,
  coldStartPlacementBridgeTaskSpec,
  blockAssemblyTaskSpec,
  profileCriticTaskSpec,
  knowledgeEdgeProposeTaskSpec,
  frontierPrerequisiteTaskSpec,
  knowledgeReviewTaskSpec,
  learningIntentOutlineTaskSpec,
  goalScopeTaskSpec,
  mindModelInductionTaskSpec,
  conjectureGroupingTaskSpec,
  conjectureProbeAuthorTaskSpec,
  conjectureProbeReviewTaskSpec,
  interventionRecommendationTaskSpec,
  interventionPackageAuthorTaskSpec,
  interventionPackageReviewTaskSpec,
  researchMeetingDirectorTaskSpec,
  dreamingTaskSpec,
  coachTaskSpec,
  memoryBriefTaskSpec,
]);

const makeDefinition = <const Kind extends string>(kind: Kind) =>
  ({
    kind,
    description: `${kind} test definition`,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'inline', text: `prompt for ${kind}` },
  }) satisfies TaskDefinition;

const makeOwnedSpec = <const Kind extends string>(kind: Kind) =>
  ({
    ownership: 'owned',
    definition: makeDefinition(kind),
    outputSchema: z.string(),
    parseText: (text: string) => text,
  }) satisfies TaskSpec<unknown, string>;

function invokeEntryValidation(entry: object): void {
  const definition = Reflect.get(entry, 'definition');
  const kind =
    typeof definition === 'object' &&
    definition !== null &&
    typeof Reflect.get(definition, 'kind') === 'string'
      ? Reflect.get(definition, 'kind')
      : 'TestTask';
  Reflect.apply(defineOwnedTaskSpecs, undefined, ['practice', { [kind]: entry }]);
}

describe('taskCatalog', () => {
  it('has the exact closed 51-kind compile-time and runtime census', () => {
    expect(TASK_KIND_IS_CLOSED).toBe(true);
    expect(Object.keys(taskCatalog).sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it('eagerly composes the exact six owner allocations', () => {
    for (const owner of Object.keys(OWNER_MAPS) as TaskOwner[]) {
      expect(Object.keys(OWNER_MAPS[owner]), owner).toHaveLength(EXPECTED_OWNER_COUNTS[owner]);
    }
    expect(ingestionTaskSpecs.ProfileCriticTask.definition).toBe(taskCatalog.ProfileCriticTask);
    expect(Object.hasOwn(copilotTaskSpecs, 'ProfileCriticTask')).toBe(false);
  });

  it('owns all eight ingestion TaskSpecs without central quarry definitions', () => {
    const expected = {
      VisionExtractTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        maxIterations: 1,
        timeout: 60_000,
        multimodal: true,
        invocation: 'manual_rescue_only',
      },
      VisionExtractTaskHeavy: {
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        maxIterations: 1,
        timeout: 90_000,
        multimodal: true,
        invocation: 'manual_rescue_only',
      },
      StructureTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        maxIterations: 1,
        timeout: 120_000,
        multimodal: true,
        invocation: undefined,
      },
      MistakeEnrollTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxIterations: 1,
        timeout: 60_000,
        multimodal: false,
        invocation: undefined,
      },
      TaggingTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        maxIterations: 1,
        timeout: 60_000,
        multimodal: false,
        invocation: undefined,
      },
      ColdStartPlacementBridgeTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        maxIterations: 1,
        timeout: 90_000,
        multimodal: false,
        invocation: undefined,
      },
      BlockAssemblyTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        maxIterations: 1,
        timeout: 60_000,
        multimodal: false,
        invocation: undefined,
      },
      ProfileCriticTask: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxIterations: 1,
        timeout: 60_000,
        multimodal: false,
        invocation: undefined,
      },
    } as const;

    for (const [kind, contract] of Object.entries(expected)) {
      const entry = ingestionTaskSpecs[kind as keyof typeof ingestionTaskSpecs];
      expect(entry.ownership, kind).toBe('owned');
      expect(entry.definition, kind).toBe(taskCatalog[kind as keyof typeof taskCatalog]);
      expect(entry.definition.defaultProvider, kind).toBe(contract.provider);
      expect(entry.definition.defaultModel, kind).toBe(contract.model);
      expect(entry.definition.budget.maxIterations, kind).toBe(contract.maxIterations);
      expect(entry.definition.budget.timeout, kind).toBe(contract.timeout);
      expect(entry.definition.needsToolCall, kind).toBe(false);
      expect(entry.definition.isMultimodal, kind).toBe(contract.multimodal);
      expect(entry.definition.allowedTools, kind).toEqual([]);
      expect('invocation' in entry.definition ? entry.definition.invocation : undefined, kind).toBe(
        contract.invocation,
      );
      expect('parseText' in entry && entry.parseText, kind).toBeTypeOf('function');
      expect('outputSchema' in entry && entry.outputSchema.safeParse, kind).toBeTypeOf('function');
    }

    const source = readFileSync(new URL('./legacy-task-definitions.ts', import.meta.url), 'utf8');
    for (const kind of Object.keys(expected)) {
      expect(source, kind).not.toMatch(new RegExp(`^  ${kind}:`, 'm'));
    }
    for (const builder of [
      'buildStructurePrompt',
      'buildMistakeEnrollPrompt',
      'buildTaggingPrompt',
      'buildBlockAssemblyPrompt',
    ]) {
      expect(source, builder).not.toContain(`function ${builder}`);
    }
  });

  it('owns the three Knowledge TaskSpecs without central quarry definitions', () => {
    const expected = {
      KnowledgeEdgeProposeTask: {
        spec: knowledgeEdgeProposeTaskSpec,
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxIterations: 2,
        timeout: 60_000,
        needsToolCall: false,
        allowedTools: [],
      },
      FrontierPrerequisiteTask: {
        spec: frontierPrerequisiteTaskSpec,
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxIterations: 2,
        timeout: 60_000,
        needsToolCall: false,
        allowedTools: [],
      },
      KnowledgeReviewTask: {
        spec: knowledgeReviewTaskSpec,
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxIterations: 12,
        timeout: 120_000,
        needsToolCall: true,
        allowedTools: ['mcp__loom__write_proposal'],
      },
    } as const;

    for (const [kind, contract] of Object.entries(expected)) {
      const entry = knowledgeTaskSpecs[kind as keyof typeof expected];
      expect(entry.ownership, kind).toBe('owned');
      expect(entry, kind).toBe(contract.spec);
      expect(entry.definition, kind).toBe(taskCatalog[kind as keyof typeof taskCatalog]);
      expect(entry.definition.defaultProvider, kind).toBe(contract.provider);
      expect(entry.definition.defaultModel, kind).toBe(contract.model);
      expect(entry.definition.budget.maxIterations, kind).toBe(contract.maxIterations);
      expect(entry.definition.budget.timeout, kind).toBe(contract.timeout);
      expect(entry.definition.needsToolCall, kind).toBe(contract.needsToolCall);
      expect(entry.definition.isMultimodal, kind).toBe(false);
      expect(entry.definition.allowedTools, kind).toEqual(contract.allowedTools);
      expect('parseText' in entry && entry.parseText, kind).toBeTypeOf('function');
      expect('outputSchema' in entry && entry.outputSchema.safeParse, kind).toBeTypeOf('function');
    }

    const source = readFileSync(new URL('./legacy-task-definitions.ts', import.meta.url), 'utf8');
    for (const kind of Object.keys(expected)) {
      expect(source, kind).not.toMatch(new RegExp(`^  ${kind}:`, 'm'));
    }
    for (const builder of [
      'buildKnowledgeEdgeProposePrompt',
      'buildFrontierPrerequisitePrompt',
      'buildKnowledgeReviewPrompt',
    ]) {
      expect(source, builder).not.toContain(`function ${builder}`);
    }
  });

  it('owns the thirteen agency TaskSpecs without quarry definitions', () => {
    expect(Object.keys(agencyTaskSpecs).sort()).toEqual(
      [
        'LearningIntentOutlineTask',
        'GoalScopeTask',
        'MindModelInductionTask',
        'ConjectureGroupingTask',
        'ConjectureProbeAuthorTask',
        'ConjectureProbeReviewTask',
        'InterventionRecommendationTask',
        'InterventionPackageAuthorTask',
        'InterventionPackageReviewTask',
        'ResearchMeetingDirectorTask',
        'DreamingTask',
        'CoachTask',
        'MemoryBriefTask',
      ].sort(),
    );
    for (const [kind, entry] of Object.entries(agencyTaskSpecs)) {
      expect(entry.ownership, kind).toBe('owned');
      expect(entry.definition, kind).toBe(taskCatalog[kind as keyof typeof taskCatalog]);
      expect('parseText' in entry, kind).toBe(true);
      expect('outputSchema' in entry, kind).toBe(true);
    }
    const specIdentities = {
      LearningIntentOutlineTask: learningIntentOutlineTaskSpec,
      GoalScopeTask: goalScopeTaskSpec,
      MindModelInductionTask: mindModelInductionTaskSpec,
      ConjectureGroupingTask: conjectureGroupingTaskSpec,
      ConjectureProbeAuthorTask: conjectureProbeAuthorTaskSpec,
      ConjectureProbeReviewTask: conjectureProbeReviewTaskSpec,
      InterventionRecommendationTask: interventionRecommendationTaskSpec,
      InterventionPackageAuthorTask: interventionPackageAuthorTaskSpec,
      InterventionPackageReviewTask: interventionPackageReviewTaskSpec,
      ResearchMeetingDirectorTask: researchMeetingDirectorTaskSpec,
      DreamingTask: dreamingTaskSpec,
      CoachTask: coachTaskSpec,
      MemoryBriefTask: memoryBriefTaskSpec,
    } as const;
    for (const [kind, spec] of Object.entries(specIdentities)) {
      expect(agencyTaskSpecs[kind as keyof typeof agencyTaskSpecs], kind).toBe(spec);
    }
    for (const kind of [
      'LearningIntentOutlineTask',
      'GoalScopeTask',
      'MindModelInductionTask',
      'ConjectureGroupingTask',
      'ConjectureProbeAuthorTask',
      'ConjectureProbeReviewTask',
    ] as const) {
      expect(Object.hasOwn(knowledgeTaskSpecs, kind), kind).toBe(false);
    }

    const source = readFileSync(new URL('./legacy-task-definitions.ts', import.meta.url), 'utf8');
    for (const kind of Object.keys(agencyTaskSpecs)) {
      expect(source, kind).not.toMatch(new RegExp(`^  ${kind}:`, 'm'));
    }
    for (const builder of [
      'buildLearningIntentOutlinePrompt',
      'buildGoalScopePrompt',
      'buildMindModelInductionPrompt',
      'buildConjectureProbeAuthorPrompt',
      'buildConjectureProbeReviewPrompt',
      'buildInterventionPackageAuthorPrompt',
      'buildInterventionPackageReviewPrompt',
    ]) {
      expect(source, builder).not.toContain(`function ${builder}`);
    }
  });

  it('owns the seven Practice sourcing and generation TaskSpecs without quarry definitions', () => {
    const kinds = [
      'SolutionGenerateTask',
      'SolutionGenerateVisionTask',
      'QuizGenTask',
      'QuestionAuthorTask',
      'ItemPriorTask',
      'SelectionOrchestratorTask',
      'SourcingTask',
    ] as const;

    for (const kind of kinds) {
      const entry = practiceTaskSpecs[kind];
      expect(entry.ownership, kind).toBe('owned');
      if (entry.ownership !== 'owned') continue;
      expect(entry.definition, kind).toBe(taskCatalog[kind]);
      expect(entry.parseText, kind).toBeTypeOf('function');
      expect(entry.outputSchema.safeParse, kind).toBeTypeOf('function');
    }

    const source = readFileSync(new URL('./legacy-task-definitions.ts', import.meta.url), 'utf8');
    for (const kind of kinds) {
      expect(source, kind).not.toMatch(new RegExp(`^  ${kind}:`, 'm'));
    }
    for (const builder of [
      'buildSolutionGeneratePrompt',
      'buildSolutionGenerateVisionPrompt',
      'buildQuizGenPrompt',
      'buildQuestionAuthorPrompt',
      'buildItemPriorPrompt',
      'buildSelectionOrchestratorPrompt',
      'buildSourcingPrompt',
    ]) {
      expect(source, builder).not.toContain(`function ${builder}`);
    }
  });

  it('owns the five Copilot TaskSpecs without central quarry definitions', () => {
    const expected = {
      CopilotDispatchTask: copilotDispatchTaskSpec,
      CopilotEvidenceReviewTask: copilotEvidenceReviewTaskSpec,
      CopilotEvidenceVerificationTask: copilotEvidenceVerificationTaskSpec,
      CopilotTask: copilotTaskSpec,
      TeachingTurnTask: teachingTurnTaskSpec,
    } as const;

    for (const [kind, spec] of Object.entries(expected)) {
      const entry = copilotTaskSpecs[kind as keyof typeof copilotTaskSpecs];
      expect(entry.ownership, kind).toBe('owned');
      expect(entry, kind).toBe(spec);
      expect(entry.definition, kind).toBe(taskCatalog[kind as keyof typeof taskCatalog]);
      expect(entry.parseText, kind).toBeTypeOf('function');
      expect(entry.outputSchema.safeParse, kind).toBeTypeOf('function');
    }

    const source = readFileSync(new URL('./legacy-task-definitions.ts', import.meta.url), 'utf8');
    for (const kind of Object.keys(expected)) {
      expect(source, kind).not.toMatch(new RegExp(`^  ${kind}:`, 'm'));
    }
    for (const builder of ['buildTeachingTurnPrompt']) {
      expect(source, builder).not.toContain(`function ${builder}`);
    }
    expect(source).not.toContain('CopilotDispatchDecisionSchema');
    expect(source).not.toContain('CopilotEvidenceReviewOutputSchema');
    expect(source).not.toContain('CopilotEvidenceVerificationOutputSchema');
    expect(source).not.toContain('CopilotEvidenceSourceRefSchema');
  });

  it('retains 46 full owned TaskSpecs and 5 identity-backed transitional entries', () => {
    // YUK-868 — QuizVerifyTask / SourceGroundingVerifyTask / VariantVerifyTask /
    // TeachingQualityTask moved from transitional to practice-owned specs.
    expect(Object.keys(legacyTaskDefinitions)).toHaveLength(5);
    for (const specs of Object.values(OWNER_MAPS)) {
      for (const [kind, entry] of Object.entries(specs)) {
        if (entry.ownership === 'owned') {
          expect(OWNED_SPECS.has(entry), kind).toBe(true);
          expect(entry.parseText, kind).toBeTypeOf('function');
          expect(entry.outputSchema.safeParse, kind).toBeTypeOf('function');
          continue;
        }
        expect(entry.definition, kind).toBe(
          legacyTaskDefinitions[kind as keyof typeof legacyTaskDefinitions],
        );
        expect(Object.hasOwn(entry, 'parseText'), kind).toBe(false);
        expect(Object.hasOwn(entry, 'outputSchema'), kind).toBe(false);
      }
    }
    expect(practiceTaskSpecs.AttributionTask).toBe(attributionTaskSpec);
    expect(practiceTaskSpecs.AttributionRerankTask).toBe(attributionRerankTaskSpec);
    expect(practiceTaskSpecs.VariantGenTask).toBe(variantGenTaskSpec);
    expect(notesTaskSpecs.NoteGenerateTask).toBe(noteGenerateTaskSpec);
    expect(notesTaskSpecs.NoteRefineTask).toBe(noteRefineTaskSpec);
    expect(notesTaskSpecs.NoteVerifyTask).toBe(noteVerifyTaskSpec);
    expect(practiceTaskSpecs.QuizVerifyTask).toBe(quizVerifyTaskSpec);
    expect(practiceTaskSpecs.SourceGroundingVerifyTask).toBe(sourceGroundingVerifyTaskSpec);
    expect(practiceTaskSpecs.VariantVerifyTask).toBe(variantVerifyTaskSpec);
    expect(practiceTaskSpecs.TeachingQualityTask).toBe(teachingQualityTaskSpec);
    expect(taskCatalog.AttributionTask).toBe(attributionTaskSpec.definition);
    expect(taskCatalog.NoteGenerateTask).toBe(noteGenerateTaskSpec.definition);
    expect(taskCatalog.NoteRefineTask).toBe(noteRefineTaskSpec.definition);
  });

  it('keeps semantic definitions out of all six owner index files', () => {
    const ownerIndexUrls = [
      new URL('../capabilities/practice/tasks/index.ts', import.meta.url),
      new URL('../capabilities/notes/tasks/index.ts', import.meta.url),
      new URL('../capabilities/ingestion/tasks/index.ts', import.meta.url),
      new URL('../capabilities/knowledge/tasks/index.ts', import.meta.url),
      new URL('../capabilities/agency/tasks/index.ts', import.meta.url),
      new URL('../capabilities/copilot/tasks/index.ts', import.meta.url),
    ];
    for (const url of ownerIndexUrls) {
      const source = readFileSync(url, 'utf8');
      expect(source, url.pathname).toContain('defineOwnedTaskSpecs(');
      expect(source, url.pathname).not.toMatch(/\bfunction\s+build/);
      expect(source, url.pathname).not.toMatch(
        /\b(description|defaultProvider|defaultModel|budget|needsToolCall|allowedTools|prompt)\s*:/,
      );
    }
    const practiceSource = readFileSync(ownerIndexUrls[0], 'utf8');
    const notesSource = readFileSync(ownerIndexUrls[1], 'utf8');
    expect(practiceSource).toContain("from './attribution'");
    expect(practiceSource).toContain("from './variant-gen'");
    expect(notesSource).toContain("from './note-tasks'");
  });

  it('freezes every owner map and each definition metadata descriptor', () => {
    expect(Object.isFrozen(taskCatalog)).toBe(true);
    for (const specs of Object.values(OWNER_MAPS)) {
      expect(Object.isFrozen(specs)).toBe(true);
      for (const entry of Object.values(specs)) {
        expect(Object.isFrozen(entry), entry.definition.kind).toBe(true);
        const definition = entry.definition;
        expect(Object.isFrozen(definition), definition.kind).toBe(true);
        expect(Object.isFrozen(definition.budget), `${definition.kind}.budget`).toBe(true);
        expect(Object.isFrozen(definition.allowedTools), `${definition.kind}.allowedTools`).toBe(
          true,
        );
        expect(Object.isFrozen(definition.prompt), `${definition.kind}.prompt`).toBe(true);
      }
    }
  });

  it('throws on actual mutation and redefinition attempts without changing values', () => {
    const originalCatalogEntry = taskCatalog.AttributionTask;
    const originalOwnerEntry = practiceTaskSpecs.AttributionTask;
    const originalDescription = originalCatalogEntry.description;
    const originalTimeout = originalCatalogEntry.budget.timeout;
    const originalTools = [...originalCatalogEntry.allowedTools];
    const originalPromptKind = originalCatalogEntry.prompt.kind;

    expect(() =>
      Object.assign(taskCatalog, { AttributionTask: taskCatalog.VariantGenTask }),
    ).toThrow();
    expect(() =>
      Object.assign(practiceTaskSpecs, { AttributionTask: practiceTaskSpecs.VariantGenTask }),
    ).toThrow();
    expect(() => Object.assign(originalCatalogEntry, { description: 'mutated' })).toThrow();
    expect(() => Object.assign(originalCatalogEntry.budget, { timeout: 1 })).toThrow();
    expect(() =>
      Array.prototype.push.call(originalCatalogEntry.allowedTools, 'forbidden'),
    ).toThrow();
    expect(() => Object.assign(originalCatalogEntry.prompt, { kind: 'mutated' })).toThrow();
    expect(() =>
      Object.defineProperty(practiceTaskSpecs, 'AttributionTask', {
        value: practiceTaskSpecs.VariantGenTask,
      }),
    ).toThrow();
    expect(() =>
      Object.defineProperty(originalCatalogEntry.budget, 'timeout', { value: 1 }),
    ).toThrow();
    expect(() =>
      Object.defineProperty(originalCatalogEntry.allowedTools, '0', { value: 'forbidden' }),
    ).toThrow();
    expect(() =>
      Object.defineProperty(originalCatalogEntry.prompt, 'kind', { value: 'mutated' }),
    ).toThrow();
    expect(() =>
      Object.defineProperty(taskCatalog, 'AttributionTask', { value: taskCatalog.VariantGenTask }),
    ).toThrow();
    expect(() =>
      Object.defineProperty(originalCatalogEntry, 'description', { value: 'redefined' }),
    ).toThrow();

    expect(taskCatalog.AttributionTask).toBe(originalCatalogEntry);
    expect(practiceTaskSpecs.AttributionTask).toBe(originalOwnerEntry);
    expect(originalCatalogEntry.description).toBe(originalDescription);
    expect(originalCatalogEntry.budget.timeout).toBe(originalTimeout);
    expect(originalCatalogEntry.allowedTools).toEqual(originalTools);
    expect(originalCatalogEntry.prompt.kind).toBe(originalPromptKind);
  });
});

describe('defineOwnedTaskSpecs', () => {
  it('preserves literal keys and full TaskSpec identity for valid owned input', () => {
    const spec = makeOwnedSpec('LiteralTask');
    const specs = defineOwnedTaskSpecs('practice', { LiteralTask: spec });
    expect(specs.LiteralTask).toBe(spec);
    expect(Object.isFrozen(specs)).toBe(true);
  });

  it('rejects key/kind mismatch', () => {
    expect(() =>
      defineOwnedTaskSpecs('practice', { WrongKey: makeOwnedSpec('RightKind') }),
    ).toThrow('key "WrongKey" does not match spec.kind "RightKind"');
  });

  it.each(['parseText', 'outputSchema'] as const)('rejects an owned entry missing %s', (field) => {
    const spec = makeOwnedSpec('TestTask');
    const malformed = Object.fromEntries(Object.entries(spec).filter(([key]) => key !== field));
    expect(() => invokeEntryValidation(malformed)).toThrow(`owned "TestTask" missing ${field}`);
  });

  it('rejects transitional entries with semantic ownership fields', () => {
    const definition = legacyTaskDefinitions.SessionSummaryTask;
    expect(() =>
      invokeEntryValidation({
        ownership: 'transitional',
        definition,
        parseText: (text: string) => text,
      }),
    ).toThrow('transitional "SessionSummaryTask" must not own parseText or outputSchema');
    expect(() =>
      invokeEntryValidation({ ownership: 'transitional', definition, outputSchema: z.string() }),
    ).toThrow('transitional "SessionSummaryTask" must not own parseText or outputSchema');
  });

  it('rejects transitional entries whose definition is not quarry-identical', () => {
    expect(() =>
      invokeEntryValidation({
        ownership: 'transitional',
        definition: { ...legacyTaskDefinitions.SessionSummaryTask },
      }),
    ).toThrow('must reference legacyTaskDefinitions by identity');
  });

  it.each([
    ['empty description', { ...makeDefinition('TestTask'), description: '  ' }],
    ['empty provider', { ...makeDefinition('TestTask'), defaultProvider: '' }],
    ['unknown provider', { ...makeDefinition('TestTask'), defaultProvider: 'other' }],
    ['empty model', { ...makeDefinition('TestTask'), defaultModel: '  ' }],
    ['non-boolean needsToolCall', { ...makeDefinition('TestTask'), needsToolCall: 'false' }],
    ['non-boolean isMultimodal', { ...makeDefinition('TestTask'), isMultimodal: 0 }],
    ['non-array tools', { ...makeDefinition('TestTask'), allowedTools: 'tool' }],
    ['empty tool name', { ...makeDefinition('TestTask'), needsToolCall: true, allowedTools: [''] }],
    [
      'non-string tool name',
      { ...makeDefinition('TestTask'), needsToolCall: true, allowedTools: [1] },
    ],
    ['invalid invocation', { ...makeDefinition('TestTask'), invocation: 'sometimes' }],
    [
      'tools on a no-tool task',
      { ...makeDefinition('TestTask'), needsToolCall: false, allowedTools: ['tool'] },
    ],
    ['invalid prompt discriminant', { ...makeDefinition('TestTask'), prompt: { kind: 'other' } }],
    [
      'empty inline prompt',
      { ...makeDefinition('TestTask'), prompt: { kind: 'inline', text: '  ' } },
    ],
    [
      'non-string inline prompt',
      { ...makeDefinition('TestTask'), prompt: { kind: 'inline', text: 1 } },
    ],
    [
      'non-function profile builder',
      { ...makeDefinition('TestTask'), prompt: { kind: 'profile', build: 'builder' } },
    ],
    [
      'inline prompt with contradictory builder',
      { ...makeDefinition('TestTask'), prompt: { kind: 'inline', text: 'x', build: () => 'x' } },
    ],
    [
      'profile prompt with contradictory text',
      { ...makeDefinition('TestTask'), prompt: { kind: 'profile', build: () => 'x', text: 'x' } },
    ],
    [
      'invalid structured output schema',
      { ...makeDefinition('TestTask'), structuredOutputSchema: {} },
    ],
  ])('rejects %s', (_label, definition) => {
    expect(() => invokeEntryValidation({ ...makeOwnedSpec('TestTask'), definition })).toThrow();
  });

  it.each([
    ['maxIterations', { maxIterations: 0, maxCost: 0.5, transientRetries: 0, timeout: 60_000 }],
    [
      'fractional maxIterations',
      { maxIterations: 1.5, maxCost: 0.5, transientRetries: 0, timeout: 60_000 },
    ],
    [
      'infinite maxIterations',
      {
        maxIterations: Number.POSITIVE_INFINITY,
        maxCost: 0.5,
        transientRetries: 0,
        timeout: 60_000,
      },
    ],
    ['maxCost', { maxIterations: 1, maxCost: -1, transientRetries: 0, timeout: 60_000 }],
    [
      'infinite maxCost',
      { maxIterations: 1, maxCost: Number.POSITIVE_INFINITY, transientRetries: 0, timeout: 60_000 },
    ],
    ['transientRetries', { maxIterations: 1, maxCost: 0.5, transientRetries: -1, timeout: 60_000 }],
    [
      'fractional transientRetries',
      { maxIterations: 1, maxCost: 0.5, transientRetries: 0.5, timeout: 60_000 },
    ],
    [
      'infinite transientRetries',
      {
        maxIterations: 1,
        maxCost: 0.5,
        transientRetries: Number.POSITIVE_INFINITY,
        timeout: 60_000,
      },
    ],
    ['timeout', { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: 0 }],
    [
      'infinite timeout',
      { maxIterations: 1, maxCost: 0.5, transientRetries: 0, timeout: Number.POSITIVE_INFINITY },
    ],
  ])('rejects an invalid %s budget field', (_field, budget) => {
    expect(() =>
      invokeEntryValidation({
        ...makeOwnedSpec('TestTask'),
        definition: { ...makeDefinition('TestTask'), budget },
      }),
    ).toThrow('invalid budget');
  });

  it('accepts a valid structured output schema', () => {
    const spec = makeOwnedSpec('StructuredTask');
    expect(defineOwnedTaskSpecs('practice', { StructuredTask: spec }).StructuredTask).toBe(spec);
  });

  it('accepts both invocation values and freezes tool metadata', () => {
    for (const invocation of ['auto', 'manual_rescue_only'] as const) {
      const spec = {
        ...makeOwnedSpec(`Invocation-${invocation}`),
        definition: {
          ...makeDefinition(`Invocation-${invocation}`),
          invocation,
          needsToolCall: true,
          allowedTools: ['tool'],
        },
      };
      const specs = defineOwnedTaskSpecs('practice', { [spec.definition.kind]: spec });
      expect(Object.isFrozen(spec.definition.allowedTools)).toBe(true);
      expect(Object.values(specs)[0]).toBe(spec);
    }
  });

  it('creates transitional entries only through quarry identity', () => {
    const entry = defineTransitionalTask(legacyTaskDefinitions.SemanticJudgeTask);
    expect(entry.definition).toBe(legacyTaskDefinitions.SemanticJudgeTask);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('composeTaskCatalog', () => {
  it('preserves literal keys while merging disjoint frozen maps', () => {
    const practice = defineOwnedTaskSpecs('practice', { TaskA: makeOwnedSpec('TaskA') });
    const notes = defineOwnedTaskSpecs('notes', { TaskB: makeOwnedSpec('TaskB') });
    const catalog = composeTaskCatalog([
      { owner: 'practice', specs: practice },
      { owner: 'notes', specs: notes },
    ]);
    expect(catalog.TaskA).toBe(practice.TaskA.definition);
    expect(catalog.TaskA.kind).toBe('TaskA');
    expect(catalog.TaskB.kind).toBe('TaskB');
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it('rejects duplicate owners even when their kinds differ', () => {
    expect(() =>
      composeTaskCatalog([
        { owner: 'practice', specs: { TaskA: makeOwnedSpec('TaskA') } },
        { owner: 'practice', specs: { TaskB: makeOwnedSpec('TaskB') } },
      ]),
    ).toThrow('duplicate owner "practice"');
  });

  it('rejects duplicate kinds across owners', () => {
    expect(() =>
      composeTaskCatalog([
        { owner: 'practice', specs: { TaskDup: makeOwnedSpec('TaskDup') } },
        { owner: 'notes', specs: { TaskDup: makeOwnedSpec('TaskDup') } },
      ]),
    ).toThrow('duplicate kind "TaskDup"');
  });

  it('rejects key/kind mismatch even for a directly supplied owner map', () => {
    expect(() =>
      composeTaskCatalog([{ owner: 'practice', specs: { WrongKey: makeOwnedSpec('RightKind') } }]),
    ).toThrow('key "WrongKey" does not match spec.kind "RightKind"');
  });

  it.each([50, 52])('rejects an expected 51-kind catalog with %i entries', (count) => {
    const entries = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const spec = makeOwnedSpec(`Task${index}`);
        return [spec.definition.kind, spec];
      }),
    );
    expect(() => composeTaskCatalog([{ owner: 'practice', specs: entries }], 51)).toThrow(
      `expected 51 definitions, received ${count}`,
    );
  });
});
