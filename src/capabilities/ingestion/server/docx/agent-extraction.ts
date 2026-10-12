import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TaskRuntime } from '@/ai/task-runtime';
import { DocxAgentState, DocxReadInput, DocxSourcePackage } from '@/core/schema/docx-agent';
import type { Db } from '@/db/client';
import { learning_session, question_block, source_document } from '@/db/schema';
import type { BlobStore } from '@/kernel/blob-store';
import { ApiError } from '@/kernel/http';
import { DOCX_INGESTION_TOOLS, toMcpAllowedToolName } from '@/kernel/tools/allowlists';
import { Ingestion } from '@/server/session';
import { docxAgentGaps, openDocxAgentWorkspace } from './agent-workspace';

/** Execution is supplied by the worker composition root; this module owns DOCX semantics. */
type DocxAgentParams = { db: Db; r2: BlobStore; sessionId: string; runtime: TaskRuntime };

export async function runDocxAgentExtraction(
  params: DocxAgentParams,
): Promise<'busy' | 'completed'> {
  // Existing Postgres advisory-lock primitive, scoped to one session. It owns no
  // business row locks across the model call, and releases on worker disconnect.
  return params.db.transaction(async (lockTx) => {
    const [claim] = await lockTx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`docx-agent:${params.sessionId}`}, 0)) as acquired`,
    );
    if (!claim.acquired) return 'busy';
    await runClaimedDocxAgentExtraction(params);
    return 'completed';
  });
}

async function runClaimedDocxAgentExtraction(params: DocxAgentParams): Promise<void> {
  const { db, r2, sessionId } = params;
  const [session] = await db
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, sessionId));
  if (session?.entrypoint !== 'docx') throw new ApiError('conflict', 'Not a DOCX ingestion', 409);
  // Queue redelivery after a committed batch must not re-run the agent.
  if (['extracted', 'partial', 'reviewed', 'imported'].includes(session.status)) return;
  await db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));
  const taskRunId = createId();
  const controller = new AbortController();
  let workspace: Awaited<ReturnType<typeof openDocxAgentWorkspace>> | undefined;
  try {
    workspace = await openDocxAgentWorkspace(db, r2, sessionId, taskRunId, (tx, input) =>
      Ingestion.stageDocxAgentDraft(tx, {
        sessionId,
        sourceDocumentId: input.sourceDocumentId,
        blockId: input.blockId,
        actorRef: taskRunId,
        block: {
          structured: {
            ...input.question.structured,
            source: 'agent_edit',
            last_modified_by: taskRunId,
          },
          figures: input.question.figures,
          page_spans: input.question.page_spans,
          source_asset_ids: input.sourceAssetIds,
          image_refs: input.question.figures.map((f) => f.asset_id),
          extraction_confidence: input.question.confidence,
        },
      }),
    );
    const boundWorkspace = workspace;
    const ctx = {
      db,
      sessionId,
      taskRunId,
      callerActor: { kind: 'agent' as const, ref: taskRunId },
      signal: controller.signal,
      docxWorkspace: workspace,
    };
    const tools = DOCX_INGESTION_TOOLS.map((name) => {
      const options = { serverName: 'loom', toolNames: [name], taskKind: 'DocxIngestionTask', ctx };
      const [tool] = params.runtime.buildDomainTools(options);
      const execute = tool.execute;
      tool.execute = async (callId, input, signal, onUpdate) => {
        if (name === 'read_docx_source') {
          let showImage = false;
          const [reader] = params.runtime.buildDomainTools({
            ...options,
            onResult(result) {
              showImage =
                result.executed &&
                result.error_reason === null &&
                (result.output as Record<string, unknown>)?.image_available === true;
            },
          });
          const result = await reader.execute(callId, input, signal, onUpdate);
          if (showImage) {
            // Native Pi image content goes to the model; the shared tool log
            // contains only the asset digest/region, never base64 image bytes.
            const bytes = await boundWorkspace.view(DocxReadInput.parse(input));
            result.content.push({
              type: 'image',
              data: bytes.toString('base64'),
              mimeType: 'image/png',
            });
          }
          return result;
        }
        if (name === 'edit_docx_drafts') return execute(callId, input, signal, onUpdate);
        // Existing block tools accept arbitrary IDs on their original surface.
        // Bind this mount to the current session BEFORE executing their owner
        // transactions, with the same locks held through mutation and logging.
        return db.transaction(async (tx) => {
          const [live] = await tx
            .select()
            .from(learning_session)
            .where(eq(learning_session.id, sessionId))
            .for('update');
          const [source] = live?.source_document_id
            ? await tx
                .select()
                .from(source_document)
                .where(eq(source_document.id, live.source_document_id))
                .for('update')
            : [];
          const state = DocxAgentState.parse(source?.provenance.docx_agent);
          if (live.status !== 'extracting' || state.task_run_id !== taskRunId || state.sealed)
            throw new ApiError('conflict', 'DOCX run is no longer editable', 409);
          const args = input as Record<string, unknown>;
          const ids = [
            args.block_id,
            args.blockId,
            args.primary_block_id,
            ...(Array.isArray(args.merge_block_ids) ? args.merge_block_ids : []),
          ].filter((id): id is string => typeof id === 'string');
          const unique = [...new Set(ids)];
          const rows = unique.length
            ? await tx
                .select({ id: question_block.id })
                .from(question_block)
                .where(
                  and(
                    eq(question_block.ingestion_session_id, sessionId),
                    inArray(question_block.id, unique),
                  ),
                )
                .for('update')
            : [];
          if (
            !unique.length ||
            rows.length !== unique.length ||
            unique.some((id) => !state.blocks.some((b) => b.block_id === id))
          )
            throw new ApiError('conflict', 'Block is outside this DOCX workspace', 409);
          const [scoped] = params.runtime.buildDomainTools({
            ...options,
            ctx: { ...ctx, db: tx as unknown as Db },
          });
          return scoped.execute(callId, input, signal, onUpdate);
        });
      };
      return tool;
    });
    const initial = await workspace.drafts({ action: 'inspect' });
    if (!(initial.state as { sealed: boolean }).sealed) {
      const runTaskFn = params.runtime.runTask;
      await runTaskFn(
        'DocxIngestionTask',
        {
          text: JSON.stringify({
            session_id: sessionId,
            source_sha256: workspace.pkg.input_sha256,
            file_count: workspace.pkg.files.length,
            instruction:
              'Read the manifest and inspect saved drafts using tools, then finish this ingestion.',
          }),
        },
        {
          db,
          taskRunId,
          lifecycleAbortController: controller,
          piToolMounts: [{ type: 'custom', tools }],
          allowedTools: DOCX_INGESTION_TOOLS.map((name) => toMcpAllowedToolName(name)),
        },
      );
    }
    await db.transaction(async (tx) => {
      const [live] = await tx
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, sessionId))
        .for('update');
      const [source] = await tx
        .select()
        .from(source_document)
        .where(eq(source_document.id, boundWorkspace.sourceId))
        .for('update');
      const state = DocxAgentState.parse(source.provenance.docx_agent);
      const pkg = DocxSourcePackage.parse(source.provenance.docx_package);
      if (live.status !== 'extracting' || state.task_run_id !== taskRunId || !state.sealed)
        throw new ApiError(
          'conflict',
          'DOCX agent did not commit; source and staged drafts retained',
          409,
        );
      const warnings = docxAgentGaps(pkg, state, boundWorkspace.textLength);
      const mappings = state.questions.map((q) => {
        const mapping = state.blocks.find((m) => m.key === q.key);
        if (!mapping) throw new Error('DOCX question has no staged draft');
        return mapping;
      });
      const rows = await tx
        .select()
        .from(question_block)
        .where(
          inArray(
            question_block.id,
            mappings.map((m) => m.block_id),
          ),
        )
        .for('update');
      if (rows.some((r) => r.version !== mappings.find((m) => m.block_id === r.id)?.version))
        throw new ApiError('conflict', 'DOCX content changed after commit', 409);
      await Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId: source.id,
        actorRef: taskRunId,
        stagedBlockIds: mappings.map((m) => m.block_id),
        blocks: rows.map((r) => {
          if (!r.structured) throw new ApiError('conflict', 'DOCX draft structure is missing', 409);
          return {
            structured: r.structured,
            figures: r.figures,
            page_spans: r.page_spans,
            source_asset_ids: r.source_asset_ids,
            image_refs: r.image_refs,
            extraction_confidence: r.extraction_confidence ?? 0,
          };
        }),
        layoutQuality: warnings.length ? 'partial' : 'structured',
        warnings,
      });
    });
  } catch (err) {
    await db.transaction(async (tx) => {
      const [live] = await tx
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, sessionId))
        .for('update');
      // The session advisory lock is still held, including restore failures before binding a run.
      if (live?.status === 'extracting') {
        await Ingestion.markExtractionFailed(
          tx,
          sessionId,
          'DOCX agent extraction failed; saved material and staged drafts retained for retry',
        );
      }
    });
    throw err;
  } finally {
    controller.abort();
    await workspace?.close();
  }
}
