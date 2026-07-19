import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { z } from 'zod';

export type SubjectId = string;

// YUK-598（v2 §2.1）— 编译期字面 builtin 常量：**运行时零权威**（运行时集合 =
// registry 三集合 API：getSelectableSubjectIds / getResolvableSubjectIds，DB 水合
// 后含 custom）。这份列表只服务编译期兜底（SPA initialData 投影、seed 循环、
// 测试 fixture）。general 有意不在此列（fallback 身份非候选科目，见 profile.ts）。
export const BUILTIN_IDS = ['yuwen', 'math', 'physics'] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

/**
 * @deprecated YUK-598 缓迁 re-export——新代码用 `BUILTIN_IDS`（编译期字面）或
 * registry 的运行时三集合 API；此别名将随消费点清零而删。
 */
export const KNOWN_SUBJECT_IDS = BUILTIN_IDS;
/**
 * @deprecated YUK-598 放宽为 string（custom `subj_<cuid2>` 一等公民，v3 合同）；
 * 需要 builtin 穷举语义的地方改用 `BuiltinId`。
 */
export type KnownSubjectId = string;

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
    // YUK-599 (v3 trait 合同 §2.1) — charter trait 的两个新节映回旧形状的落点。
    // 显式不带六槽的 .min(1)：空串是合法初态（种子即空串），带 .min(1) 会让
    // thin-create 与全部装配校验当场翻红（分歧有意，trait-compose.test 钉死）。
    // 注入语义：methodology → copilot/note 教学 prompt（YUK-600 接线）；
    // rubricGuidance → 仅四个作者化题目级 rubric 锚点（v3 §4.1，judge 读端零变化）。
    methodology: z.string().default(''),
    rubricGuidance: z.string().default(''),
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
  // YUK-697 — jyeooSupply: 声明本 subject 有 jyeoo-rs 确定性题源 producer。存在 = supply
  // dispatcher 在本 subject 的 tier-2 缺口上把 jyeoo_fetch 路由排到 sourcing_web 之前
  // （route-planner），并按 JYEOO_FETCH_ENABLED kill switch 派发。`subject` = jyeoo-rs 的
  // 站内 subject 词表 token（如 'math2'），NOT loom subject id。缺省 = 无 jyeoo 支持。
  jyeooSupply: z
    .object({
      subject: z.string().trim().min(1),
    })
    .optional(),
});
export type SubjectProfile = z.infer<typeof SubjectProfileSchema>;
export type SlimSubjectProfile = Pick<SubjectProfile, 'id' | 'displayName' | 'renderConfig'>;
