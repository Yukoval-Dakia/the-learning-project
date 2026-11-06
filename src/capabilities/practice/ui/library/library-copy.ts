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
  admission_undecided: { title: '这次没查出结果', why: '暂时不会出给你。' },
};

/** Where the automatic check of a new question stands. The server's reason, when given, comes first. */
export const ADMISSION_WORDS = {
  pending: { title: '还在检查', why: '刚收进来，检查完就会出给你。', tone: 'neutral' },
  admitted: { title: '检查通过', why: '', tone: 'neutral' },
  failed: { title: '检查没通过', why: '这道题暂时不会出给你。', tone: 'caution' },
  undecided: { title: '这次没查出结果', why: '暂时不会出给你。', tone: 'caution' },
} as const;

export const HOLD_UNKNOWN = { title: '暂不出题', why: '原因还不确定。' };

/** Why it is held: the automatic check's own state first, so a new question is never 「原因还不确定」. */
export function holdKey(serving: {
  hold_reason: string | null;
  admission?: { status: keyof typeof ADMISSION_WORDS } | null;
}): string | null {
  switch (serving.admission?.status) {
    case 'pending':
      return 'awaiting_admission';
    case 'failed':
      return 'admission_failed';
    case 'undecided':
      return 'admission_undecided';
    default:
      return serving.hold_reason;
  }
}

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
 * What a verify request came back with when it did not enable the question, by the typed status
 * the server returns. The check's own reason is not rewritten here: the question page shows it
 * as written (verify_reason). A skipped status means no check ran, so it never says "没通过".
 */
const VERIFY_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  failed: '核验没通过，原因写在题目上方。',
  needs_review: '核验没下定论，需要你看一眼，原因写在题目上方。',
  'skipped:unsupported_source': '这道题的来源还不能核验，这次没有核验，也没有启用。',
  'skipped:not_draft': '这道题已经不在待审核里了。',
  'skipped:archived_draft': '这道题已经归档或被拒，不能再启用。',
  'skipped:archived_knowledge': '这道题练的知识点已经归档，不能启用。',
  'skipped:question_part': '这是大题里的一小问，要随整道题一起核验。',
  'skipped:not_found': '找不到这道题了。',
};

export function verifyOutcomeWords(status: string): string {
  return VERIFY_OUTCOME_WORDS[status] ?? `这次没有启用（${status}）。`;
}
