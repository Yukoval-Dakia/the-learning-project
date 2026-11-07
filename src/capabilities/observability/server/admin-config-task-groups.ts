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
  SolutionGenerateTask: 'question-prep',
  SolutionGenerateVisionTask: 'question-prep',
  SourceGroundingVerifyTask: 'question-prep',
  QuizVerifyTask: 'question-prep',
  VariantVerifyTask: 'question-prep',
  QuestionAdmissionSolveTask: 'question-prep',
  QuestionAdmissionAdjudicateTask: 'question-prep',
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
  IngestionSolutionAnnotationTask: 'ingestion',
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

// Per-kind human-facing one-liner for expanded task rows: a short Chinese name
// plus what the task does for the learner or the system. Copy rules: no ticket
// numbers, no internal codes, no English class names — those stay in
// `description`. Display copy only, colocated with the grouping map rather than
// in task specs. Kinds absent here return null and the row shows its kind.

const LABEL_BY_KIND: Readonly<Record<string, string>> = {
  // 学习伙伴 — the learner-facing conversation surface.
  CopilotTask: '学习伙伴：唯一面向学习者的对话助手——答疑、一起解题、评析思路、查记录、商量安排',
  TeachingTurnTask: '教学回合：围绕一个学习项逐轮讲解、出检查题、判断何时收尾',
  TeachingTurnVisionTask: '看图提示：对着题目原图给下一步最小提示，不透最终答案',
  // 学习教练 — plans, goals, interventions and session/quality reviews.
  CoachTask: '今日教练：读学习信号起草当天的安排和重点，改动先经学习者确认',
  GoalScopeTask: '目标范围：把一句学习目标翻成要覆盖的知识节点清单和粗略顺序',
  LearningIntentOutlineTask: '意向拆分：把「我想学某个主题」拆成一篇总览加若干小节学习路径',
  InterventionRecommendationTask: '干预选法：为已证实的错因猜想挑一种教学方法，证据不足就弃权',
  InterventionPackageAuthorTask: '干预包作者：一次产出一份教学材料加即时、延迟、迁移三道诊断题',
  InterventionPackageReviewTask: '干预包审查：对照独立盲解审查干预包质量，指出问题但不代修',
  TeachingQualityTask: '审题质检：入池前检查题干是否清楚、答案是否唯一、干扰项有没有诊断力',
  SessionSummaryTask: '练习复盘：学习结束后写一小段观察记录和下次建议',
  SelectionOrchestratorTask: '选题编排：给还没到期、可练可不练的题和卷按教学价值打分排序',
  // 备题员 — sourcing, generation, solving and admission for the question bank.
  SourcingTask: '联网找题：检索现成练习题，忠实抽取题面答案并记下出处',
  SupplyPlanTask: '供题规划：每晚盘点题池缺口，列出要补的知识点、题型和数量',
  QuizPlanTask: '出题规划：只定计划不写题——每道题考哪个知识点、什么题型、多难',
  QuizGenTask: '检索出题：联网找素材后按定好的计划逐题原创编写并自报出处',
  QuestionAuthorTask: '单题原创：按知识点或粘贴的素材恰好写一道原创题',
  QuestionPreparerTask: '备题员：处理一张缺题工单——查库存后决定外找、自出还是改编，并修复准入退回',
  VariantGenTask: '错题变式：按判出的错因给做错的原题出一道针对性变式',
  ItemPriorTask: '难度预估：分析认知步骤和易错点，给新题估一个起步难度',
  ItemPriorLlasaTask: '模拟学生估难度：扮不同水平的学生实际作答，由答对率反推难度',
  SolutionGenerateTask: '参考解生成：独立解一道没有判据的题，产出判分要点和给学习者看的详解',
  SolutionGenerateVisionTask: '看图生成参考解：对着题目附图独立解题，产出判分要点和详解',
  SourceGroundingVerifyTask: '来源核验：回看来源图片，确认题面真的出自这张图而不是凭空写的',
  QuizVerifyTask: '出题质检：闭卷复核新题的事实、原创度和是否考到目标知识点',
  VariantVerifyTask: '变式质检：确认变式题仍测同一个错因、本身可解',
  QuestionAdmissionSolveTask: '准入盲解：不看任何答案独立解一遍题，产出候选答案键和典型错答',
  QuestionAdmissionAdjudicateTask: '准入裁决：对照两份独立解题结果，定稿答案键或列出可修的退回项',
  // 判分 — grading, verification judges and mistake attribution.
  SemanticJudgeTask: '语义判分：按采分点给文字作答打分并写一句反馈',
  StepsJudgeTask: '分步判分：读学生的解题步骤图片，逐项对照判分要点判对错',
  MultimodalDirectJudgeTask: '整体判分：对带图的作答做一次整体对错判定，不拆步骤',
  AssessmentRubricJudgeTask: '量规判分：按发布时冻结的评分细则逐条给分，不汇总不越权',
  AssessmentRuleJudgeTask: '规则判分：按发布时冻结的给分规则或等级表判定单个评分单元',
  JevScoringDecisionTask: '判分服务调用：按冻结规则或等级表给单个评分单元判分（专用判分服务）',
  AttributionTask:
    '错因归因（兼容保留）：给做错的题判错因类别并写分析；线上实际由另一路重排任务定主因',
  AttributionRerankTask: '错因归因·定主因：对候选错因逐条权衡，选出最主要的一条',
  CauseCategoryProposeTask: '错因类目治理：「其他」类错因攒够复发次数后，判断是否该新增一个类目',
  UnitDimensionFallback: '单位量纲兜底：程序解不动答案里的自然语言单位时，换算后与参考值比对',
  // 录入 — intake, OCR/vision extraction and structure assembly.
  VisionExtractTask: '识图抽取：把题目照片切成块，抽出题面、答案和位置（人工救援通道）',
  VisionExtractTaskHeavy: '识图抽取·重档：轻量识别失败后兜底处理难读的图（人工救援通道）',
  IngestionAgentTask: '录入代理：一次跑完整个上传包——读页、切题、结构化、送准入闸',
  TaggingTask: '知识点打标：给抽出的题建议挂到哪些知识节点，并给出把握度',
  BlockAssemblyTask: '题块拼合：发现相邻题块本是一道题，提议合并给学习者确认',
  StructureTask: '版面结构化：看整页试卷图片，整理出规范化的题目结构树',
  ProfileCriticTask: '科目档案评审：审一份科目配置草稿并给出修改建议，不直接发布',
  MistakeEnrollTask: '错题登记草稿：给已作答的题草拟对错、题型、难度和错因供确认',
  ColdStartPlacementBridgeTask:
    '冷启动过桥：图谱还没有可挂节点时，给题定科目、起概念名、补参考答案',
  IngestionSolutionAnnotationTask:
    '解法标注：给录入的题写「这类题怎么想、怎么做」的方法与关键步骤，不给答案',
  // 记忆整理 — learner-model memory: briefs, mind-model induction, conjectures.
  MemoryBriefTask: '记忆简报：把一个学习范围的活动整理成近一周、近月、长期三段小结',
  MindModelInductionTask: '思维猜想：从反复出现的错因证据里归纳一条关于学习者思维方式的猜想',
  DreamingTask: '记忆整理：夜间归并压缩学习者记忆，所有改动都可撤销',
  ConjectureGroupingTask: '猜想归组：把语义相同的思维猜想合并成组',
  ConjectureProbeAuthorTask: '探针出题：按冻结的猜想写两道专门诱发目标错误的诊断题',
  ConjectureProbeReviewTask: '探针审查：独立复核两道诊断题质量，给通过或失败码，不代修',
  // 笔记与知识 — note artifacts and the knowledge graph.
  NoteGenerateTask: '笔记生成：按科目模板写一篇学习笔记全文',
  NoteRefineTask: '笔记精修：按触发原因给已有笔记出一组小编辑，大改动先经确认',
  KnowledgeReviewTask: '知识图谱维护：看整棵知识树和近期错题，提议结构和关系调整',
  FrontierPrerequisiteTask: '先修补边：给还没有先修关系的知识点提议少量临时前置边',
};

export function adminConfigTaskLabel(kind: string): string | null {
  return LABEL_BY_KIND[kind] ?? null;
}
