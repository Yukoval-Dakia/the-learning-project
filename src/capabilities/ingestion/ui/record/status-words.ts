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

  if (rec.lane === 'agent' && rec.blocks.length === 0) {
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
  const count = (test: (e: Recording['blocks'][number]['ingestion_enrollment']) => boolean) =>
    rec.blocks.filter((b) => test(b.ingestion_enrollment)).length;
  // A plain reading can follow a helper run that stopped; its questions count here too.
  const helperIn = rec.items.filter((i) => i.status === 'withheld' || i.status === 'admitted');
  const helperFailed = rec.items.filter((i) => i.status === 'failed').length;
  const inBank =
    count((e) => e.state === 'in_library' && e.library_visible !== false) + helperIn.length;
  const pending = count((e) => e.reason === 'pending');
  const failed = count((e) => e.reason === 'publish_failed') + helperFailed;
  const noText = count((e) => e.reason === 'needs_text');
  const partly =
    rec.status === 'partial'
      ? '这次只认出了一部分，可能还有题没认出来，对照原页看一下。'
      : undefined;
  if (pending > 0) {
    return {
      text:
        inBank > 0
          ? `${inBank} 道题已进题库，另外 ${pending} 道正在进题库`
          : `${pending} 道题正在进题库`,
      tone: 'working',
      detail: partly,
    };
  }
  // In the library is not yet given out: how many still wait on the answer check, or are held.
  const servings = [...rec.blockServing.values()].filter((v) => !v.servable);
  const checking = servings.filter((v) => v.admission?.status === 'pending').length;
  const heldBack = servings.length - checking;
  const notYet = [
    checking > 0 ? `${checking} 道还在核对答案` : '',
    heldBack > 0 ? `${heldBack} 道先不出` : '',
  ]
    .filter(Boolean)
    .join('，');
  const inBankWords =
    inBank > 0 ? `${inBank} 道题已进题库${notYet ? `（其中 ${notYet}）` : ''}` : '';
  const left = [
    failed > 0 ? `${failed} 道没进题库` : '',
    noText > 0 ? `${noText} 道没认出题目` : '',
  ]
    .filter(Boolean)
    .join('，');
  if (left) {
    return {
      text: inBank > 0 ? `${inBankWords}，${left}` : left,
      tone: 'caution',
      detail: partly,
    };
  }
  if (inBank > 0) {
    return {
      text: inBankWords,
      tone: checking > 0 ? 'working' : heldBack > 0 ? 'caution' : 'positive',
      detail:
        [
          partly,
          checking > 0 ? '核对完的题才会出给你练。' : '',
          heldBack > 0 ? '先不出的原因写在每道题下面。' : '',
        ]
          .filter(Boolean)
          .join('') || undefined,
    };
  }
  if (rec.blocks.length > 0) return { text: '这次的题没有收进题库', tone: 'neutral' };
  return { text: '没认出题目', tone: 'neutral' };
}
