// YUK-599 (YUK-597 v3 trait 合同 §2.1) — 六个 trait kind 的 per-kind strict Zod
// 写门 schema + kind 常量的单一来源（src/db/schema.ts 从这里 import，防两处枚举漂移；
// 本模块浏览器安全——零 db/server import，红线同 profile-schema.ts）。
//
// 字段切分（SubjectProfile 全字段无遗漏映射，v3 §2.1 表）：
//   charter        — languageStyle + promptFragments 六槽（扁平化）+ noteTemplate 五节
//                    + 新增 methodology / rubricGuidance（纯 LLM prompt 消费）
//   judge_policy   — questionKinds / judgePolicy / judgeCapabilities（确定性路由+校验）
//   cause_taxonomy — causeCategories（FK 语义：错因 tag id）
//   source_policy  — grounding / sourceWhitelist / sourcingRoutePreference / exampleSources
//   render_theme   — renderConfig（+未来 uiTheme token 位，触发器见 v3 §5.3）
//   scheduling     — schedulingHints（FSRS 参数）
// id/displayName 归 subject 控制行；装配 version = jt: 身份组合串（不落列，v3 §2.1）。
//
// charter 是「扁平命名节对象」（歧义钉死：不是嵌套 promptFragments）——写门在顶层
// `.strict()` 拒未知节名（422）；装配层（trait-compose.ts）负责映回 SubjectProfile
// 旧形状。methodology/rubricGuidance = z.string().default('')，显式不带六槽的
// .min(1)：空串是合法初态（带 .min(1) 会让 thin-create 与全部装配校验当场翻红——
// 分歧有意，测试钉死「全空两节校验绿」）。

import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { z } from 'zod';
import { JudgeRouteKindSchema, SubjectQuestionKindSchema } from './profile-schema';

export const SUBJECT_TRAIT_KINDS = [
  'charter',
  'judge_policy',
  'cause_taxonomy',
  'source_policy',
  'render_theme',
  'scheduling',
] as const;
export type SubjectTraitKind = (typeof SUBJECT_TRAIT_KINDS)[number];

// 每 kind 的 payload schema 代际（journal 行快照携带；upgrade-on-read 的比较轴）。
// 全部从 1 起；改 payload 形状时 bump 对应 kind。
export const TRAIT_PAYLOAD_SCHEMA_VERSIONS: Record<SubjectTraitKind, number> = {
  charter: 1,
  judge_policy: 1,
  cause_taxonomy: 1,
  source_policy: 1,
  render_theme: 1,
  scheduling: 1,
};

export const CharterTraitSchema = z
  .object({
    languageStyle: z.string().trim().min(1),
    // promptFragments 六槽（扁平化；.min(1) 语义与 profile-schema.ts:61-68 逐位一致）。
    roleNoun: z.string().trim().min(1),
    noteExamplePolicy: z.string().trim().min(1),
    variantExamplePolicy: z.string().trim().min(1),
    teachingStyle: z.string().trim().min(1),
    checkQuestionPolicy: z.string().trim().min(1),
    learningIntentPolicy: z.string().trim().min(1),
    noteTemplate: z
      .object({
        definition: z.string().trim().min(1),
        mechanism: z.string().trim().min(1),
        example: z.string().trim().min(1),
        pitfall: z.string().trim().min(1),
        check: z.string().trim().min(1),
      })
      .strict(),
    // 新增两节：空串合法初态（显式无 .min(1)，见模块头）。种子为空串。
    methodology: z.string().default(''),
    rubricGuidance: z.string().default(''),
  })
  .strict();
export type CharterTrait = z.infer<typeof CharterTraitSchema>;

export const JudgePolicyTraitSchema = z
  .object({
    questionKinds: z.array(SubjectQuestionKindSchema).min(1),
    judgePolicy: z
      .object({
        preferredRoutes: z.array(JudgeRouteKindSchema).min(1),
        notes: z.array(z.string()),
      })
      .strict(),
    judgeCapabilities: z.array(z.string().trim().min(1)),
  })
  .strict();
export type JudgePolicyTrait = z.infer<typeof JudgePolicyTraitSchema>;

export const CauseTaxonomyTraitSchema = z
  .object({
    causeCategories: z.array(CauseCategoryDeclaration).min(1),
  })
  .strict();
export type CauseTaxonomyTrait = z.infer<typeof CauseTaxonomyTraitSchema>;

export const SourcePolicyTraitSchema = z
  .object({
    grounding: z
      .object({
        requirement: z.string().trim().min(1),
        allowedSources: z.array(z.string().trim().min(1)),
        uncertaintyPolicy: z.string().trim().min(1),
      })
      .strict(),
    sourceWhitelist: z.array(z.string().trim().min(1)).default([]),
    sourcingRoutePreference: z
      .record(
        SubjectQuestionKindSchema,
        z.array(z.enum(['sourced', 'material', 'closed_book', 'variant'])).min(1),
      )
      .optional(),
    // YUK-697 — jyeoo-rs 确定性题源声明（source_policy trait 承载，与 sourceWhitelist/
    // sourcingRoutePreference 同族）。存在即本 subject 有 jyeoo producer；见 SubjectProfileSchema。
    jyeooSupply: z
      .object({
        subject: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    exampleSources: z.array(z.string().trim().min(1)),
  })
  .strict();
export type SourcePolicyTrait = z.infer<typeof SourcePolicyTraitSchema>;

export const RenderThemeTraitSchema = z
  .object({
    renderConfig: RenderConfig,
  })
  .strict();
export type RenderThemeTrait = z.infer<typeof RenderThemeTraitSchema>;

export const SchedulingTraitSchema = z
  .object({
    schedulingHints: SchedulingHints,
  })
  .strict();
export type SchedulingTrait = z.infer<typeof SchedulingTraitSchema>;

// per-kind 写门/水合共用查表（safeParse 的唯一入口——写门 422 回显与坏行降级
// 用同一 schema，防「写门认、水合拒」的双真相源）。
export const TRAIT_PAYLOAD_SCHEMAS = {
  charter: CharterTraitSchema,
  judge_policy: JudgePolicyTraitSchema,
  cause_taxonomy: CauseTaxonomyTraitSchema,
  source_policy: SourcePolicyTraitSchema,
  render_theme: RenderThemeTraitSchema,
  scheduling: SchedulingTraitSchema,
} as const satisfies Record<SubjectTraitKind, z.ZodTypeAny>;

export type SubjectTraitPayloads = {
  charter: CharterTrait;
  judge_policy: JudgePolicyTrait;
  cause_taxonomy: CauseTaxonomyTrait;
  source_policy: SourcePolicyTrait;
  render_theme: RenderThemeTrait;
  scheduling: SchedulingTrait;
};
