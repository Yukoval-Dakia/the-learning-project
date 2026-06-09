// YUK-288 题库 UI — metadata maps (kind / source / difficulty / grounding tier →
// 中文 label + LoomIcon name + tone). The design mock used a 5-value kind set
// (mcq/short/trans/cloze/reading) and a 4-value source set (seed/quiz/exam/
// variant); the REAL API uses the canonical enums (QuestionKind / QuestionSource
// in src/core/schema/business.ts). This module is the UI mapping layer — it never
// changes the API to fit the mock's names. Unknown values degrade to a neutral
// fallback rather than throwing (the enums grow zero-DDL; a新 source value must
// still render).

import { normalizeToCanonicalKind } from '@/subjects/question-kind';
import type { LoomBadgeTone } from '@/ui/primitives/LoomBadge';
import type { LoomIconName } from '@/ui/primitives/LoomIcon';

export interface KindMeta {
  label: string;
  icon: LoomIconName;
}

export interface SourceMeta {
  label: string;
  icon: LoomIconName;
  tone: 'neutral' | 'info' | 'coral';
}

export type DifficultyTone = 'good' | 'hard' | 'again';

export interface DifficultyMeta {
  tone: DifficultyTone;
  word: string;
}

// canonical QuestionKind → 中文. Keys are the real persisted `kind` strings.
const KIND_META: Record<string, KindMeta> = {
  choice: { label: '单选', icon: 'list' },
  true_false: { label: '判断', icon: 'check' },
  fill_blank: { label: '填空', icon: 'hash' },
  short_answer: { label: '简答', icon: 'pencil' },
  essay: { label: '论述', icon: 'pencil' },
  computation: { label: '计算', icon: 'bolt' },
  reading: { label: '阅读理解', icon: 'doc' },
  translation: { label: '翻译', icon: 'book' },
  derivation: { label: '推导', icon: 'fx' },
  // composite小题 marker (parts.ts) — surfaced if a part row ever reaches a face.
  question_part: { label: '小题', icon: 'layers' },
};

const KIND_FALLBACK: KindMeta = { label: '题目', icon: 'quiz' };

export function kindMeta(kind: string): KindMeta {
  // The list/detail readers return the RAW persisted `kind`, which for subject
  // datasets is the profile/skill vocabulary (single_choice / reading_comprehension
  // / calculation …) rather than canonical QuestionKind (choice / reading /
  // computation …). Fold to canonical first via the single authoritative seam
  // (src/subjects/question-kind.ts) so subject rows show 单选 / 阅读理解 instead of
  // the 题目 fallback. A canonical value passes through unchanged; a genuinely
  // unknown value (neither vocabulary) stays on the fallback.
  const canonical = normalizeToCanonicalKind(kind) ?? kind;
  return KIND_META[canonical] ?? KIND_FALLBACK;
}

// canonical QuestionSource → 中文 + tone. The list's 来源 axis filters on the real
// `source` value (not the derived grounding tier — see groundingTierMeta below).
const SOURCE_META: Record<string, SourceMeta> = {
  manual: { label: '手动录入', icon: 'pencil', tone: 'neutral' },
  embedded: { label: '随文小测', icon: 'teach', tone: 'info' },
  daily: { label: '每日一题', icon: 'today', tone: 'info' },
  final: { label: '阶段卷', icon: 'doc', tone: 'info' },
  dreaming: { label: '夜间生成', icon: 'sparkle', tone: 'coral' },
  vision_single: { label: '拍照单题', icon: 'camera', tone: 'info' },
  vision_paper: { label: '试卷录入', icon: 'camera', tone: 'info' },
  reverse_mark: { label: '反向标注', icon: 'reverse', tone: 'neutral' },
  mistake_variant: { label: '错题变体', icon: 'sparkle', tone: 'coral' },
  teaching_check: { label: '教学小测', icon: 'teach', tone: 'info' },
  quiz_gen: { label: 'AI 组卷', icon: 'sparkle', tone: 'coral' },
  web_sourced: { label: '网络题源', icon: 'link', tone: 'info' },
  synthetic_seed: { label: '种子数据', icon: 'layers', tone: 'neutral' },
  // ADR-0031 / YUK-304 (lane B) — copilot 对话内拟题 (author_question knowledge|material seed).
  copilot_authored: { label: 'Copilot 拟题', icon: 'sparkle', tone: 'coral' },
};

const SOURCE_FALLBACK: SourceMeta = { label: '其它来源', icon: 'layers', tone: 'neutral' };

export function sourceMeta(source: string): SourceMeta {
  return SOURCE_META[source] ?? SOURCE_FALLBACK;
}

// 1-5 difficulty → tone + 中文词 (mirrors the design QDIFF map).
const DIFFICULTY_META: Record<number, DifficultyMeta> = {
  1: { tone: 'good', word: '易' },
  2: { tone: 'good', word: '较易' },
  3: { tone: 'hard', word: '中等' },
  4: { tone: 'again', word: '较难' },
  5: { tone: 'again', word: '难' },
};

const DIFFICULTY_FALLBACK: DifficultyMeta = { tone: 'hard', word: '中等' };

export function difficultyMeta(d: number): DifficultyMeta {
  return DIFFICULTY_META[d] ?? DIFFICULTY_FALLBACK;
}

// derived grounding tier (1 authentic → 4 generated) → micro-indicator label +
// badge tone. Secondary to `source`; surfaces provenance confidence.
const TIER_LABEL: Record<number, { label: string; tone: LoomBadgeTone }> = {
  1: { label: '真题', tone: 'good' },
  2: { label: '网源', tone: 'info' },
  3: { label: '材料生成', tone: 'neutral' },
  4: { label: 'AI 生成', tone: 'coral' },
};

export function groundingTierMeta(tier: number): { label: string; tone: LoomBadgeTone } {
  return TIER_LABEL[tier] ?? { label: '未知来源', tone: 'neutral' };
}

// MCQ choice key derivation: choices_md is an ordered string[] with NO embedded
// key (the design mock carried {key,text}); index → A/B/C/D… is derived here so
// the option editor and the answer match share one source of truth.
export function choiceKey(index: number): string {
  // 26 letters then wrap to A1/B1… — defensive; real MCQs never exceed ~6 options.
  if (index < 26) return String.fromCharCode(65 + index);
  return `${String.fromCharCode(65 + (index % 26))}${Math.floor(index / 26)}`;
}

// lineage glyph for the list rail (mock used ◆ root / ◇ variant / ▫ part).
export function lineageGlyph(item: {
  root_question_id: string | null;
  parent_question_id: string | null;
}): { glyph: string; cls: string; title: string } {
  if (item.parent_question_id !== null) {
    return { glyph: '▫', cls: 'is-part', title: '小题' };
  }
  if (item.root_question_id !== null) {
    return { glyph: '◇', cls: 'is-variant', title: 'AI 变体' };
  }
  return { glyph: '◆', cls: '', title: '母题' };
}
