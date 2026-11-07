// Curator starting payload (YUK-1776): an index, not the corpus.
//
// Before this, every Dreaming run stringified the full digest, every event row
// with its payload, and the legacy layers into one user message (~346k provider
// input tokens on TEST). The model now gets topic/event/legacy indexes and reads
// bodies on demand through query_context / query_events. Every index carries the
// total and what was left out, so "I read the index" never has to mean "I saw
// everything" without the model saying so.
import type { Db } from '@/db/client';
import { type CuratorLegacyScope, readCuratorEvidence } from './curator-evidence';
import { readLegacyFacts, unwithdrawnLegacyFacts } from './legacy-facts';
import { readTopics, topicBoard, withdrawnTopicEvidence } from './topics';

/** Newest event index lines included in the starting payload. */
export const CURATOR_EVIDENCE_INDEX_LINES = 120;
/** Excerpt budget per event line; only enough to choose what to read. */
export const CURATOR_EVIDENCE_EXCERPT_CHARS = 160;
/** Legacy fact rows previewed before the model pages the rest. */
export const CURATOR_LEGACY_FACT_PREVIEW = 10;
/** Legacy fact body preview; full body comes from query_context.legacyFacts. */
export const CURATOR_LEGACY_FACT_PREVIEW_CHARS = 400;

export const CURATOR_INSTRUCTION =
  '整理和压缩上下文，不决定做什么。本次输入是索引：topics 列出全部主题（名称、说明、事实数、陈旧度），evidence 只列自上次固化以来的事件索引（excerpt 只用于挑事件），legacy_scopes/legacy_facts 是旧层索引。写之前先用 query_context 读取要改主题的完整事实（topicKeys，每次至多 5 个），用 query_events（filter.sinceAt=evidence.window_start，includePayload=true）读取事件正文；legacy scope 用 query_context 的 scopeKey 读，旧事实用 query_context 的 legacyFacts 分页读。主题正文只能走 topicKeys：不要不带参数调 query_context，也不要用 scopeKey=global 或 global:digest 取主题正文——那几路把整份摘要当 brief 拉回来。索引里的 total/omitted_older/has_more/next_cursor 表示还没载入的部分：必须读到写到，才能声称整理完；没有读到的细节不能当事实写入，excerpt 不能代替正文。接管 legacy_scopes 中所有 scope 的整理；即使没有新事件也检查陈旧程度，主题保留 scope_key，陈旧不等于错误。legacy-global 是旧摘要原文：第一次整理时把主题名、说明和正文改成学习者能懂的白话，不提迁移、升级或内部系统名；逐条保留所有经历事实及成功/失败、先后和不确定性，不能以清理建议为由丢掉事实。逐条 supersede 原事实，不合并 event/weakness；原文仍保留在旧 scope 和版本日志。只重写内容有变化的主题；没变化就停止。学习者 correction 最高优先。';

export interface CuratorPayloadBlocks {
  context_chars: number;
  topics_index_chars: number;
  evidence_index_chars: number;
  legacy_scopes_index_chars: number;
  legacy_facts_index_chars: number;
  instruction_chars: number;
  payload_chars: number;
  evidence_events_total: number;
  evidence_events_shown: number;
  legacy_facts_total: number;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

function eventExcerpt(payload: unknown): { text: string; truncated: boolean } {
  return clip(JSON.stringify(payload ?? null), CURATOR_EVIDENCE_EXCERPT_CHARS);
}

export async function buildCuratorPayload(
  db: Db,
  input: {
    anchorId: string;
    now: Date;
    contextMarkdown: string;
    legacyScopes: CuratorLegacyScope[];
  },
): Promise<{
  payload: Record<string, unknown>;
  blocks: CuratorPayloadBlocks;
  /** Coverage bookkeeping for the run's watermark decision. */
  evidence: {
    /** Every window row, ascending — the coverage universe, not just the index. */
    rows: Awaited<ReturnType<typeof readCuratorEvidence>>;
    /** Rows actually printed in the index; the model saw their excerpts. */
    shownIds: Set<string>;
    /** The watermark this window was cut from (null before the first digest). */
    asOf: string | null;
  };
}> {
  const [contextDigest, evidenceRows, board, legacyFacts] = await Promise.all([
    readTopics(db),
    readCuratorEvidence(db, input.anchorId),
    topicBoard(db, input.now),
    readLegacyFacts(db),
  ]);
  const visibleLegacyFacts = unwithdrawnLegacyFacts(
    legacyFacts,
    withdrawnTopicEvidence(contextDigest.digest),
  );

  const topics = {
    version: contextDigest.version,
    as_of: contextDigest.digest.as_of,
    topics: board.topics.map((topic) => ({
      key: topic.key,
      scope_key: topic.scope_key,
      name: topic.name,
      description: topic.description,
      facts: topic.facts.length,
      updated_at: topic.updated_at,
      evidence_at: topic.evidence_at,
      memory_weight: topic.memory_weight,
      freshness: topic.freshness === null ? null : Number(topic.freshness.toFixed(3)),
      stale: topic.stale,
    })),
  };

  const shownRows = evidenceRows.slice(-CURATOR_EVIDENCE_INDEX_LINES);
  const evidence = {
    // `||`: a bootstrapped digest can carry as_of:''; the model passes this
    // string straight into query_events.filter.sinceAt, so it must stay a
    // parseable timestamp.
    window_start:
      contextDigest.digest.as_of || new Date(input.now.getTime() - 30 * 86_400_000).toISOString(),
    total: evidenceRows.length,
    shown: shownRows.length,
    omitted_older: evidenceRows.length - shownRows.length,
    events: shownRows.map((row) => {
      const excerpt = eventExcerpt(row.payload);
      return {
        id: row.id,
        at: row.at.toISOString(),
        action: row.action,
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        outcome: row.outcome,
        excerpt: excerpt.text,
        excerpt_truncated: excerpt.truncated,
      };
    }),
  };

  const legacyScopesIndex = input.legacyScopes.map(({ scope, note, freshness }) => ({
    scope,
    readable: note !== null,
    version: note?.version ?? null,
    refreshed_at: note?.refreshed_at?.toISOString() ?? null,
    freshness_state: freshness.state,
    recent_week_chars: note?.recent_week_md.length ?? 0,
    recent_months_chars: note?.recent_months_md.length ?? 0,
    long_term_chars: note?.long_term_md.length ?? 0,
    evidence_count: note
      ? new Set([
          ...note.recent_week_evidence_ids,
          ...note.recent_months_evidence_ids,
          ...note.long_term_evidence_ids,
        ]).size
      : 0,
  }));

  const legacyFactsPreview = visibleLegacyFacts
    .slice(0, CURATOR_LEGACY_FACT_PREVIEW)
    .map((fact) => {
      const body = clip(fact.body, CURATOR_LEGACY_FACT_PREVIEW_CHARS);
      return {
        id: fact.id,
        memory_kind: fact.memory_kind,
        evidence_count: fact.evidence_ids.length,
        body: body.text,
        body_truncated: body.truncated,
      };
    });
  const legacyFactsIndex = {
    total: visibleLegacyFacts.length,
    preview: legacyFactsPreview,
    has_more: visibleLegacyFacts.length > legacyFactsPreview.length,
    next_cursor: legacyFactsPreview.at(-1)?.id ?? null,
  };

  const payload = {
    context: input.contextMarkdown,
    topics,
    evidence,
    legacy_scopes: legacyScopesIndex,
    legacy_facts: legacyFactsIndex,
    instruction: CURATOR_INSTRUCTION,
  };

  const chars = (value: unknown) => JSON.stringify(value).length;
  const blocks: CuratorPayloadBlocks = {
    context_chars: input.contextMarkdown.length,
    topics_index_chars: chars(topics),
    evidence_index_chars: chars(evidence),
    legacy_scopes_index_chars: chars(legacyScopesIndex),
    legacy_facts_index_chars: chars(legacyFactsIndex),
    instruction_chars: CURATOR_INSTRUCTION.length,
    payload_chars: chars(payload),
    evidence_events_total: evidenceRows.length,
    evidence_events_shown: shownRows.length,
    legacy_facts_total: visibleLegacyFacts.length,
  };
  return {
    payload,
    blocks,
    evidence: {
      rows: evidenceRows,
      shownIds: new Set(shownRows.map((row) => row.id)),
      asOf: contextDigest.digest.as_of || null,
    },
  };
}
