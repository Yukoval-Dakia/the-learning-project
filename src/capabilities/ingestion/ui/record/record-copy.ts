// Learner words for the record page (YUK-1473). Codes and internal names never reach the screen:
// every code maps to a plain sentence here, and anything unknown gets a plain generic line.

import type { StartProblem } from './record-start';

export const STAGE_WORDS: Record<string, string> = {
  reading: '在读页面',
  segmenting: '在把题一道道分开',
  structuring: '在整理题目',
  solving: '在自己解一遍',
  calibrating: '在核对答案',
  presenting: '在排版',
  done: '整理完了',
};

export const ITEM_WORDS: Record<string, string> = {
  queued: '等着整理',
  structuring: '整理中',
  solving: '解题中',
  calibrating: '核对中',
  admitted: '已进题库',
  withheld: '进了题库，等核对',
  failed: '没整理好',
  draft: '没收进题库',
  imported: '已进题库',
  ignored: '没收',
  auto_enrolled: '已自动进题库',
  unknown: '当时的状态没记下',
};

/** Missing evidence, in the server's own terms (history evidence.missing), as plain sentences. */
export const GAP_WORDS: Record<string, string> = {
  unparsed: '这次录入有一部分过程记录读不出来，下面只列出读得出的部分。',
  expired: '过程记录已经过期，只剩下收进来的题目。',
  errors_cut: '中途出过的问题没有全部记下来。',
  items_unknown: '这次找到了哪些题，没有留下记录。',
  asks_unknown: '录入助手问过你什么，没有留下记录。',
  nothing_kept: '这次录入没有留下能读出的题目和过程记录。',
};

export const RUN_WORDS: Record<string, string> = {
  done: '整理完了',
  failed: '没整理完',
  lost: '中途断开了',
  in_progress: '没跑完',
  waiting: '停在等你回答',
};

const IN_BANK = new Set(['admitted', 'imported', 'auto_enrolled']);

/**
 * Today's state of a question, as its own line under what it was at the finish. Null when today
 * says nothing new (still in the library and served, or still waiting for the usual check).
 */
export function nowWords(
  now: { servable: boolean; holdReason: string | null } | null,
  atFinish: string,
): string | null {
  if (!now) return null;
  if (now.servable) return IN_BANK.has(atFinish) ? null : '现在：可以练了';
  const code = now.holdReason;
  if (code === 'awaiting_admission' || code === 'unverified_rules') {
    return atFinish === 'withheld' ? null : '现在：在题库里，等核对答案';
  }
  if (code === 'withdrawn') return '现在：已经撤回了';
  if (code === 'retraction_hold') return '现在：先不出，正在撤回';
  return `现在：${holdWords(code) ?? '还没出给你练。'}`;
}

const STOP_WORDS: Record<string, string> = {
  page_unreadable: '有一页看不清，换一张更清楚的照片会更好。',
  solve_timeout: '解题用的时间太长，没做完。',
  model_unavailable: '录入助手暂时用不了。',
  budget_exhausted: '这次整理用到了上限，停在了这里。',
  crop_failed: '没能把题从照片里裁出来。',
  worker_lost: '整理到一半断开了。',
  structure_failed: '没能理清这道题的结构。',
  ask_expired: '问你的问题没等到回答。',
  policy_blocked: '按你选的用途，这份材料不能交给录入助手。',
};

export function stopWords(code: string | null, scope: 'session' | 'item'): string {
  return (
    (code && STOP_WORDS[code]) || (scope === 'session' ? '整理中断了。' : '这道题出了点问题。')
  );
}

const HOLD_WORDS: Record<string, string> = {
  admission_failed: '两次独立解出的答案对不上，先不出。',
  source_check_failed: '和原题对不上，先不出。',
  verify_hold: '等你确认之后再出。',
  no_input_renderer: '这种作答方式暂时还不支持。',
  invalid_presentation: '排版有问题，先不出。',
};
/** Reasons that only mean "in the library, answer still being checked" — the normal path. */
const NORMAL_HOLDS = new Set(['awaiting_admission', 'unverified_rules']);

/**
 * Why a question in the library is held back, or null when it is just the normal wait for the
 * answer check. The helper writes its own reason: codes are translated, sentences pass through.
 */
export function holdWords(reason: string | null): string | null {
  if (!reason) return null;
  const code = reason.trim().split(/[:\s]/)[0];
  if (NORMAL_HOLDS.has(code)) return null;
  if (HOLD_WORDS[code]) return HOLD_WORDS[code];
  if (/^[a-z][a-z0-9_]*$/.test(code)) return '先不出，原因没有说清。';
  return reason;
}

export const START_WORDS: Record<StartProblem, { title: string; body: string }> = {
  quota_used: {
    title: '这周的录入助手启动额度用完了',
    body: '额度只管录入助手能不能开始整理；收进题库的核对另算。可以改用普通识别，或者下周再让录入助手来。',
  },
  quota_busy: {
    title: '另一份录入还在进行',
    body: '等它结束再开始。也可以先改用普通识别。',
  },
  quota_settling: {
    title: '上一次的费用还在结算',
    body: '稍后再试。也可以先改用普通识别。',
  },
  quota_unknown: {
    title: '暂时确认不了录入助手的每周启动额度',
    body: '这不代表额度用完了。稍后再试，或者先改用普通识别。',
  },
  agent_not_allowed: {
    title: '这份材料选了「只用来收这些题」',
    body: '这种材料不交给录入助手，改用普通识别就行。',
  },
  other: { title: '没能开始整理', body: '再试一次；还不行的话，改用普通识别。' },
};

const MASK_WORDS: Record<string, string> = {
  labeled_identity: '姓名、学校或班级',
  phone: '电话',
  labeled_contact: '微信、QQ 或地址',
  email: '邮箱',
  id_number: '身份证号或考号',
  ranking: '排名',
  credential: '密码或口令',
};

/** One receipt line: what was masked before AI saw the text, and how the pages went. */
export function receiptWords(input: {
  counts: Record<string, number>;
  pagesRaw: boolean;
  answerOnly: boolean;
}): string {
  const parts = Object.entries(input.counts)
    .filter(([, n]) => n > 0)
    .map(([code, n]) => `${MASK_WORDS[code] ?? '其他个人信息'} ${n} 处`);
  const masked =
    parts.length > 0 ? `交给 AI 前遮掉了：${parts.join('、')}。` : '文字里没发现要遮的个人信息。';
  const pages = input.pagesRaw ? '照片本身会原样交给 AI 认题。' : '';
  const use = input.answerOnly ? '这份材料只用来收这些题。' : '';
  return [masked, pages, use].filter(Boolean).join(' ');
}

/** Known notes the server keeps on a recording; anything else reads as the generic one. */
const WARNING_WORDS: Record<string, string> = {
  已忽略外部链接: 'Word 里的外部链接没有带进来。',
};

/**
 * The recording's stored notes (session.warnings) as one plain line, or null when there are none.
 * Most notes are internal reader messages, so they are never shown as they are.
 */
export function warningWords(warnings: string[]): string | null {
  if (warnings.length === 0) return null;
  const known = [...new Set(warnings.flatMap((w) => (WARNING_WORDS[w] ? [WARNING_WORDS[w]] : [])))];
  const other = warnings.some((w) => !WARNING_WORDS[w]);
  return [...known, other ? '部分内容识别质量不高，建议逐题核对。' : null]
    .filter(Boolean)
    .join(' ');
}

export function answerRejectWords(status: number, code: string | undefined): string {
  if (status === 409 && code === 'ask_already_resolved') return '这一问已经有结果了。';
  if (status === 409) return '这次回答和刚才的不一样，刷新一下再答。';
  if (status === 422 && code === 'answer_too_long') return '最多 500 字。';
  if (status === 422 && code === 'answer_empty') return '先写点内容。';
  if (status === 422 && code === 'option_not_found') return '这个选项已经不在了。';
  return '没发出去，再试一次。';
}

const dayFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

export function whenWords(ms: number | null, now: number): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? `今天 ${timeFmt.format(d)}` : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

export function materialWords(entrypoint: string | null, pages: number): string {
  if (entrypoint === 'docx') return 'Word 文件';
  if (entrypoint === 'vision_single') return '一张照片';
  return pages > 0 ? `${pages} 页材料` : '一份材料';
}
