// Answer comparison owner.
//
// One place answers "is this answer the same as this key?": the frozen
// normalization version selects the concrete folding here, from the frozen
// criterion itself. Callers pass the frozen unit/key and never choose a version,
// fold text or re-implement the comparison. The pre-freeze legacy exact judge
// and the solve-check answer identity live here too, so the same question is
// answered once.
//
// Invariants:
//   - Versions are frozen per revision: answer_head@2 / blank-norm@2 /
//     numeric-norm@2 are the current contracts; answer_head / blank-norm@1 /
//     numeric-norm@1 (and a missing numeric version) keep their historical
//     NFKC semantics byte-for-byte. A numeric literal keeps its float64 reading
//     when its exact value matches that float's round-trip spelling; a neighbor
//     integer does not. ignore_punctuation keeps a numeric minus and decimal
//     point. Neither rule is a new normalization version.
//   - A comparison that cannot decide (unparseable, ambiguous, beyond the
//     comparator contract) is reported as undecidable with a reason; callers
//     turn that into pending, never a fake zero.
//   - No caller-facing version parameter: the version is read from the frozen
//     criterion, so a new comparison site cannot pick or forget one.
import { normalizeAnswerWidth, normalizeNumericAnswer } from '../answer-normalization';
import {
  type DeclaredPrivateKey,
  type NumericTolerance,
  compileDeclaredKey,
  compiledCanonicalOf,
  declaredRationalValueOf,
} from './blank-answer-compare';
import type { BlankAnswerShapeT } from './blank-answer-shape';
import type { BlankKeyCriterionT, BlankNormalizationT, TextKeyCriterionT } from './scoring';

// ====================================================================
// Current contract versions (the only definitions of "new default")
// ====================================================================

/** Normalization a newly minted blank text key carries. */
export const CURRENT_BLANK_NORMALIZATION: BlankNormalizationT = {
  version: 'blank-norm@2',
  nfkc: true,
  trim_outer: true,
  casefold: false,
  collapse_whitespace: true,
  ignore_punctuation: false,
  character_variants: [],
};

/** Numeric normalization a newly minted numeric key carries. */
export const CURRENT_NUMERIC_NORMALIZATION_VERSION = 'numeric-norm@2' as const;

/** Text-key normalization a newly minted text key carries. */
export const CURRENT_TEXT_KEY_NORMALIZATION = 'answer_head@2' as const;

export type NumericNormalizationVersionT = 'numeric-norm@1' | 'numeric-norm@2';

// ====================================================================
// Answer head extraction (legacy exact contract)
// ====================================================================

// web-sourced reference_md stores several producer conventions:
//   "（C）选项原文\n\n解析：…"          (jyeoo parenthesized head)
//   "C.0.432\n\n解析：…" / "B．0.4\n\n【详解】…"
//   "**C. 0.950**\n\n解析：…"          (markdown emphasis wrapper)
//   "$D(X+Y)=…$（选项 D）。\n\n解析：…"  (option text + trailing 选项 note)
//   "【答案】{2,3}\n【分析】…\n【解答】…" (jyeoo block format, single \n)
// Only the bare-answer head is judgeable by string equality; the tail is
// explanation prose no learner submission can reproduce verbatim.
const ANSWER_BLOCK_RE = /【\s*答案\s*】\s*([^\n【]+)/;
const EXPLANATION_TAIL_RE =
  /\n+\s*(?:【\s*(?:解析|详解|解答|分析|点评|点拨|答案解析)\s*】|\**\s*(?:解析|详解|解答|证明|分析|点评|点拨)\s*[：:])/;
const LEADING_ANSWER_MARKER_RE = /^(?:答案|答|解)\s*[：:．.]\s*/;

// Trailing-junk stripping, shared by both head-extraction branches. The previous
// end-anchored regex had overlapping whitespace alternatives, so V8 enumerated an
// exponential number of partitions on a ~140-char learner submission (the API allows
// 12 000 chars) before concluding it did not match. stripTrailingJunk accepts the same
// language in linear time: the trailing run is the longest suffix that is a
// concatenation of tokens, each either
//   (a) one junk char (whitespace or the punctuation/`*` set), or
//   (b) optional whitespace + '(' / '（' + whitespace + 选项|正确答案 + whitespace +
//       0-4 [A-Z] + whitespace + optional ')' / '）' annotation.
const JUNK_CHAR_RE = /[\s。．.，,；;：:、*]/;
const WHITESPACE_CHAR_RE = /\s/;
const OPTION_ANNOTATION_KEYWORDS = ['选项', '正确答案'] as const;

/** ASCII-only `[A-Z]` membership (the retired regex's letter class). */
function isAsciiUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

/**
 * True when an option annotation (`(选项…)` / `（正确答案…）`) that starts at `i`
 * can end at some `j` whose `reachable[j]` is already known. `reachable[k]`
 * means `s.slice(k)` is a tokenizable junk run.
 */
function optionAnnotationReachesEnd(s: string, i: number, reachable: boolean[]): boolean {
  let p = i + 1;
  while (p < s.length && WHITESPACE_CHAR_RE.test(s[p] as string)) p += 1;
  let afterKeyword = -1;
  for (const keyword of OPTION_ANNOTATION_KEYWORDS) {
    if (s.startsWith(keyword, p)) {
      afterKeyword = p + keyword.length;
      break;
    }
  }
  if (afterKeyword === -1) return false;

  let q = afterKeyword;
  while (q < s.length && WHITESPACE_CHAR_RE.test(s[q] as string)) q += 1;

  for (let count = 0; count <= 4; count += 1) {
    if (count > 0 && !isAsciiUpper(s[q + count - 1] as string)) break;
    const letterEnd = q + count;
    // `\s*` may stop anywhere before the optional closing paren.
    let r = letterEnd;
    while (r < s.length && WHITESPACE_CHAR_RE.test(s[r] as string)) r += 1;
    for (let j = letterEnd; j <= r; j += 1) {
      if (reachable[j]) return true;
    }
    if (r < s.length && (s[r] === ')' || s[r] === '）') && reachable[r + 1]) return true;
  }
  return false;
}

/**
 * Strip the maximal trailing "junk" run — the token language is documented on
 * the block comment above. Equivalent to `s.replace(TRAILING_JUNK_RE, '')` for
 * the retired expression, but linear-time (no overlapping alternation).
 */
function stripTrailingJunk(s: string): string {
  const n = s.length;
  if (n === 0) return s;
  const reachable = new Array<boolean>(n + 1).fill(false);
  reachable[n] = true;
  for (let i = n - 1; i >= 0; i -= 1) {
    const ch = s[i] as string;
    if (reachable[i + 1] && JUNK_CHAR_RE.test(ch)) {
      reachable[i] = true;
      continue;
    }
    if (ch === '(' || ch === '（') {
      reachable[i] = optionAnnotationReachesEnd(s, i, reachable);
    }
  }
  let start = 0;
  while (start < n && !reachable[start]) start += 1;
  return start === n ? s : s.slice(0, start);
}

/** The two frozen answer-head contracts: legacy NFKC, or width-folded @2. */
type AnswerHeadPolicy = 'legacy' | 'answer_head@2';

function foldForAnswerHeadPolicy(s: string, policy: AnswerHeadPolicy): string {
  return (policy === 'answer_head@2' ? normalizeAnswerWidth(s) : s.normalize('NFKC')).trim();
}

/**
 * The bare-answer head of a reference/answer blob: normalize Unicode, strip edge
 * markdown emphasis, extract a 【答案】block when present, strip a leading
 * "答："/"解：" marker, cut the first newline-separated explanation tail
 * ("解析：…" / "【详解】…" …), then trim trailing punctuation and "(选项 D)"
 * annotations. Returns the trimmed head; falls back to the normalized input
 * when stripping would leave nothing (pure worked-solution blobs).
 */
function extractAnswerHeadWithPolicy(s: string, policy: AnswerHeadPolicy): string {
  const t = foldForAnswerHeadPolicy(s, policy);
  const unwrapped = t.replace(/^[*_]{1,3}\s*/, '').replace(/[*_\s]{1,3}$/, '');
  const block = unwrapped.match(ANSWER_BLOCK_RE);
  if (block?.[1]) {
    const head = stripTrailingJunk(block[1]).trim();
    if (head.length > 0) return head;
  }
  const lead = unwrapped.replace(LEADING_ANSWER_MARKER_RE, '');
  const m = lead.match(EXPLANATION_TAIL_RE);
  const head = stripTrailingJunk(m ? lead.slice(0, m.index) : lead)
    .replace(/^[*_\s]+/, '')
    .trim();
  return head.length > 0 ? head : t;
}

/** The frozen legacy answer head (NFKC + explanation-tail strip). */
export function extractAnswerHead(s: string): string {
  return extractAnswerHeadWithPolicy(s, 'legacy');
}

/**
 * Answer head under a frozen text-key normalization basis: a row with no frozen
 * basis is minted under the current default (@2); a frozen non-@2 basis keeps
 * its historical head contract.
 */
export function extractAnswerHeadForFrozenBasis(
  s: string,
  normalization: TextKeyNormalizationT | null,
): string {
  return extractAnswerHeadWithPolicy(
    s,
    normalization == null || normalization === CURRENT_TEXT_KEY_NORMALIZATION
      ? 'answer_head@2'
      : 'legacy',
  );
}

const SOLUTION_BLOB_RE = /解析|详解|解答|证明|【解|【答/;
const MAX_EXACT_HEAD_LEN = 300;

// ====================================================================
// 过程作答的【终态答案】提取（确定性、保守、绝不"最后数字获胜"）
// ====================================================================
//
// 主解答槽的学习者文本可以是完整推导（"…q=-2，S5=11"）。整段做答案头比较
// 必然 miss —— 这是过程作答被误判 0 分的机制。本提取器只认【明示终态结论】：
//   1. 结论标记行/从句：答 / 答案 / 最终答案 / 综上 / 所以 / 因此 / 故 / 即 / ∴；
//   2. 完整末句 `identifier = value`，或肯定结果词引出的完整句末赋值从句。
// 多个相互矛盾的明示结论 ⇒ 'ambiguous'（交人工/语义复核，绝不猜）；
// 找不到任何明示结论 ⇒ 'none'（调用方对过程文本落 pending，不落 0）。
// 提取到的 value 同时给出 `rhs` 备选（"答：S5=11" 的 "11"），比较面两侧
// 都尝试 —— 等号两边是同一结论的左右表述，不是两个候选。

export type FinalAnswerExtraction =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | {
      readonly kind: 'found';
      /** 所有等价表述（原文候选 + 等式右侧）；调用方逐一与 accepted keys 比较。 */
      readonly values: readonly string[];
      readonly marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality';
    };

/** Recorded evidence when the answer was rescued through its explicit final answer. */
export interface FinalAnswerEvidence {
  value: string;
  marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality';
}

// 声明类标记（"答：…"/"答案：…"/"最终答案"/"【答案】"）在任何行都成立 —— 它们
// 是对最终答案的明示声明，推导中间不会写。结论类标记（所以/因此/故/综上/即/∴）
// 与尾随赋值从最终句确定候选；此前不同变量的完整结论赋值属于中间量，
// 不加入最终答案的候选集。同变量的结论及显式答案声明仍须一致。
const DECLARATION_LINE_RE =
  /^\s*(?:【\s*(?:答案|答)\s*】|(?:最终答案|答案|答)\s*[：:，,．.\s])\s*(\S.*?)\s*$/u;
// Only a line/sentence boundary can introduce a conclusion; never a bare
// copula (为/是) or a suffix inside arbitrary prose.
const LAST_LINE_CONCLUSION_RE =
  /(?:^|[。；;，,])\s*(?:所以|因此|故|综上(?:所述)?|即|∴)\s*[：:，,]?\s*(\S.*?)\s*$/u;
// A positive result introducer must start a whole terminal clause. Capture
// the entire value, then require an identifier assignment; never scan for `=`.
const TERMINAL_RESULT_CLAUSE_RE = /(?:^|[，,；;])\s*(?:相加|可得|得到|得)\s*(\S.*?)\s*$/u;
// NFKC maps S₅ / full-width forms to S5 / ASCII. Restrict projection to a
// complete identifier assignment; e.g. 不是S5=11 cannot yield the suffix 11.
const FINAL_ASSIGNMENT_RE = /^([A-Za-zΑ-Ωα-ω][A-Za-zΑ-Ωα-ω0-9_]*)\s*=\s*(\S.*?)$/u;
const COMPARISON_RE = /[<>≤≥≠≈∈]|!=/u;

function canonicalFinal(value: string, policy: AnswerHeadPolicy): string {
  return foldForAnswerHeadPolicy(value, policy).toLowerCase();
}

/**
 * Marked text/compound values are opaque exact strings, never prose to reduce.
 * Only a whole `identifier = value` adds its COMPLETE RHS as an alternative.
 * Preserve !, signs, parentheses, multiplication and every other value token;
 * Do not emit candidates whose existing answer-head normalization would
 * discard tokens (e.g. an unmatched trailing `*`); refuse instead of letting
 * that consumer turn an incomplete expression into an accepted fragment.
 * Unsupported relations/equality chains are unresolved, not last-`=` guesses.
 */
function candidateValues(raw: string, policy: AnswerHeadPolicy): string[] | null {
  const value = raw.trim();
  if (value.length === 0) return [];
  if (COMPARISON_RE.test(value)) return null;
  const values = [value];
  if (value.includes('=')) {
    const assignment = value.match(FINAL_ASSIGNMENT_RE);
    if (!assignment?.[2] || value.indexOf('=') !== value.lastIndexOf('=')) return null;
    values.push(assignment[2].trim());
  }
  return values.every((candidate) => extractAnswerHeadWithPolicy(candidate, policy) === candidate)
    ? values
    : null;
}

function extractFinalAnswerWithPolicy(
  text: string,
  policy: AnswerHeadPolicy,
): FinalAnswerExtraction {
  // Chinese full stops delimit process sentences, not mathematical tokens.
  // Explicit answer declarations still own their whole line, including prose
  // or compound values. Do not split ASCII dots, `!`, operators or tuples.
  const sentences = (
    policy === 'answer_head@2' ? normalizeAnswerWidth(text) : text.normalize('NFKC')
  )
    .split(/\n+/)
    .flatMap((line) => (DECLARATION_LINE_RE.test(line) ? [line] : line.split(/。+/)))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const found: {
    value: string;
    marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality';
  }[] = [];
  // Unsupported syntax invalidates the extraction as a whole, even if
  // another declaration is usable. No candidate may come from a submatch.
  const unsafe: string[] = [];
  const collect = (
    value: string,
    marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality',
  ) => {
    if (candidateValues(value, policy) === null) {
      unsafe.push(value);
    } else {
      found.push({ value, marker });
    }
  };

  for (const sentence of sentences) {
    const declaration = sentence.match(DECLARATION_LINE_RE);
    if (declaration?.[1]) collect(declaration[1], 'answer_marker');
  }
  const lastSentence = sentences[sentences.length - 1];
  if (lastSentence !== undefined) {
    const declaration = lastSentence.match(DECLARATION_LINE_RE);
    const result = declaration ? null : lastSentence.match(TERMINAL_RESULT_CLAUSE_RE);
    const resultAssignment = result?.[1]?.match(FINAL_ASSIGNMENT_RE);
    const conclusion = lastSentence.match(LAST_LINE_CONCLUSION_RE);
    const terminalValue =
      declaration?.[1] ??
      (resultAssignment
        ? result?.[1]
        : (conclusion?.[1] ?? (lastSentence.includes('=') ? lastSentence : undefined)));
    if (terminalValue !== undefined) {
      if (!declaration) {
        collect(
          terminalValue,
          resultAssignment || conclusion ? 'conclusion_marker' : 'trailing_equality',
        );
      }
      const terminalVariable = terminalValue.match(FINAL_ASSIGNMENT_RE)?.[1];
      const priorSentences = sentences.slice(0, -1);
      if (resultAssignment && result?.index !== undefined && result.index > 0) {
        priorSentences.push(lastSentence.slice(0, result.index));
      }
      for (const sentence of priorSentences) {
        // Explicit answer declarations already participate unconditionally.
        if (DECLARATION_LINE_RE.test(sentence)) continue;
        const priorAssignmentVariable = sentence.match(FINAL_ASSIGNMENT_RE)?.[1];
        const priorConclusion =
          sentence.match(LAST_LINE_CONCLUSION_RE)?.[1] ??
          (terminalVariable &&
          priorAssignmentVariable &&
          canonicalFinal(priorAssignmentVariable, policy) ===
            canonicalFinal(terminalVariable, policy)
            ? sentence
            : undefined);
        if (!priorConclusion) continue;
        const priorVariable = priorConclusion.match(FINAL_ASSIGNMENT_RE)?.[1];
        if (
          terminalVariable &&
          priorVariable &&
          canonicalFinal(priorVariable, policy) !== canonicalFinal(terminalVariable, policy) &&
          candidateValues(priorConclusion, policy) !== null
        ) {
          continue;
        }
        // Same-variable contradictions, opaque conclusions and unsupported
        // relations/chains cannot be erased by a later matching assignment.
        collect(priorConclusion, 'conclusion_marker');
      }
    }
  }
  if (unsafe.length > 0) {
    return {
      kind: 'ambiguous',
      candidates: [...new Set([...found.map((entry) => entry.value), ...unsafe])],
    };
  }

  // 每条提取项展开成规范值集合（"S5=11" → {s5=11,11} —— 同一结论的左右面）。
  // 全部提取项的规范集两两相容（存在共享规范值）⇒ 一致结论；任何一对不相交
  // ⇒ 学习者明示了矛盾终态 ⇒ ambiguous，绝不猜其一。
  const entries: {
    marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality';
    values: string[];
  }[] = found
    .map((entry) => ({
      marker: entry.marker,
      values: (candidateValues(entry.value, policy) ?? []).filter(
        (v) => canonicalFinal(v, policy).length > 0,
      ),
    }))
    .filter((entry) => entry.values.length > 0);
  if (entries.length === 0) return { kind: 'none' };
  let shared: Set<string> | null = null;
  for (const entry of entries) {
    const current = new Set<string>(entry.values.map((value) => canonicalFinal(value, policy)));
    shared = shared === null ? current : new Set([...shared].filter((v: string) => current.has(v)));
    if (shared.size === 0) {
      return { kind: 'ambiguous', candidates: entries.map((e) => e.values[0] as string) };
    }
  }
  const values = [...new Set<string>(entries.flatMap((entry) => entry.values))];
  return {
    kind: 'found',
    values,
    marker: entries[0]?.marker ?? 'conclusion_marker',
  };
}

const PROCESS_MARKER_RE = /[∵∴⇒→]|解[：:]|步骤|因为[\s\S]{0,80}所以/u;
const PROCESS_ANSWER_MAX_LEN = 120;

/**
 * 过程作答形态判定（保守）：多行、连等式、超出短答长度、或含推导标记 ⇒ true。
 * 只用于「比较不出结果时给 pending 而非 0」的诚实降级边界；提取得到明确
 * 终态的输入不走这里。
 */
export function isProcessLikeAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  const normalized = t.normalize('NFKC');
  const nonEmptyLines = t.split(/\n+/).filter((line) => line.trim().length > 0).length;
  return (
    nonEmptyLines > 1 ||
    // A one-line equality chain is still worked reasoning. If extraction
    // cannot establish its final answer, preserve review instead of a fake zero.
    normalized.indexOf('=') !== normalized.lastIndexOf('=') ||
    [...t].length > PROCESS_ANSWER_MAX_LEN ||
    PROCESS_MARKER_RE.test(t) ||
    LAST_LINE_CONCLUSION_RE.test(normalized)
  );
}

/**
 * 'exact' is a verbatim-compare contract: the reference must resolve to a bare
 * answer head — single short paragraph, no worked-solution markers. A producer
 * 'exact' override on a blob reference is structurally unwinnable; the write
 * path demotes it to the derived route instead of storing a verdict that can
 * never pass. The guard is structural, not semantic: single-paragraph process
 * prose that extracts a head stays exact (rare, still matchable).
 */
export function isExactCapableReference(reference: string): boolean {
  const head = extractAnswerHead(reference);
  return (
    head.length > 0 &&
    head.length <= MAX_EXACT_HEAD_LEN &&
    !/\n\s*\n/.test(head) &&
    !SOLUTION_BLOB_RE.test(head)
  );
}

// ====================================================================
// Frozen text-key normalization (version map lives here)
// ====================================================================

export type TextKeyNormalizationT =
  | 'exact'
  | 'trim'
  | 'trim_casefold_nfc'
  | 'answer_head'
  | 'answer_head@2';

/** Fold a raw answer under a frozen text_key normalization. */
export function normalizeTextKeyAnswer(
  value: string,
  normalization: TextKeyNormalizationT,
): string {
  switch (normalization) {
    case 'exact':
      return value;
    case 'trim':
      return value.trim();
    case 'trim_casefold_nfc':
      return value.normalize('NFKC').trim().toLowerCase();
    case 'answer_head@2':
      return extractAnswerHeadWithPolicy(value, 'answer_head@2').trim().toLowerCase();
    case 'answer_head':
      // 与 legacy exact 判分同语义：先抽答案头（"答：B"→"B"、答案+解析→答案），
      // 再 NFKC + trim + lowercase。
      return extractAnswerHeadWithPolicy(value, 'legacy').normalize('NFKC').trim().toLowerCase();
  }
}

/** Answer-head policy paired with a frozen text_key normalization. */
function textKeyHeadPolicy(normalization: TextKeyNormalizationT): AnswerHeadPolicy {
  return normalization === 'answer_head@2' ? 'answer_head@2' : 'legacy';
}

const NUMERIC_MINUS = new Set(['-', '\uFF0D']);
const NUMERIC_DECIMAL = new Set(['.', '\uFF0E']);

function isDecimalDigit(char: string | undefined): boolean {
  return char != null && /\p{Nd}/u.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char != null && /\s/u.test(char);
}

/** Index of a number start at or after `index`, skipping spaces. Null when there is none. */
function numberStartAt(source: string, index: number): number | null {
  let cursor = index;
  while (isSpace(source[cursor])) cursor += 1;
  const char = source[cursor];
  if (isDecimalDigit(char)) return cursor;
  if (char != null && NUMERIC_DECIMAL.has(char) && isDecimalDigit(source[cursor + 1]))
    return cursor;
  return null;
}

function previousNonSpaceIsDigit(source: string, index: number): boolean {
  let cursor = index - 1;
  while (isSpace(source[cursor])) cursor -= 1;
  return isDecimalDigit(source[cursor]);
}

/**
 * `\p{P}` includes the hyphen-minus and the decimal point. Dropping them makes
 * `-5` match `5`, `-.5` match `.5`, and `10.24` match `1024`. Keep a unary
 * minus (including `-.5` and `- 5`) and a dot that starts a fractional digit.
 * Word hyphens and sentence periods still drop.
 */
function keepsNumericPunctuation(source: string, index: number): boolean {
  const char = source[index];
  if (char == null) return false;
  if (NUMERIC_MINUS.has(char)) {
    return numberStartAt(source, index + 1) != null && !previousNonSpaceIsDigit(source, index);
  }
  return NUMERIC_DECIMAL.has(char) && isDecimalDigit(source[index + 1]);
}

/** Fold a raw blank answer under a frozen blank normalization. */
export function normalizeBlankAnswerText(text: string, normalization: BlankNormalizationT): string {
  let value = text;
  if (normalization.nfkc) {
    // New contracts fold width only: compatibility symbols can encode exponents,
    // indices or distinct variables. Other versions retain frozen replay semantics.
    value =
      normalization.version === 'blank-norm@2'
        ? normalizeAnswerWidth(value)
        : value.normalize('NFKC');
  }
  for (const [from, to] of normalization.character_variants) value = value.split(from).join(to);
  if (normalization.casefold) value = value.toLowerCase();
  if (normalization.ignore_punctuation) {
    value = value.replace(/\p{P}/gu, (char, index) =>
      keepsNumericPunctuation(value, index) ? char : '',
    );
  }
  if (normalization.collapse_whitespace) value = value.replace(/\s+/gu, ' ');
  if (normalization.trim_outer) value = value.trim();
  return value;
}

/** Answer-head policy paired with a frozen blank normalization. */
function blankHeadPolicy(normalization: BlankNormalizationT): AnswerHeadPolicy {
  return normalization.version === 'blank-norm@2' ? 'answer_head@2' : 'legacy';
}

function finalAnswerEvidence(extraction: FinalAnswerExtraction): FinalAnswerEvidence | undefined {
  return extraction.kind === 'found'
    ? { value: extraction.values[0] ?? '', marker: extraction.marker }
    : undefined;
}

/** Frozen text_key comparison verdict. */
export type TextKeyComparison =
  | { outcome: 'correct'; finalAnswer?: FinalAnswerEvidence }
  | { outcome: 'incorrect'; finalAnswer?: FinalAnswerEvidence }
  | { outcome: 'undecidable'; detail: string; finalAnswer?: FinalAnswerEvidence };

/**
 * Frozen text_key answer comparison. Mirrors the deterministic exact_text
 * comparator: full-text fold, then an explicit final answer for worked
 * responses; an unresolvable process answer stays undecidable.
 */
export function compareTextKeyAnswer(criterion: TextKeyCriterionT, raw: string): TextKeyComparison {
  const normalize = (value: string) => normalizeTextKeyAnswer(value, criterion.normalization);
  const given = normalize(raw);
  if (criterion.accepted_texts.some((accepted) => normalize(accepted) === given)) {
    return { outcome: 'correct' };
  }
  // YUK-1407 — 整段比较 miss 后，对过程作答再确定性抽一次【明示终态答案】：
  // "推导…S5=11" 的 head 是整段（无解析 tail），与 "11" 不等 ⇒ 旧路径判 0。
  const extraction = extractFinalAnswerWithPolicy(raw, textKeyHeadPolicy(criterion.normalization));
  const evidence = finalAnswerEvidence(extraction);
  if (extraction.kind === 'found') {
    const finalHit = criterion.accepted_texts.some((accepted) =>
      extraction.values.some((candidate) => normalize(candidate) === normalize(accepted)),
    );
    if (finalHit) return { outcome: 'correct', finalAnswer: evidence };
    // 明示结论与参考答案不一致：单句明示结论（"答：12"）= 确定性判错；
    // 过程文本的 miss 可能是单位/等价形式 —— 超出本比较器合同，交复核，
    // 绝不把"没看懂"落成 0。
    if (isProcessLikeAnswer(raw)) {
      return {
        outcome: 'undecidable',
        detail:
          'extracted final answer does not match any accepted key — equivalence beyond the exact-text comparator contract; review required (no fake zero)',
        finalAnswer: evidence,
      };
    }
    return { outcome: 'incorrect', finalAnswer: evidence };
  }
  if (isProcessLikeAnswer(raw)) {
    return {
      outcome: 'undecidable',
      detail:
        extraction.kind === 'ambiguous'
          ? `conflicting explicit final answers (${extraction.candidates.join(' / ')}) — the exact-text comparator cannot adjudicate; review required`
          : 'worked/process answer carries no unambiguous final answer — beyond the exact-text comparator contract; review required (no fake zero)',
    };
  }
  return { outcome: 'incorrect' };
}

// ====================================================================
// Frozen blank-key comparison (text branch)
// ====================================================================

export type AnswerCharDiff = {
  codepoint_offset: number;
  given: string;
  expected: string;
}[];

/** Frozen blank text-key comparison verdict. */
export type BlankTextComparison =
  | { outcome: 'correct'; finalAnswer?: FinalAnswerEvidence }
  | { outcome: 'incorrect'; charDiff?: AnswerCharDiff }
  | { outcome: 'undecidable'; detail: string; finalAnswer?: FinalAnswerEvidence };

export type BlankTextKeyT = Extract<BlankKeyCriterionT['key'], { kind: 'text' }>;

function charDiff(given: string, expected: string): AnswerCharDiff | undefined {
  const a = [...given];
  const b = [...expected];
  if (a.length !== b.length) return undefined;
  const diff = a
    .map((char, offset) => ({ codepoint_offset: offset, given: char, expected: b[offset] }))
    .filter((entry) => entry.given !== entry.expected);
  return diff.length > 0 ? diff : undefined;
}

/**
 * Frozen blank text-key answer comparison.
 *
 * Two entries ask this question with different authority:
 *   - 'learner_grading' (evaluation dispatch) owns the YUK-1407 process-answer
 *     boundary: after a full-text miss on a worked response, the explicit final
 *     answer is tried; if that cannot decide, the comparison is undecidable
 *     (pending), never a fake zero.
 *   - 'admission_author_key' (author-key acceptance) compares the whole answer
 *     form only. A solver alias is one candidate answer, not a worked script, so
 *     no rescue applies there; a miss is incorrect.
 * Numeric blanks do not go through here.
 */
export type BlankTextComparisonEntry = 'learner_grading' | 'admission_author_key';

export function compareBlankTextAnswer(
  key: BlankTextKeyT,
  raw: string,
  entry: BlankTextComparisonEntry,
): BlankTextComparison {
  const normalize = (value: string) => normalizeBlankAnswerText(value, key.normalization);
  const given = normalize(raw);
  const accepted = key.accepted.map((text) => normalize(text));
  if (accepted.includes(given)) return { outcome: 'correct' };
  // Whole-answer-form miss: same verdict under both entries.
  const wholeTextMiss = (): BlankTextComparison => ({
    outcome: 'incorrect',
    charDiff: accepted.map((text) => charDiff(given, text)).find((entry) => entry != null),
  });
  if (entry === 'admission_author_key' || !isProcessLikeAnswer(raw)) return wholeTextMiss();
  const extraction = extractFinalAnswerWithPolicy(raw, blankHeadPolicy(key.normalization));
  const evidence = finalAnswerEvidence(extraction);
  if (extraction.kind === 'found') {
    const finalHit = extraction.values.some((candidate) => accepted.includes(normalize(candidate)));
    if (finalHit) return { outcome: 'correct', finalAnswer: evidence };
    return {
      outcome: 'undecidable',
      detail:
        'extracted final answer does not match any accepted key — equivalence beyond the blank-exact comparator contract; review required (no fake zero)',
      finalAnswer: evidence,
    };
  }
  return {
    outcome: 'undecidable',
    detail:
      extraction.kind === 'ambiguous'
        ? `conflicting explicit final answers (${extraction.candidates.join(' / ')}) — the blank-exact comparator cannot adjudicate; review required`
        : 'worked/process answer carries no unambiguous final answer — beyond the blank-exact comparator contract; review required (no fake zero)',
  };
}

// ====================================================================
// Frozen numeric-key comparison
// ====================================================================

export type NumericKeyIdentity = {
  normalization_version?: NumericNormalizationVersionT;
  expected_unit?: string;
};

/**
 * Fold a raw numeric answer the way the frozen numeric key reads it. New
 * contracts fold width only (and refuse compatibility symbols that could
 * encode exponents); versions without a numeric contract keep the frozen NFKC.
 */
export function normalizeNumericKeyInput(raw: string, identity: NumericKeyIdentity): string | null {
  return identity.normalization_version === 'numeric-norm@2'
    ? normalizeNumericAnswer(raw, identity.expected_unit != null)
    : raw.normalize('NFKC');
}

/**
 * `numeric_unit_conversion` input: the reference unit is declared by the
 * criterion. null means the frozen width fold rejected the compatibility
 * symbols; an empty string means the caller sent no original input.
 */
export function normalizeNumericUnitInput(
  raw: string,
  identity: NumericKeyIdentity,
): string | null {
  return identity.normalization_version === 'numeric-norm@2'
    ? normalizeNumericAnswer(raw, identity.expected_unit != null)
    : raw.trim();
}

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const PLAIN_NUMBER_PREFIX = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/u;
/** float64 tops out near 1e308; longer materialization is not a grading input. */
const MAX_EXACT_INTEGER_DIGITS = 400;

/**
 * Plain-number read shared by grading and cross-kind key agreement.
 * `finite` is a round-trip spelling of its float64 (`1e23`, `10.24`, `2^53`).
 * The stored key is that same float, so the old tolerance read must stand.
 * `displaced` is a different value that Number() collapsed onto the float
 * (`9007199254740993` → `9007199254740992`). Callers compare it as a rational.
 */
type ExactRational = { n: bigint; d: bigint };

type FrozenPlainNumber =
  | { kind: 'finite'; value: number }
  | { kind: 'displaced'; literal: ExactRational }
  | { kind: 'unreadable' };

type ExactRationalRead = { kind: 'rational'; value: ExactRational } | { kind: 'unsupported' };

function readExactRational(text: string): ExactRationalRead {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (match == null) return { kind: 'unsupported' };
  const fraction = match[3] ?? match[4] ?? '';
  const exponentText = match[5];
  if (exponentText != null && exponentText.replace(/^[+-]/u, '').length > 4) {
    return { kind: 'unsupported' };
  }
  const exponent = exponentText != null ? Number(exponentText) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXACT_INTEGER_DIGITS) {
    return { kind: 'unsupported' };
  }
  const digits = `${match[2] ?? ''}${fraction}`.replace(/^0+(?=\d)/u, '') || '0';
  const scale = exponent - fraction.length;
  if (
    digits.length > MAX_EXACT_INTEGER_DIGITS ||
    digits.length + Math.max(scale, 0) > MAX_EXACT_INTEGER_DIGITS
  ) {
    return { kind: 'unsupported' };
  }
  const magnitude = BigInt(digits);
  const signed = match[1] === '-' ? -magnitude : magnitude;
  if (scale >= 0) {
    return { kind: 'rational', value: { n: signed * 10n ** BigInt(scale), d: 1n } };
  }
  return { kind: 'rational', value: { n: signed, d: 10n ** BigInt(-scale) } };
}

function floatToRational(value: number): ExactRational | null {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return { n: 0n, d: 1n };
  const sign = value < 0 ? -1n : 1n;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, Math.abs(value));
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = bits & ((1n << 52n) - 1n);
  const subnormal = exponent === 0;
  const significand = subnormal ? mantissa : (1n << 52n) | mantissa;
  const power = subnormal ? -1074 : exponent - 1075;
  if (power >= 0) return { n: sign * significand * 2n ** BigInt(power), d: 1n };
  return { n: sign * significand, d: 2n ** BigInt(-power) };
}

function sameRational(left: ExactRational, right: ExactRational): boolean {
  return left.n * right.d === right.n * left.d;
}

function classifyPlainNumber(text: string): FrozenPlainNumber {
  if (!PLAIN_NUMBER.test(text)) return { kind: 'unreadable' };
  const exact = readExactRational(text);
  if (exact.kind === 'unsupported') return { kind: 'unreadable' };
  const asNumber = Number(text);
  if (!Number.isFinite(asNumber)) return { kind: 'unreadable' };
  // The key stores this float. Its round-trip spelling (`Number(text).toString()`)
  // is the same answer; a collapsed neighbor has a different exact value.
  const canonical = readExactRational(asNumber.toString());
  if (canonical.kind === 'rational' && sameRational(exact.value, canonical.value)) {
    return { kind: 'finite', value: asNumber };
  }
  return { kind: 'displaced', literal: exact.value };
}

function readFrozenPlainNumber(raw: string, identity: NumericKeyIdentity): FrozenPlainNumber {
  const text = (
    identity.normalization_version === 'numeric-norm@2'
      ? normalizeNumericAnswer(raw, false)
      : raw.normalize('NFKC')
  )?.trim();
  if (text == null) return { kind: 'unreadable' };
  return classifyPlainNumber(text);
}

/**
 * 纯数值读取：冻结 Unicode 策略 + trim + PLAIN_NUMBER + finite，不解释表达式。
 * 同一个确定性 parse 既用于判分，也用于准入双解的跨 kind 一致性；新键用宽度折叠，
 * 缺省版本保留旧 NFKC。对不上往返写法的字面量不返回折叠值。
 */
export function parseFrozenNumericAnswer(raw: string, identity: NumericKeyIdentity): number | null {
  const read = readFrozenPlainNumber(raw, identity);
  return read.kind === 'finite' ? read.value : null;
}

function absoluteCross(literal: ExactRational, expected: ExactRational): bigint {
  const left = literal.n * expected.d;
  const right = expected.n * literal.d;
  return left >= right ? left - right : right - left;
}

/** |literal - expected| <= tolerance, with every value an exact rational. */
function withinAbsolute(
  literal: ExactRational,
  expected: ExactRational,
  tolerance: ExactRational,
): boolean {
  return absoluteCross(literal, expected) * tolerance.d <= tolerance.n * literal.d * expected.d;
}

/** |literal - expected| / |expected| <= ratio. A zero expected matches only itself. */
function withinRelative(
  literal: ExactRational,
  expected: ExactRational,
  ratio: ExactRational,
): boolean {
  if (expected.n === 0n) return literal.n === 0n;
  const expAbs = expected.n < 0n ? -expected.n : expected.n;
  return absoluteCross(literal, expected) * ratio.d <= ratio.n * expAbs * literal.d;
}

function displacedWithinTolerance(
  literal: ExactRational,
  expected: number,
  tolerance: NumericTolerance,
): 0 | 1 {
  if (!Number.isFinite(expected)) return 0;
  const expectedRational = floatToRational(expected);
  if (expectedRational == null) return 0;
  const span = tolerance.kind === 'absolute' ? tolerance.value : tolerance.ratio;
  if (!Number.isFinite(span) || span < 0) return 0;
  if (tolerance.kind === 'relative' && (span === 0 || expectedRational.n === 0n)) {
    return literal.n * expectedRational.d === expectedRational.n * literal.d ? 1 : 0;
  }
  const spanRational = floatToRational(span);
  if (spanRational == null) return 0;
  const hit =
    tolerance.kind === 'absolute'
      ? withinAbsolute(literal, expectedRational, spanRational)
      : withinRelative(literal, expectedRational, spanRational);
  return hit ? 1 : 0;
}

function leadingPlainNumber(text: string): string | null {
  return PLAIN_NUMBER_PREFIX.exec(text)?.[0] ?? null;
}

/**
 * The frozen tolerance semantics, shared by every numeric comparator.
 */
export function numericAnswerWithinTolerance(
  value: number,
  expected: number,
  tolerance: NumericTolerance,
): boolean {
  const diff = Math.abs(value - expected);
  if (!Number.isFinite(value)) return false;
  if (tolerance.kind === 'absolute') return diff <= tolerance.value;
  return expected === 0 ? diff === 0 : diff / Math.abs(expected) <= tolerance.ratio;
}

/**
 * Frozen `numeric_tolerance` input: new contracts read the original raw input;
 * versions without a numeric contract keep the stored parsed value.
 */
export function resolveNumericToleranceValue(
  rawInput: string | null | undefined,
  parsedValue: number | null | undefined,
  identity: NumericKeyIdentity,
): { value: number; unparseable: boolean } {
  if (identity.normalization_version !== 'numeric-norm@2') {
    return { value: parsedValue ?? Number.NaN, unparseable: false };
  }
  const value = parseFrozenNumericAnswer(rawInput ?? '', identity) ?? Number.NaN;
  return { value, unparseable: !Number.isFinite(value) };
}

/** Unit suffix equality under the frozen numeric contract (NFKC, case-sensitive). */
export function numericUnitSuffixesAgree(given: string, expected: string): boolean {
  return given.normalize('NFKC') === expected.normalize('NFKC');
}

export type NumericBlankComparison = 0 | 1 | null;

/**
 * 数值空：无参考单位时只接受纯数值；有参考单位时用 mathjs 换算到参考单位，
 * 纯数值（漏写单位）按答错处理。无法解释的文本 → null（调用方给 pending）。
 */
export async function compareNumericBlankAnswer(
  key: Extract<BlankKeyCriterionT['key'], { kind: 'numeric' }>,
  raw: string,
): Promise<NumericBlankComparison> {
  const text = normalizeNumericKeyInput(raw, key)?.trim() ?? null;
  if (text == null) return null;
  const expectedUnit = key.expected_unit;
  if (expectedUnit == null) {
    const read = readFrozenPlainNumber(raw, key);
    switch (read.kind) {
      case 'finite':
        return numericAnswerWithinTolerance(read.value, key.expected, key.tolerance) ? 1 : 0;
      case 'displaced':
        return displacedWithinTolerance(read.literal, key.expected, key.tolerance);
      case 'unreadable':
        return null;
    }
  }
  if (PLAIN_NUMBER.test(text)) return 0;
  // A coefficient that is not its float's round-trip spelling must not become
  // a full mark through mathjs toNumber(). That conversion stays undecided.
  const coefficient = leadingPlainNumber(text);
  if (coefficient != null && classifyPlainNumber(coefficient).kind !== 'finite') return null;
  const { unit: parseUnit } = await import('mathjs');
  let reference: import('mathjs').Unit;
  try {
    reference = parseUnit(1, expectedUnit);
  } catch {
    return null;
  }
  try {
    const given = parseUnit(text);
    if (!given.equalBase(reference)) return 0;
    return numericAnswerWithinTolerance(given.toNumber(expectedUnit), key.expected, key.tolerance)
      ? 1
      : 0;
  } catch {
    return null;
  }
}

// ====================================================================
// Legacy exact answer comparison (pre-freeze contract, unversioned)
// ====================================================================

export interface LegacyExactComparison {
  match: boolean;
  /** How the verdict was reached; 'text' also covers a plain unmatched text. */
  matchType: 'choice_index' | 'text' | 'final_answer';
  choiceMatch: boolean;
  answerHead: string;
  referenceHead: string;
  answerChoiceIndices: number[] | null;
  referenceChoiceIndices: number[] | null;
  /** null when the head already decided the comparison (no extraction ran). */
  finalAnswer: FinalAnswerExtraction | null;
  processUnresolvable: boolean;
}

/** Legacy exact identity fold: NFKC + trim + lowercase on the whole text/head. */
export function foldLegacyExactAnswer(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase();
}

/**
 * The single legacy exact comparison used by the V1 and V2 exact judges.
 * Choice questions resolve letters and option text both ways; and after a head
 * miss an explicit final answer ("推导…S5=11" vs "11") is tried once.
 */
export function compareLegacyExactAnswer(input: {
  reference: string;
  answer: string;
  choices: readonly string[];
}): LegacyExactComparison {
  const normalize = foldLegacyExactAnswer;
  const choices = input.choices;
  const resolveChoiceIndices = (value: string): number[] | null => {
    if (choices.length === 0) return null;
    const t = value.normalize('NFKC').trim();
    if (t.length === 0) return null;
    // `t` is already NFKC + trim; normalize(t) would only re-add toLowerCase.
    const tLower = t.toLowerCase();

    // (1) Exact option-text equality first — so an option whose text happens to
    // be pure Latin letters (e.g. ['True','False'], or a math option 'a + b')
    // matches by text rather than being mis-parsed as a letter index.
    const exact = choices.findIndex((c) => normalize(c) === tLower);
    if (exact !== -1) return [exact];

    // (2) Pure letter string(s): "A" / "BC" / "B、C". Only accept when every
    // resolved index is in range; otherwise fall through to prefix parsing.
    const lettersOnly = t.toUpperCase().replace(/[\s,，、和与]/g, '');
    if (/^[A-Z]+$/.test(lettersOnly)) {
      const idx = [...new Set(lettersOnly.split('').map((c) => c.charCodeAt(0) - 65))].sort(
        (a, b) => a - b,
      );
      if (idx.length > 0 && idx.every((i) => i < choices.length)) return idx;
    }

    // (3) Leading-letter prefix: reference_md per the reading-comprehension skill
    // is "正确项字母 + 依据" (e.g. "C。原文依据…"), and choices_md options may carry
    // a label prefix ("A. 修八尺有余…"). jyeoo/web-sourced references also use
    // the parenthesised form "（C）选项原文（+解析）" — allow an optional
    // full/half-width open paren before the letter. Parse the leading letter
    // when followed by a separator so 'C' answer ↔ "C。…" / "（C）…" reference
    // are judged equal.
    const prefix = t
      .toUpperCase()
      .match(/^[（(]([A-Z]{1,4})(?:[\s.．。、,，:：)）]|$)|^([A-Z])(?:[\s.．。、,，:：)）]|$)/);
    if (prefix) {
      const indices = [...(prefix[1] ?? prefix[2])].map((ch) => ch.charCodeAt(0) - 65);
      if (indices.every((i) => i < choices.length)) return indices;
    }

    return null;
  };
  // web-sourced reference_md stores "<bare answer>\n\n解析：…" — the judgeable
  // surface is the extracted answer head. Same for the learner's answer
  // ("答：X" / trailing self-written explanation is still a correct answer).
  // resolveChoiceIndices and the text compare both run on heads.
  const answerHead = extractAnswerHeadWithPolicy(input.answer, 'legacy');
  const referenceHead = extractAnswerHeadWithPolicy(input.reference, 'legacy');
  const answerChoiceIndices = resolveChoiceIndices(answerHead);
  const referenceChoiceIndices = resolveChoiceIndices(referenceHead);
  const choiceMatch =
    answerChoiceIndices !== null &&
    referenceChoiceIndices !== null &&
    answerChoiceIndices.length === referenceChoiceIndices.length &&
    answerChoiceIndices.every((v, i) => v === referenceChoiceIndices[i]);
  const textMatch = normalize(answerHead) === normalize(referenceHead);
  const finalAnswer =
    choiceMatch || textMatch ? null : extractFinalAnswerWithPolicy(input.answer, 'legacy');
  const finalMatch =
    finalAnswer?.kind === 'found' &&
    finalAnswer.values.some((candidate) => normalize(candidate) === normalize(referenceHead));
  const match = choiceMatch || textMatch || finalMatch === true;
  return {
    match,
    matchType: finalMatch === true ? 'final_answer' : choiceMatch ? 'choice_index' : 'text',
    choiceMatch,
    answerHead,
    referenceHead,
    answerChoiceIndices,
    referenceChoiceIndices,
    finalAnswer,
    processUnresolvable: !match && isProcessLikeAnswer(input.answer),
  };
}

// ====================================================================
// Solve-check answer identity (unversioned diagnostic contract)
// ====================================================================

/**
 * Solver-vs-reference answer identity for solve-check / choice-surface.
 * Deliberately distinct from learner grading: NFKC + lowercase + whitespace
 * stripped (mathematical symbols stay load-bearing).
 */
export function foldSolveCheckAnswer(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/gu, '') // strip ASCII + full-width whitespace only
    .trim();
}

/** Case-preserving option identity for duplicate detection (NFKC + whitespace). */
export function foldSolveCheckOptionIdentity(text: string): string {
  return text.normalize('NFKC').replace(/[\s　]+/gu, '');
}

// ====================================================================
// Candidate-key agreement (blind solves / author keys / minted keys)
// ====================================================================

/** A candidate answer key before it becomes a frozen criterion. */
export type AnswerKeyT =
  | { kind: 'select'; accepted_item_ids: string[] }
  | { kind: 'blank_text'; accepted: string[] }
  | {
      kind: 'blank_numeric';
      expected: number;
      tolerance: NumericTolerance;
      expected_unit?: string;
    };

/** The frozen unit facts key agreement reads; the caller never selects a version. */
export interface FrozenKeyAgreementUnit {
  blank_normalization: BlankNormalizationT | null;
  declared_shape: BlankAnswerShapeT | null;
}

export interface KeyAgreement {
  agree: boolean;
  detail?: string;
  key?: AnswerKeyT;
}

/** Conflict details stay bounded — they land in withheld evidence and reasons. */
const DETAIL_VALUE_MAX = 160;
function boundDetail(value: string, max = DETAIL_VALUE_MAX): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

/** Compact value-level rendering of a key for conflict details. */
function keyBrief(key: AnswerKeyT): string {
  switch (key.kind) {
    case 'select':
      return boundDetail(`select[${key.accepted_item_ids.join(',')}]`);
    case 'blank_text':
      return boundDetail(`blank_text[${key.accepted.join('|')}]`);
    case 'blank_numeric':
      return `blank_numeric{expected=${key.expected},tolerance=${JSON.stringify(
        key.tolerance,
      )},unit=${key.expected_unit ?? '∅'}}`;
  }
}

const tolOf = (t: { value?: number; ratio?: number }) => t.value ?? t.ratio ?? 0;

/** AdmissionKey → 比较核心的私有键读面（select 无对应 —— 声明只在 blank 槽）。 */
function privateKeyOf(key: AnswerKeyT): DeclaredPrivateKey | null {
  switch (key.kind) {
    case 'select':
      return null;
    case 'blank_text':
      return { kind: 'text', accepted: key.accepted };
    case 'blank_numeric':
      return {
        kind: 'numeric',
        expected: key.expected,
        tolerance: key.tolerance,
        ...(key.expected_unit != null ? { expected_unit: key.expected_unit } : {}),
      };
  }
}

/**
 * 已声明槽的 A/B 键一致性：两侧【全部】别名经同一 compileDeclaredKey 编译，
 * 每个别名必须完整解析且为同一数学对象（别名数可不同）；铸出的键携带全部
 * 已验证别名 —— 实际 grade 逐一接受。
 * 返回 null = 交由既有分支（numeric/numeric 容差铸键，单位相容已验）。
 */
function declaredKeysAgree(
  a: AnswerKeyT,
  b: AnswerKeyT,
  shape: BlankAnswerShapeT,
): { agree: boolean; detail?: string; key?: AnswerKeyT } | null {
  if (a.kind === 'select' || b.kind === 'select') {
    return { agree: false, detail: 'select key cannot satisfy a declared answer_shape' };
  }
  if (a.kind === 'blank_text' && b.kind === 'blank_text') {
    const privateKeyA = privateKeyOf(a);
    const privateKeyB = privateKeyOf(b);
    if (privateKeyA == null || privateKeyB == null) {
      return { agree: false, detail: 'blank_text keys must carry an accepted alias list' };
    }
    const ca = compileDeclaredKey(shape, privateKeyA);
    const cb = compileDeclaredKey(shape, privateKeyB);
    if (!ca.ok) {
      return {
        agree: false,
        detail: `solver A aliases invalid under declared shape: ${ca.reason}`,
      };
    }
    if (!cb.ok) {
      return {
        agree: false,
        detail: `solver B aliases invalid under declared shape: ${cb.reason}`,
      };
    }
    const canonicalA = compiledCanonicalOf(ca.compiled);
    const canonicalB = compiledCanonicalOf(cb.compiled);
    if (canonicalA == null || canonicalB == null || canonicalA !== canonicalB) {
      return {
        agree: false,
        detail: `independent solves disagree as declared objects: ${canonicalA} vs ${canonicalB}`,
      };
    }
    const accepted = [...a.accepted, ...b.accepted.filter((t) => !a.accepted.includes(t))];
    return {
      agree: true,
      key: { kind: 'blank_text', accepted },
      detail: `agreed as declared object ${canonicalA} (${accepted.length} validated aliases)`,
    };
  }
  if (a.kind === 'blank_numeric' && b.kind === 'blank_numeric') {
    if (shape.value.kind !== 'number') {
      return {
        agree: false,
        detail: `numeric keys cannot express declared value kind '${shape.value.kind}'`,
      };
    }
    if (shape.value.unit != null) {
      const unit = shape.value.unit.unit.normalize('NFKC');
      const norm = (u?: string): string => (u ?? '').normalize('NFKC');
      if (norm(a.expected_unit) !== unit || norm(b.expected_unit) !== unit) {
        return {
          agree: false,
          detail: `declared unit '${unit}' vs keys ${a.expected_unit ?? '∅'}/${b.expected_unit ?? '∅'}`,
        };
      }
    }
    return null; // 单位/形态相容 → 既有容差铸键分支（更严容差侧）。
  }
  // 跨 kind（numeric × text）：仅无声明单位的 number 形状；文本侧全部别名
  // 必须编译为同一精确有理值且落在冻结容差内 —— 铸 numeric 键（判分读法
  // 逐一接受这些文本形式）。
  const numeric = a.kind === 'blank_numeric' ? a : b.kind === 'blank_numeric' ? b : null;
  const text = a.kind === 'blank_text' ? a : b.kind === 'blank_text' ? b : null;
  if (
    numeric != null &&
    text != null &&
    shape.value.kind === 'number' &&
    shape.value.unit == null &&
    numeric.expected_unit == null
  ) {
    const privateKey = privateKeyOf(text);
    if (privateKey == null) {
      return { agree: false, detail: 'blank_text key must carry an accepted alias list' };
    }
    const ct = compileDeclaredKey(shape, privateKey);
    if (!ct.ok) {
      return {
        agree: false,
        detail: `text aliases invalid under declared number shape: ${ct.reason}`,
      };
    }
    const value = declaredRationalValueOf(ct.compiled);
    if (value != null && numericAnswerWithinTolerance(value, numeric.expected, numeric.tolerance)) {
      return {
        agree: true,
        key: numeric,
        detail: `text forms all read as the declared numeric key: ${boundDetail(text.accepted.join('|'))} -> ${keyBrief(numeric)}`,
      };
    }
    return {
      agree: false,
      detail: `declared text aliases (${boundDetail(text.accepted.join('|'))}) disagree with ${keyBrief(numeric)}`,
    };
  }
  return {
    agree: false,
    detail: `key kinds ${a.kind}/${b.kind} cannot agree under declared value kind '${shape.value.kind}'`,
  };
}

/**
 * A seeded blank key with no frozen normalization keeps the legacy contract:
 * trim only, no width/NFKC folding (the fallback is not the current default).
 */
const UNVERSIONED_TRIM_NORMALIZATION: BlankNormalizationT = {
  version: 'n/a',
  nfkc: false,
  trim_outer: true,
  casefold: false,
  collapse_whitespace: false,
  ignore_punctuation: false,
  character_variants: [],
};

/**
 * Whether two candidate keys describe the same answer under one frozen unit.
 * The caller passes the unit facts (frozen blank normalization + declared
 * shape); version selection and folding stay here.
 */
export function compareAnswerKeys(
  a: AnswerKeyT,
  b: AnswerKeyT,
  unit: FrozenKeyAgreementUnit,
): KeyAgreement {
  if (unit.declared_shape != null) {
    const declared = declaredKeysAgree(a, b, unit.declared_shape);
    if (declared != null) return declared;
    // numeric/numeric 且单位/形态已验相容 → 落到既有容差铸键分支。
  }
  if (a.kind !== b.kind) {
    // blank_text vs blank_numeric may still describe ONE key: every
    // accepted text form must read as a plain number under the SAME
    // deterministic parse the minted numeric key later applies in grading
    // (width fold + trim + plain number, no units/separators), and each value
    // must land inside the numeric tolerance. A numeric key carrying
    // expected_unit can never agree — plain-number forms have no unit.
    const numeric = a.kind === 'blank_numeric' ? a : b.kind === 'blank_numeric' ? b : null;
    const text = a.kind === 'blank_text' ? a : b.kind === 'blank_text' ? b : null;
    if (numeric != null && text != null && numeric.expected_unit == null) {
      const parsed = text.accepted.map((form) => ({
        form,
        value: parseFrozenNumericAnswer(form, {
          normalization_version: CURRENT_NUMERIC_NORMALIZATION_VERSION,
        }),
      }));
      if (
        parsed.length > 0 &&
        parsed.every(
          (entry) =>
            entry.value != null &&
            numericAnswerWithinTolerance(entry.value, numeric.expected, numeric.tolerance),
        )
      ) {
        // Mint the NUMERIC key — its grading read accepts exactly the forms
        // that just parsed, so admission and grading stay consistent.
        return {
          agree: true,
          key: numeric,
          detail: `text forms all read as the numeric key: ${boundDetail(
            text.accepted.join('|'),
          )} -> ${keyBrief(numeric)}`,
        };
      }
    }
    return {
      agree: false,
      detail: `key kind ${a.kind} vs ${b.kind}: ${keyBrief(a)} vs ${keyBrief(b)}`,
    };
  }
  if (a.kind === 'select' && b.kind === 'select') {
    const sa = [...a.accepted_item_ids].sort();
    const sb = [...b.accepted_item_ids].sort();
    return sa.length === sb.length && sa.every((id, i) => id === sb[i])
      ? { agree: true, key: a }
      : {
          agree: false,
          detail: `select key ${boundDetail(sa.join(','))} vs ${boundDetail(sb.join(','))}`,
        };
  }
  if (a.kind === 'blank_text' && b.kind === 'blank_text') {
    const norm = unit.blank_normalization ?? UNVERSIONED_TRIM_NORMALIZATION;
    const na = [...new Set(a.accepted.map((t) => normalizeBlankAnswerText(t, norm)))].sort();
    const nb = [...new Set(b.accepted.map((t) => normalizeBlankAnswerText(t, norm)))].sort();
    // Partial overlap cannot prove that omitted aliases are wrong.
    const allA = na.every((t) => nb.includes(t));
    const allB = nb.every((t) => na.includes(t));
    if (allA && allB) return { agree: true, key: a };
    return {
      agree: false,
      detail: `blank_text ${boundDetail(na.join('|'))} vs ${boundDetail(nb.join('|'))}`,
    };
  }
  if (a.kind === 'blank_numeric' && b.kind === 'blank_numeric') {
    if ((a.expected_unit ?? null) !== (b.expected_unit ?? null)) {
      return {
        agree: false,
        detail: `expected_unit ${a.expected_unit ?? '∅'} vs ${b.expected_unit ?? '∅'}: ${keyBrief(a)} vs ${keyBrief(b)}`,
      };
    }
    // 容差同型才可互证：absolute/relative 语义不同型 ⇒ 不视为等价，不合并铸键。
    if (a.tolerance.kind !== b.tolerance.kind) {
      return {
        agree: false,
        detail: `tolerance kind ${a.tolerance.kind} vs ${b.tolerance.kind}: ${keyBrief(a)} vs ${keyBrief(b)}`,
      };
    }
    const tolA = tolOf(a.tolerance);
    const tolB = tolOf(b.tolerance);
    const ok =
      numericAnswerWithinTolerance(a.expected, b.expected, b.tolerance) &&
      numericAnswerWithinTolerance(b.expected, a.expected, a.tolerance);
    if (!ok) {
      return { agree: false, detail: `numeric ${a.expected} vs ${b.expected}` };
    }
    // 一致且容差可比 ⇒ 铸更严的一侧（绝不取更宽）。
    const tighter = tolA <= tolB ? a.tolerance : b.tolerance;
    const looser = tolA <= tolB ? b.tolerance : a.tolerance;
    return {
      agree: true,
      key: { ...a, tolerance: tighter },
      detail:
        tolA === tolB
          ? undefined
          : `minted stricter tolerance (kept ${JSON.stringify(tighter)} over ${JSON.stringify(looser)})`,
    };
  }
  return {
    agree: false,
    detail: `uncomparable key kinds: ${keyBrief(a)} vs ${keyBrief(b)}`,
  };
}
