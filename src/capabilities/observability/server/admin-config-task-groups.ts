// YUK-1808 — the config page's first layer in human language: every task kind
// maps to one named group (学习伙伴 / 学习教练 / 备题员 / 判分 / 录入 / 记忆整理 /
// 笔记与知识), displayed in this order. Kinds not listed here fall back to
// 'other' (其他) — the read face reports them honestly rather than guessing.
// This is a display projection only; it makes no routing decisions.

export interface AdminConfigTaskGroup {
  readonly id: string;
  readonly label: string;
}

export const ADMIN_CONFIG_TASK_GROUPS: readonly AdminConfigTaskGroup[] = [
  { id: 'companion', label: '学习伙伴' },
  { id: 'coach', label: '学习教练' },
  { id: 'question-prep', label: '备题员' },
  { id: 'grading', label: '判分' },
  { id: 'ingestion', label: '录入' },
  { id: 'memory', label: '记忆整理' },
  { id: 'notes-knowledge', label: '笔记与知识' },
];

export const ADMIN_CONFIG_OTHER_TASK_GROUP: AdminConfigTaskGroup = {
  id: 'other',
  label: '其他',
};

const GROUP_BY_KIND: Readonly<Record<string, string>> = {
  // 学习伙伴 — the learner-facing conversation surface.
  CopilotTask: 'companion',
  TeachingTurnTask: 'companion',
  TeachingTurnVisionTask: 'companion',
  // 学习教练 — plans, goals, interventions and session/quality reviews.
  CoachTask: 'coach',
  TodayPlan: 'coach',
  GoalScopeTask: 'coach',
  LearningIntentOutlineTask: 'coach',
  InterventionRecommendationTask: 'coach',
  InterventionPackageAuthorTask: 'coach',
  InterventionPackageReviewTask: 'coach',
  TeachingQualityTask: 'coach',
  SessionSummaryTask: 'coach',
  SelectionOrchestratorTask: 'coach',
  // 备题员 — sourcing, generation, solving and admission for the question bank.
  SourcingTask: 'question-prep',
  SupplyPlanTask: 'question-prep',
  QuizPlanTask: 'question-prep',
  QuizGenTask: 'question-prep',
  QuestionAuthorTask: 'question-prep',
  QuestionPreparerTask: 'question-prep',
  VariantGenTask: 'question-prep',
  ItemPriorTask: 'question-prep',
  ItemPriorLlasaTask: 'question-prep',
  JyeooFetch: 'question-prep',
  BankRequirementInterpretTask: 'question-prep',
  BankConditionVerifyTask: 'question-prep',
  SolutionGenerateTask: 'question-prep',
  SolutionGenerateVisionTask: 'question-prep',
  SourceGroundingVerifyTask: 'question-prep',
  QuizVerifyTask: 'question-prep',
  VariantVerifyTask: 'question-prep',
  QuestionAdmissionSolveTask: 'question-prep',
  // 判分 — grading, verification judges and mistake attribution.
  SemanticJudgeTask: 'grading',
  StepsJudgeTask: 'grading',
  MultimodalDirectJudgeTask: 'grading',
  AssessmentRubricJudgeTask: 'grading',
  AssessmentRuleJudgeTask: 'grading',
  JevScoringDecisionTask: 'grading',
  AttributionTask: 'grading',
  AttributionRerankTask: 'grading',
  CauseCategoryProposeTask: 'grading',
  UnitDimensionFallback: 'grading',
  // 录入 — intake, OCR/vision extraction and structure assembly.
  VisionExtractTask: 'ingestion',
  VisionExtractTaskHeavy: 'ingestion',
  IngestionAgentTask: 'ingestion',
  TaggingTask: 'ingestion',
  BlockAssemblyTask: 'ingestion',
  StructureTask: 'ingestion',
  ProfileCriticTask: 'ingestion',
  MistakeEnrollTask: 'ingestion',
  ColdStartPlacementBridgeTask: 'ingestion',
  // 记忆整理 — learner-model memory: briefs, mind-model induction, conjectures.
  MemoryBriefTask: 'memory',
  MindModelInductionTask: 'memory',
  DreamingTask: 'memory',
  ConjectureGroupingTask: 'memory',
  ConjectureProbeAuthorTask: 'memory',
  ConjectureProbeReviewTask: 'memory',
  // 笔记与知识 — note artifacts and the knowledge graph.
  NoteGenerateTask: 'notes-knowledge',
  NoteRefineTask: 'notes-knowledge',
  KnowledgeReviewTask: 'notes-knowledge',
  FrontierPrerequisiteTask: 'notes-knowledge',
};

export function adminConfigTaskGroupId(kind: string): string {
  return GROUP_BY_KIND[kind] ?? ADMIN_CONFIG_OTHER_TASK_GROUP.id;
}
