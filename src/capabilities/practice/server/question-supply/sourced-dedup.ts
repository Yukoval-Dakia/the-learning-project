// YUK-986 (Supply-Agent/1) — 供给去重/白名单确定性原语下沉模块。
//
// 这三个 helper 原本散在 jobs/quiz_verify.ts、jobs/source_verify.ts、jobs/sourcing.ts，
// 而那三个 jobs 模块都 import server/question-supply/ —— supply-agent 的
// candidates/commit 模块（同在 question-supply/ 与 server/tools/）若反向 import jobs/
// 即成目录级 import 环。故纯函数下沉于此，jobs/* 改为经 re-export 透出（jobs→server
// 是既有受准方向；quiz_verify.test.ts / sourcing.test.ts 的既有 import 路径不动）。
// 全部逻辑逐字未改：
//   - maxNgramOverlap（含 shingles / normalizeForOverlap / jaccard / COPY_SAFETY_NGRAM）：
//     原 quiz_verify.ts §4/§5 确定性 word-shingle Jaccard（CJK-aware）。
//   - DEDUP_OVERLAP_THRESHOLD：原 source_verify.ts 的近重阈值（0.7，保守起点）。
//   - matchesWhitelist：原 sourcing.ts OF-2 的 host 后缀匹配。

// §4 / §5 — deterministic normalized n-gram overlap. Word-shingle Jaccard between
// the prompt and each source snippet; we take the MAX over snippets (worst-case
// closeness). Returns 0 when there are no usable snippets (nothing to copy from →
// no deterministic signal; the LLM copy_safety verdict still applies). Tunable;
// CONSERVATIVE start. Language-agnostic: splits on whitespace + CJK characters so
// it degrades gracefully for both English and Chinese source material.
const COPY_SAFETY_NGRAM = 3;

function normalizeForOverlap(text: string): string[] {
  // Lowercase, strip punctuation to spaces, then tokenise. CJK has no spaces, so
  // we also split runs of CJK ideographs into per-character tokens to give the
  // shingler something to chew on.
  const cleaned = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/([一-鿿])/gu, ' $1 ');
  return cleaned.split(/\s+/u).filter((t) => t.length > 0);
}

function shingles(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length < n) {
    // Too short for an n-gram — fall back to the whole token bag as a single
    // shingle so identical short strings still register as overlapping.
    if (tokens.length > 0) out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function maxNgramOverlap(promptMd: string, snippets: string[]): number {
  const promptShingles = shingles(normalizeForOverlap(promptMd), COPY_SAFETY_NGRAM);
  if (promptShingles.size === 0) return 0;
  let max = 0;
  for (const snippet of snippets) {
    if (!snippet) continue;
    const snippetShingles = shingles(normalizeForOverlap(snippet), COPY_SAFETY_NGRAM);
    const score = jaccard(promptShingles, snippetShingles);
    if (score > max) max = score;
  }
  return max;
}

// Dedup threshold: a sourced question whose prompt n-gram overlap with an existing
// ACTIVE pool question (sharing a knowledge point) is at/above this is treated as a
// near-duplicate. CONSERVATIVE start, tunable.
export const DEDUP_OVERLAP_THRESHOLD = 0.7;

// OF-2: does the question's source URL host match a whitelisted domain? Suffix match
// on the hostname (so 'example.edu' matches 'www.example.edu'). An unparseable URL
// never matches (treated as off-whitelist → demoted, not rejected).
export function matchesWhitelist(sourceUrl: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return false;
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return whitelist.some((domain) => {
    const d = domain.trim().toLowerCase().replace(/^\*\./, '');
    if (d.length === 0) return false;
    return host === d || host.endsWith(`.${d}`);
  });
}
