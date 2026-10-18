import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { learning_session, source_document } from '@/db/schema';
import { redactIngestionText } from '../privacy-guard';
import { formatAssetRef, readSourcePackage } from '../source-package';
import { cachedAgentRedaction } from './redaction-sink';
import { requireIngestionScope } from './source-tool-support';
import type { DomainTool, ToolContext } from './types';

// YUK-1404 (B2/R2) — read_source: the one text-reading tool for every source
// package kind. The agent gets the manifest (kind, page refs, text coverage)
// and windowed access to body_md — anchored markdown, so a page read is a
// slice between <!-- tlp:page index=N --> comments, never a fabricated
// transcription. There is deliberately no per-format reader.
//
// YUK-1522 (R8 R1) — every text window handed to the model is re-redacted
// through redactIngestionText before it leaves this tool (idempotent on
// already-redacted body_md; the docx/legacy lanes can hold raw text), and the
// fired fields/counts fold into the run-scoped redaction sink so the usage
// receipt's extracted_text:'redacted' claim is true, not nominal.

const MAX_CHARS_HARD_CAP = 24_000;
const DEFAULT_MAX_CHARS = 12_000;

const ReadSourceInputSchema = z.object({
  document_id: z.string().min(1),
  /** 0-based page index. When omitted the call returns the manifest only
   * (plus a document-level text window when one exists and offset is set). */
  page_index: z.number().int().min(0).optional(),
  /** Character offset into the selected text section (paging). */
  offset: z.number().int().min(0).optional(),
  /** Characters per window, ≤24000. */
  max_chars: z.number().int().min(200).max(MAX_CHARS_HARD_CAP).optional(),
});
type ReadSourceInput = z.infer<typeof ReadSourceInputSchema>;

const ReadSourceOutputSchema = z.object({
  status: z.enum(['ok', 'not_found', 'no_package', 'no_text', 'bad_page']),
  document_id: z.string(),
  kind: z.enum(['word', 'pdf', 'images']).nullable(),
  title: z.string().nullable(),
  page_count: z.number().int(),
  /** Whole-document text length (body_md), before windowing. */
  document_text_chars: z.number().int(),
  /** true for 'word' packages — the markdown covers the whole document, not
   * one page; use offset paging instead of page_index for text. */
  document_level_text: z.boolean(),
  manifest: z
    .array(
      z.object({
        index: z.number().int(),
        image_ref: z.string().nullable(),
        text_class: z.enum(['text', 'marker_only', 'empty']).nullable(),
        text_chars: z.number().int().nullable(),
      }),
    )
    .nullable(),
  text: z
    .object({
      scope: z.enum(['page', 'document']),
      page_index: z.number().int().nullable(),
      offset: z.number().int(),
      content: z.string(),
      next_offset: z.number().int().nullable(),
    })
    .nullable(),
});
type ReadSourceOutput = z.infer<typeof ReadSourceOutputSchema>;

const PAGE_ANCHOR_RE = /<!-- tlp:page index=(\d+).*?-->/g;

/** Slice the anchored body_md down to page `index`'s section. */
function pageSection(bodyMd: string, pageIndex: number): string | null {
  const marks: { index: number; at: number; end: number }[] = [];
  for (const m of bodyMd.matchAll(PAGE_ANCHOR_RE)) {
    marks.push({ index: Number(m[1]), at: m.index, end: m.index + m[0].length });
  }
  const mark = marks.find((x) => x.index === pageIndex);
  if (!mark) return null;
  const next = marks.find((x) => x.at > mark.at);
  const end = next ? next.at : bodyMd.length;
  return bodyMd.slice(mark.end, end).trim();
}

function windowText(
  content: string,
  offset: number,
  maxChars: number,
  scope: 'page' | 'document',
  pageIndex: number | null,
): NonNullable<ReadSourceOutput['text']> {
  const clampedOffset = Math.min(offset, content.length);
  const slice = content.slice(clampedOffset, clampedOffset + maxChars);
  const next = clampedOffset + slice.length;
  return {
    scope,
    page_index: pageIndex,
    offset: clampedOffset,
    content: slice,
    next_offset: next < content.length ? next : null,
  };
}

/**
 * R2-1: redact the FULL source text once (page section or whole document),
 * then window the REDACTED text — never slice raw text. A window that starts
 * mid-identifier (「电话：」on the previous window boundary) would leak the
 * bare number if redaction ran on the slice; redacting the whole text keeps
 * label↔value adjacency intact. Results are cached per run so re-windowing
 * neither re-pays the regex pass nor double-counts the receipt.
 */
function redactedFullText(ctx: ToolContext, cacheKey: string, raw: string): string {
  return cachedAgentRedaction(ctx, cacheKey, () => redactIngestionText(raw)).text;
}

async function executeReadSource(
  ctx: ToolContext,
  raw: ReadSourceInput,
): Promise<ReadSourceOutput> {
  const input = ReadSourceInputSchema.parse(raw);

  // Scope enforcement (P2-5, fails closed): the bound session's own
  // source_document is the only document this tool may read.
  const scopeId = requireIngestionScope(ctx);
  const [session] = await ctx.db
    .select({ source_document_id: learning_session.source_document_id })
    .from(learning_session)
    .where(eq(learning_session.id, scopeId))
    .limit(1);
  if (!session?.source_document_id || session.source_document_id !== input.document_id) {
    throw new Error(`document '${input.document_id}' is outside ingestion_session '${scopeId}'`);
  }

  const [doc] = await ctx.db
    .select({
      title: source_document.title,
      body_md: source_document.body_md,
      provenance: source_document.provenance,
    })
    .from(source_document)
    .where(eq(source_document.id, input.document_id))
    .limit(1);
  if (!doc) {
    return {
      status: 'not_found',
      document_id: input.document_id,
      kind: null,
      title: null,
      page_count: 0,
      document_text_chars: 0,
      document_level_text: false,
      manifest: null,
      text: null,
    };
  }

  const pkg = readSourcePackage(doc.provenance);
  const bodyMd = doc.body_md ?? '';
  const base = {
    document_id: input.document_id,
    kind: pkg?.kind ?? null,
    title: doc.title,
    page_count: pkg?.pages.length ?? 0,
    document_text_chars: bodyMd.length,
  };

  if (!pkg) {
    return {
      ...base,
      status: 'no_package',
      document_level_text: false,
      manifest: null,
      text: null,
    };
  }

  const manifest = pkg.pages.map((page) => ({
    index: page.index,
    image_ref:
      page.image_asset_id && page.image_sha256
        ? formatAssetRef(page.image_asset_id, page.image_sha256)
        : null,
    text_class: page.text_class ?? null,
    text_chars: page.text_chars ?? null,
  }));

  const offset = input.offset ?? 0;
  const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
  const isWordText = pkg.kind === 'word' && bodyMd.length > 0;

  if (input.page_index === undefined) {
    // Manifest call — include a document-level text window only for the kind
    // whose text IS the document (word) so the agent can start reading
    // immediately; pdf/pages are read per page_index.
    return {
      ...base,
      status: 'ok',
      document_level_text: isWordText,
      manifest,
      text: isWordText
        ? windowText(
            redactedFullText(ctx, `doc:${input.document_id}:full`, bodyMd),
            offset,
            maxChars,
            'document',
            null,
          )
        : null,
    };
  }

  const page = pkg.pages.find((p) => p.index === input.page_index);
  if (!page) {
    return {
      ...base,
      status: 'bad_page',
      document_level_text: isWordText,
      manifest,
      text: null,
    };
  }

  if (pkg.kind === 'word') {
    // Word text is document-level; a page read returns the page's image ref in
    // the manifest plus a document window — page text is never fabricated.
    return {
      ...base,
      status: isWordText ? 'ok' : 'no_text',
      document_level_text: isWordText,
      manifest,
      text: isWordText
        ? windowText(
            redactedFullText(ctx, `doc:${input.document_id}:full`, bodyMd),
            offset,
            maxChars,
            'document',
            null,
          )
        : null,
    };
  }

  const section = pageSection(bodyMd, input.page_index);
  if (section === null) {
    return {
      ...base,
      status: 'no_text',
      document_level_text: false,
      manifest,
      text: null,
    };
  }
  return {
    ...base,
    status: 'ok',
    document_level_text: false,
    manifest,
    text: windowText(
      redactedFullText(ctx, `doc:${input.document_id}:page:${input.page_index}`, section),
      offset,
      maxChars,
      'page',
      input.page_index,
    ),
  };
}

export const readSourceTool: DomainTool<ReadSourceInput, ReadSourceOutput> = {
  name: 'read_source',
  description:
    'Read an ingestion source package. Without page_index returns the package manifest (kind, per-page image refs, embedded-text coverage); page_index pages the per-page text (pdf) or returns the document-level markdown window (word — its text covers the whole document). Image refs in the manifest are versioned ast1 refs usable with view_image / crop_image / rotate_image / glm_ocr.',
  effect: 'read',
  inputSchema: ReadSourceInputSchema,
  outputSchema: ReadSourceOutputSchema,
  costClass: 'local',
  execute: executeReadSource,
  summarize: (_input, output) =>
    `read_source ${output.status} kind=${output.kind ?? 'none'} pages=${output.page_count}`,
  mirrorEvent: 'when_user_visible',
};
