// YUK-226 S2-5b (PR #320 验证轮 A) — 单一权威「题型词表」规范化层.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §5
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3.2
//
// 项目里同一「题型」概念有三套词表，历史上各处手搓转换、互相漂移：
//   1. 持久 `question.kind` —— YUK-386 起为自由文本展示标签
//      (core/schema/business.ts QuestionKind = z.string().min(1))；
//      KNOWN_QUESTION_KIND_IDS 是其中的惯用标签集合（choice / computation /
//      reading / translation / derivation ...）。**kind 不再是行为权威**：
//      行为分支读 answer_class / 结构信号 / parent_question_id。
//   2. profile / skill key —— subjects/profile-schema.ts `SubjectQuestionKind`
//      (single_choice / multiple_choice / reading_comprehension / calculation /
//      proof / word_problem ...)。profile.questionKinds、sourcingRoutePreference key、
//      QUIZ_GEN_SKILL_KIND_KEYS、skill 目录命名都用它 —— 这是 profile 侧声明词表，
//      保持 z.enum 契约不变。
//   3. skill 目录名 —— quiz-gen-<key>（连字符，reading-comprehension）。由 (2) 派生，
//      已由 QUIZ_GEN_SKILL_KIND_KEYS 单点翻译，不在本模块再开一份。
//
// 本模块是 (1)↔(2) 的唯一双向映射 + 归一入口：skill 解析、读侧词表展开、
// pin/过滤的 answer-class 相容比较全部消费这里，任何一处都不再 hand-roll
// computation/calculation 之类的特例。
//
// YUK-386 收编：`kindsMatch`（归一后字符串相等）退役，替换为
// `answerClassCompatible`（归一后比较 answer-class）——pin/过滤的语义从
// 「同一题型名」改为「同一判分类」。kind 标签本身不进分支。

import type { z } from 'zod';
import { kindLabelsShareAnswerClass } from '@/core/schema/answer-class';
import { KNOWN_QUESTION_KIND_IDS, type QuestionKind } from '@/core/schema/business';
import { type SubjectQuestionKind, SubjectQuestionKindSchema } from '@/subjects/profile-schema';

// canonical 持久题型标签 (business.ts QuestionKind —— YUK-386 起为自由字符串).
// 本地派生，避免耦合 judge-routing.ts 的同名别名。
type QuestionKindT = z.infer<typeof QuestionKind>;

// The KNOWN canonical label vocabulary (recognition set for the vocab fold —
// NOT a gate: unknown labels are valid free-form kinds).
const CANONICAL_KIND_IDS: ReadonlySet<string> = new Set(KNOWN_QUESTION_KIND_IDS);

// ── (2) → (1): profile/skill key → canonical 持久 kind 标签 ──────────────────
//
// 每个 SubjectQuestionKind 归一到它落库时的持久 kind 标签。多个 profile kind 可折叠到同一
// canonical（single_choice + multiple_choice → choice；calculation + word_problem →
// computation）—— 这是有损方向（reverse 取代表值），但 pin 校验只需「两边归一后同
// answer-class」，折叠不影响正确性。
const SKILL_TO_CANONICAL: Record<SubjectQuestionKind, QuestionKindT> = {
  single_choice: 'choice',
  multiple_choice: 'choice',
  short_answer: 'short_answer',
  translation: 'translation',
  reading_comprehension: 'reading',
  proof: 'derivation',
  calculation: 'computation',
  word_problem: 'computation',
};

// ── (1) → (2): canonical 持久 kind 标签 → 代表性 profile/skill key ──────────
//
// 取每个 canonical 的代表 SubjectQuestionKind（choice→single_choice、computation→
// calculation、reading→reading_comprehension、derivation→proof）。true_false /
// fill_blank / essay 在 SubjectQuestionKind 里无对应（profile 不分这些题型）—— 留空，
// 由 toSkillKind 透传原值（与 slice-4 旧 questionKindToSkillKind 的「未命中即透传」行为
// 一致：skill 解析对这些 kind 解析到无 skill 包，走降级链）。
const CANONICAL_TO_SKILL: Partial<Record<QuestionKindT, SubjectQuestionKind>> = {
  choice: 'single_choice',
  short_answer: 'short_answer',
  translation: 'translation',
  reading: 'reading_comprehension',
  computation: 'calculation',
  derivation: 'proof',
};

/**
 * 把**任意一套词表**的合法 kind 值归一到 canonical 持久 kind 标签。
 * - 已是 KNOWN canonical 标签（choice / computation / reading ...）→ 原样返回。
 * - profile/skill key（single_choice / calculation / reading_comprehension ...）→ 折叠到
 *   对应 canonical 标签。
 * - 两套都不认的值 → `null`（调用方据此 400 / 跳过 / 透传，而非永败 job）。
 *
 * YUK-386：这是词表折叠，不是合法性校验——`null` 只意味着「不在已知词表」，
 * 自由文本标签本身照样是合法 kind。
 */
export function normalizeToCanonicalKind(value: string): QuestionKindT | null {
  if (CANONICAL_KIND_IDS.has(value)) return value;
  if (SubjectQuestionKindSchema.safeParse(value).success) {
    return SKILL_TO_CANONICAL[value as SubjectQuestionKind];
  }
  return null;
}

/**
 * 两个 kind 标签（可分属不同词表）是否落在同一 answer-class——pin / 过滤的
 * YUK-386 语义：kind 名不进分支，两边的「判分类」一致即视为相容。
 *
 * 归一顺序：先把已知的 profile/skill key 折叠到 canonical 标签（'calculation'
 * pin ↔ 'computation' 产出、'single_choice' pin ↔ 'choice' 产出），再比较
 * label 的 kind 级 answer-class（answerClassForKindLabel——不计 rubric/choices
 * 行结构，两侧同为纯标签比较）。词表外的自由标签直接按自身类比较：
 * 'reading' pin 与任意开放作答标签（'short_answer' / 'essay' / 自定义标签）
 * 同属 semantic → 相容；'choice' pin 只接受 exact 类标签。
 *
 * 替代退役的 `kindsMatch`（归一后字符串相等）：语义从「同一题型名」放宽为
 * 「同一判分类」——objectiveOnly 之类硬约束仍被类比较守住。
 */
export function answerClassCompatible(a: string, b: string): boolean {
  const ca = normalizeToCanonicalKind(a) ?? a;
  const cb = normalizeToCanonicalKind(b) ?? b;
  return kindLabelsShareAnswerClass(ca, cb);
}

/**
 * 持久 `question.kind` 标签（canonical，如 'computation'）→ profile/skill
 * `SubjectQuestionKind`（如 'calculation'）。先把入参归一到 canonical（容忍调用方
 * 已传 profile key），再取代表 skill key；无对应 skill key 的 canonical
 * （true_false / fill_blank / essay）或词表外的自由标签透传原值，保持降级链
 * 「无 skill 包 → 回退 promptFragments」。
 */
export function questionKindToSkillKind(persistedKind: string): SubjectQuestionKind {
  const canonical = normalizeToCanonicalKind(persistedKind);
  if (canonical === null) return persistedKind as SubjectQuestionKind;
  return CANONICAL_TO_SKILL[canonical] ?? (canonical as unknown as SubjectQuestionKind);
}

/**
 * `questionKindToSkillKind` 的逆：profile/skill `SubjectQuestionKind`（如 'calculation'）→
 * 落库的持久 `question.kind` 标签（如 'computation'），让 `WHERE kind = …` 的 few-shot
 * 过滤命中真行。等价于 normalizeToCanonicalKind 走 skill→canonical 分支；不认的值透传。
 */
export function skillKindToQuestionKind(skillKind: SubjectQuestionKind): string {
  return SKILL_TO_CANONICAL[skillKind] ?? (skillKind as string);
}

/**
 * 给定一个 canonical kind 标签，返回**所有归一到它的持久 kind 形态**：canonical 自身
 * + 每个折叠到它的 SubjectQuestionKind（choice → [choice, single_choice, multiple_choice]；
 * computation → [computation, calculation, word_problem]；reading → [reading,
 * reading_comprehension]；derivation → [derivation, proof]）。
 *
 * 为什么需要这个：持久 `question.kind` 是自由文本标签（YUK-386），历史 seed /
 * fixture 写路径落过 profile 词表（single_choice / reading_comprehension /
 * calculation）。所以一个按 canonical 标签过滤的读路径若用 `eq(question.kind,
 * 'choice')` 会漏掉所有 `single_choice` 行（YUK-288 题型 filter 空集 bug）。读侧用本
 * 函数把请求的 canonical 标签展开成 `IN (...)` 集合，命中两套词表落库的行；展示侧已由
 * `normalizeToCanonicalKind`（meta.ts）反向归一，两侧对称。
 *
 * 入参若不是 KNOWN canonical 标签（如已是 profile key 或自由标签）→ 先归一；归一不到
 * 则原样返回单元素集合（调用方据此仍做精确匹配，不放大）。
 *
 * YUK-390 residual：`kind_cleanup_backfill` 已随 YUK-386 退役（持久 kind 不再需要
 * 收敛到 canonical——标签本就自由）。本展开继续负责让旧脏行对 canonical 过滤可见。
 */
export function canonicalKindToPersistedForms(kind: string): string[] {
  const canonical = normalizeToCanonicalKind(kind);
  if (canonical === null) return [kind];
  const forms = new Set<string>([canonical]);
  for (const [skillKind, mapped] of Object.entries(SKILL_TO_CANONICAL) as Array<
    [SubjectQuestionKind, QuestionKindT]
  >) {
    if (mapped === canonical) forms.add(skillKind);
  }
  return [...forms];
}
