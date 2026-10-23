// YUK-1473 — learner words for the 题目 library: kinds, sources, why a question is held, what a
// draft check said. Data only; components look words up here and never show a raw value.

import { QUESTION_KIND_OPTIONS } from '@/core/schema/business';

const KIND_WORDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(QUESTION_KIND_OPTIONS.map((o) => [o.id, `${o.label}题`])),
  derivation: '推导题',
  question_part: '小题',
};

export const KIND_CHOICES: ReadonlyArray<{ id: string; label: string }> = QUESTION_KIND_OPTIONS.map(
  (o) => ({ id: o.id, label: `${o.label}题` }),
);

export function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? '其他题型';
}

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  vision_single: '拍照录入',
  vision_paper: '试卷录入',
  manual: '我手动加的',
  reverse_mark: '批改过的作业',
  mistake_variant: '由错题变出',
  embedded: '课程自带',
  daily: '每日练习',
  final: '期末复习',
  dreaming: '夜里准备的',
  teaching_check: '讲解时的小检查',
  quiz_gen: 'AI 出的题',
  web_sourced: '从网上找来',
  copilot_authored: '学习伙伴出的',
};

export const SOURCE_CHOICES: ReadonlyArray<{ id: string; label: string }> = Object.entries(
  SOURCE_WORDS,
).map(([id, label]) => ({ id, label }));

export function sourceWord(source: string): string {
  return SOURCE_WORDS[source] ?? '其他来源';
}

export const DIFFICULTY_WORDS = ['', '很容易', '容易', '中等', '难', '很难'] as const;

export function difficultyWord(difficulty: number): string {
  return DIFFICULTY_WORDS[difficulty] ?? '难度不明';
}

/** Why a question is not being given out, and what it means for you. */
export const HOLD_WORDS: Readonly<Record<string, { title: string; why: string }>> = {
  awaiting_admission: { title: '还在检查', why: '刚收进来，检查完就会出给你。' },
  admission_failed: { title: '检查没通过', why: '题目或答案有问题，改好后可以重新核验。' },
  source_check_failed: { title: '出处没确认', why: '找不到可靠的出处，可以再查一次。' },
  verify_hold: { title: '等你复核', why: '答案可能有错，你看过之后可以恢复出题。' },
  retraction_hold: { title: '正在撤下', why: '这道题会被撤下；不需要的话可以删除。' },
  no_input_renderer: { title: '这里还没法作答', why: '这种作答方式还不支持，暂时不出。' },
  invalid_presentation: { title: '题面显示有问题', why: '题面渲染不完整，改好后可以重新核验。' },
  withdrawn: { title: '已撤下', why: '这道题已经撤下，不会再出给你。' },
};

export const HOLD_UNKNOWN = { title: '暂不出题', why: '原因还不确定。' };

export function holdWords(reason: string | null): { title: string; why: string } {
  return (reason && HOLD_WORDS[reason]) || HOLD_UNKNOWN;
}

export const SERVING_COMMAND_WORDS: Readonly<Record<string, string>> = {
  reverify: '重新核验',
  recheck_source: '再查出处',
  release_verify_hold: '看过了，恢复出题',
};

export const VERIFY_WORDS: Readonly<Record<string, { word: string; tone: 'neutral' | 'caution' }>> =
  {
    unverified: { word: '还没核验', tone: 'neutral' },
    needs_review: { word: '需要你看一眼', tone: 'caution' },
    failed: { word: '核验没通过', tone: 'caution' },
  };

/** Attempt outcome words for the history list. Unknown values stay neutral. */
export function outcomeWord(outcome: string): string {
  switch (outcome) {
    case 'success':
    case 'good':
      return '做对了';
    case 'partial':
    case 'hard':
      return '部分对';
    case 'failure':
    case 'again':
      return '做错了';
    case 'pending':
      return '还在判';
    default:
      return '结果还不确定';
  }
}

/**
 * What a failed check said, in plain words. The raw check text is internal and never shown; a
 * reason not listed here becomes one general sentence.
 */
const VERIFY_REASON_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['source_consistency', '题目内容和标注的来源对不上。'],
  ['source_grounding', '找不到能支撑这道题的来源。'],
  ['structure_completeness', '题目不完整，缺了题干、选项或答案中的一部分。'],
  ['solve_check', '重新解了一遍，得到的答案和参考答案不一样。'],
  ['dedup', '题库里已经有一道几乎一样的题。'],
  ['exact answer mismatch', '答案和来源里的答案对不上。'],
  ['image content was unavailable', '题目里的图没能读到，没法核对。'],
  ['knowledge point archived', '这道题练的知识点已经归档了。'],
  ['vector similarity', '和题库里另一道题很像，需要你看一眼。'],
  ['question not found', '找不到这道题了。'],
];

export const VERIFY_REASON_UNKNOWN = '核验没通过。看一眼题目和答案，改好后可以再核验一次。';

export function verifyReasonWords(raw: string | null | undefined): string {
  if (!raw) return VERIFY_REASON_UNKNOWN;
  const hit = VERIFY_REASON_WORDS.find(([key]) => raw.includes(key));
  return hit ? hit[1] : VERIFY_REASON_UNKNOWN;
}
