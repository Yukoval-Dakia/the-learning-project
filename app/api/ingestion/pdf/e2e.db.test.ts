import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { learning_session, source_document } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';

// Tracer-bullet of the seam invariant (YUK-250): render → image assets →
// session create → assets resolve as PNG bytes. Proves the downstream-zero-change
// claim — PDF-rendered page assets are indistinguishable from photo assets to
// the rest of the ingestion pipeline. Stops before the live Tencent/VLM worker
// (out of scope; covered by tencent_ocr_extract tests, unchanged here).
//
// db partition (real Postgres for source_asset / source_document /
// learning_session; R2 mocked in-memory and shared by all three routes).

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

import { GET as getAssetContent } from '../../assets/[id]/content/route';
// Import the route handlers AFTER the R2 mock so each picks up memR2.
import { POST as createSession } from '../route';
import { POST as expandPdf } from './route';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '../../../../tests/fixtures/pdf');

function pdfRequest(name: string): Request {
  const buf = readFileSync(join(FIX, name));
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const fd = new FormData();
  fd.set('file', new File([bytes], name, { type: 'application/pdf' }));
  return new Request('http://localhost/api/ingestion/pdf', { method: 'POST', body: fd });
}

describe('PDF ingest seam — expand → session → resolvable image assets', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('rendered page assets feed session create and resolve to PNG bytes', async () => {
    // 1. Expand the PDF → image asset ids.
    const expandRes = await expandPdf(pdfRequest('sample-2page.pdf'));
    expect(expandRes.status).toBe(201);
    const { asset_ids, page_count } = (await expandRes.json()) as {
      asset_ids: string[];
      page_count: number;
    };
    expect(page_count).toBe(2);
    expect(asset_ids).toHaveLength(2);

    // 2. Feed those ids into session create (entrypoint=vision_paper, the
    //    multi-page paper flow PDFs reuse).
    const sessionRes = await createSession(
      new Request('http://localhost/api/ingestion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entrypoint: 'vision_paper', asset_ids }),
      }),
    );
    expect(sessionRes.status).toBe(200);
    const { session } = (await sessionRes.json()) as {
      session: {
        id: string;
        source_document_id: string;
        status: string;
        source_asset_ids: string[];
      };
    };
    expect(session.status).toBe('uploaded');
    expect(session.source_asset_ids).toEqual(asset_ids);

    // 3. The session + document rows exist and carry exactly the rendered ids.
    const db = testDb();
    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, session.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('uploaded');
    const docs = await db
      .select()
      .from(source_document)
      .where(eq(source_document.id, session.source_document_id));
    expect(docs).toHaveLength(1);
    expect(docs[0].source_asset_ids).toEqual(asset_ids);

    // 4. Each rendered asset resolves via the same content route a photo asset
    //    would — PNG content-type and non-empty PNG-signature bytes. This is the
    //    "indistinguishable from a photo asset" proof.
    for (const id of asset_ids) {
      const contentRes = await getAssetContent(
        new Request(`http://localhost/api/assets/${id}/content`),
        {
          params: Promise.resolve({ id }),
        },
      );
      expect(contentRes.status).toBe(200);
      expect(contentRes.headers.get('Content-Type')).toBe('image/png');
      const bytes = new Uint8Array(await contentRes.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);
      // PNG 8-byte signature: 89 50 4E 47 0D 0A 1A 0A
      expect(Array.from(bytes.subarray(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    }
  });
});
