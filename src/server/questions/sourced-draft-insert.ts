// Shared tier-2 web_sourced draft INSERT and cross-KC dedup lifecycle. SourcingTask and
// jyeoo_fetch both use it so their persistence cannot drift; callers own trigger/KC
// resolution before the insert and verify dispatch after it. On a canonical-hash race the
// target KCs merge into the winner, or a terminal-rejected draft is released and retried.

import { sql } from 'drizzle-orm';
import {
  type SupplyTraceV1T,
  mergeExactQuestionDuplicateKnowledgeIds,
  withSupplyTraceDifficultyEvidence,
} from '@/capabilities/practice/public';
import {
  DifficultyEvidence,
  type DifficultyEvidenceT,
  buildProducerDifficultyEvidence,
} from '@/core/schema/difficulty-evidence';
import { defaultJudgeKindForQuestion, isExactCapableReference } from '@/core/schema/judge-routing';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { sanitizeSourcedMarkup } from '@/server/questions/sourced-markup';

// Single-sourced from the schema so both producers type created_by identically.
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
 * Only un-declared candidates belong to this writer. Typed parts/units must go
 * through saveDraftEdit → submitDraftQuestion; the flat writer would drop them.
 */
export function assertNoDraftDeclarations(q: SourcedQuestionT): void {
  if (q.parts != null && q.parts.length > 0) {
    throw new Error(
      'insertSourcedDraft: candidate carries typed parts/units declarations — ' +
        'flat writer would silently drop them; route via saveDraftEdit + submitDraftQuestion',
    );
  }
}

/**
 * Insert one tier-2 web_sourced draft and run the cross-KC dedup lifecycle on a
 * canonical-hash race. Returns the built evidence/trace on insert, or the merge
 * disposition when a concurrent winner absorbed the target KCs.
 */
export async function insertSourcedDraft(
  tx: Tx,
  input: InsertSourcedDraftInput,
): Promise<InsertSourcedDraftResult> {
  const { id, q, knowledgeIds, sourceRoute, createdBy, whitelistMatch, fetchedAt, now } = input;
  const { canonicalContentHash, mergeActorRef, taskRunId } = input;

  assertNoDraftDeclarations(q);

  // Preserve an explicit judge_kind_override; only derive the default when absent. A
  // producer 'exact' pin on a non-choice row without a bare-answer head is unwinnable,
  // so demote it to the derived route and record the demotion for audit.
  let judgeKind = q.judge_kind_override ?? defaultJudgeKindForQuestion(q);
  let judgeKindDemotion: { declared: 'exact'; applied: string; reason: string } | undefined;
  if (
    judgeKind === 'exact' &&
    (q.choices_md ?? []).length === 0 &&
    !isExactCapableReference(q.reference_md)
  ) {
    const derived = defaultJudgeKindForQuestion({ ...q, judge_kind_override: null });
    if (derived !== 'exact') {
      judgeKindDemotion = {
        declared: 'exact',
        applied: derived,
        reason: 'reference_not_exact_capable',
      };
      judgeKind = derived;
    }
  }
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

  // whitelist_match only demotes at selection time. extract is required because
  // source_verify grounds the declared URL against it without refetching.
  const webSourced: WebSourcedProvenanceT = {
    url: q.source_url,
    title: q.source_title,
    fetched_at: fetchedAt,
    whitelist_match: whitelistMatch,
    ...(q.extraction_hash ? { extraction_hash: q.extraction_hash } : {}),
    extract: q.extract,
  };

  // Normalize source markup at the ingest seam so rows render through MathMarkdown;
  // flag it only when the idempotent transform changed something.
  const promptMd = sanitizeSourcedMarkup(q.prompt_md);
  const referenceMd = sanitizeSourcedMarkup(q.reference_md);
  const choicesMd = q.choices_md ? q.choices_md.map(sanitizeSourcedMarkup) : null;
  const markupSanitized =
    promptMd !== q.prompt_md ||
    referenceMd !== q.reference_md ||
    (q.choices_md ?? []).some((c, i) => c !== choicesMd?.[i]);

  // draft_status is added at each .values() site so audit:draft-status sees both INSERTs.
  const questionRow = withAnswerClass({
    id,
    kind: q.kind,
    source: 'web_sourced',
    prompt_md: promptMd,
    reference_md: referenceMd,
    rubric_json: q.rubric_json ?? null,
    choices_md: choicesMd,
    judge_kind_override: judgeKind,
    knowledge_ids: knowledgeIds,
    difficulty: q.difficulty,
    // source_ref_kind disambiguates the overloaded source_ref column; both land tier 2.
    source_ref: q.source_url,
    created_by: createdBy,
    metadata: {
      web_sourced: webSourced,
      source_ref_kind: 'url',
      difficulty_evidence: difficultyEvidence,
      ...(judgeKindDemotion ? { judge_kind_override_demoted: judgeKindDemotion } : {}),
      ...(markupSanitized ? { sourced_markup_sanitized: true } : {}),
      ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
    },
    created_at: now,
    canonical_content_hash: canonicalContentHash,
    updated_at: now,
  });

  // Sourced drafts stay out of the pool/FSRS until source_verify passes. Keep
  // `.insert(question)` and `.values(` adjacent: audit:draft-status scans between them.
  const insertOnce = () =>
    tx
      .insert(question)
      .values({ ...questionRow, draft_status: 'draft' })
      // Scope the arbiter to the partial unique index; the `where` predicate is required
      // for Postgres to infer it and keeps PK conflicts from looking like hash collisions.
      .onConflictDoNothing({
        target: question.canonical_content_hash,
        where: sql`${question.canonical_content_hash} is not null`,
      })
      .returning({ id: question.id });

  const inserted = await insertOnce();
  if (inserted.length > 0) {
    // Mint the first revision in the same transaction. Unverified drafts stay withheld;
    // verify/promote republishes them as admitted after source_verify passes.
    await publishQuestionGroupFromRow(tx, {
      rootId: id,
      admission: { state: 'withheld', reason: 'unverified_rules' },
      availability: 'general_pool',
      actorRef: `sourced-draft:${sourceRoute}`,
      now,
    });
    return { status: 'inserted', difficultyEvidence, supplyTrace };
  }

  // A concurrent insert won the hash race: merge into it, or release and retry.
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
    await publishQuestionGroupFromRow(tx, {
      rootId: id,
      admission: { state: 'withheld', reason: 'unverified_rules' },
      availability: 'general_pool',
      actorRef: `sourced-draft:${sourceRoute}`,
      now,
    });
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
