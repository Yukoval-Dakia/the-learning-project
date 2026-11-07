// Shared match-or-propose KC tagging. Embed the question, retrieve nearest active
// KCs, and either match by cosine distance or propose a new child KC.
//
// Propose mints the KC immediately so day-one tagging is not blocked, but marks it
// approval_status='pending': an agent-invented KC is not self-approved. Both branches
// write audit-only events; neither creates an inbox proposal.
//
// YUK-1604 — input-entry semantic classification: goal/container nodes are never
// match candidates (role='kc' gate in the retriever), and every audit event carries
// the classification basis (original quote, mapping confidence, embed/naming
// provider·model·revision·cost) plus the pending reason for the await-confirmation
// bucket (unresolved domain / non-kc parent).
//
// The naming model call runs outside any DB transaction. Creation is event-first and
// projected in the same transaction. The caller binds the embedding provider; kernel
// records do not import server/ai.

import { and, eq, isNull } from 'drizzle-orm';
import {
  EMBED_VERSION,
  embedHash,
  knowledgeEmbedText,
  questionEmbedText,
} from '@/core/embed-source';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { ai_task_runs, knowledge } from '@/db/schema';
import { costUsdToMicroUsd } from '@/kernel/cost';
import { writeEvent } from '@/kernel/events';
import {
  type KnowledgeSimilarityCandidate,
  RETRIEVAL_TOP_K,
  matchKnowledgeBySimilarity,
  matchThreshold,
} from '@/kernel/read-models/knowledge-similarity';
import {
  batchResolveEffectiveDomains,
  getEffectiveDomain,
} from '@/kernel/read-models/knowledge-tree';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { getKnownSubjects } from '@/subjects/profile';
// Projection parity assert: throws in dev/test, warns in prod.
import {
  type KnowledgeEmbedStamp,
  prepareProposedKnowledgeId,
  projectKnowledgeNodeGuarded,
} from './knowledge-node-materialization';

/**
 * YUK-1604 — revision of the input-entry classification contract stamped on every
 * tag audit event (semantic role / original quote / mapping confidence / pending
 * basis). Bump when the classification semantics change.
 */
export const TAG_CLASSIFICATION_REVISION = 'yuk1604-kc-classification-v1';

/** Bounded excerpt of the question text when extraction gave no knowledge hint. */
const ORIGINAL_QUOTE_MAX_CHARS = 240;

function originalQuoteOf(questionText: string, knowledgeHint: string | null): string {
  if (knowledgeHint && knowledgeHint.trim().length > 0) return knowledgeHint.trim();
  const collapsed = questionText.trim().replace(/\s+/g, ' ');
  return collapsed.slice(0, ORIGINAL_QUOTE_MAX_CHARS);
}

/** match confidence from cosine distance, clamped to [0,1]; null for propose_new. */
function matchConfidence(cosineDistance: number): number {
  return Math.min(1, Math.max(0, 1 - cosineDistance));
}

export interface NamingProvenance {
  /** The naming task run (ColdStartPlacementBridgeTask); absent for stub names. */
  task_run_id?: string;
  /** Known USD cost of the naming run; absent when unpriced. */
  cost_usd?: number;
}

/** Best-effort provider/model/revision readback for the naming run; null fields stay null. */
async function namingRunFacts(
  db: Db,
  taskRunId: string | undefined,
): Promise<{ provider: string | null; model: string | null; revision: string | null }> {
  if (!taskRunId) return { provider: null, model: null, revision: null };
  try {
    const [run] = await db
      .select({
        provider: ai_task_runs.provider,
        model: ai_task_runs.model,
        // The run-bound prompt fingerprint is the naming contract's revision.
        revision: ai_task_runs.prompt_fingerprint,
      })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId))
      .limit(1);
    return {
      provider: run?.provider ?? null,
      model: run?.model ?? null,
      revision: run?.revision ?? null,
    };
  } catch {
    // Audit readback only — a missing run row must not fail the tagging decision.
    return { provider: null, model: null, revision: null };
  }
}

/**
 * Naming seam: the caller owns model naming; Knowledge owns only the match-or-propose
 * decision and its writes. YUK-1604 — the result may carry the naming run's
 * provenance so the audit events stay provider/model/revision/cost auditable.
 */
export type NameKcFn = (args: {
  questionText: string;
  knowledgeHint: string | null;
  subjectId: string;
  knownSubjects: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
}) => Promise<{ kc_name: string } & NamingProvenance>;

/** Question embedder in the KC vector space; provider and model are stamped on audit provenance. */
export interface KnowledgeTagEmbedder {
  provider: string;
  model: string;
  embed: (text: string) => Promise<number[]>;
}

export interface TagKnowledgeDeps {
  /**
   * Top-level handle: the retriever needs it, and the verdict is computed before the
   * caller's transaction because naming must never run inside a DB transaction.
   */
  db: Db;
  embedder: KnowledgeTagEmbedder;
  /** Caller-owned naming: a model adapter or a previously resolved bridge result. */
  nameKcFn: NameKcFn;
  /** Override the MATCH cutoff (cosine distance). Defaults to MATCH_THRESHOLD. */
  threshold?: number;
  /**
   * Per-upload cache of `${subjectRootId}::${normalizedName}` → knowledge_id, so
   * siblings proposing the same name reuse one KC. The caller owns its lifetime.
   *
   * Calls sharing a cache must run sequentially: the get/set straddle the propose
   * transaction, so concurrent siblings would both miss and double-create.
   */
  batchCache?: Map<string, string>;
}

export interface TagKnowledgeInput {
  /** Extracted question prompt (+ optional reference / choices already folded by caller). */
  questionText: string;
  /** Soft topic hint from extraction (non-authoritative), or null. */
  knowledgeHint?: string | null;
  /**
   * Ingestion session, when applicable. Bound onto audit events so consent
   * withdrawal stays retroactive through the shared derivation filter.
   */
  sessionId?: string | null;
  /** Resolved subject root id — `seed:<subjectId>:root`. The PROPOSE parent. */
  subjectRootId: string;
  /** Closed subject-id vocabulary (anti-hallucination for the naming invoker). */
  knownSubjects?: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
  /** Audit-only provenance anchor; never read by the decision. */
  sourceRef?: { kind: string; id: string } | null;
}

/**
 * - `match`: existing KCs within threshold, nearest first; no new KC, audit only.
 * - `propose`: a concrete id, either newly minted under the subject root or reused
 *   from the batch cache (in which case nothing was created).
 */
export type TagKnowledgeResult =
  | { kind: 'match'; knowledge_ids: string[] }
  | { kind: 'propose'; knowledge_ids: string[]; kc_name: string };

function subjectIdFromRoot(subjectRootId: string): string | null {
  const m = /^seed:([^:]+):root$/.exec(subjectRootId);
  return m ? m[1] : null;
}

function batchCacheKey(subjectRootId: string, kcName: string): string {
  return `${subjectRootId}::${kcName.trim().toLowerCase()}`;
}

/** Punctuation-insensitive comparison form; CJK-safe (case folding only helps latin). */
function normalizeKcName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s，。、；：！？,.!?;:（）()[\]【】「」『』《》<>"'`]/g, '');
}

/**
 * Deterministic safety net for the propose branch: the model may re-propose a concept
 * whose wording differs only in spacing/punctuation from a live KC in the same subject
 * (the cosine gate can also miss it when the KC vector is not current). Reuse the
 * existing node instead of minting a near-duplicate (YUK-1990).
 *
 * Deliberately conservative: exact normalized-name equality inside the same effective
 * domain only. Semantic near-duplicates are the embedder's job, not a name heuristic's.
 */
async function findSameNamedKnowledge(
  db: Db,
  params: { name: string; effectiveDomain: string | null },
): Promise<{ id: string; name: string } | null> {
  if (params.effectiveDomain === null) return null;
  const target = normalizeKcName(params.name);
  if (target.length === 0) return null;
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(isNull(knowledge.archived_at), eq(knowledge.role, 'kc')));
  // Name-normalize first so the domain walk only pays for real candidates; the
  // batch resolver climbs one loaded tree instead of a per-row ancestry query.
  const candidates = rows.filter(
    (row) => isLearnerVisibleKnowledgeId(row.id) && normalizeKcName(row.name) === target,
  );
  if (candidates.length === 0) return null;
  const domains = await batchResolveEffectiveDomains(
    db,
    candidates.map((c) => c.id),
  );
  return candidates.find((row) => domains.get(row.id) === params.effectiveDomain) ?? null;
}

/**
 * Compute the fresh node's vector BEFORE the creation transaction: provider work must
 * never sit inside the DB tx. Returns undefined on provider failure, leaving the row
 * for the nightly embed backfill.
 */
async function freshKnowledgeEmbedStamp(
  embedder: KnowledgeTagEmbedder,
  params: { name: string; effectiveDomain: string | null },
): Promise<KnowledgeEmbedStamp | undefined> {
  try {
    const text = knowledgeEmbedText({ name: params.name, effectiveDomain: params.effectiveDomain });
    const vector = await embedder.embed(text);
    if (vector.length === 0) return undefined;
    return {
      embedding: vector,
      embed_model: embedder.model,
      embed_version: EMBED_VERSION,
      embed_content_hash: embedHash(text),
    };
  } catch (err) {
    console.warn(`[tag_knowledge] fresh KC "${params.name}" left without an embedding`, err);
    return undefined;
  }
}

/** Match-or-propose tagging; a proposal reuses the batch cache before naming. */
export async function tagKnowledge(
  deps: TagKnowledgeDeps,
  input: TagKnowledgeInput,
): Promise<TagKnowledgeResult> {
  const { db, embedder } = deps;
  const nameKcFn = deps.nameKcFn;
  const threshold = deps.threshold ?? matchThreshold();
  // An explicit empty list also means "use the live registry"; otherwise the naming
  // invoker would receive an undefined subject.
  const knownSubjects = input.knownSubjects?.length ? input.knownSubjects : getKnownSubjects();
  const knowledgeHint = input.knowledgeHint ?? null;
  const originalQuote = originalQuoteOf(input.questionText, knowledgeHint);

  // Stamp both events with the session policy; binding the id keeps consent
  // withdrawal retroactive.
  const sessionId = input.sessionId ?? null;
  const derivationPolicy = sessionId
    ? await resolveSessionDerivationPolicy(db, sessionId)
    : 'allow';
  const policyField = derivationPolicy === 'allow' ? {} : { derivation_policy: derivationPolicy };

  const qvec = await embedder.embed(
    questionEmbedText({ prompt_md: input.questionText, reference_md: null, choices_md: null }),
  );

  const candidates = await matchKnowledgeBySimilarity(db, qvec, { topK: RETRIEVAL_TOP_K });

  // The retriever is global, so scope candidates to the target subject before
  // deciding. Otherwise a nearest physics KC could match a math question. Parallel
  // lookups preserve the nearest-first order.
  const targetDomain = await getEffectiveDomain(db, input.subjectRootId);
  const candidateDomains = await Promise.all(
    candidates.map((c) => getEffectiveDomain(db, c.knowledge_id)),
  );
  const subjectScoped: KnowledgeSimilarityCandidate[] = candidates.filter(
    (_c, i) => candidateDomains[i] === targetDomain,
  );

  const nearest = subjectScoped[0];
  if (nearest && nearest.cosine_distance <= threshold) {
    const matchingCandidates = subjectScoped.filter(
      (c: KnowledgeSimilarityCandidate) => c.cosine_distance <= threshold,
    );
    const matchingIds = matchingCandidates.map((c) => c.knowledge_id);

    // Audit-only MATCH event: attribution feeds mastery and FSRS downstream, so a
    // silent match must stay traceable. Use a distinct action name; `_created` would
    // make the fold reducer and dedup job treat this KC as newly created. Best effort:
    // a failed audit write must not fail a good match.
    try {
      await writeEvent(db, {
        id: newId(),
        session_id: sessionId,
        actor_kind: 'agent',
        actor_ref: 'tag_knowledge',
        action: 'experimental:auto_tag_kc_matched',
        subject_kind: 'knowledge',
        subject_id: nearest.knowledge_id,
        outcome: 'success',
        payload: {
          source: 'tag_knowledge',
          subject_root_id: input.subjectRootId,
          source_ref: input.sourceRef ?? null,
          ...policyField,
          threshold,
          primary_knowledge_id: nearest.knowledge_id,
          // YUK-1604 — input-entry semantic classification: what was attributed, from
          // which source quote, and how confidently the embedding mapping was made.
          classification: {
            revision: TAG_CLASSIFICATION_REVISION,
            semantic_role: 'kc',
            original_quote: originalQuote,
            mapping: {
              kind: 'match',
              confidence: matchConfidence(nearest.cosine_distance),
              threshold,
            },
          },
          matches: matchingCandidates.map((c) => ({
            knowledge_id: c.knowledge_id,
            name: c.name,
            cosine_distance: c.cosine_distance,
            confidence: matchConfidence(c.cosine_distance),
            // YUK-1603 — version provenance so each attributed match reconciles back to
            // the node revision whose vector produced it (NULL = pre-column legacy).
            version: c.version,
            embed_source_revision: c.embed_source_revision,
            embed_content_hash: c.embed_content_hash,
          })),
          provenance: {
            embed: { provider: embedder.provider, model: embedder.model },
          },
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
      });
    } catch (err) {
      console.error('[tag_knowledge] MATCH audit event write failed (match unaffected)', err);
    }

    return { kind: 'match', knowledge_ids: matchingIds };
  }

  // Propose: name outside any transaction, then create and audit atomically.
  const subjectId = subjectIdFromRoot(input.subjectRootId);
  const { kc_name, ...namingProvenance } = await nameKcFn({
    questionText: input.questionText,
    knowledgeHint,
    // A non-canonical root still needs a valid pinned subject for the naming invoker.
    subjectId: subjectId ?? knownSubjects[0].id,
    knownSubjects,
  });

  // Model-backed naming can return a blank string; fail loud instead of persisting it.
  if (!kc_name?.trim()) {
    throw new Error('tagKnowledge: nameKcFn returned an empty KC name');
  }

  // Reuse a sibling's identical proposal from this run instead of minting a duplicate.
  if (deps.batchCache) {
    const key = batchCacheKey(input.subjectRootId, kc_name);
    const cachedId = deps.batchCache.get(key);
    if (cachedId) {
      return { kind: 'propose', knowledge_ids: [cachedId], kc_name };
    }
  }

  // Second safety net after the cosine gate: an existing live KC in this subject whose
  // name differs only in spacing/punctuation is the same concept, not a new node.
  const sameNamed = await findSameNamedKnowledge(db, {
    name: kc_name,
    effectiveDomain: targetDomain,
  });
  if (sameNamed) {
    if (deps.batchCache) {
      deps.batchCache.set(batchCacheKey(input.subjectRootId, kc_name), sameNamed.id);
      deps.batchCache.set(batchCacheKey(input.subjectRootId, sameNamed.name), sameNamed.id);
    }
    try {
      await writeEvent(db, {
        id: newId(),
        session_id: sessionId,
        actor_kind: 'agent',
        actor_ref: 'tag_knowledge',
        action: 'experimental:auto_tag_kc_matched',
        subject_kind: 'knowledge',
        subject_id: sameNamed.id,
        outcome: 'success',
        payload: {
          source: 'tag_knowledge',
          subject_root_id: input.subjectRootId,
          source_ref: input.sourceRef ?? null,
          ...policyField,
          threshold,
          primary_knowledge_id: sameNamed.id,
          match_basis: 'normalized_name',
          proposed_name: kc_name,
          matched_name: sameNamed.name,
          classification: {
            revision: TAG_CLASSIFICATION_REVISION,
            semantic_role: 'kc',
            original_quote: originalQuote,
            mapping: {
              kind: 'match',
              confidence: 1,
              threshold,
            },
          },
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
      });
    } catch (err) {
      console.error('[tag_knowledge] name-reuse audit event write failed (reuse unaffected)', err);
    }
    return { kind: 'propose', knowledge_ids: [sameNamed.id], kc_name: sameNamed.name };
  }

  // YUK-1604 — classify the placement before minting: a new KC whose effective domain
  // is unresolved or whose parent is a goal/container is exactly the population the
  // owner ruled must await confirmation (待确认), never silently pass. The parent-role
  // read runs outside the creation tx; a concurrent role change folds later and the
  // ops repair (yuk1604) re-derives the basis, so no lock is needed for an audit fact.
  const [parentRow] = await db
    .select({ role: knowledge.role })
    .from(knowledge)
    .where(eq(knowledge.id, input.subjectRootId))
    .limit(1);
  const parentRole: 'kc' | 'goal' | 'container' | null = parentRow?.role ?? null;
  const pendingReasons: Array<'domain_unresolved' | 'parent_non_kc'> = [];
  if (targetDomain === null) pendingReasons.push('domain_unresolved');
  if (parentRole === null || parentRole !== 'kc') pendingReasons.push('parent_non_kc');
  const namingFacts = await namingRunFacts(db, namingProvenance.task_run_id);
  const namingCostMicroUsd = costUsdToMicroUsd(namingProvenance.cost_usd);
  // Embed before the tx so the node is matchable as soon as it exists; a provider
  // failure only defers the vector to the nightly backfill.
  const embedStamp = await freshKnowledgeEmbedStamp(embedder, {
    name: kc_name,
    effectiveDomain: targetDomain,
  });

  const newKcId = await db.transaction(async (tx) => {
    const now = new Date();
    const createdId = await prepareProposedKnowledgeId(tx, { parent_id: input.subjectRootId });
    await writeEvent(tx, {
      id: newId(),
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'tag_knowledge',
      action: 'experimental:auto_tag_kc_created',
      subject_kind: 'knowledge',
      subject_id: createdId,
      outcome: 'success',
      payload: {
        source: 'tag_knowledge',
        auto_created_kc_id: createdId,
        subject_root_id: input.subjectRootId,
        parent_id: input.subjectRootId,
        name: kc_name,
        knowledge_hint: knowledgeHint,
        generated_by: 'tag_knowledge',
        // Agent-minted KCs are not self-approved. Nothing gates on this today, so
        // tagging still works, but the node is honestly marked for later review.
        approval_status: 'pending',
        // YUK-1604 — which owner rule puts this KC in the await-confirmation bucket.
        // A resolved domain under a kc parent would leave this empty (其余不变);
        // today every propose parents under the subject root, so 'parent_non_kc'
        // is the expected basis.
        pending_reasons: pendingReasons,
        // YUK-1604 — input-entry semantic classification with audit-grade provenance
        // (original quote, mapping decision, embed/naming provider·model·revision·cost).
        classification: {
          revision: TAG_CLASSIFICATION_REVISION,
          semantic_role: 'kc',
          original_quote: originalQuote,
          mapping: {
            kind: 'propose_new',
            confidence: null,
            threshold,
          },
        },
        parent_role: parentRole,
        effective_domain: targetDomain,
        provenance: {
          embed: { provider: embedder.provider, model: embedder.model },
          naming: {
            task_run_id: namingProvenance.task_run_id ?? null,
            provider: namingFacts.provider,
            model: namingFacts.model,
            revision: namingFacts.revision,
            cost_usd: namingProvenance.cost_usd ?? null,
          },
        },
        reasoning: `unified tagging auto-created KC "${kc_name}" under ${input.subjectRootId} (no live KC within matchThreshold()=${threshold}); pending owner review, applied as ${createdId}`,
        ...policyField,
      },
      caused_by_event_id: null,
      task_run_id: namingProvenance.task_run_id ?? null,
      cost_micro_usd: namingCostMicroUsd,
      created_at: now,
    });

    await projectKnowledgeNodeGuarded(tx, createdId, embedStamp);
    return createdId;
  });

  if (deps.batchCache) {
    deps.batchCache.set(batchCacheKey(input.subjectRootId, kc_name), newKcId);
  }

  return { kind: 'propose', knowledge_ids: [newKcId], kc_name };
}
