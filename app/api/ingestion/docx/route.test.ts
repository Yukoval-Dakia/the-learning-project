import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { event, job_events, learning_session, question_block, source_asset } from '@/db/schema';
import { setDocxConverterForTests } from '@/server/ingestion/docx/convert';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';

// db partition. Real Postgres for source_document / learning_session /
// question_block / job_events / event; R2 mocked in-memory; boss mocked; the
// converter seam injected with pre-converted fixtures (NO real spawn / docker).
// Mock-before-import discipline: r2 + boss mocks are declared before the route
// import below.

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

const bossSend = vi.fn(async () => 'job-id-1');
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: async () => ({ send: bossSend }),
}));

// Import the route AFTER the mocks so it picks up memR2 + the mocked boss.
import { POST } from './route';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCX_FIX = join(__dirname, '../../../../tests/fixtures/docx');
const PDF_FIX = join(__dirname, '../../../../tests/fixtures/pdf');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function bytesOf(dir: string, name: string): Uint8Array {
  // Copy into a fresh, non-shared ArrayBuffer so the type is Uint8Array<ArrayBuffer>
  // (a Buffer view's .buffer is ArrayBufferLike, which File([...]) rejects).
  return new Uint8Array(readFileSync(join(dir, name)));
}

function fileFromBytes(bytes: Uint8Array, name: string, mime: string): File {
  return new File([bytes.slice().buffer], name, { type: mime });
}

function docxRequest(name: string, mime = DOCX_MIME): Request {
  const fd = new FormData();
  fd.set('file', fileFromBytes(bytesOf(DOCX_FIX, name), name, mime));
  return new Request('http://localhost/api/ingestion/docx', { method: 'POST', body: fd });
}

// A real 2-page PDF (from the pdf fixtures) so renderPdfToPngPages produces real
// page images when the seam's docxToPdf is invoked.
const REAL_PDF = bytesOf(PDF_FIX, 'sample-2page.pdf');

// Pre-converted text-line markdown (pandoc gfm) — the same fixture the segmenter
// unit test reads.
const YUWEN_MD = readFileSync(join(DOCX_FIX, 'yuwen-text.md'), 'utf-8');
const TINY_PNG = bytesOf(DOCX_FIX, 'media/image1.png');

function injectTextConverter(markdown = YUWEN_MD) {
  setDocxConverterForTests({
    async docxToMarkdown() {
      return { markdown, media: [{ path: 'media/image1.png', bytes: TINY_PNG }] };
    },
    async docxToPdf() {
      return REAL_PDF;
    },
  });
}

function injectVisualConverter() {
  setDocxConverterForTests({
    async docxToMarkdown() {
      throw new Error('visual line should not call docxToMarkdown');
    },
    async docxToPdf() {
      return REAL_PDF;
    },
  });
}

describe('POST /api/ingestion/docx', () => {
  beforeEach(async () => {
    r2._store.clear();
    bossSend.mockClear();
    await resetDb();
  });
  afterEach(() => {
    setDocxConverterForTests(null);
  });

  it('text line: yuwen docx → extracted session + draft blocks + terminal event', async () => {
    injectTextConverter();
    const res = await POST(docxRequest('yuwen-text.docx'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_id: string; line: string; page_count: number };
    expect(body.line).toBe('text');
    expect(body.page_count).toBe(2); // REAL_PDF is 2 pages

    const db = testDb();
    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('extracted');
    expect(sessions[0].entrypoint).toBe('docx');
    // Evidence page images pinned (2 from the real PDF).
    expect(sessions[0].source_asset_ids).toHaveLength(2);

    // Blocks: 2 questions from the yuwen fixture, all draft + structured.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, body.session_id));
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b.status).toBe('draft');
      expect(b.layout_quality).toBe('structured');
      expect(b.structured?.source).toBe('docx_text');
      expect(b.page_spans).toEqual([{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }]);
    }
    // Q1 carries the embedded image as an image_ref (asset id, not media path).
    const q1 = blocks.find((b) => b.structured?.question_no === '1');
    expect(q1?.image_refs).toHaveLength(1);

    // Evidence pages + 1 embedded image = 3 source_asset rows.
    const assets = await db.select().from(source_asset);
    expect(assets.length).toBe(3);

    // SSE terminal event emitted (no queued/extracting hops).
    const events = await db
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, body.session_id));
    const types = events.map((e) => e.event_type);
    expect(types).toContain('ingestion.uploaded');
    expect(types).toContain('ingestion.extraction_completed');
    expect(types).not.toContain('ingestion.queued');
    expect(types).not.toContain('ingestion.extracting');

    // Domain extract event with actor_ref='docx_text', outcome='success'.
    const domainEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.session_id, body.session_id), eq(event.action, 'extract')));
    expect(domainEvents).toHaveLength(1);
    expect(domainEvents[0].actor_ref).toBe('docx_text');
    expect(domainEvents[0].outcome).toBe('success');

    // boss NOT touched on the text line.
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('visual line: mathtype docx → queued session + tencent_ocr_extract enqueued', async () => {
    injectVisualConverter();
    const res = await POST(docxRequest('math-mathtype.docx'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_id: string; line: string; page_count: number };
    expect(body.line).toBe('visual');
    expect(body.page_count).toBe(2);

    const db = testDb();
    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('queued');
    expect(sessions[0].entrypoint).toBe('docx');

    // No blocks on the visual line (extract is async via worker).
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, body.session_id));
    expect(blocks).toHaveLength(0);

    // tencent_ocr_extract enqueued exactly once.
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith('tencent_ocr_extract', { sessionId: body.session_id });
  });

  it('rejects oversized upload → 400', async () => {
    injectTextConverter();
    const big = new Uint8Array(20_000_001);
    const fd = new FormData();
    fd.set('file', new File([big.buffer], 'big.docx', { type: DOCX_MIME }));
    const res = await POST(
      new Request('http://localhost/api/ingestion/docx', { method: 'POST', body: fd }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/上限/);
  });

  it('rejects a non-docx mime → 400', async () => {
    injectTextConverter();
    const res = await POST(docxRequest('yuwen-text.docx', 'image/png'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unsupported mime_type/);
  });

  it('text line with 0 segmented blocks → 400 and NO session残留', async () => {
    // Inject a converter whose markdown has no question numbers → 0 blocks.
    injectTextConverter('一段没有题号的普通文字。\n\n另一段。');
    const res = await POST(docxRequest('yuwen-text.docx'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/未能切出任何题/);

    // No session row created (rejected before initiateDocxTextUpload).
    const db = testDb();
    const sessions = await db.select().from(learning_session);
    expect(sessions).toHaveLength(0);
  });
});
