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
