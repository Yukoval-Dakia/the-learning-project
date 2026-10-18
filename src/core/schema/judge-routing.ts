// Shared judge-route inference for AI-generated questions.
//
// Extracted from src/server/boss/handlers/embedded_check_generate.ts (Q1 of the
// search-grounded QuizGen wave, docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
// §2 / §5). Both EmbeddedCheckGenerate and QuizGen (and any future generator)
// need the same default judge_kind for a freshly generated question, so the
// routing rule lives here in core/ (cross-subject, no IO) rather than being
// duplicated per handler.
//
// The input is structural (kind + optional override + optional rubric) so any
// generated-question shape that carries those fields can be routed without
// importing the per-handler Zod schema.
//
// YUK-391 (kind Step 4) — the default route is a pure read of the answer-class
// axis (core/schema/answer-class.ts, the single source of truth). This is the
// PROFILE-FREE generation twin of route-resolve.ts
// (resolveQuestionJudgeRoute); the two must stay behavior-synced — pinned by
// src/core/schema/answer-class-route-parity.test.ts.
import type { z } from 'zod';
import { deriveAnswerClass } from './answer-class';
import type { JudgeKind, QuestionKind, Rubric } from './business';

// YUK-386 — question.kind is a free-form display label; QuestionKindT is
// `string` (kept as an alias for source-compatible imports). No reader below
// treats the label as a closed-set authority.
export type QuestionKindT = z.infer<typeof QuestionKind>;
export type JudgeKindT = z.infer<typeof JudgeKind>;

// nonEmptyStrings moved to answer-class.ts (YUK-391) so judge-routing can import
// deriveAnswerClass without an import cycle; re-exported here to keep this
// module's public surface stable for its existing consumers.
export { nonEmptyStrings } from './answer-class';

/** Minimum shape needed to infer a default judge route for a generated question. */
export interface JudgeRoutableQuestion {
  kind: QuestionKindT;
  judge_kind_override?: JudgeKindT | null;
  rubric_json?: z.infer<typeof Rubric> | null;
}

// YUK-1003 — web-sourced reference_md stores several producer conventions:
//   "（C）选项原文\n\n解析：…"          (jyeoo parenthesized head)
//   "C.0.432\n\n解析：…" / "B．0.4\n\n【详解】…"
//   "**C. 0.950**\n\n解析：…"          (markdown emphasis wrapper)
//   "$D(X+Y)=…$（选项 D）。\n\n解析：…"  (option text + trailing 选项 note)
//   "【答案】{2,3}\n【分析】…\n【解答】…" (jyeoo block format, single \n)
// Only the bare-answer head is judgeable by string equality; the tail is
// explanation prose no learner submission can reproduce verbatim. Shared by
// the exact judges (choice-index resolution AND the plain text compare both
// run on the head) and by the write-path exact-capability guard below, so all
// consumers resolve the same head.
const ANSWER_BLOCK_RE = /【\s*答案\s*】\s*([^\n【]+)/;
const EXPLANATION_TAIL_RE =
  /\n+\s*(?:【\s*(?:解析|详解|解答|分析|点评|点拨|答案解析)\s*】|\**\s*(?:解析|详解|解答|证明|分析|点评|点拨)\s*[：:])/;
const LEADING_ANSWER_MARKER_RE = /^(?:答案|答|解)\s*[：:．.]\s*/;

// YUK-1224 (SCF-141) — trailing-junk stripping, shared by both head-extraction
// branches. This replaced a single end-anchored regex
//   /(?:[\s。．.，,；;：:、*]|\s*[（(]\s*(?:选项|正确答案)\s*[A-Z]{0,4}\s*[)）]?)+$/
// whose outer `+` overlapped on whitespace (the bare `\s` alternative vs. the
// `\s*`-prefixed option annotation). On learner-supplied text such as
// `(' (选项A'.repeat(20)).trim() + 'x'` V8 enumerated an exponential number of
// partitions before concluding the end-anchored pattern does not match — a
// ~140-char submission stalled the event loop (the API allows 12 000 chars).
// stripTrailingJunk accepts the SAME language in linear time: the trailing run
// is the longest suffix that is a concatenation of tokens, each either
//   (a) one junk char (whitespace or the punctuation/`*` set), or
//   (b) an optional-whitespace + '(' / '（' + whitespace + 选项|正确答案 +
//       whitespace + 0-4 [A-Z] + whitespace + optional ')' / '）' annotation.
// judge-routing.test.ts pins it against the retired expression (differential
// oracle) and asserts the pathological input stays bounded.
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
export function stripTrailingJunk(s: string): string {
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

/**
 * The bare-answer head of a reference/answer blob: NFKC-normalize, strip edge
 * markdown emphasis, extract a 【答案】block when present, strip a leading
 * "答："/"解：" marker, cut the first newline-separated explanation tail
 * ("解析：…" / "【详解】…" …), then trim trailing punctuation and "(选项 D)"
 * annotations. Returns the trimmed head; falls back to the normalized input
 * when stripping would leave nothing (pure worked-solution blobs).
 */
export function extractAnswerHead(s: string): string {
  const t = s.normalize('NFKC').trim();
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

const SOLUTION_BLOB_RE = /解析|详解|解答|证明|【解|【答/;
const MAX_EXACT_HEAD_LEN = 300;

// ====================================================================
// YUK-1407 — 过程作答的【终态答案】提取（确定性、保守、绝不"最后数字获胜"）
// ====================================================================
//
// 主解答槽的学习者文本可以是完整推导（"…q=-2，S5=11"）。整段做答案头比较
// 必然 miss —— 这是 R02 误 0 的机制。本提取器只认【明示终态结论】：
//   1. 结论标记行/从句：答 / 答案 / 最终答案 / 综上 / 所以 / 因此 / 故 / 即 / ∴；
//   2. 末行尾随等式 `X = v`（右侧为结论值，左式不允许是比较符复合）。
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

// 声明类标记（"答：…"/"答案：…"/"最终答案"/"【答案】"）在任何行都成立 —— 它们
// 是对最终答案的明示声明，推导中间不会写。结论类标记（所以/因此/故/综上/即/∴）
// 与尾随等式只看【最后一个非空行】：推导中间步骤会用同一批词写中间结论，
// 终态结论永远在最后。
const DECLARATION_LINE_RE =
  /^\s*(?:【\s*(?:答案|答)\s*】|(?:最终答案|答案|答)\s*[：:，,．.\s])\s*(\S.*?)\s*$/u;
const LAST_LINE_CONCLUSION_RE =
  /^\s*(?:所以|因此|故|综上(?:所述)?|即|∴)\s*[：:，,．.]?\s*(\S.*?)\s*$/u;
const CONCLUSION_TAIL_RE = /(?:所以|因此|故|即|∴|为)\s*([^.。!！;；，,]+?)\s*[.。!！]?$/u;
const TRAILING_EQUALITY_RE =
  /([^<>=!≤≥≠≈∈\s][^<>!≤≥≠≈∈=\n]*?)\s*[=＝]\s*(\S[^=]*?)\s*[.。!！]?\s*$/u;
const FINAL_TRAILING_PUNCT_RE = /[\s。．.，,；;：:、!！?？*（）()]+$/u;
const COPULA_RE = /[为得是]\s*(\S[^为得是]*)$/u;
/**
 * 不安全提取守卫（P1 review）：否定（不是/不等/不得/并非）、比较符（<、>、
 * ≤、≥、≠、!=）与多重等号 —— 确定性契约无法证明其语义的值绝不进 found，
 * 只进 unsafe ⇒ ambiguous（人审裁决）。绝不把「答案不是11」经 copula 剥成
 * 「11」给满分，也不把「x<=11」「S5=10=11」的数字碎片当终态。「S5=31=11」
 * 这类无法证明同值的链式写法同样走 ambiguous —— 保守未决好过凭数字碎片发分。
 */
const UNSAFE_EXTRACT_RE = /≠|≤|≥|<=|>=|<|>|!=|不[是等得]|并非/u;

function canonicalFinal(value: string): string {
  return value
    .normalize('NFKC')
    .replace(FINAL_TRAILING_PUNCT_RE, '')
    .replace(/^[*_\s]+|[*_\s]+$/g, '')
    .trim()
    .toLowerCase();
}

/** "S5=11" → ["S5=11","11"]；"前五项和为11" → […,"11"]；否则原值单候选。 */
function candidateValues(raw: string): string[] {
  const value = raw.replace(FINAL_TRAILING_PUNCT_RE, '').trim();
  if (value.length === 0) return [];
  const values = [value];
  const eq = value.match(/[=＝]/);
  if (eq && eq.index !== undefined && eq.index > 0 && eq.index < value.length - 1) {
    const rhs = value.slice(eq.index + 1).trim();
    if (rhs.length > 0 && canonicalFinal(rhs) !== canonicalFinal(value)) values.push(rhs);
  }
  const copula = value.match(COPULA_RE);
  if (copula?.[1]) {
    const tail = copula[1].trim();
    if (canonicalFinal(tail).length > 0 && !values.includes(tail)) values.push(tail);
  }
  return values;
}

export function extractFinalAnswer(text: string): FinalAnswerExtraction {
  const lines = text
    .normalize('NFKC')
    .split(/\n+/)
    .map((line) => line.replace(/^[*_>\s]+|[*_\s]+$/g, '').trim())
    .filter((line) => line.length > 0);
  const found: {
    value: string;
    marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality';
  }[] = [];
  // 否定/比较/多重等号：无法确定性证明语义 → 永不进 found；存在即整体
  // ambiguous（人审裁决），即使另有安全候选——安全+不安全并存同样不可裁。
  const unsafe: string[] = [];
  const collect = (
    value: string,
    marker: 'answer_marker' | 'conclusion_marker' | 'trailing_equality',
  ) => {
    if (UNSAFE_EXTRACT_RE.test(value) || value.indexOf('=') !== value.lastIndexOf('=')) {
      unsafe.push(value);
    } else {
      found.push({ value, marker });
    }
  };

  for (const line of lines) {
    const declaration = line.match(DECLARATION_LINE_RE);
    if (declaration?.[1]) collect(declaration[1], 'answer_marker');
  }
  const lastLine = lines[lines.length - 1];
  if (lastLine !== undefined) {
    const conclusion = lastLine.match(LAST_LINE_CONCLUSION_RE);
    if (conclusion?.[1]) collect(conclusion[1], 'conclusion_marker');
    const tail = lastLine.match(CONCLUSION_TAIL_RE);
    if (tail?.[1]) collect(tail[1], 'conclusion_marker');
    const equality = lastLine.match(TRAILING_EQUALITY_RE);
    if (equality?.[2]) {
      // 行内多重等号（"S5=10=11"）：尾随等式只抓到链条最后一环，无法证明
      // 各环节同值 → 按 unsafe 处理，绝不把最后一环数字当终态。
      if (lastLine.split('=').length - 1 > 1) unsafe.push(equality[2]);
      else collect(equality[2], 'trailing_equality');
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
      values: candidateValues(entry.value).filter((v: string) => canonicalFinal(v).length > 0),
    }))
    .filter((entry) => entry.values.length > 0);
  if (entries.length === 0) return { kind: 'none' };
  let shared: Set<string> | null = null;
  for (const entry of entries) {
    const current = new Set<string>(entry.values.map(canonicalFinal));
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
 * 过程作答形态判定（保守）：多行、超出短答长度、或含推导标记 ⇒ true。
 * 只用于「比较不出结果时给 pending 而非 0」的诚实降级边界；提取得到明确
 * 终态的输入不走这里。
 */
export function isProcessLikeAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  const nonEmptyLines = t.split(/\n+/).filter((line) => line.trim().length > 0).length;
  return nonEmptyLines > 1 || [...t].length > PROCESS_ANSWER_MAX_LEN || PROCESS_MARKER_RE.test(t);
}

/**
 * 'exact' is a verbatim-compare contract: the reference must resolve to a bare
 * answer head — single short paragraph, no worked-solution markers. A producer
 * 'exact' override on a blob reference is structurally unwinnable (YUK-1003);
 * the write path demotes it to the derived route instead of storing a verdict
 * that can never pass. The guard is structural, not semantic: single-paragraph
 * process prose that extracts a head stays exact (rare, still matchable).
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

export function defaultJudgeKindForQuestion(q: JudgeRoutableQuestion): JudgeKindT {
  if (q.judge_kind_override) return q.judge_kind_override;
  // The gen-time twin is choices-blind by contract (generated choice rows carry
  // choices_md, but the runtime resolver owns the choices→exact structural
  // priority; parity is pinned cell-for-cell in answer-class-route-parity.test.ts).
  switch (
    deriveAnswerClass({ kind: q.kind, rubric_json: q.rubric_json ?? null, choices_md: null })
  ) {
    case 'exact':
      return 'exact';
    case 'keyword':
      return 'keyword';
    // M2.1 (2026-05-22): derivation must NEVER fall through to exact — step-by-step
    // answers cannot be graded by string equality. Generated derivation runs through
    // semantic (required_points-driven); the 'steps' route is reserved for
    // first-class math questions with reference_solution shape (see
    // src/core/capability/judges/steps.ts), not generator output. Defense-in-depth
    // covers LLM hallucination + future prompt changes.
    case 'steps':
      return 'semantic';
    case 'semantic':
      // Prose + keyword-less computation + every free-form label (YUK-386) →
      // semantic. The retired closed-enum fallback sent non-enum kinds to
      // 'exact'; under free-form labels that cell is removed — 'semantic' is
      // the conservative model-backed default for any label the classifier
      // does not recognise.
      return 'semantic';
  }
}
