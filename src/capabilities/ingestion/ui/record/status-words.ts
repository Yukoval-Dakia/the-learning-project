// The one sentence at the top of a recording (YUK-1473): where it is, in plain words.

import { STAGE_WORDS } from './record-copy';
import type { StartState } from './record-start';
import type { Recording } from './recording-model';

export type Tone = 'neutral' | 'working' | 'positive' | 'caution' | 'critical';

export interface StatusWords {
  text: string;
  tone: Tone;
  /** One quieter line under the sentence, when there is something everyone needs to know. */
  detail?: string;
}

export function statusWords(rec: Recording, start: StartState | null): StatusWords {
  if (rec.history === 'expired') {
    return { text: '这次录入的过程记录已经过期，只剩下收进来的题目', tone: 'neutral' };
  }
  if (rec.phase === 'not_started') {
    if (start?.status === 'starting') return { text: '正在开始整理…', tone: 'working' };
    if (start?.status === 'failed') return { text: '还没开始整理', tone: 'caution' };
    return { text: '还没开始整理', tone: 'neutral' };
  }
  if (rec.phase === 'failed') return { text: '没整理完', tone: 'critical' };

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

  if (rec.lane === 'agent') {
    const inBank = rec.items.filter((i) => i.status === 'withheld' || i.status === 'admitted');
    const failed = rec.items.filter((i) => i.status === 'failed').length;
    const tail = failed > 0 ? `，${failed} 道没整理好` : '';
    return {
      text: `整理完了：${inBank.length} 道进了题库${tail}`,
      tone: 'positive',
      detail: '录入助手自己解过每道题；答案再核对一遍之后，这些题才会出给你练。',
    };
  }
  const importable = rec.status === 'extracted' || rec.status === 'reviewed';
  const drafts = importable ? rec.blocks.filter((b) => b.status === 'draft').length : 0;
  const inBank = rec.blocks.filter((b) => b.status === 'imported' || b.status === 'auto_enrolled');
  if (drafts > 0) return { text: `认出 ${drafts} 道题，看一眼就能收进题库`, tone: 'caution' };
  if (inBank.length > 0) return { text: `${inBank.length} 道题已进题库`, tone: 'positive' };
  return { text: '没认出题目', tone: 'neutral' };
}
