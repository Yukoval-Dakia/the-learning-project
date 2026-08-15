import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';
import { attributionRerankTaskSpec, attributionTaskSpec } from './attribution';
import { itemPriorTaskSpec } from './item-prior';
import { questionAuthorTaskSpec } from './question-author';
import { quizGenTaskSpec } from './quiz-generation';
import { selectionOrchestratorTaskSpec } from './selection-orchestrator';
import { solutionGenerateTaskSpec, solutionGenerateVisionTaskSpec } from './solution-generation';
import { sourcingTaskSpec } from './sourcing';
import { variantGenTaskSpec } from './variant-gen';

export const practiceTaskSpecs = defineOwnedTaskSpecs('practice', {
  AttributionTask: attributionTaskSpec,
  AttributionRerankTask: attributionRerankTaskSpec,
  VariantGenTask: variantGenTaskSpec,
  SemanticJudgeTask: defineTransitionalTask(legacyTaskDefinitions.SemanticJudgeTask),
  UnitDimensionFallback: defineTransitionalTask(legacyTaskDefinitions.UnitDimensionFallback),
  StepsJudgeTask: defineTransitionalTask(legacyTaskDefinitions.StepsJudgeTask),
  MultimodalDirectJudgeTask: defineTransitionalTask(
    legacyTaskDefinitions.MultimodalDirectJudgeTask,
  ),
  SourceGroundingVerifyTask: defineTransitionalTask(
    legacyTaskDefinitions.SourceGroundingVerifyTask,
  ),
  VariantVerifyTask: defineTransitionalTask(legacyTaskDefinitions.VariantVerifyTask),
  SolutionGenerateTask: solutionGenerateTaskSpec,
  SolutionGenerateVisionTask: solutionGenerateVisionTaskSpec,
  QuizGenTask: quizGenTaskSpec,
  QuizVerifyTask: defineTransitionalTask(legacyTaskDefinitions.QuizVerifyTask),
  TeachingQualityTask: defineTransitionalTask(legacyTaskDefinitions.TeachingQualityTask),
  QuestionAuthorTask: questionAuthorTaskSpec,
  ItemPriorTask: itemPriorTaskSpec,
  SelectionOrchestratorTask: selectionOrchestratorTaskSpec,
  SourcingTask: sourcingTaskSpec,
});
