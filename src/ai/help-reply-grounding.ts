// I02-C12 ReadReplyGrounding. A gold case applies only when the question stem
// matches that case. The checker sees the explanation, not the sealed gloss.
// A correct claim stays; a failed claim is replaced before publication.
// Unknown cost stays null. Early hints do not receive the numeric monotonic answer.

import { createHash } from 'node:crypto';
import type { HelpCost } from '@/ai/help-latency';

export type HelpExplanationTopic = 'union' | 'monotonic_interval' | 'legal_alternate';

export type HelpExplanationVerdict = 'pass' | 'fail' | 'ungrounded';

export interface HelpExplanationEvidence {
  readonly task_run_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly cost: HelpCost;
}

export interface SealedHelpExplanationReplay {
  readonly kind: 'help_explanation_replay';
  readonly blind: true;
  readonly gold_ids: readonly string[];
  readonly verdict: HelpExplanationVerdict;
  readonly published_source: 'model' | 'sealed_gloss';
  readonly input_digest: string;
  readonly output_digest: string;
  readonly published_digest: string;
  readonly task_run_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly cost: HelpCost;
}

interface HelpExplanationGold {
  readonly id: string;
  readonly topic: HelpExplanationTopic;
  /** Folded fragment that identifies this question. Explanation text alone does not. */
  readonly stem_key: string;
  readonly prompt_md: string;
  readonly learner_form: string;
  readonly sealed_gloss: string;
  readonly hint_gloss: string;
}

const FULL_EXPLANATION_INDEX = 5;
const DIGEST = /^[a-f0-9]{64}$/;
const NEGATIONS = ['并不是', '不是', '并非', '并不', '不能', '而非', '不要'];
const UNION_PASS = ['属于任一段', '任一段即可', '至少一段', '任意一段', '其中任一段'];
const CORRECT_INTERVALS = new Set(['(-∞,2-√3)', '(2+√3,+∞)', '(2+√3,∞)', '(2-√3,2+√3)']);

/** Explainer-visible face. Sealed glosses stay out of this object and its digest. */
export const HELP_EXPLANATION_GOLD: readonly HelpExplanationGold[] = [
  {
    id: 'union-either',
    topic: 'union',
    stem_key: 'x+1/x-2',
    prompt_md: '已知函数 $f(x)=\\dfrac{x+1}{x-2}$，求其定义域。',
    learner_form: '(-∞,2)∪(2,+∞)',
    sealed_gloss:
      '∪ 是并集：属于任一段即可，不是同时属于两段。区间并集、集合描述和不等式可以是同一种合法定义域。',
    hint_gloss:
      '∪ 是并集：属于任一段即可，不是同时属于两段。区间并集、集合描述和不等式可以是同一种合法定义域。',
  },
  {
    id: 'monotonic-m03',
    topic: 'monotonic_interval',
    stem_key: 'x^3-3ax^2+3x+1',
    prompt_md:
      '已知函数 $f(x)=x^3-3ax^2+3x+1$。（1）当 $a=2$ 时，求 $f(x)$ 的单调区间；（2）若 $f(x)$ 在区间 $(2,3)$ 内至少有一个极值点，求 $a$ 的取值范围。',
    learner_form: '增区间 (-∞,2-√3)∪(2+√3,+∞)；减区间 (2-√3,2+√3)',
    sealed_gloss:
      '当 a=2 时，增区间是 (-∞,2-√3) 与 (2+√3,+∞)，写成并集 (-∞,2-√3)∪(2+√3,+∞) 仍是同一种合法答案；减区间是 (2-√3,2+√3)。a 的范围是 5/4<a<5/3，两端等号不成立。',
    hint_gloss:
      '增区间在两根外侧，减区间在两根之间。两个增区间写成并集仍是同一种合法写法。端点的开闭不能收成闭区间。',
  },
  {
    id: 'union-closure-0',
    topic: 'legal_alternate',
    stem_key: '(0,1)∪[0,2)',
    prompt_md: '把 (0,1)∪[0,2) 收成一个区间，并说明 0 在不在里面。',
    learner_form: '(0,1)∪[0,2)',
    sealed_gloss: '(0,1)∪[0,2) 的并集是 [0,2)。0 属于第二段，所以并集含 0，不能收成 (0,2)。',
    hint_gloss: '(0,1)∪[0,2) 的并集是 [0,2)。0 属于第二段，所以并集含 0，不能收成 (0,2)。',
  },
];

export function blindReplayFace(prompt: string, golds: readonly HelpExplanationGold[]) {
  return {
    prompt_md: prompt,
    cases: golds.map((gold) => ({
      id: gold.id,
      topic: gold.topic,
      prompt_md: gold.prompt_md,
      learner_form: gold.learner_form,
    })),
  };
}

export function replayHelpExplanation(input: {
  prompt: string;
  explanation: string;
  hintIndex: number;
  evidence: HelpExplanationEvidence;
}): { text_md: string; replay: SealedHelpExplanationReplay | null } {
  const checked = HELP_EXPLANATION_GOLD.flatMap((gold) => {
    const verdict = checkGold(gold, input.prompt, input.explanation);
    return verdict === 'not_applicable' ? [] : [{ gold, verdict }];
  });
  if (checked.length === 0) return { text_md: input.explanation, replay: null };

  const failed = checked.filter((item) => item.verdict === 'fail');
  const verdict: HelpExplanationVerdict =
    failed.length > 0
      ? 'fail'
      : checked.some((item) => item.verdict === 'pass')
        ? 'pass'
        : 'ungrounded';
  const text_md =
    failed.length === 0
      ? input.explanation
      : failed.map((item) => gloss(item.gold, input.hintIndex)).join('\n');
  const face = blindReplayFace(
    input.prompt,
    checked.map((item) => item.gold),
  );
  return {
    text_md,
    replay: {
      kind: 'help_explanation_replay',
      blind: true,
      gold_ids: checked.map((item) => item.gold.id),
      verdict,
      published_source: failed.length === 0 ? 'model' : 'sealed_gloss',
      input_digest: sha256(JSON.stringify(face)),
      output_digest: sha256(input.explanation),
      published_digest: sha256(text_md),
      task_run_id: input.evidence.task_run_id,
      provider: input.evidence.provider,
      model: input.evidence.model,
      cost: input.evidence.cost,
    },
  };
}

export function readReplyGrounding(value: unknown): SealedHelpExplanationReplay | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'help_explanation_replay' || record.blind !== true) return undefined;
  if (record.verdict !== 'pass' && record.verdict !== 'fail' && record.verdict !== 'ungrounded') {
    return undefined;
  }
  if (record.published_source !== 'model' && record.published_source !== 'sealed_gloss') {
    return undefined;
  }
  if (!isDigest(record.input_digest) || !isDigest(record.output_digest)) return undefined;
  if (!isDigest(record.published_digest)) return undefined;
  if (!Array.isArray(record.gold_ids) || record.gold_ids.some((id) => typeof id !== 'string')) {
    return undefined;
  }
  const cost = readCost(record.cost);
  if (!cost) return undefined;
  return {
    kind: 'help_explanation_replay',
    blind: true,
    gold_ids: record.gold_ids as string[],
    verdict: record.verdict,
    published_source: record.published_source,
    input_digest: record.input_digest,
    output_digest: record.output_digest,
    published_digest: record.published_digest,
    task_run_id: optionalId(record.task_run_id),
    provider: optionalId(record.provider),
    model: optionalId(record.model),
    cost,
  };
}

function gloss(gold: HelpExplanationGold, hintIndex: number): string {
  return hintIndex < FULL_EXPLANATION_INDEX ? gold.hint_gloss : gold.sealed_gloss;
}

function checkGold(
  gold: HelpExplanationGold,
  prompt: string,
  explanation: string,
): HelpExplanationVerdict | 'not_applicable' {
  if (!fold(prompt).includes(gold.stem_key)) return 'not_applicable';
  if (gold.topic === 'union') return checkUnion(explanation);
  if (gold.topic === 'monotonic_interval') return checkMonotonic(explanation);
  return checkClosure(explanation);
}

function checkUnion(explanation: string): HelpExplanationVerdict | 'not_applicable' {
  return walkClaims(fold(explanation), ['同时属于'], UNION_PASS);
}

function checkMonotonic(explanation: string): HelpExplanationVerdict | 'not_applicable' {
  const text = fold(explanation);
  if (!mentionsMonotonic(text)) return 'not_applicable';
  const range = readARange(text);
  const intervals = readIntervals(text);
  const labeled = readLabels(text);
  if (range === 'wrong' || intervals === 'wrong' || labeled === 'wrong') return 'fail';
  if (range === 'right' || intervals === 'right' || labeled === 'right') return 'pass';
  return 'ungrounded';
}

function checkClosure(explanation: string): HelpExplanationVerdict | 'not_applicable' {
  const text = fold(explanation);
  if (!text.includes('(0,1)∪[0,2)')) return 'not_applicable';
  const claimed = text.split('(0,1)∪[0,2)').join('');
  return walkClaims(claimed, ['(0,2)', '丢掉闭', '不含0'], ['[0,2)', '并集含0', '含0']);
}

function mentionsMonotonic(text: string): boolean {
  return (
    text.includes('增') ||
    text.includes('减') ||
    text.includes('2-√3') ||
    text.includes('2+√3') ||
    text.includes('5/4') ||
    text.includes('5/3')
  );
}

function readARange(text: string): 'right' | 'wrong' | 'absent' {
  if (!text.includes('5/4') && !text.includes('5/3')) return 'absent';
  if (text.includes('5/4<a<5/3') || text.includes('(5/4,5/3)')) return 'right';
  return 'wrong';
}

function readIntervals(text: string): 'right' | 'wrong' | 'absent' {
  const claims = intervalClaims(text);
  const asserted = claims.filter((claim) => claim.asserted);
  if (asserted.length === 0) return 'absent';
  for (const claim of asserted) {
    if (!CORRECT_INTERVALS.has(claim.token)) return 'wrong';
    const middle = claim.token === '(2-√3,2+√3)';
    if (middle && claim.sign === '增') return 'wrong';
    if (!middle && claim.sign === '减') return 'wrong';
  }
  return 'right';
}

function intervalClaims(text: string): Array<{
  token: string;
  sign: '增' | '减' | null;
  asserted: boolean;
}> {
  const claims = [];
  const pattern = /[([][^()[\]]{0,48}[)\]]/g;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (!token.includes('√3')) continue;
    const at = match.index ?? 0;
    const before = text.slice(clauseStart(text, at), at);
    const after = text.slice(at + token.length, at + token.length + 6);
    const rejected =
      before.includes('不是') ||
      /写成了|误写|错写|错成/.test(before) ||
      /^(不对|不是|错误|有误)/.test(after);
    claims.push({ token, sign: signBefore(text, at), asserted: !rejected });
  }
  return claims;
}

function readLabels(text: string): 'right' | 'wrong' | 'absent' {
  const outer = signNear(text, ['两根外侧', '外侧', '两端']);
  const middle = signNear(text, ['两根之间', '中间']);
  if (outer === '减' || middle === '增') return 'wrong';
  if (outer === '增' || middle === '减') return 'right';
  return 'absent';
}

function signNear(text: string, markers: readonly string[]): '增' | '减' | null {
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const sentence = text.slice(sentenceStart(text, at), sentenceEnd(text, at));
    const local = at - sentenceStart(text, at);
    return nearestSign(sentence, local);
  }
  return null;
}

function nearestSign(sentence: string, markerAt: number): '增' | '减' | null {
  let best: { distance: number; sign: '增' | '减' } | null = null;
  for (const sign of ['增', '减'] as const) {
    let from = 0;
    while (from < sentence.length) {
      const at = sentence.indexOf(sign, from);
      if (at < 0) break;
      const distance = Math.abs(at - markerAt);
      if (!best || distance < best.distance) best = { distance, sign };
      from = at + sign.length;
    }
  }
  return best?.sign ?? null;
}

function signBefore(text: string, at: number): '增' | '减' | null {
  const prefix = text.slice(sentenceStart(text, at), at);
  const inc = prefix.lastIndexOf('增');
  const dec = prefix.lastIndexOf('减');
  if (inc < 0 && dec < 0) return null;
  return inc > dec ? '增' : '减';
}

// NFKC folds the clause comma into the same ',' an interval uses. A comma
// inside brackets stays in that interval, so「不是」covers the whole union.
function clauseStart(text: string, at: number): number {
  const sentence = sentenceStart(text, at);
  let depth = 0;
  for (let i = at - 1; i >= sentence; i -= 1) {
    const ch = text[i];
    if (ch === ')' || ch === ']') depth += 1;
    else if (ch === '(' || ch === '[') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ',' || ch === '，')) return i + 1;
  }
  return sentence;
}

function sentenceStart(text: string, at: number): number {
  let start = 0;
  for (const mark of ['。', '！', '？', '\n', '；', ';']) {
    const found = text.lastIndexOf(mark, at - 1);
    if (found >= start) start = found + 1;
  }
  return start;
}

function sentenceEnd(text: string, at: number): number {
  let end = text.length;
  for (const mark of ['。', '！', '？', '\n', '；', ';']) {
    const found = text.indexOf(mark, at);
    if (found >= 0 && found < end) end = found;
  }
  return end;
}

function walkClaims(
  text: string,
  failPhrases: readonly string[],
  passPhrases: readonly string[],
): HelpExplanationVerdict | 'not_applicable' {
  const claims: Array<{ kind: 'fail' | 'pass'; negated: boolean }> = [];
  for (const sentence of text.split(/[。！？\n；;]/)) {
    const marks = scanMarks(sentence, failPhrases, passPhrases);
    for (const mark of marks) {
      if (mark.kind === 'neg') continue;
      claims.push({ kind: mark.kind, negated: negationGoverns(sentence, marks, mark.at) });
    }
  }
  if (claims.length === 0) return 'not_applicable';
  if (claims.some((claim) => claim.kind === 'fail' && !claim.negated)) return 'fail';
  if (claims.some((claim) => claim.kind === 'pass' && claim.negated)) {
    return claims.some((claim) => claim.kind === 'pass' && !claim.negated) ? 'pass' : 'fail';
  }
  if (claims.some((claim) => claim.kind === 'pass')) return 'pass';
  return 'ungrounded';
}

function scanMarks(
  sentence: string,
  failPhrases: readonly string[],
  passPhrases: readonly string[],
): Array<{ at: number; kind: 'neg' | 'fail' | 'pass'; length: number }> {
  const marks: Array<{ at: number; kind: 'neg' | 'fail' | 'pass'; length: number }> = [];
  let index = 0;
  while (index < sentence.length) {
    const negation = matchAt(sentence, index, NEGATIONS);
    const failed = matchAt(sentence, index, failPhrases);
    const passed = matchAt(sentence, index, passPhrases);
    const bareNot =
      sentence.startsWith('不', index) && matchAt(sentence, index + 1, passPhrases)
        ? '不'
        : undefined;
    const chosen = longestMark(
      negation ? { kind: 'neg' as const, phrase: negation } : undefined,
      bareNot ? { kind: 'neg' as const, phrase: bareNot } : undefined,
      failed ? { kind: 'fail' as const, phrase: failed } : undefined,
      passed ? { kind: 'pass' as const, phrase: passed } : undefined,
    );
    if (!chosen) {
      index += 1;
      continue;
    }
    marks.push({ at: index, kind: chosen.kind, length: chosen.phrase.length });
    index += chosen.phrase.length;
  }
  return marks;
}

function longestMark(
  ...options: Array<{ kind: 'neg' | 'fail' | 'pass'; phrase: string } | undefined>
): { kind: 'neg' | 'fail' | 'pass'; phrase: string } | undefined {
  return options.reduce<{ kind: 'neg' | 'fail' | 'pass'; phrase: string } | undefined>(
    (best, option) => {
      if (!option) return best;
      if (!best || option.phrase.length > best.phrase.length) return option;
      return best;
    },
    undefined,
  );
}

function negationGoverns(
  sentence: string,
  marks: ReadonlyArray<{ at: number; kind: 'neg' | 'fail' | 'pass'; length: number }>,
  claimAt: number,
): boolean {
  const prior = marks.filter((mark) => mark.kind === 'neg' && mark.at < claimAt).at(-1);
  if (!prior) return false;
  if (marks.some((mark) => mark.kind !== 'neg' && mark.at > prior.at && mark.at < claimAt)) {
    return false;
  }
  const gap = sentence.slice(prior.at + prior.length, claimAt);
  return gap.length === 0 || /^(?:是|表示|指|在说|说)*$/.test(gap);
}

function matchAt(text: string, index: number, phrases: readonly string[]): string | undefined {
  return phrases
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((phrase) => text.startsWith(phrase, index));
}

function fold(text: string): string {
  let folded = text.normalize('NFKC').replace(/\$/g, '').replace(/−/g, '-');
  folded = folded.replace(/\\left|\\right/g, '');
  folded = folded.replace(/\\(?:d|t)?frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2');
  folded = folded.replace(/\\(?:d|t)?frac(\d)(\d)/g, '$1/$2');
  folded = folded.replace(/\\(?:geq|ge)/g, '≥');
  folded = folded.replace(/\\cup/g, '∪');
  folded = folded.replace(/\\infty/g, '∞');
  folded = folded.replace(/\\sqrt\{([^{}]+)\}/g, '√$1');
  folded = folded.replace(/\\sqrt/g, '√');
  folded = folded.replace(/\\(?:leq|le)/g, '≤');
  folded = folded.replace(/\\,/g, '');
  folded = folded.replace(/[{}\\]/g, '');
  return folded.replace(/\s+/g, '');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function optionalId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readCost(value: unknown): HelpCost | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const cost = value as { basis?: unknown; usd?: unknown };
  if (cost.basis === 'unknown' && cost.usd === null) return { basis: 'unknown', usd: null };
  if (
    (cost.basis === 'reported' || cost.basis === 'estimated') &&
    typeof cost.usd === 'number' &&
    Number.isFinite(cost.usd) &&
    cost.usd >= 0
  ) {
    return { basis: cost.basis, usd: cost.usd };
  }
  return undefined;
}
