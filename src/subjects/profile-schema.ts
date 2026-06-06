import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { z } from 'zod';

export type SubjectId = string;
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math', 'physics'] as const;
export type KnownSubjectId = (typeof KNOWN_SUBJECT_IDS)[number];

export const SubjectQuestionKindSchema = z.enum([
  'single_choice',
  'multiple_choice',
  'short_answer',
  'translation',
  'reading_comprehension',
  'proof',
  'calculation',
  'word_problem',
]);
export type SubjectQuestionKind = z.infer<typeof SubjectQuestionKindSchema>;

// Desired route families for subject policy. These are allowed to mention
// future strategies; judgeCapabilities below lists registry-backed runners.
export const JudgeRouteKindSchema = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'unit_dimension',
  'multimodal_direct',
  'ai_flexible',
]);
export type JudgeRouteKind = z.infer<typeof JudgeRouteKindSchema>;

export const SubjectProfileSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  languageStyle: z.string().trim().min(1),
  questionKinds: z.array(SubjectQuestionKindSchema).min(1),
  judgePolicy: z.object({
    preferredRoutes: z.array(JudgeRouteKindSchema).min(1),
    notes: z.array(z.string()),
  }),
  exampleSources: z.array(z.string().trim().min(1)),
  noteTemplate: z.object({
    definition: z.string().trim().min(1),
    mechanism: z.string().trim().min(1),
    example: z.string().trim().min(1),
    pitfall: z.string().trim().min(1),
    check: z.string().trim().min(1),
  }),
  grounding: z.object({
    requirement: z.string().trim().min(1),
    allowedSources: z.array(z.string().trim().min(1)),
    uncertaintyPolicy: z.string().trim().min(1),
  }),
  promptFragments: z.object({
    roleNoun: z.string().trim().min(1),
    noteExamplePolicy: z.string().trim().min(1),
    variantExamplePolicy: z.string().trim().min(1),
    teachingStyle: z.string().trim().min(1),
    checkQuestionPolicy: z.string().trim().min(1),
    learningIntentPolicy: z.string().trim().min(1),
  }),
  causeCategories: z.array(CauseCategoryDeclaration).min(1),
  renderConfig: RenderConfig,
  schedulingHints: SchedulingHints,
  judgeCapabilities: z.array(z.string().trim().min(1)),
  // YUK-225 (S2 slice 4) — 规范双轨 thin profile section (no skill registry; the
  // SKILL.md packs live in src/subjects/<id>/skills/ and are discovered on disk —
  // spec §5 第五轮定稿「不建 skill 注册表」).
  //
  // sourceWhitelist: 可信题源域名列表，SourcingTask (slice 2) 用它判 whitelist_match。
  // OWNER-FORK OF-1 拍板「委托 agent 调研提名」(plan §12)，首批候选见
  // .omc/research/2026-06-05-source-whitelist-candidates.md。OF-2「入库但降权」: 白名单
  // 外源仍入库 (whitelist_match=false)，只在选题排序后置，不降质量门。空数组 = 全部
  // 来源 whitelist_match=false (cold-start 默认，owner 后补域名即生效)。
  sourceWhitelist: z.array(z.string().trim().min(1)).default([]),
  // sourcingRoutePreference: per-题型「缺题时找题次序」偏好 (§3.2)。key = SubjectQuestionKind,
  // value = 该题型优先走的四线次序 (slice 5b 的 sourcing-sequence 消费)。如阅读题直奔
  // material 线。未列题型走默认次序 (sourced → material → closed_book)。加性、可选。
  sourcingRoutePreference: z
    .record(
      SubjectQuestionKindSchema,
      z.array(z.enum(['sourced', 'material', 'closed_book', 'variant'])).min(1),
    )
    .optional(),
});
export type SubjectProfile = z.infer<typeof SubjectProfileSchema>;
export type SlimSubjectProfile = Pick<SubjectProfile, 'id' | 'displayName' | 'renderConfig'>;
