import { eq, inArray } from 'drizzle-orm';
import { canonicalHash, sha256Hex } from '@/core/migration/canonical';
import { DocxAgentState, DocxSourcePackage } from '@/core/schema/docx-agent';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { Tx } from '@/db/client';
import { question_block, source_asset, source_document } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type { ImportBodyParsed } from '../../api/import-schema';
import { docxAgentGaps } from './agent-workspace';

function reject(message: string): never {
  throw new ApiError('conflict', `DOCX agent review required: ${message}`, 409);
}
/** Agent attestation is distinct from the legacy human-confirmation format.
 * This gate validates the frozen draft, not correctness or answerability. */
export async function confirmDocxAgentImport(
  tx: Tx,
  sessionId: string,
  source: typeof source_document.$inferSelect,
  body: ImportBodyParsed,
) {
  const pkg = DocxSourcePackage.parse(source.provenance.docx_package);
  const state = DocxAgentState.parse(source.provenance.docx_agent);
  if (!state.sealed) reject('extraction was not committed');
  if (
    pkg.files.find((f) => f.role === 'original')?.sha256 !== pkg.input_sha256 ||
    pkg.files.find((f) => f.role === 'markdown')?.sha256 !== sha256Hex(source.body_md ?? '')
  )
    reject('source content changed');
  const rows = await tx
    .select()
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, sessionId));
  const assets = await tx
    .select()
    .from(source_asset)
    .where(
      inArray(
        source_asset.id,
        pkg.files.map((f) => f.asset_id),
      ),
    );
  if (
    pkg.files.some(
      (f) =>
        !source.source_asset_ids.includes(f.asset_id) ||
        assets.find((a) => a.id === f.asset_id)?.sha256 !== f.sha256,
    )
  )
    reject('source manifest changed');
  for (const block of body.blocks) {
    if (block.source_block_ids.length !== 1) reject('import must retain one agent draft lineage');
    const mapping = state.blocks.find((m) => m.block_id === block.source_block_ids[0]);
    const q = state.questions.find((q) => q.key === mapping?.key);
    const row = rows.find((row) => row.id === mapping?.block_id);
    if (!q || !row || row.version !== mapping?.version || !row.structured)
      reject('draft changed after agent review');
    const qFiles = pkg.files.filter(
      (f) =>
        (f.role === 'page' && q.page_spans.some((p) => p.page_index === f.page_index)) ||
        q.figures.some((image) => image.asset_id === f.asset_id),
    );
    if (
      docxAgentGaps(
        { ...pkg, files: qFiles },
        {
          ...state,
          questions: [q],
          coverage: state.coverage.map((c) => ({
            ...c,
            question_keys: c.question_keys.filter((key) => key === q.key),
          })),
        },
        0,
      ).length
    )
      reject(`draft ${q.key} has unresolved material`);
    if (
      block.final_prompt_md !== structuredToPromptMarkdown(row.structured) ||
      canonicalHash(block.image_refs) !== canonicalHash(row.image_refs) ||
      canonicalHash(block.page_spans.map((p) => ({ page_index: p.page_index, bbox: p.bbox }))) !==
        canonicalHash(row.page_spans.map((p) => ({ page_index: p.page_index, bbox: p.bbox }))) ||
      (row.structured.kind && block.question_kind !== row.structured.kind)
    )
      reject('import content differs from reviewed agent draft');
  }
}

export async function hasPendingDocxAgentMaterial(tx: Tx, sourceId: string): Promise<boolean> {
  const [source] = await tx.select().from(source_document).where(eq(source_document.id, sourceId));
  if (source?.provenance.line !== 'agent') return false;
  const state = DocxAgentState.parse(source.provenance.docx_agent);
  const pkg = DocxSourcePackage.parse(source.provenance.docx_package);
  return docxAgentGaps(pkg, state, (source.body_md ?? '').length).length > 0;
}
