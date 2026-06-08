// YUK-226 S2-5b (PR #320 验证轮 A) — 单一权威「题型词表」规范化层.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §5
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3.2
//
// 项目里同一「题型」概念有三套词表，历史上各处手搓转换、互相漂移：
//   1. 持久 `question.kind` —— core/schema/business.ts `QuestionKind`
//      (choice / computation / reading / translation / derivation ...)。生成 / 验题 /
//      排序 / judge route 的 SoT，也是落库的真值。**canonical = 这一套。**
//   2. profile / skill key —— subjects/profile-schema.ts `SubjectQuestionKind`
//      (single_choice / multiple_choice / reading_comprehension / calculation /
//      proof / word_problem ...)。profile.questionKinds、sourcingRoutePreference key、
//      QUIZ_GEN_SKILL_KIND_KEYS、skill 目录命名都用它。
//   3. skill 目录名 —— quiz-gen-<key>（连字符，reading-comprehension）。由 (2) 派生，
//      已由 QUIZ_GEN_SKILL_KIND_KEYS 单点翻译，不在本模块再开一份。
//
// 本模块是 (1)↔(2) 的唯一双向映射 + 校验入口：route 入口校验、sequence 池过滤、pin
// 校验、skill 解析全部消费这里，任何一处都不再 hand-roll computation/calculation 之类
// 的特例。slice-4 落在 quiz-gen-skills.ts 的 questionKindToSkillKind /
// skillKindToQuestionKind 收编进这里（单一实现），原文件改为 re-export。

import { QuestionKind } from '@/core/schema/business';
import { type SubjectQuestionKind, SubjectQuestionKindSchema } from '@/subjects/profile-schema';
import type { z } from 'zod';

// canonical 持久题型 (core/schema/business.ts QuestionKind). 本地派生，避免耦合
// judge-routing.ts 的 QuestionKindT 别名。
type QuestionKindT = z.infer<typeof QuestionKind>;

// ── (2) → (1): profile/skill key → canonical 持久 QuestionKind ────────────────
//
// 每个 SubjectQuestionKind 归一到它落库时的持久 kind。多个 profile kind 可折叠到同一
// canonical（single_choice + multiple_choice → choice；calculation + word_problem →
// computation）—— 这是有损方向（reverse 取代表值），但 pin 校验只需「两边归一后相等」，
// 折叠不影响正确性。
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

// ── (1) → (2): canonical 持久 QuestionKind → 代表性 profile/skill key ──────────
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
 * 把**任意一套词表**的合法 kind 值归一到 canonical 持久 `QuestionKind`。
 * - 已是持久 QuestionKind（choice / computation / reading ...）→ 原样返回。
 * - profile/skill key（single_choice / calculation / reading_comprehension ...）→ 折叠到
 *   对应持久 kind。
 * - 两套都不认的值 → `null`（调用方据此 400 / 跳过，而非永败 job）。
 *
 * 这是 pin 校验的核心：请求侧与产出侧各自 normalize 后比较，reading_comprehension 请求
 * 命中 reading 产出、calculation 命中 computation。
 */
export function normalizeToCanonicalKind(value: string): QuestionKindT | null {
  if (QuestionKind.safeParse(value).success) return value as QuestionKindT;
  if (SubjectQuestionKindSchema.safeParse(value).success) {
    return SKILL_TO_CANONICAL[value as SubjectQuestionKind];
  }
  return null;
}

/**
 * 两个 kind 值（可分属不同词表）归一到 canonical 后是否同一题型。任一侧无法归一 →
 * 不视为匹配（false）。pin 校验（quiz_gen / sourcing 入库前）用它，使
 * `reading_comprehension` 请求 vs `reading` 产出、`calculation` vs `computation` 判为命中。
 */
export function kindsMatch(a: string, b: string): boolean {
  const ca = normalizeToCanonicalKind(a);
  if (ca === null) return false;
  const cb = normalizeToCanonicalKind(b);
  return cb !== null && ca === cb;
}

/**
 * 持久 `question.kind`（canonical，如 'computation'）→ profile/skill `SubjectQuestionKind`
 * （如 'calculation'）。slice-4 旧 `questionKindToSkillKind` 的语义超集：先把入参归一到
 * canonical（容忍调用方已传 profile key），再取代表 skill key；无对应 skill key 的 canonical
 * （true_false / fill_blank / essay）透传原值，保持降级链「无 skill 包 → 回退 promptFragments」。
 */
export function questionKindToSkillKind(persistedKind: string): SubjectQuestionKind {
  const canonical = normalizeToCanonicalKind(persistedKind);
  if (canonical === null) return persistedKind as SubjectQuestionKind;
  return CANONICAL_TO_SKILL[canonical] ?? (canonical as unknown as SubjectQuestionKind);
}

/**
 * `questionKindToSkillKind` 的逆：profile/skill `SubjectQuestionKind`（如 'calculation'）→
 * 落库的持久 `question.kind`（如 'computation'），让 `WHERE kind = …` 的 few-shot 过滤命中真行。
 * 等价于 normalizeToCanonicalKind 走 skill→canonical 分支；不认的值透传。
 */
export function skillKindToQuestionKind(skillKind: SubjectQuestionKind): string {
  return SKILL_TO_CANONICAL[skillKind] ?? (skillKind as string);
}

/**
 * 给定一个 canonical `QuestionKind`，返回**所有归一到它的持久 kind 形态**：canonical 自身
 * + 每个折叠到它的 SubjectQuestionKind（choice → [choice, single_choice, multiple_choice]；
 * computation → [computation, calculation, word_problem]；reading → [reading,
 * reading_comprehension]；derivation → [derivation, proof]）。
 *
 * 为什么需要这个：`business.ts` 声明 canonical = 落库真值，但 seed / fixture 写路径
 * （subjects/{math,physics,wenyan}/fixtures）历史上直接落 profile 词表
 * （single_choice / reading_comprehension / calculation），违反了该不变量。所以一个按
 * canonical `kind` 过滤的读路径若用 `eq(question.kind, 'choice')` 会漏掉所有
 * `single_choice` 行（YUK-288 题型 filter 空集 bug）。读侧用本函数把请求的 canonical 展开
 * 成 `IN (...)` 集合，命中两套词表落库的行；展示侧已由 `normalizeToCanonicalKind`
 * （meta.ts）反向归一，两侧对称。
 *
 * 入参若不是合法 canonical QuestionKind（如已是 profile key 或未知串）→ 先归一；归一不到
 * 则原样返回单元素集合（调用方据此仍做精确匹配，不放大）。
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
