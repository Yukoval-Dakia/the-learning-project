// Shared match-or-propose KC tagging. Embed the question, retrieve nearest active
// KCs, and either match by cosine distance or propose a new pending child KC.
//
// The naming model call runs outside any DB transaction. Creation is event-first
// and projected in the same transaction. The DashScope embedder is bound by
// knowledge; this module does not import server.

import { and, eq, isNull } from 'drizzle-orm';
import { questionEmbedText } from '@/core/embed-source';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, knowledge } from '@/db/schema';
import { costUsdToMicroUsd } from '@/kernel/cost';
import { writeEvent } from '@/kernel/events';
import {
  type KnowledgeSimilarityCandidate,
  RETRIEVAL_TOP_K,
  matchKnowledgeBySimilarity,
  matchThreshold,
} from '@/kernel/read-models/knowledge-similarity';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';
import { getKnownSubjects } from '@/subjects/profile';

/**
 * Provider-attempt lifecycle failures that must abort tagging rather than be
 * swallowed as a best-effort miss. The error class lives in server/ai, which
 * this module cannot import, so the check is the class name plus reason.
 */
export function isTagKnowledgeInvariantError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'ProviderAttemptLifecycleError') return false;
  if (!('reason' in error)) return false;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason !== 'control_plane_unavailable';
}

/**
 * Revision of the input-entry classification contract stamped on every tag
 * audit event. Bump when the classification semantics change.
 */
export const TAG_CLASSIFICATION_REVISION = 'yuk1604-kc-classification-v1';

const ORIGINAL_QUOTE_MAX_CHARS = 240;

function originalQuoteOf(questionText: string, knowledgeHint: string | null): string {
  if (knowledgeHint && knowledgeHint.trim().length > 0) return knowledgeHint.trim();
  const collapsed = questionText.trim().replace(/\s+/g, ' ');
  return collapsed.slice(0, ORIGINAL_QUOTE_MAX_CHARS);
}

function matchConfidence(cosineDistance: number): number {
  return Math.min(1, Math.max(0, 1 - cosineDistance));
}

export interface NamingProvenance {
  /** The naming task run; absent for stub names. */
  task_run_id?: string;
  /** Known USD cost of the naming run; absent when unpriced. */
  cost_usd?: number;
}

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
    return { provider: null, model: null, revision: null };
  }
}

/** Caller-owned naming. Knowledge tagging owns only the match-or-propose decision. */
export type NameKcFn = (args: {
  questionText: string;
  knowledgeHint: string | null;
  subjectId: string;
  knownSubjects: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
}) => Promise<{ kc_name: string } & NamingProvenance>;

export interface KnowledgeTagProviderAttempt {
  readonly db?: Db;
  readonly caller: 'api' | 'worker';
  readonly deadlineAt: Date;
  readonly operationAnchor?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface KnowledgeTagEmbedder {
  readonly model: string;
  embed(text: string, providerAttempt: KnowledgeTagProviderAttempt | undefined): Promise<number[]>;
}

let embedder: KnowledgeTagEmbedder | undefined;

/** Knowledge calls this at composition with the DashScope embedder. */
export function bindKnowledgeTagEmbedder(next: KnowledgeTagEmbedder): void {
  embedder = next;
}

export interface TagKnowledgeDeps {
  /**
   * Top-level handle: the retriever needs it, and the verdict is computed before the
   * caller's transaction because naming must never run inside a DB transaction.
   */
  db: Db;
  /** Embed the question text. Injected in tests. Defaults to the bound embedder. */
  embedFn?: (text: string) => Promise<number[]>;
  providerAttempt?: KnowledgeTagProviderAttempt;
  /** Caller-owned naming: a model adapter or a previously resolved bridge result. */
  nameKcFn: NameKcFn;
  /** Override the MATCH cutoff (cosine distance). Defaults to the configured threshold. */
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

function embedQuestion(text: string, deps: TagKnowledgeDeps): Promise<number[]> {
  if (deps.embedFn) return deps.embedFn(text);
  if (!embedder) throw new Error('tagKnowledge: DashScope embedder is not bound');
  return embedder.embed(text, deps.providerAttempt);
}

async function requireProposedKnowledgeId(db: Db | Tx, parentId: string): Promise<string> {
  const [parent] = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(eq(knowledge.id, parentId), isNull(knowledge.archived_at)))
    .limit(1);
  if (!parent) {
    throw new Error(`parent knowledge node not found or archived: ${parentId}`);
  }
  return newId();
}

/** Match-or-propose tagging. A proposal reuses the batch cache before naming. */
export async function tagKnowledge(
  deps: TagKnowledgeDeps,
  input: TagKnowledgeInput,
): Promise<TagKnowledgeResult> {
  const { db } = deps;
  const nameKcFn = deps.nameKcFn;
  const threshold = deps.threshold ?? matchThreshold();
  const knownSubjects = input.knownSubjects?.length ? input.knownSubjects : getKnownSubjects();
  const knowledgeHint = input.knowledgeHint ?? null;
  const originalQuote = originalQuoteOf(input.questionText, knowledgeHint);
  const embedModel = embedder?.model ?? 'unbound';

  const sessionId = input.sessionId ?? null;
  const derivationPolicy = sessionId
    ? await resolveSessionDerivationPolicy(db, sessionId)
    : 'allow';
  const policyField = derivationPolicy === 'allow' ? {} : { derivation_policy: derivationPolicy };

  const qvec = await embedQuestion(
    questionEmbedText({ prompt_md: input.questionText, reference_md: null, choices_md: null }),
    deps,
  );

  const candidates = await matchKnowledgeBySimilarity(db, qvec, { topK: RETRIEVAL_TOP_K });
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

    // Audit-only MATCH event. A distinct action name: `_created` would make the
    // fold reducer and dedup job treat this KC as newly created. A failed audit
    // write must not fail a good match.
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
            version: c.version,
            embed_source_revision: c.embed_source_revision,
            embed_content_hash: c.embed_content_hash,
          })),
          provenance: {
            embed: { provider: 'dashscope', model: embedModel },
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

  const subjectId = subjectIdFromRoot(input.subjectRootId);
  const { kc_name, ...namingProvenance } = await nameKcFn({
    questionText: input.questionText,
    knowledgeHint,
    subjectId: subjectId ?? knownSubjects[0].id,
    knownSubjects,
  });

  if (!kc_name?.trim()) {
    throw new Error('tagKnowledge: nameKcFn returned an empty KC name');
  }

  if (deps.batchCache) {
    const key = batchCacheKey(input.subjectRootId, kc_name);
    const cachedId = deps.batchCache.get(key);
    if (cachedId) {
      return { kind: 'propose', knowledge_ids: [cachedId], kc_name };
    }
  }

  // Classify before minting. A new KC whose effective domain is unresolved or
  // whose parent is a goal/container waits for confirmation. The parent-role
  // read runs outside the creation tx; a concurrent role change folds later.
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

  const newKcId = await db.transaction(async (tx) => {
    const now = new Date();
    const createdId = await requireProposedKnowledgeId(tx, input.subjectRootId);
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
        approval_status: 'pending',
        pending_reasons: pendingReasons,
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
          embed: { provider: 'dashscope', model: embedModel },
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

    await projectKnowledgeNodeGuarded(tx, createdId);
    return createdId;
  });

  if (deps.batchCache) {
    deps.batchCache.set(batchCacheKey(input.subjectRootId, kc_name), newKcId);
  }

  return { kind: 'propose', knowledge_ids: [newKcId], kc_name };
}
