import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { z } from 'zod';

const RecentFailureEvidence = z
  .object({ recent_failure_count_30d: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();

const UNREADABLE_REASON = '这条提议暂无可读的依据说明，请核实后再决定是否采纳。';

function knownEvidence(value: unknown): string | null {
  const parsed = RecentFailureEvidence.safeParse(value);
  return parsed.success
    ? `提议引用的统计中，最近 30 天有 ${parsed.data.recent_failure_count_30d} 条失败作答记录。`
    : null;
}

/** Only a complete known fact is translated. A mixed dump is never interpreted. */
export function proposalReasonPlainText(value: unknown): string {
  if (typeof value !== 'string') return knownEvidence(value) ?? UNREADABLE_REASON;
  const text = value.trim();
  if (!text) return UNREADABLE_REASON;

  const legacyCount = /^recent_failure_count_30d\s*=\s*(0|[1-9][0-9]*)$/.exec(text);
  if (legacyCount) {
    return knownEvidence({ recent_failure_count_30d: Number(legacyCount[1]) }) ?? UNREADABLE_REASON;
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return knownEvidence(JSON.parse(text)) ?? UNREADABLE_REASON;
    } catch {
      return UNREADABLE_REASON;
    }
  }

  // These recognize dump/secret syntax, not the meaning of educational prose.
  if (
    text.includes('recent_failure_count_30d') ||
    /```|~~~|<(?:think|thinking|analysis|reasoning)\b/i.test(text) ||
    technicalAssignmentOutsideMath(text) ||
    /\b(?:api[-_]?key|password|secret|authorization|access[-_]?token|refresh[-_]?token)\b\s*[=:]/i.test(
      text,
    ) ||
    /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+\S+/i.test(text) ||
    /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(
      text,
    ) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /(?:\b(?:phone|email|address)\b|电话|邮箱|住址)\s*[=:：]/i.test(text) ||
    unsafeUrlIn(text)
  ) {
    return UNREADABLE_REASON;
  }
  // No slicing, token substitution, or math-delimiter rewriting.
  return value;
}

interface ReasonMathNode {
  type: string;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
  children?: ReasonMathNode[] | undefined;
}

const reasonMathParser = unified().use(remarkParse).use(remarkMath);

function technicalAssignmentOutsideMath(text: string): boolean {
  const assignments = [...text.matchAll(/\b[a-z][a-z0-9]*_[a-z][a-z0-9_]+["']?\s*[=:]/gi)];
  if (assignments.length === 0) return false;
  const mathSpans: Array<[number, number]> = [];
  const collect = (node: ReasonMathNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === 'inlineMath' || node.type === 'math') &&
      start !== undefined &&
      end !== undefined
    ) {
      mathSpans.push([start, end]);
    }
    for (const child of node.children ?? []) collect(child);
  };
  try {
    collect(reasonMathParser.parse(text));
  } catch {
    return true;
  }
  // The renderer's explicit legacy delimiter grammar, in original source coordinates.
  const legacy =
    /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;
  for (const match of text.matchAll(legacy)) {
    if (match[2] !== undefined || match[3] !== undefined) {
      mathSpans.push([match.index, match.index + match[0].length]);
    }
  }
  return assignments.some(
    (match) =>
      !mathSpans.some(
        ([start, end]) => start <= match.index && match.index + match[0].length <= end,
      ),
  );
}

function unsafeUrlIn(text: string): boolean {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'；]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || url.search) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Raw reason copies in legacy payloads must not bypass the public read mapping. */
export function mapProposalReasonFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapProposalReasonFields);
  if (typeof value !== 'object' || value === null) return value;
  const entries: Array<[string, unknown]> = Object.entries(value);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      key === 'reason_md' || key === 'reasoning' || key === 'reason' || key === 'archived_reason'
        ? proposalReasonPlainText(item)
        : mapProposalReasonFields(item),
    ]),
  );
}
