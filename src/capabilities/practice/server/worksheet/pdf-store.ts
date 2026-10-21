// worksheet export PDF 的 blob 读写 seam。
// 写者只有 jobs/worksheet_render 的渲染 job；读者只有
// GET /api/worksheet-exports/[token]/pdf。R2 key 内容寻址
// （worksheet-pdf/<sha256-hex>.pdf）：digest 即 key 的唯一真源，
// 导出行不另存 key —— 重跑同一份渲染写同一个 key，天然幂等；
// 冲突渲染留下的孤儿对象也按 digest 可判。

import { eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { worksheet_export } from '@/db/schema';
import { type R2Client, getR2 } from '@/server/r2';

const PDF_DIGEST_PREFIX = 'sha256:';

/** pdf_digest（'sha256:<hex>'）→ R2 对象 key（内容寻址，重跑安全）。 */
export function worksheetPdfBlobKey(pdfDigest: string): string {
  return `worksheet-pdf/${pdfDigest.slice(PDF_DIGEST_PREFIX.length)}.pdf`;
}

/** 渲染 job 唯一的 PDF 写口：content-addressed put（重跑覆盖同 key，幂等）。 */
export async function putWorksheetExportPdf(
  pdfDigest: string,
  bytes: Uint8Array,
  r2?: R2Client,
): Promise<string> {
  const key = worksheetPdfBlobKey(pdfDigest);
  await (r2 ?? getR2()).put(key, bytes, 'application/pdf');
  return key;
}

export type WorksheetPdfResult =
  | { status: 'ok'; pdf: Uint8Array; pdf_digest: string; short_code: string }
  | { status: 'not_found' }
  | { status: 'not_rendered' }
  | { status: 'blob_missing'; blob_key: string };

/** token → 已存档 PDF 字节；未渲染与 blob 缺失分开如实上报。 */
export async function readWorksheetExportPdf(
  db: Db | Tx,
  token: string,
  r2?: R2Client,
): Promise<WorksheetPdfResult> {
  const [row] = await db
    .select({
      pdf_digest: worksheet_export.pdf_digest,
      archived_at: worksheet_export.archived_at,
      short_code: worksheet_export.short_code,
    })
    .from(worksheet_export)
    .where(eq(worksheet_export.export_token, token))
    .limit(1);
  if (row == null) return { status: 'not_found' };
  if (row.pdf_digest == null || row.archived_at == null) return { status: 'not_rendered' };
  const key = worksheetPdfBlobKey(row.pdf_digest);
  const bytes = await (r2 ?? getR2()).get(key);
  if (bytes == null) return { status: 'blob_missing', blob_key: key };
  return { status: 'ok', pdf: bytes, pdf_digest: row.pdf_digest, short_code: row.short_code };
}
