// The one sentence at the top of a recording (YUK-1473): where it is, in plain words.

import { STAGE_WORDS } from './record-copy';
import type { StartState } from './record-start';
import type { Recording } from './recording-model';
import { reviewOffered } from './review-check';

export type Tone = 'neutral' | 'working' | 'positive' | 'caution' | 'critical';

export interface StatusWords {
  text: string;
  tone: Tone;
  /** One quieter line under the sentence, when there is something everyone needs to know. */
  detail?: string;
}

export function statusWords(rec: Recording, start: StartState | null): StatusWords {
  if (rec.gaps.includes('expired')) {
    // Only questions with a link into the library count as taken in.
    const n = rec.items.filter((i) => i.now !== null).length;
    return {
      text: n > 0 ? `收进来 ${n} 道题` : '这次录入的过程记录已经过期',
      tone: 'neutral',
    };
  }
  if (rec.phase === 'not_started') {
    if (start?.status === 'starting') return { text: '正在开始整理…', tone: 'working' };
    if (start?.status === 'failed') return { text: '还没开始整理', tone: 'caution' };
    return { text: '还没开始整理', tone: 'neutral' };
  }
  if (rec.phase === 'failed') {
    return { text: rec.runState === 'lost' ? '整理到一半断开了' : '没整理完', tone: 'critical' };
  }

  if (rec.gaps.includes('nothing_kept')) {
    return { text: '这次录入读不出留下了什么', tone: 'neutral' };
  }

  const openAsks = rec.asks.filter((a) => a.open).length;
  const pages =
    rec.pages && rec.pages.total > 0 ? `（${rec.pages.done} / ${rec.pages.total} 页）` : '';

  if (rec.phase === 'working') {
    if (openAsks > 0) return { text: `有 ${openAsks} 处想问你，答了它才接着整理`, tone: 'caution' };
    if (rec.lane === 'agent') {
      const stage = rec.stage ? (STAGE_WORDS[rec.stage] ?? '在整理') : '在排队';
      const found = rec.items.length > 0 ? `，已找到 ${rec.items.length} 道题` : '';
      return { text: `录入助手${stage}${pages}${found}`, tone: 'working' };
    }
    return { text: `正在认题${pages}`, tone: 'working' };
  }

  if (rec.read === 'loading') return { text: '正在找回这次录入…', tone: 'neutral' };
  if (rec.read === 'unreadable') return { text: '这次录入的过程暂时读不出来', tone: 'caution' };

  if (rec.lane === 'agent') {
    if (rec.items.length === 0 && rec.gaps.length > 0) {
      return { text: '整理完了，但找到的题没有留下记录', tone: 'neutral' };
    }
    const inBank = rec.items.filter((i) => i.status === 'withheld' || i.status === 'admitted');
    const failed = rec.items.filter((i) => i.status === 'failed').length;
    const unknown = rec.items.filter((i) => i.status === 'unknown').length;
    const tail = [
      failed > 0 ? `${failed} 道没整理好` : '',
      unknown > 0 ? `${unknown} 道当时的状态没记下` : '',
    ]
      .filter(Boolean)
      .map((t) => `，${t}`)
      .join('');
    return {
      text: `整理完了：${inBank.length} 道进了题库${tail}`,
      tone: 'positive',
      detail: '录入助手自己解过每道题；答案再核对一遍之后，这些题才会出给你练。',
    };
  }
  // Nothing about the questions is said until they are actually read.
  if (rec.blocksRead === 'loading') return { text: '正在找回认出的题…', tone: 'neutral' };
  if (rec.blocksRead === 'failed') return { text: '认出的题暂时读不出来', tone: 'caution' };
  const drafts = rec.blocks.filter((b) => b.status === 'draft').length;
  const inBank = rec.blocks.filter((b) => b.status === 'imported' || b.status === 'auto_enrolled');
  if (drafts > 0 && rec.status === 'partial') {
    return {
      text: `认出 ${drafts} 道题，有的没认全`,
      tone: 'caution',
      detail: reviewOffered(rec)
        ? '这次只认出了一部分。逐道看过、点「都看过了」之后，就能收进题库。「再认一次」能让题目读得更准。'
        : '这次只认出了一部分，这次录入收不进题库。「再认一次」能让题目读得更准，但不能让它收进去。',
    };
  }
  if (drafts > 0 && rec.status === 'reviewed') {
    return {
      text: `都看过了，还有 ${drafts} 道没收进题库`,
      tone: 'caution',
      detail: '看过只是记下你核对过，题还没进题库。补好每道题缺的，再点「收进题库」。',
    };
  }
  if (drafts > 0 && rec.status === 'extracted') {
    return { text: `认出 ${drafts} 道题，看一眼就能收进题库`, tone: 'caution' };
  }
  if (inBank.length > 0) return { text: `${inBank.length} 道题已进题库`, tone: 'positive' };
  if (rec.blocks.length > 0) return { text: '这次的题没有收进题库', tone: 'neutral' };
  return { text: '没认出题目', tone: 'neutral' };
}
