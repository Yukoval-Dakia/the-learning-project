// YUK-697 — jyeoo-rs → loom NDJSON adapter (pure, unit-tested).
//
// ~/jyeoo-rs/docs/DESIGN.md §1.1 (NDJSON envelope) / §5 (exit codes);
// docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md §5 (VIP, image).
//
// The producer emits one JSON envelope per stdout line: { question, jyeoo }. `question`
// is byte-aligned with loom's SourcedQuestion Zod contract; `jyeoo` is a free-form
// extension block the handler reads for VIP status / knowledge hints / audit. This
// module owns: (a) per-line parse + SourcedQuestion validation, (b) deterministic exit
// classification, (c) image-dependency detection + markdown destination rewriting.
// No IO, no DB — spawn lives in jyeoo-spawn.ts, persistence in the handler.

import { SourcedQuestion, type SourcedQuestionT } from '@/core/schema/sourcing';
import { z } from 'zod';

// ── exit classification ──────────────────────────────────────────────────────
//
// DESIGN §5 exit codes: 0 ok / 2 args (clap) / 3 auth (cookie invalid / guest) /
// 4 network / 5 parse. YUK-697 producer-patch proposal adds 6 = VIP required/expired
// (so a non-VIP run fails BEFORE emitting hole-punched reference_md rather than exiting
// 0 with degraded content). Until the patch lands, the handler ALSO gates on the
// per-line vip flag (belt-and-suspenders — see jyeoo.vip below).
export const JYEOO_EXIT = {
  OK: 0,
  ARGS: 2,
  AUTH: 3,
  NETWORK: 4,
  PARSE: 5,
  VIP: 6,
} as const;

export type JyeooFailureClass =
  | 'auth' // cookie invalid / guest mode (exit 3) — terminal, needs a fresh cookie.
  | 'vip' // VIP expired/absent (exit 6, or a per-line vip:false) — terminal, needs VIP.
  | 'network' // transient network error (exit 4) — retryable.
  | 'timeout' // wall-clock timeout, process killed — retryable.
  | 'parse' // producer-side HTML parse failure (exit 5) — terminal (producer bug).
  | 'args' // bad CLI args (exit 2) — terminal (caller bug).
  | 'spawn' // failed to spawn / killed by signal (no clean exit) — terminal.
  | 'unknown'; // any other non-zero exit — terminal (fail loud).

export interface JyeooExitClassification {
  /** null ⇒ clean success (exit 0, no timeout, no signal). */
  failure: JyeooFailureClass | null;
  /** Retryable failures (network/timeout) should re-throw so pg-boss retries; terminal
   *  ones write a failure event and return without a retry storm. */
  retryable: boolean;
}

/**
 * Classify a finished jyeoo-rs run. A non-zero exit (or a timeout / killing signal)
 * means the WHOLE batch is discarded before any INSERT — the producer contract is
 * "fail the whole batch, never emit half the data" (DESIGN §5 反爬: batch 中途失效立即
 * 整体退出码 3), so a partial/mid-crash run must not ingest partial questions.
 */
export function classifyJyeooExit(input: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}): JyeooExitClassification {
  if (input.timedOut) return { failure: 'timeout', retryable: true };
  if (input.exitCode === null || input.signal !== null) {
    // Killed by a signal / never produced an exit code (spawn failure).
    return { failure: 'spawn', retryable: false };
  }
  switch (input.exitCode) {
    case JYEOO_EXIT.OK:
      return { failure: null, retryable: false };
    case JYEOO_EXIT.AUTH:
      return { failure: 'auth', retryable: false };
    case JYEOO_EXIT.VIP:
      return { failure: 'vip', retryable: false };
    case JYEOO_EXIT.NETWORK:
      return { failure: 'network', retryable: true };
    case JYEOO_EXIT.PARSE:
      return { failure: 'parse', retryable: false };
    case JYEOO_EXIT.ARGS:
      return { failure: 'args', retryable: false };
    default:
      return { failure: 'unknown', retryable: false };
  }
}

// ── per-line envelope parse ──────────────────────────────────────────────────
//
// The `jyeoo` extension block is deliberately loose (passthrough) — the handler only
// reads vip + id/subject for audit; everything else is opaque. vip is OPTIONAL: the
// pre-patch producer omits it (the handler then relies on the exit-6 gate); the patched
// producer emits vip:true on every line and exits 6 (never emitting lines) when non-VIP.
const JyeooMeta = z
  .object({
    id: z.string().optional(),
    subject: z.string().optional(),
    knowledge_hints: z.array(z.string()).optional(),
    vip: z.boolean().optional(),
    fetched_at: z.string().optional(),
  })
  .passthrough();

export type JyeooMetaT = z.infer<typeof JyeooMeta>;

const JyeooEnvelope = z.object({
  question: SourcedQuestion,
  jyeoo: JyeooMeta.optional(),
});

export type JyeooParsedLine =
  | { ok: true; question: SourcedQuestionT; jyeoo: JyeooMetaT }
  | { ok: false; reason: string };

/**
 * Parse one NDJSON stdout line into a validated { question, jyeoo }. A blank line
 * returns a skip signal (ok:false with a blank reason the caller ignores). A malformed
 * line (bad JSON or a question that fails the SourcedQuestion contract) returns ok:false
 * with a reason — the caller counts it as `invalid` and drops THAT line, but a clean
 * exit-0 run still ingests the valid lines (a single bad line must not sink the batch;
 * a mid-batch producer failure surfaces as a non-zero exit, handled separately).
 */
export function parseJyeooLine(line: string): JyeooParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'blank' };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, reason: `json parse: ${(e as Error).message}` };
  }
  const parsed = JyeooEnvelope.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `envelope invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, question: parsed.data.question, jyeoo: parsed.data.jyeoo ?? {} };
}

// ── image dependency ─────────────────────────────────────────────────────────
//
// A markdown image `![alt](src)` in the stem or a choice means the question's meaning
// depends on a figure. YUK-727 now localizes and persists those figures; this predicate
// remains the pure structural classifier for consumers. reference_md is scanned too: the
// worked solution is learner-visible and must not retain a temporary/external image URL.
//
// Deliberately OVER-INCLUSIVE: detect the
// markdown image MARKER STRUCTURE `![...](` rather than parse a full `(...)` URL. A URL
// containing a literal `)` (e.g. `![x](https://h/Foo_(bar).png)`) would defeat a
// balanced-paren/`[^)]*` regex and let the figure question slip through — better to
// over-classify than to miss a prompt whose judging depends on a figure.
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(/;

export function isImageDependentQuestion(q: SourcedQuestionT): boolean {
  if (MARKDOWN_IMAGE.test(q.prompt_md)) return true;
  for (const choice of q.choices_md ?? []) {
    if (MARKDOWN_IMAGE.test(choice)) return true;
  }
  return MARKDOWN_IMAGE.test(q.reference_md ?? '');
}

interface MarkdownImageDestination {
  source: string;
  start: number;
  end: number;
}

interface MarkdownImageScan {
  images: MarkdownImageDestination[];
  malformed: boolean;
}

/**
 * Locate markdown image destinations, including URLs with balanced parentheses. jyeoo-rs emits
 * the narrow `![alt](source)` shape (no title), so the destination body is the source verbatim.
 */
function scanImageDestinations(markdown: string): MarkdownImageScan {
  const found: MarkdownImageDestination[] = [];
  let malformed = false;
  let cursor = 0;
  while (cursor < markdown.length) {
    const marker = markdown.indexOf('![', cursor);
    if (marker === -1) break;
    const destinationStart = markdown.indexOf('](', marker + 2);
    if (destinationStart === -1) {
      // A bare `![` is ordinary punctuation, but a completed alt + opening destination
      // is an image marker. The latter must never fail open into persisted Markdown.
      if (MARKDOWN_IMAGE.test(markdown.slice(marker))) malformed = true;
      break;
    }

    const start = destinationStart + 2;
    let depth = 1;
    let escaped = false;
    let end = start;
    for (; end < markdown.length; end += 1) {
      const char = markdown[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      malformed = true;
      break;
    }

    const source = markdown.slice(start, end).trim();
    if (source.length > 0) found.push({ source, start, end });
    cursor = end + 1;
  }
  return { images: found, malformed };
}

function imageDestinations(markdown: string): MarkdownImageDestination[] {
  return scanImageDestinations(markdown).images;
}

export function markdownImageSources(markdown: string | null | undefined): string[] {
  return markdown ? imageDestinations(markdown).map((image) => image.source) : [];
}

/** True when Markdown contains an opened image destination that the balanced scanner cannot close. */
export function hasMalformedMarkdownImage(markdown: string | null | undefined): boolean {
  return markdown ? scanImageDestinations(markdown).malformed : false;
}

/** Replace only image destinations; alt text and surrounding markdown remain byte-identical. */
export function rewriteMarkdownImageSources(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let rewritten = markdown;
  for (const image of imageDestinations(markdown).reverse()) {
    const replacement = replacements.get(image.source);
    if (replacement === undefined) continue;
    rewritten = `${rewritten.slice(0, image.start)}${replacement}${rewritten.slice(image.end)}`;
  }
  return rewritten;
}

// ── source host guard ─────────────────────────────────────────────────────────
//
// A row whose source_url host is NOT the expected jyeoo host is a producer anomaly (a
// jyeoo scrape only ever yields www.jyeoo.com URLs). Since source_verify grounds a
// web_sourced row against its PERSISTED extract (never a refetch), a foreign URL would
// otherwise promote to tier-2 unchecked — so the handler filters such rows pre-INSERT.
// An unparseable URL is treated as foreign (SourcedQuestion.parse already requires a valid
// URL, so this only fires on a genuine host mismatch). Exact hostname match (case-folded).
export function isForeignSourceHost(sourceUrl: string, expectedHost: string): boolean {
  try {
    return new URL(sourceUrl).hostname.toLowerCase() !== expectedHost.toLowerCase();
  } catch {
    return true;
  }
}
