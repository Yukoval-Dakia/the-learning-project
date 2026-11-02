import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import {
  attributionRerankTaskSpec,
  attributionTaskSpec,
  causeCategoryProposeTaskSpec,
  variantGenTaskSpec,
} from '../failure-learning/public';
import {
  bankConditionVerifyTaskSpec,
  bankRequirementInterpretTaskSpec,
} from '../question-bank/tasks/bank-search-semantic';
import { itemPriorLlasaTaskSpec, itemPriorTaskSpec } from '../question-bank/tasks/item-prior';
import { questionAdmissionSolveTaskSpec } from '../question-bank/tasks/question-admission-solve';
import { quizVerifyTaskSpec } from '../question-bank/tasks/quiz-verify';
import { variantVerifyTaskSpec } from '../question-bank/tasks/variant-verify';
import { selectionOrchestratorTaskSpec } from '../scheduling/tasks/selection-orchestrator';
import { sessionSummaryTaskSpec } from '../session/tasks/session-summary';
import { assessmentRubricTaskSpec } from './assessment-rubric';
import { assessmentRuleTaskSpec } from './assessment-rule';
import { jevScoringDecisionTaskSpec } from './jev-typed';
import {
  multimodalDirectJudgeTaskSpec,
  semanticJudgeTaskSpec,
  stepsJudgeTaskSpec,
  unitDimensionFallbackTaskSpec,
} from './judges';
import { questionAuthorTaskSpec } from './question-author';
import { quizGenTaskSpec } from './quiz-generation';
import { quizPlanTaskSpec } from './quiz-planning';
import { solutionGenerateTaskSpec, solutionGenerateVisionTaskSpec } from './solution-generation';
import { sourceGroundingVerifyTaskSpec } from './source-grounding-verify';
import { sourcingTaskSpec } from './sourcing';
import { supplyPlanTaskSpec } from './supply-planning';
import { teachingQualityTaskSpec } from './teaching-quality';

export const practiceTaskSpecs = defineOwnedTaskSpecs('practice', {
  BankRequirementInterpretTask: bankRequirementInterpretTaskSpec,
  BankConditionVerifyTask: bankConditionVerifyTaskSpec,
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
  JevScoringDecisionTask: jevScoringDecisionTaskSpec,
  AssessmentRuleJudgeTask: assessmentRuleTaskSpec,
  AssessmentRubricJudgeTask: assessmentRubricTaskSpec,
  QuestionAdmissionSolveTask: questionAdmissionSolveTaskSpec,
});
