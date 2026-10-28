import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { parseDraftRef } from '@/core/question-draft-ref';
import type { Db } from '@/db/client';
import { learning_session, question, question_block } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { UNKNOWN_SERVING, readQuestionServing } from '@/kernel/read-models/question-serving';
import type { IngestionHistoryItem, IngestionSessionHistoryResponse } from '../api/contracts';
import {
  type AgentHistoryAskT,
  type AgentHistoryPriorRunT,
  hasAgentEvidence,
  readAgentRunHistory,
} from './agent/history';
import { readSessionCostEvidence } from './session-cost-evidence';
import { readSessionTitles } from './session-titles';

/** Server-side cap for the wire preview; full bodies stay on their own routes. */
const PREVIEW_MAX = 500;

type BlockRow = typeof question_block.$inferSelect;

function truncatePreview(text: string | null | undefined): {
  preview_md: string | null;
  preview_truncated: boolean;
} {
  if (text == null || text.length === 0) return { preview_md: null, preview_truncated: false };
  if (text.length <= PREVIEW_MAX) return { preview_md: text, preview_truncated: false };
  return { preview_md: text.slice(0, PREVIEW_MAX), preview_truncated: true };
}

/** 1-based page → the session's source_asset_ids by order (same convention as §4.1). */
function assetForPage(sourceAssetIds: string[], page: number | null | undefined): string[] {
  if (page == null) return [];
  const id = sourceAssetIds[page - 1];
  return id == null ? [] : [id];
}

function firstPage(block: BlockRow): number | null {
  const indices = (block.page_spans ?? [])
    .map((span) => span.page_index)
    .filter((i): i is number => typeof i === 'number');
  return indices.length === 0 ? null : Math.min(...indices) + 1;
}

/**
 * GET /api/ingestion-sessions/:id/history — one-shot durable read-back for the
 * after-upload view. The agent lane merges the durable run snapshot
 * (agent_budget.history, identity-matched to the live execution_owner) with
 * same-run job_events still inside the 30-day window, then links items to
 * questions via item_state question_id → normalized draft ref → source_ref.
 * `state_at_finish` and `preview_md` report ONLY frozen evidence (item_state
 * captures, immutable extracted_prompt_md); mutable question/question_block
 * fields never stand in — unprovable slices return 'unknown'/null and are named
 * in `evidence.missing`. `current` is today's admission/serving projection.
 */
/** `qdraft1:<block>:<version>` (or a bare legacy ref) → question_block.id. */
function draftBlockIdOf(ref: string | null | undefined): string | null {
  if (ref == null) return null;
  return parseDraftRef(ref)?.blockId ?? ref;
}
export async function readIngestionSessionHistory(
  db: Db,
  params: Record<string, string>,
): Promise<IngestionSessionHistoryResponse> {
  const sessionId = params.id;
  if (!sessionId) throw new ApiError('validation_error', 'session id is required', 400);

  const [session] = await db
    .select({
      id: learning_session.id,
      status: learning_session.status,
      entrypoint: learning_session.entrypoint,
      source_document_id: learning_session.source_document_id,
      source_asset_ids: learning_session.source_asset_ids,
      warnings: learning_session.warnings,
      error_message: learning_session.error_message,
      started_at: learning_session.started_at,
      ended_at: learning_session.ended_at,
      created_at: learning_session.created_at,
      updated_at: learning_session.updated_at,
    })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  if (!session) throw new ApiError('not_found', 'ingestion session not found', 404);

  const title = (await readSessionTitles(db, [sessionId])).get(sessionId);

  const agentEvidence = await hasAgentEvidence(db, sessionId);

  // Extract-lane blocks are bound to the session id; agent drafts live under
  // the actor-scoped `draft:` session key (edit-question writes, by design).
  const [blocks, draftBlocks] = await Promise.all([
    db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId))
      .orderBy(asc(question_block.ordinal), asc(question_block.id)),
    agentEvidence
      ? db
          .select()
          .from(question_block)
          .where(eq(question_block.ingestion_session_id, `draft:ingestion_agent:${sessionId}`))
          .orderBy(asc(question_block.created_at), asc(question_block.id))
      : Promise.resolve([] as BlockRow[]),
  ]);

  const path = agentEvidence ? 'agent' : blocks.length > 0 ? 'extract' : null;

  const history = agentEvidence ? await readAgentRunHistory(db, sessionId) : null;

  // Questions this session's agent run submitted: stamped source_ref on group
  // roots only (parts stay out of the per-item count).
  const sessionQuestions = agentEvidence
    ? await db
        .select({
          id: question.id,
          prompt_md: question.prompt_md,
          draft_status: question.draft_status,
          metadata: question.metadata,
          created_at: question.created_at,
        })
        .from(question)
        .where(
          and(
            eq(question.source_ref, `ingestion_agent:${sessionId}`),
            isNull(question.parent_question_id),
          ),
        )
        .orderBy(asc(question.created_at), asc(question.id))
    : [];

  // Every question id any item links to — submitted roots, imported block
  // targets, and ledger-recorded ids — gets a current serving projection.
  const linkedQuestionIds = new Set<string>();
  for (const block of blocks) {
    if (block.imported_question_id != null) linkedQuestionIds.add(block.imported_question_id);
  }
  for (const q of sessionQuestions) linkedQuestionIds.add(q.id);
  for (const item of history?.items ?? []) {
    if (item.question_id != null) linkedQuestionIds.add(item.question_id);
  }
  const questionMeta = new Map<string, { draft_status: string | null }>();
  for (const q of sessionQuestions) questionMeta.set(q.id, { draft_status: q.draft_status });
  const missingMetaIds = [...linkedQuestionIds].filter((id) => !questionMeta.has(id));
  if (missingMetaIds.length > 0) {
    const rows = await db
      .select({ id: question.id, draft_status: question.draft_status })
      .from(question)
      .where(inArray(question.id, missingMetaIds));
    for (const row of rows) questionMeta.set(row.id, { draft_status: row.draft_status });
  }
  const serving = await readQuestionServing(db, [...linkedQuestionIds]);

  const currentOf = (
    questionId: string | null,
  ): NonNullable<IngestionHistoryItem['current']> | null => {
    if (questionId == null || !questionMeta.has(questionId)) return null;
    const s = serving.byId.get(questionId) ?? UNKNOWN_SERVING;
    return {
      draft_status: questionMeta.get(questionId)?.draft_status ?? null,
      servable: s.servable,
      hold_reason: s.hold_reason,
      held_since: s.held_since,
      next_action: s.next_action,
      pending_action: s.pending_action,
    };
  };

  const sourceAssetIds = session.source_asset_ids ?? [];
  const items: IngestionHistoryItem[] = [];

  if (path === 'agent') {
    const draftById = new Map(draftBlocks.map((b) => [b.id, b]));
    const qById = new Map(sessionQuestions.map((q) => [q.id, q]));
    const qByDraftBlock = new Map<string, (typeof sessionQuestions)[number]>();
    for (const q of sessionQuestions) {
      const draftBlockId = (q.metadata as Record<string, unknown> | null)?.draft_block_id;
      if (typeof draftBlockId === 'string') qByDraftBlock.set(draftBlockId, q);
    }
    const claimedBlocks = new Set<string>();
    const claimedQuestions = new Set<string>();

    let ordinal = 0;
    for (const item of history?.items ?? []) {
      // Normalize the versioned draft ref before every map/set lookup and
      // output field; the raw ref stays on the wire as its own field.
      const blockId = draftBlockIdOf(item.draft_ref);
      const block = blockId != null ? draftById.get(blockId) : undefined;
      const q =
        (item.question_id != null ? qById.get(item.question_id) : undefined) ??
        (blockId != null ? qByDraftBlock.get(blockId) : undefined);
      if (block != null) claimedBlocks.add(block.id);
      if (q != null) claimedQuestions.add(q.id);
      const questionId = q?.id ?? item.question_id ?? null;
      items.push({
        item_id: item.item_id,
        ordinal: ordinal++,
        question_no: item.question_no,
        page: item.page ?? (block != null ? firstPage(block) : null),
        source_asset_ids:
          item.page != null
            ? assetForPage(sourceAssetIds, item.page)
            : (block?.source_asset_ids ?? []),
        // Preview is the frozen item_state capture only — never the mutable
        // current question/block body.
        preview_md: item.preview_md ?? null,
        preview_truncated: false,
        state_at_finish: item.status,
        reason: item.reason ?? null,
        draft_block_id: block?.id ?? blockId,
        draft_ref: item.draft_ref ?? null,
        question_id: questionId,
        status_at: item.status_at ?? null,
        current: currentOf(questionId),
      });
    }
    // Drafts the agent created but never reported/submitted still belong to
    // the session view — the durable block row proves existence; its mutable
    // status is NOT the at-finish state, so it reports 'unknown'.
    for (const block of draftBlocks) {
      if (claimedBlocks.has(block.id)) continue;
      const q = qByDraftBlock.get(block.id);
      if (q != null) claimedQuestions.add(q.id);
      items.push({
        item_id: block.id,
        ordinal: ordinal++,
        question_no: null,
        page: firstPage(block),
        source_asset_ids: block.source_asset_ids,
        // extracted_prompt_md is written once and never re-projected — frozen.
        ...truncatePreview(block.extracted_prompt_md),
        state_at_finish: 'unknown',
        reason: null,
        draft_block_id: block.id,
        draft_ref: null,
        question_id: q?.id ?? null,
        status_at: null,
        current: currentOf(q?.id ?? null),
      });
    }
    // Session-bound blocks (extract/rescue leftovers on a hybrid session) are
    // durable rows too — same 'unknown' at-finish rule.
    for (const block of blocks) {
      if (claimedBlocks.has(block.id)) continue;
      items.push({
        item_id: block.id,
        ordinal: ordinal++,
        question_no: null,
        page: firstPage(block),
        source_asset_ids: block.source_asset_ids,
        ...truncatePreview(block.extracted_prompt_md),
        state_at_finish: 'unknown',
        reason: null,
        draft_block_id: null,
        draft_ref: null,
        question_id: block.imported_question_id,
        status_at: null,
        current: currentOf(block.imported_question_id),
      });
    }
    // Submitted questions with no surviving item/draft link (events pruned
    // before this feature, or the report step was skipped).
    for (const q of sessionQuestions) {
      if (claimedQuestions.has(q.id)) continue;
      items.push({
        item_id: q.id,
        ordinal: ordinal++,
        question_no: null,
        page: null,
        source_asset_ids: [],
        preview_md: null,
        preview_truncated: false,
        state_at_finish: 'unknown',
        reason: null,
        draft_block_id: null,
        draft_ref: null,
        question_id: q.id,
        status_at: null,
        current: currentOf(q.id),
      });
    }
  } else {
    for (const block of blocks) {
      const page = firstPage(block);
      items.push({
        item_id: block.id,
        ordinal: block.ordinal,
        question_no: null,
        page,
        source_asset_ids: block.source_asset_ids,
        // extracted_prompt_md is the frozen upload-time extraction; the block
        // status is projected/mutable and never serves as at-finish state.
        ...truncatePreview(block.extracted_prompt_md),
        state_at_finish: 'unknown',
        reason: null,
        draft_block_id: null,
        draft_ref: null,
        question_id: block.imported_question_id,
        status_at: null,
        current: currentOf(block.imported_question_id),
      });
    }
  }

  const now = Date.now();
  const wireAsk = (ask: AgentHistoryAskT) => ({
    ask_id: ask.ask_id,
    item_id: ask.item_id,
    question_no: ask.question_no,
    prompt_md: ask.prompt_md,
    answer_kind: ask.answer_kind,
    ...(ask.options != null ? { options: ask.options } : {}),
    placeholder: ask.placeholder,
    expires_at: ask.expires_at,
    created_at: ask.created_at,
    resolved: ask.resolved,
    unresolved: ask.resolved == null,
    expired_unresolved:
      ask.resolved == null && ask.expires_at != null && new Date(ask.expires_at).getTime() < now,
  });
  const asks = (history?.asks ?? []).map(wireAsk);

  const wirePriorRun = (prior: AgentHistoryPriorRunT) => ({
    run_ref: prior.run_ref,
    event_floor: prior.event_floor,
    captured_at: prior.captured_at,
    session_status: prior.session_status,
    run_state: prior.run_state,
    stage: prior.stage,
    execution_closed: prior.execution_closed,
    paid_outcome_unknown: prior.paid_outcome_unknown,
    errors_truncated: prior.errors_truncated,
    items: prior.items.map((item) => ({
      item_id: item.item_id,
      question_no: item.question_no,
      status: item.status,
      reason: item.reason ?? null,
      page: item.page ?? null,
      preview_md: item.preview_md ?? null,
      draft_ref: item.draft_ref ?? null,
      question_id: item.question_id ?? null,
      status_at: item.status_at ?? null,
    })),
    asks: prior.asks.map(wireAsk),
    segments: prior.segments.map((seg) => ({
      segment: seg.segment,
      trigger: seg.trigger,
      outcome: seg.outcome ?? null,
      task_run_id: seg.task_run_id ?? null,
      at: seg.at,
    })),
    errors: prior.errors.map((err) => ({
      scope: err.scope,
      item_id: err.item_id ?? null,
      code: err.code,
      retryable: err.retryable,
      at: err.at,
    })),
  });
  const prior_runs = (history?.prior_runs ?? []).map(wirePriorRun);

  const run =
    history == null || (!history.snapshot && !history.live_events)
      ? null
      : {
          run_ref: history.run_ref,
          run_state: history.run_state,
          stage: history.stage,
          segment_count: history.segments.filter((seg) => seg.segment >= 1).length,
          started_at: history.started_at,
          finished_at: history.finished_at,
          captured_at: history.captured_at,
          execution_closed: history.execution_closed,
          paid_outcome_unknown: history.paid_outcome_unknown,
          errors_truncated: history.errors_truncated,
          counts:
            history.items.length === 0
              ? null
              : {
                  items_total: history.items.length,
                  items_done: history.items.filter(
                    (i) => i.status === 'admitted' || i.status === 'withheld',
                  ).length,
                  items_withheld: history.items.filter((i) => i.status === 'withheld').length,
                  items_failed: history.items.filter((i) => i.status === 'failed').length,
                },
          segments: history.segments.map((seg) => ({
            segment: seg.segment,
            trigger: seg.trigger,
            outcome: seg.outcome ?? null,
            task_run_id: seg.task_run_id ?? null,
            at: seg.at,
          })),
          errors: history.errors.map((err) => ({
            scope: err.scope,
            item_id: err.item_id ?? null,
            code: err.code,
            retryable: err.retryable,
            at: err.at,
          })),
        };

  const missing: string[] = [];
  if (path === 'agent') {
    if (run == null) missing.push('run');
    if (history != null && !history.snapshot) missing.push('snapshot');
    if (history?.corrupt_snapshot === true) missing.push('unparsed_history');
    // The durable record itself declares it once dropped rows — name the
    // known gap instead of implying completeness.
    if (history?.errors_truncated === true) missing.push('errors');
    if (items.length === 0) missing.push('items');
    if (asks.length === 0 && run == null) missing.push('asks');
  } else if (path === null) {
    missing.push('run', 'items', 'asks');
  }

  const body: IngestionSessionHistoryResponse = {
    session: {
      id: session.id,
      status: session.status,
      path,
      entrypoint: session.entrypoint,
      source_document_id: session.source_document_id,
      source_asset_ids: sourceAssetIds,
      title: title?.title ?? null,
      title_source: title?.title_source ?? null,
      started_at: session.started_at.toISOString(),
      ended_at: session.ended_at?.toISOString() ?? null,
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
      error_message: session.error_message,
      warnings: session.warnings ?? [],
    },
    run,
    prior_runs,
    items,
    asks,
    cost_evidence: await readSessionCostEvidence(db, sessionId),
    evidence: {
      snapshot: history?.snapshot ?? false,
      live_events: history?.live_events ?? false,
      missing,
    },
  };
  return body;
}
