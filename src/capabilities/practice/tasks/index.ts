import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { attributionRerankTaskSpec, attributionTaskSpec } from './attribution';
import { causeCategoryProposeTaskSpec } from './cause-category-propose';
import { itemPriorLlasaTaskSpec, itemPriorTaskSpec } from './item-prior';
import {
  multimodalDirectJudgeTaskSpec,
  semanticJudgeTaskSpec,
  stepsJudgeTaskSpec,
  unitDimensionFallbackTaskSpec,
} from './judges';
import { questionAuthorTaskSpec } from './question-author';
import { quizGenTaskSpec } from './quiz-generation';
import { quizPlanTaskSpec } from './quiz-planning';
import { quizVerifyTaskSpec } from './quiz-verify';
import { selectionOrchestratorTaskSpec } from './selection-orchestrator';
import { sessionSummaryTaskSpec } from './session-summary';
import { solutionGenerateTaskSpec, solutionGenerateVisionTaskSpec } from './solution-generation';
import { sourceGroundingVerifyTaskSpec } from './source-grounding-verify';
import { sourcingTaskSpec } from './sourcing';
import { supplyPlanTaskSpec } from './supply-planning';
import { teachingQualityTaskSpec } from './teaching-quality';
import { variantGenTaskSpec } from './variant-gen';
import { variantVerifyTaskSpec } from './variant-verify';

export const practiceTaskSpecs = defineOwnedTaskSpecs('practice', {
  AttributionTask: attributionTaskSpec,
  AttributionRerankTask: attributionRerankTaskSpec,
  CauseCategoryProposeTask: causeCategoryProposeTaskSpec,
  VariantGenTask: variantGenTaskSpec,
  SemanticJudgeTask: semanticJudgeTaskSpec,
  UnitDimensionFallback: unitDimensionFallbackTaskSpec,
  StepsJudgeTask: stepsJudgeTaskSpec,
  MultimodalDirectJudgeTask: multimodalDirectJudgeTaskSpec,
  SourceGroundingVerifyTask: sourceGroundingVerifyTaskSpec,
  VariantVerifyTask: variantVerifyTaskSpec,
  SolutionGenerateTask: solutionGenerateTaskSpec,
  SolutionGenerateVisionTask: solutionGenerateVisionTaskSpec,
  QuizGenTask: quizGenTaskSpec,
  QuizPlanTask: quizPlanTaskSpec,
  QuizVerifyTask: quizVerifyTaskSpec,
  TeachingQualityTask: teachingQualityTaskSpec,
  QuestionAuthorTask: questionAuthorTaskSpec,
  ItemPriorTask: itemPriorTaskSpec,
  ItemPriorLlasaTask: itemPriorLlasaTaskSpec,
  SelectionOrchestratorTask: selectionOrchestratorTaskSpec,
  SessionSummaryTask: sessionSummaryTaskSpec,
  SourcingTask: sourcingTaskSpec,
  SupplyPlanTask: supplyPlanTaskSpec,
});
