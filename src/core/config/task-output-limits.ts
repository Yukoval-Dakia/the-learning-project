// Run-wide output ceilings include reasoning and all root/child turns.
// Three times the largest measured run, rounded up to 4096, with a 16k floor.
// Sparse authoring/editing samples use the larger measured generation family.
// Evidence: tlp-docs/audit/2026-11-07-output-tokens-by-task.md (2026-11-07).
export const TASK_OUTPUT_CAP_TOKENS: Readonly<Record<string, number>> = {
  AttributionRerankTask: 16384,
  BlockAssemblyTask: 16384,
  CoachTask: 28672,
  ColdStartPlacementBridgeTask: 16384,
  CopilotTask: 86016,
  DreamingTask: 69632,
  FrontierPrerequisiteTask: 16384,
  GoalScopeTask: 16384,
  ItemPriorTask: 16384,
  LearningIntentOutlineTask: 16384,
  MemoryBriefTask: 24576,
  NoteGenerateTask: 28672,
  NoteRefineTask: 28672,
  QuestionAdmissionAdjudicateTask: 16384,
  QuestionAdmissionSolveTask: 77824,
  QuestionAuthorTask: 32768,
  QuizGenTask: 32768,
  QuizPlanTask: 73728,
  QuizVerifyTask: 16384,
  SelectionOrchestratorTask: 16384,
  SemanticJudgeTask: 16384,
  SolutionGenerateTask: 32768,
  StructureTask: 36864,
  SupplyPlanTask: 16384,
  TeachingQualityTask: 16384,
  TeachingTurnTask: 16384,
  VariantGenTask: 32768,
  AssessmentRuleJudgeTask: 28672,
  MultimodalDirectJudgeTask: 28672,
};
// Unknown tasks, KnowledgeReviewTask (measured 200175) and SourcingTask
// (76153) retain catalog limits until their output requirements are understood.
