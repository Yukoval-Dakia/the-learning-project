// YUK-697 — shared tier-2 web_sourced draft INSERT + cross-KC dedup lifecycle.
//
// The sourcing (SourcingTask) and jyeoo_fetch handlers persist an identical draft shape:
// source='web_sourced', tier-2 provenance (metadata.web_sourced + source_ref_kind='url'),
// difficulty_evidence, draft_status='draft', canonical_content_hash with a partial-unique
// arbiter. This helper is the single source of that persistence so the two producers can't
// drift. Callers own everything BEFORE the insert (trigger resolution, knowledge_ids
// resolution, the pre-INSERT exact-dup MERGE + near-dup) and AFTER it
// (writeVerifyDispatchIntent, per-question bookkeeping).
//
// YUK-720 (merged from #938): the ON CONFLICT path is a cross-KC dedup — when a concurrent
// insert won the canonical-hash race, the target KCs are MERGED into the winner (or, if the
// winner is a terminal-rejected draft, that stale row is released and this INSERT retried).
// This helper runs that exact lifecycle so sourcing + jyeoo_fetch get identical dedup.

import {
  DifficultyEvidence,
  type DifficultyEvidenceT,
  buildProducerDifficultyEvidence,
} from '@/core/schema/difficulty-evidence';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';
import {
  type SupplyTraceV1T,
  withSupplyTraceDifficultyEvidence,
} from '@/server/question-supply/evidence-demand';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { mergeExactQuestionDuplicateKnowledgeIds } from '@/server/quiz/content-fingerprint';
import { sql } from 'drizzle-orm';

// question.created_by column type (AgentRef jsonb, notNull) — single-sourced from the
// schema so the two producers' created_by refs are typed identically.
type AgentRefValue = (typeof question.$inferInsert)['created_by'];

export interface InsertSourcedDraftInput {
  id: string;
  q: SourcedQuestionT;
  /** Resolved, existence-checked knowledge ids for the fresh draft AND the target-KC set
   *  merged into an existing row on an ON CONFLICT race (caller owns resolution). */
  knowledgeIds: string[];
  /** difficulty_evidence source_route + producer-estimate fallback route (e.g. 'sourcing_web' | 'jyeoo_fetch'). */
  sourceRoute: string;
  /** question.created_by (aiAgentRef for the LLM producer, a system ref for the scraper). */
  createdBy: AgentRefValue;
  /** metadata.web_sourced.whitelist_match — caller computes via matchesWhitelist(profile whitelist). */
  whitelistMatch: boolean;
  /** metadata.web_sourced.fetched_at ISO string. */
  fetchedAt: string;
  canonicalContentHash: string;
  supplyTrace?: SupplyTraceV1T;
  /** Producer id for the cross-KC merge's question_edit audit event (YUK-720). */
  mergeActorRef: 'quiz_gen' | 'sourcing' | 'jyeoo_fetch';
  taskRunId?: string;
  now: Date;
}

export type InsertSourcedDraftResult =
  | {
      status: 'inserted';
      difficultyEvidence: DifficultyEvidenceT;
      supplyTrace: SupplyTraceV1T | undefined;
    }
  // A concurrent insert won the canonical-hash race; the winner absorbed the target KCs
  // (YUK-720 cross-KC merge). No new row was created.
  | {
      status: 'raced_merged';
      existingId: string;
      addedKnowledgeIds: string[];
      resultingKnowledgeIds: string[];
      draftStatus: string | null;
    };

/**
 * INSERT one tier-2 web_sourced draft (draft_status='draft'), running the YUK-720 cross-KC
 * dedup lifecycle on an ON CONFLICT race. Returns the built difficulty evidence + supply
 * trace on a fresh insert (including a retry after a terminal-rejected draft was released),
 * or the merge disposition when a concurrent winner absorbed the target KCs. Throws only
 * when an ON CONFLICT fires but no duplicate can be found / the retry still conflicts (a
 * real invariant violation).
 */
export async function insertSourcedDraft(
  tx: Tx,
  input: InsertSourcedDraftInput,
): Promise<InsertSourcedDraftResult> {
  const { id, q, knowledgeIds, sourceRoute, createdBy, whitelistMatch, fetchedAt, now } = input;
  const { canonicalContentHash, mergeActorRef, taskRunId } = input;

  // Preserve an EXPLICIT judge_kind_override; only derive the structural default when absent
  // (never clobber e.g. 'keyword' with the default).
  const judgeKind = q.judge_kind_override ?? defaultJudgeKindForQuestion(q);
  const declaredDifficultyEvidence =
    q.difficulty_evidence ?? buildProducerDifficultyEvidence(q.difficulty, sourceRoute, now);
  const difficultyEvidence = DifficultyEvidence.parse({
    ...declaredDifficultyEvidence,
    observed_at: declaredDifficultyEvidence.observed_at ?? now.toISOString(),
    source_route: declaredDifficultyEvidence.source_route ?? sourceRoute,
  });
  const supplyTrace = input.supplyTrace
    ? withSupplyTraceDifficultyEvidence(input.supplyTrace, difficultyEvidence)
    : undefined;

  // §2.1 web_sourced provenance. whitelist_match only demotes at selection time; it never
  // blocks ingestion or relaxes the verify gate. extract is REQUIRED (source_verify grounds
  // the declared URL against it deterministically, no refetch).
  const webSourced: WebSourcedProvenanceT = {
    url: q.source_url,
    title: q.source_title,
    fetched_at: fetchedAt,
    whitelist_match: whitelistMatch,
    ...(q.extraction_hash ? { extraction_hash: q.extraction_hash } : {}),
    extract: q.extract,
  };

  // Row WITHOUT draft_status — it is added at each .values() call site below so
  // audit:draft-status can statically prove the gate on both the original + retry INSERT.
  const questionRow = withAnswerClass({
    id,
    kind: q.kind,
    source: 'web_sourced',
    prompt_md: q.prompt_md,
    reference_md: q.reference_md,
    rubric_json: q.rubric_json ?? null,
    choices_md: q.choices_md ?? null,
    judge_kind_override: judgeKind,
    knowledge_ids: knowledgeIds,
    difficulty: q.difficulty,
    // source_ref = the fetched URL; source_ref_kind='url' disambiguates the overloaded
    // source_ref column（合约三 = SourceRefKind 契约，见 src/core/schema/provenance.ts
    // §「合约三：source_ref disambiguation」+ deriveSourceTier）. Both land tier 2.
    source_ref: q.source_url,
    created_by: createdBy,
    metadata: {
      web_sourced: webSourced,
      source_ref_kind: 'url',
      difficulty_evidence: difficultyEvidence,
      ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
    },
    created_at: now,
    canonical_content_hash: canonicalContentHash,
    updated_at: now,
  });

  const insertOnce = () =>
    tx
      .insert(question)
      // Option B — sourced drafts do NOT enter the pool / FSRS until source_verify passes.
      // Keep draft_status explicit at every INSERT site so audit:draft-status can prove it.
      .values({ ...questionRow, draft_status: 'draft' })
      // Scope the arbiter to the canonical-hash partial unique index (WHERE ... IS NOT NULL)
      // so a bare conflict (e.g. the PK) can't be misread as a hash collision. The `where`
      // predicate is REQUIRED for Postgres to infer the partial unique index as arbiter.
      .onConflictDoNothing({
        target: question.canonical_content_hash,
        where: sql`${question.canonical_content_hash} is not null`,
      })
      .returning({ id: question.id });

  const inserted = await insertOnce();
  if (inserted.length > 0) {
    return { status: 'inserted', difficultyEvidence, supplyTrace };
  }

  // ON CONFLICT — a concurrent insert won the canonical-hash race (YUK-720). Merge the
  // target KCs into the winner, or release a terminal-rejected draft and retry this INSERT.
  const raced = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
    canonicalContentHash,
    knowledgeIds,
    actorRef: mergeActorRef,
    taskRunId,
    now,
  });
  if (!raced) {
    throw new Error(`insertSourcedDraft: canonical hash conflict did not resolve for ${id}`);
  }
  if (raced.disposition === 'released_terminal_draft') {
    const retry = await insertOnce();
    if (retry.length === 0) {
      throw new Error(`insertSourcedDraft: canonical hash retry still conflicted for ${id}`);
    }
    return { status: 'inserted', difficultyEvidence, supplyTrace };
  }
  return {
    status: 'raced_merged',
    existingId: raced.id,
    addedKnowledgeIds: raced.addedKnowledgeIds,
    resultingKnowledgeIds: raced.knowledgeIds,
    draftStatus: raced.draftStatus,
  };
}
