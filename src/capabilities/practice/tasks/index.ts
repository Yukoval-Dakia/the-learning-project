import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import {
  attributionRerankTaskSpec,
  attributionTaskSpec,
  causeCategoryProposeTaskSpec,
  variantGenTaskSpec,
} from '../failure-learning/public';
import {
  attemptInsightTaskSpec,
  backtraceJudgeTaskSpec,
} from '../failure-learning/tasks/backtrace';
import { assessmentRubricTaskSpec } from '../grading/tasks/assessment-rubric';
import { assessmentRuleTaskSpec } from '../grading/tasks/assessment-rule';
import { jevScoringDecisionTaskSpec } from '../grading/tasks/jev-typed';
import {
  multimodalDirectJudgeTaskSpec,
  semanticJudgeTaskSpec,
  stepsJudgeTaskSpec,
  unitDimensionFallbackTaskSpec,
} from '../grading/tasks/judges';
import { sourceGroundingVerifyTaskSpec } from '../grading/tasks/source-grounding-verify';
import { itemPriorLlasaTaskSpec, itemPriorTaskSpec } from '../question-bank/tasks/item-prior';
import { questionAdmissionAdjudicateTaskSpec } from '../question-bank/tasks/question-admission-adjudicate';
import { questionAdmissionSolveTaskSpec } from '../question-bank/tasks/question-admission-solve';
import { quizVerifyTaskSpec } from '../question-bank/tasks/quiz-verify';
import { variantVerifyTaskSpec } from '../question-bank/tasks/variant-verify';
import { selectionOrchestratorTaskSpec } from '../scheduling/tasks/selection-orchestrator';
import { sessionSummaryTaskSpec } from '../session/tasks/session-summary';
import { questionPreparerTaskSpec } from '../supply/tasks/question-preparer';
import { questionAuthorTaskSpec } from './question-author';
import { quizGenTaskSpec } from './quiz-generation';
import { quizPlanTaskSpec } from './quiz-planning';
import { solutionGenerateTaskSpec, solutionGenerateVisionTaskSpec } from './solution-generation';
import { sourcingTaskSpec } from './sourcing';
import { supplyPlanTaskSpec } from './supply-planning';
import { teachingQualityTaskSpec } from './teaching-quality';

export const practiceTaskSpecs = defineOwnedTaskSpecs('practice', {
  AttemptInsightTask: attemptInsightTaskSpec,
  BacktraceJudgeTask: backtraceJudgeTaskSpec,
  QuestionPreparerTask: questionPreparerTaskSpec,
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
  QuestionAdmissionAdjudicateTask: questionAdmissionAdjudicateTaskSpec,
});
