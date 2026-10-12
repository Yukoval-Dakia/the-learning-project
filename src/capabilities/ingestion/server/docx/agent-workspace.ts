import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { canonicalHash } from '@/core/migration/canonical';
import {
  DocxAgentState,
  type DocxAgentStateT,
  type DocxDraftInputT,
  type DocxReadInputT,
  DocxSourcePackage,
  type DocxSourcePackageT,
} from '@/core/schema/docx-agent';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { learning_session, question_block, source_asset, source_document } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type { R2Client } from '@/server/r2';
import { Ingestion } from '@/server/session';

function conflict(message: string): never {
  throw new ApiError('conflict', message, 409);
}
export function docxAgentGaps(
  pkg: DocxSourcePackageT,
  state: DocxAgentStateT,
  textLength: number,
): string[] {
  const gaps: string[] = [];
  if (!state.questions.length) gaps.push('No questions recorded');
  const keys = new Set(state.questions.map((q) => q.key));
  for (const q of state.questions) {
    gaps.push(...q.unresolved.map((issue) => `${q.key}: ${issue}`));
    const visit = (node: StructuredQuestionT) => {
      if (!node.prompt_text.trim()) gaps.push(`${q.key}/${node.id}: prompt missing`);
      if (node.options && new Set(node.options.map((o) => o.label)).size !== node.options.length)
        gaps.push(`${q.key}/${node.id}: duplicate option labels`);
      for (const child of node.sub_questions ?? []) visit(child);
    };
    visit(q.structured);
  }
  for (const file of pkg.files.filter((f) => f.role === 'page' || f.role === 'media')) {
    if (!state.seen_images.includes(file.asset_id))
      gaps.push(`${file.name}: not viewed as a complete image`);
    const review = state.coverage.find((c) => c.asset_id === file.asset_id);
    if (!review || review.disposition === 'unresolved')
      gaps.push(`${file.name}: unresolved coverage`);
    if (review?.question_keys.some((key) => !keys.has(key)))
      gaps.push(`${file.name}: unknown question reference`);
    if (review?.disposition === 'question_material' && !review.question_keys.length)
      gaps.push(`${file.name}: no question owner`);
    if (file.role === 'media' && review) {
      const owners = state.questions
        .filter((q) => q.figures.some((f) => f.asset_id === file.asset_id))
        .map((q) => q.key);
      if (
        review.disposition === 'question_material' &&
        JSON.stringify([...owners].sort()) !== JSON.stringify([...review.question_keys].sort())
      )
        gaps.push(`${file.name}: figure ownership differs from coverage`);
      if (review.disposition === 'non_question_material' && owners.length)
        gaps.push(`${file.name}: non-question image is attached to a question`);
    }
    if (file.role === 'page' && review) {
      const owners = state.questions
        .filter((q) => q.page_spans.some((p) => p.page_index === file.page_index))
        .map((q) => q.key);
      if (
        review.disposition === 'question_material' &&
        JSON.stringify([...owners].sort()) !== JSON.stringify([...review.question_keys].sort())
      )
        gaps.push(`${file.name}: page ownership differs from coverage`);
      if (review.disposition === 'non_question_material' && owners.length)
        gaps.push(`${file.name}: non-question page contains draft references`);
    }
  }
  let end = 0;
  for (const [start, stop] of [...state.text_ranges].sort((a, b) => a[0] - b[0])) {
    if (start > end) break;
    end = Math.max(end, stop);
  }
  if (end < textLength) gaps.push(`Source text unread from character ${end} of ${textLength}`);
  return gaps;
}

/** The agent receives file handles, never paths or shell access. Only immutable
 * session-owned bytes are restored; display names cannot select filesystem paths. */
export async function openDocxAgentWorkspace(
  db: Db,
  r2: R2Client,
  sessionId: string,
  taskRunId: string,
) {
  const [session] = await db
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, sessionId));
  if (!session?.source_document_id) conflict('DOCX session has no source');
  const sourceId = session.source_document_id;
  const [source] = await db.select().from(source_document).where(eq(source_document.id, sourceId));
  const pkg = DocxSourcePackage.parse(source.provenance.docx_package);
  const directory = await mkdtemp(join(tmpdir(), 'tlp-docx-agent-'));
  const paths = new Map<string, string>();
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  try {
    const rows = await db
      .select()
      .from(source_asset)
      .where(
        inArray(
          source_asset.id,
          pkg.files.map((f) => f.asset_id),
        ),
      );
    for (const [index, file] of pkg.files.entries()) {
      const row = rows.find((r) => r.id === file.asset_id);
      if (!row || !source.source_asset_ids.includes(row.id) || row.sha256 !== file.sha256)
        conflict('DOCX package ownership or digest changed');
      const bytes = await r2.get(row.storage_key);
      if (!bytes || hash(bytes) !== file.sha256)
        conflict(`DOCX source bytes missing or changed: ${file.name}`);
      const path = join(directory, String(index));
      await writeFile(path, bytes);
      paths.set(file.asset_id, path);
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(pkg));
  } catch (err) {
    await rm(directory, { recursive: true, force: true });
    throw err;
  }
  const fileFor = (assetId?: string) => {
    const file = pkg.files.find((f) => f.asset_id === assetId);
    if (!file) conflict('File is outside this ingestion workspace');
    return file;
  };
  const bytesFor = async (assetId: string) => {
    const file = fileFor(assetId);
    const path = paths.get(file.asset_id);
    if (!path) conflict('File was not restored');
    return readFile(path);
  };
  const markdown = pkg.files.find((f) => f.role === 'markdown');
  if (!markdown) {
    await rm(directory, { recursive: true, force: true });
    conflict('DOCX text source missing');
  }
  const text = (await bytesFor(markdown.asset_id)).toString('utf8');
  const mutate = async <T>(
    fn: (state: DocxAgentStateT, tx: Tx) => T | Promise<T>,
    bind = false,
  ): Promise<T> =>
    db.transaction(async (tx) => {
      const [liveSession] = await tx
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, sessionId))
        .for('update');
      if (liveSession?.status !== 'extracting' || liveSession.source_document_id !== sourceId)
        conflict('DOCX extraction is no longer active');
      const [live] = await tx
        .select()
        .from(source_document)
        .where(eq(source_document.id, sourceId))
        .for('update');
      if (canonicalHash(live.provenance.docx_package) !== canonicalHash(pkg))
        conflict('DOCX source package changed');
      const state = DocxAgentState.parse(live.provenance.docx_agent);
      if (!bind && state.task_run_id !== taskRunId) conflict('DOCX agent run was superseded');
      if (bind) state.task_run_id = taskRunId;
      // Existing draft tools remain the canonical editors. Refresh their committed
      // structure and versions before checking or saving; every edit invalidates coverage.
      for (const mapping of state.blocks) {
        const [row] = await tx
          .select()
          .from(question_block)
          .where(eq(question_block.id, mapping.block_id))
          .for('update');
        const q = state.questions.find((q) => q.key === mapping.key);
        if (!row || row.ingestion_session_id !== sessionId)
          conflict('DOCX draft ownership changed');
        if (!q) continue;
        if (row.status === 'ignored') {
          state.retired.push(q);
          state.questions = state.questions.filter((entry) => entry.key !== q.key);
          state.coverage = state.coverage.filter((c) => !c.question_keys.includes(q.key));
          state.sealed = false;
          state.revision++;
        } else if (row.version !== mapping.version) {
          if (!row.structured) conflict('DOCX draft lost its structure');
          q.structured = row.structured;
          q.figures = row.figures;
          q.page_spans = row.page_spans;
          state.coverage = state.coverage.filter((c) => !c.question_keys.includes(q.key));
          mapping.version = row.version;
          state.sealed = false;
          state.revision++;
        }
      }
      const result = await fn(state, tx);
      await tx
        .update(source_document)
        .set({
          provenance: { ...live.provenance, docx_agent: state },
          updated_at: new Date(),
          version: live.version + 1,
        })
        .where(eq(source_document.id, sourceId));
      return result;
    });
  try {
    await mutate(() => undefined, true);
  } catch (err) {
    await rm(directory, { recursive: true, force: true });
    throw err;
  }
  const view = async (input: DocxReadInputT) => {
    const file = fileFor(input.asset_id);
    if (file.role !== 'page' && file.role !== 'media')
      conflict('This file is not a viewable source image');
    let decoder = sharp(await bytesFor(file.asset_id), { limitInputPixels: 80_000_000 });
    const metadata = await decoder.metadata();
    if (!metadata.width || !metadata.height)
      conflict('Source image cannot be decoded; retain it as unresolved');
    if (input.region) {
      const r = input.region;
      const left = Math.floor(r.x * metadata.width),
        top = Math.floor(r.y * metadata.height);
      const width = Math.min(metadata.width - left, Math.ceil(r.width * metadata.width));
      const height = Math.min(metadata.height - top, Math.ceil(r.height * metadata.height));
      if (width < 1 || height < 1) conflict('Image region is empty');
      decoder = decoder.extract({ left, top, width, height });
    }
    return decoder
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  };
  return {
    pkg,
    sourceId,
    textLength: text.length,
    close: () => rm(directory, { recursive: true, force: true }),
    view,
    read: async (input: DocxReadInputT): Promise<Record<string, unknown>> => {
      if (input.action === 'list')
        return { files: pkg.files, source_sha256: pkg.input_sha256, text_length: text.length };
      const file = fileFor(input.asset_id);
      if (input.action === 'text') {
        if (file.role !== 'markdown' && file.role !== 'layout')
          conflict('Only source text/layout can be read as text');
        const body =
          file.role === 'markdown' ? text : (await bytesFor(file.asset_id)).toString('utf8');
        const start = Math.min(input.offset ?? 0, body.length),
          end = Math.min(start + (input.length ?? 6000), body.length);
        if (file.role === 'markdown')
          await mutate((state) => {
            state.text_ranges.push([start, end]);
          });
        return {
          asset_id: file.asset_id,
          start,
          end,
          total: body.length,
          text: body.slice(start, end),
          format: file.format,
        };
      }
      await view(input); // Decode before claiming that the image was available.
      if (!input.region)
        await mutate((state) => {
          state.seen_images = [...new Set([...state.seen_images, file.asset_id])];
        });
      return {
        asset_id: file.asset_id,
        sha256: file.sha256,
        region: input.region ?? null,
        image_available: true,
      };
    },
    drafts: async (input: DocxDraftInputT): Promise<Record<string, unknown>> =>
      mutate(async (state, tx) => {
        if (input.action === 'inspect') return { state };
        if (input.action === 'check')
          return { revision: state.revision, gaps: docxAgentGaps(pkg, state, text.length) };
        if (input.expected_revision !== state.revision)
          conflict(`Stale DOCX revision; inspect current revision ${state.revision}`);
        if (state.sealed)
          return {
            revision: state.revision,
            sealed: true,
            gaps: docxAgentGaps(pkg, state, text.length),
          };
        if (input.action === 'upsert') {
          const replacements = input.questions ?? [];
          const replacing = new Set(replacements.map((q) => q.key));
          if (new Set(replacements.map((q) => q.key)).size !== replacements.length)
            conflict('Duplicate question keys');
          const next = [...state.questions.filter((q) => !replacing.has(q.key)), ...replacements];
          if (next.length > 200)
            conflict('DOCX draft batch exceeds 200 questions; source is retained');
          const nodeIds = new Set<string>();
          for (const q of next) {
            const ids = new Set<string>();
            const visit = (node: StructuredQuestionT) => {
              if (nodeIds.has(node.id)) conflict('Duplicate structured node id');
              nodeIds.add(node.id);
              ids.add(node.id);
              if (node.role !== 'stem' && node.sub_questions?.length)
                conflict('Only stem nodes can contain subquestions');
              for (const child of node.sub_questions ?? []) visit(child);
            };
            visit(q.structured);
            if (
              q.page_spans.some(
                (s) => !pkg.files.some((f) => f.role === 'page' && f.page_index === s.page_index),
              )
            )
              conflict('Draft references a missing source page');
            for (const figure of q.figures) {
              if (
                !pkg.files.some((f) => f.role === 'media' && f.asset_id === figure.asset_id) ||
                !ids.has(figure.attached_to_index) ||
                !q.page_spans.some((s) => s.page_index === figure.source_page_index)
              )
                conflict('Figure reference is outside this draft source');
            }
          }
          const figureOwners = next.flatMap((q) => q.figures.map((f) => f.asset_id));
          if (new Set(figureOwners).size !== figureOwners.length)
            conflict(
              'One embedded image has multiple owners; use a shared stem or retain unresolved',
            );
          state.retired.push(...state.questions.filter((q) => replacing.has(q.key)));
          state.questions = next;
          for (const q of replacements) {
            const mapping = state.blocks.find((m) => m.key === q.key);
            const written = await Ingestion.stageDocxAgentDraft(tx, {
              sessionId,
              sourceDocumentId: sourceId,
              blockId: mapping?.block_id,
              actorRef: taskRunId,
              block: {
                structured: { ...q.structured, source: 'agent_edit', last_modified_by: taskRunId },
                figures: q.figures,
                page_spans: q.page_spans,
                source_asset_ids: pkg.files
                  .filter(
                    (f) =>
                      f.role === 'page' && q.page_spans.some((s) => s.page_index === f.page_index),
                  )
                  .map((f) => f.asset_id),
                image_refs: q.figures.map((f) => f.asset_id),
                extraction_confidence: q.confidence,
              },
            });
            q.structured = { ...q.structured, source: 'agent_edit', last_modified_by: taskRunId };
            state.blocks = [
              ...state.blocks.filter((m) => m.key !== q.key),
              { key: q.key, block_id: written.id, version: written.version },
            ];
            state.coverage = state.coverage.filter((c) => !c.question_keys.includes(q.key));
          }
          for (const review of input.coverage ?? []) {
            if (
              !pkg.files.some(
                (f) => ['page', 'media'].includes(f.role) && f.asset_id === review.asset_id,
              )
            )
              conflict('Coverage references an unknown source');
            state.coverage = [
              ...state.coverage.filter((c) => c.asset_id !== review.asset_id),
              review,
            ];
          }
        } else {
          if (!state.questions.length)
            conflict('Cannot commit zero questions; source remains recoverable');
          state.sealed = true;
        }
        state.revision++;
        return {
          revision: state.revision,
          sealed: state.sealed,
          question_count: state.questions.length,
          blocks: state.blocks,
          gaps: docxAgentGaps(pkg, state, text.length),
        };
      }),
  };
}
