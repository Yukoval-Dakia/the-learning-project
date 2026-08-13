import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';
import { attributionRerankTaskSpec, attributionTaskSpec } from './attribution';
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
  TeachingTurnTask: defineTransitionalTask(legacyTaskDefinitions.TeachingTurnTask),
  SolutionGenerateTask: defineTransitionalTask(legacyTaskDefinitions.SolutionGenerateTask),
  SolutionGenerateVisionTask: defineTransitionalTask(
    legacyTaskDefinitions.SolutionGenerateVisionTask,
  ),
  QuizGenTask: defineTransitionalTask(legacyTaskDefinitions.QuizGenTask),
  QuizVerifyTask: defineTransitionalTask(legacyTaskDefinitions.QuizVerifyTask),
  TeachingQualityTask: defineTransitionalTask(legacyTaskDefinitions.TeachingQualityTask),
  QuestionAuthorTask: defineTransitionalTask(legacyTaskDefinitions.QuestionAuthorTask),
  ItemPriorTask: defineTransitionalTask(legacyTaskDefinitions.ItemPriorTask),
  SelectionOrchestratorTask: defineTransitionalTask(
    legacyTaskDefinitions.SelectionOrchestratorTask,
  ),
  SourcingTask: defineTransitionalTask(legacyTaskDefinitions.SourcingTask),
});
