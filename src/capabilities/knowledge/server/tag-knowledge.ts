// P2 (YUK-489) — unified match-or-propose KC tagging step.
//
// `tagKnowledge` is the shared content→KC-attribution step that will run on every
// question-creation entry point (auto-enroll / upload, manual /api/mistakes, import,
// image-candidate-accept) in P3. It REPLACES today's per-entry tagging (auto-enroll's
// LLM-prefilled knowledge_ids + the cold-start-bridge ① half) with a single embedding
// retrieval + threshold decision:
//
//   1. embed the question text → qvec (DashScope text-embedding-v4, 1024-dim)
//   2. matchKnowledgeBySimilarity(db, qvec, {topK}) → nearest active embedded KCs
//   3. nearest cosine_distance <= MATCH_THRESHOLD  → kind:'match' (all candidates within)
//      else                                         → kind:'propose' (mint a child KC)
//
// PROPOSE auto-approves the new KC (no human review wall, day-one usable) and writes an
// AUDIT-ONLY event (`experimental:auto_tag_kc_created`) that is NOT a pending inbox
// proposal (proposalWhere() in inbox.ts does not fold generic experimental:* actions),
// mirroring the live cold-start primitive in auto-enroll.ts.
//
// MATCH also writes an AUDIT-ONLY event (`experimental:auto_tag_kc_matched`, YUK-540) —
// a silent MATCH was previously untraceable even though its knowledge_ids feed
// mastery/FSRS one hop downstream via question.knowledge_ids. Best-effort (never throws);
// see the MATCH branch below for the full rationale and the collision-safety note on the
// action name (it must NOT reuse `_created` — see that branch's comment).
//
// LIVE-WIRED (stale "ADDITIVE-ONLY / no entry point calls this yet" claim removed, YUK-540
// review): two production entry points call this — auto-enroll.ts (ENROLL mode, per
// question_block) and image-candidate-accept.ts (thin-seed accept path). Reference-answer
// generation is intentionally OUT of scope (that is P4a) — this is the pure CONTENT/KC axis
// (design §6), orthogonal to grading (YUK-488).
//
// The LLM naming call (PROPOSE path) runs OUTSIDE any DB transaction (design §3 — never a
// model call inside a DB tx). Node creation is event-first, projected in the same transaction.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import {
  type EmbedProviderAttemptOptions,
  embedText,
  isDirectProviderAttemptInvariantError,
} from '@/server/ai/embed';
import { questionEmbedText } from '@/server/ai/embed-source';
// YUK-471 W1 PR-A2b — accept-time projection parity assert (dev/test throws, prod warns).
import { projectKnowledgeNodeGuarded } from '@/server/projections/knowledge';
import { getKnownSubjects } from '@/subjects/profile';
import { type KnowledgeSimilarityCandidate, matchKnowledgeBySimilarity } from './match-similarity';
import { prepareProposedKnowledgeId } from './proposals';
import { MATCH_THRESHOLD } from './tagging-flags';

/** Nearest-first candidates fetched per tag. Mirrors poolFetch's modest top-K. */
const RETRIEVAL_TOP_K = 10;

export function isTagKnowledgeInvariantError(error: unknown): boolean {
  return isDirectProviderAttemptInvariantError(error);
}

/**
 * Naming seam — given the question (subject already resolved), return a concise
 * child-KC name. The ingestion caller owns model naming (or reuses an existing
 * bridge result); Knowledge owns only the match-or-propose decision and its writes.
 */
export type NameKcFn = (args: {
  questionText: string;
  knowledgeHint: string | null;
  subjectId: string;
  knownSubjects: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
}) => Promise<{ kc_name: string }>;

export interface TagKnowledgeDeps {
  /**
   * Top-level DB handle. Typed `Db` (not `Db | Tx`) deliberately: the retriever
   * (matchKnowledgeBySimilarity) requires a top-level handle, AND the whole flow runs OUTSIDE
   * any enroll transaction by design (the LLM naming call must never sit inside a DB tx; the
   * tag verdict is computed first, then passed INTO the caller's tx — design §3).
   */
  db: Db;
  /** Embed the question text → query vector. Injected in tests. Defaults to embedText. */
  embedFn?: (text: string) => Promise<number[]>;
  providerAttempt?: EmbedProviderAttemptOptions;
  /** Caller-owned naming: a model adapter or a previously resolved bridge result. */
  nameKcFn: NameKcFn;
  /** Override the MATCH cutoff (cosine distance). Defaults to MATCH_THRESHOLD. */
  threshold?: number;
  /**
   * Per-run batch-coherence cache (design §4): a Map keyed by
   * `${subjectRootId}::${normalizedName}` → knowledge_id. Sibling questions in one upload
   * that would PROPOSE the same name reuse the first-proposed KC id instead of re-proposing
   * a duplicate. The caller owns the Map's lifetime (one per upload pass) — `tagKnowledge`
   * reads + writes it but never clears it. Omit for one-shot tags.
   *
   * CONTRACT — calls sharing one `batchCache` MUST run SEQUENTIALLY (await each before the
   * next), NOT concurrently (no `Promise.all`). The cache GET (miss) and SET straddle two
   * awaits (the propose tx), so concurrent siblings proposing the same name would BOTH miss
   * and double-create, the later SET silently overwriting the first (OCR #562). All P3
   * callers loop sequentially (auto-enroll per-question, import per-block), satisfying this.
   */
  batchCache?: Map<string, string>;
}

export interface TagKnowledgeInput {
  /** Extracted question prompt (+ optional reference / choices already folded by caller). */
  questionText: string;
  /** Soft topic hint from extraction (non-authoritative), or null. */
  knowledgeHint?: string | null;
  /** Resolved subject root id — `seed:<subjectId>:root`. The PROPOSE parent. */
  subjectRootId: string;
  /** Closed subject-id vocabulary (anti-hallucination for the naming invoker). */
  knownSubjects?: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
  /**
   * Optional caller-supplied provenance anchor for audit traceability (YUK-540) — e.g. the
   * ingestion `question_block.id` (auto-enroll) or the accepted `image_candidate` proposal id
   * (image-candidate-accept). PURELY OBSERVATIONAL: never read by the match/propose decision
   * itself, only threaded into the MATCH audit event's payload. Omit when no natural anchor
   * exists at call time (e.g. the question row doesn't exist yet).
   */
  sourceRef?: { kind: string; id: string } | null;
}

/**
 * Discriminated result. `propose` ALWAYS yields a concrete (auto-approved) knowledge id —
 * the dead `knowledge_ids:[]` zero-match gate is gone (design §2/§3).
 *
 * - `match`: ≥1 existing KC within threshold. `knowledge_ids` are the matching ids,
 *   nearest-first. NO new KC created; DOES write an audit-only event (YUK-540,
 *   `experimental:auto_tag_kc_matched`) — no row mutation, best-effort (never throws).
 * - `propose`: minted a new child KC under `subjectRootId`. `knowledge_ids=[newId]`,
 *   `kc_name` is the minted name. A batch-cache reuse (a sibling already proposed this
 *   name this run) ALSO returns `kind:'propose'` with the cached id but creates nothing.
 */
export type TagKnowledgeResult =
  | { kind: 'match'; knowledge_ids: string[] }
  | { kind: 'propose'; knowledge_ids: string[]; kc_name: string };

/** Extracts `<subjectId>` from a `seed:<subjectId>:root` id, else null. */
function subjectIdFromRoot(subjectRootId: string): string | null {
  const m = /^seed:([^:]+):root$/.exec(subjectRootId);
  return m ? m[1] : null;
}

/** Stable cache key — subject root + case/space-normalized name. */
function batchCacheKey(subjectRootId: string, kcName: string): string {
  return `${subjectRootId}::${kcName.trim().toLowerCase()}`;
}

/**
 * Unified match-or-propose tagging. See module header + design §3.
 *
 * Flow: embed → retrieve top-K KCs → nearest within threshold ? MATCH : PROPOSE.
 * PROPOSE consults the batch cache first (sibling reuse), else names a KC (LLM, OUTSIDE any
 * tx), records its approved creation event, projects the node, and caches its id.
 */
export async function tagKnowledge(
  deps: TagKnowledgeDeps,
  input: TagKnowledgeInput,
): Promise<TagKnowledgeResult> {
  const { db } = deps;
  const embedFn = deps.embedFn ?? ((text: string) => embedText(text, deps.providerAttempt));
  const nameKcFn = deps.nameKcFn;
  const threshold = deps.threshold ?? MATCH_THRESHOLD;
  // Guard the explicit-empty-array case too: `?? default` fires only on `undefined`, so a
  // caller passing `[]` would otherwise leave `knownSubjectIds[0]` undefined and propagate
  // `[undefined]` into the naming invoker (OCR #562). Treat empty as "use the default vocab".
  // YUK-600：默认回退改活 registry 词表（getKnownSubjects——不读编译期冻结快照；
  // custom 科目 hydrate 后自动入表）。显式空数组同样落默认（OCR #562 守卫保留）。
  const knownSubjects = input.knownSubjects?.length ? input.knownSubjects : getKnownSubjects();
  const knowledgeHint = input.knowledgeHint ?? null;

  // (1) embed the question text → query vector.
  const qvec = await embedFn(
    questionEmbedText({ prompt_md: input.questionText, reference_md: null, choices_md: null }),
  );

  // (2) retrieve nearest active embedded KCs (pure read; [] for empty query vec).
  const candidates = await matchKnowledgeBySimilarity(db, qvec, { topK: RETRIEVAL_TOP_K });

  // (2b) D1 (YUK-489) — SUBJECT-SCOPE the candidates. matchKnowledgeBySimilarity is a GLOBAL
  // top-K retriever (it documents that the caller applies the effective-domain filter), so a
  // math question whose nearest vector happens to be a physics KC would otherwise return
  // kind:'match' under the WRONG subject. Resolve the target subject's effective domain once,
  // then keep only candidates that resolve to the SAME effective domain. The cross-subject
  // near-neighbour is dropped here (BEFORE the match/propose decision) so it can never cause a
  // match; the question falls through to PROPOSE under the correct subject root. topK=10 →
  // ≤11 short parent-walks per tag (the target + ≤10 candidates), not a hot loop.
  const targetDomain = await getEffectiveDomain(db, input.subjectRootId);
  // Resolve each candidate's effective domain in PARALLEL — the lookups are independent (each a
  // short parent-walk) and Promise.all preserves input order, so the nearest-first property of
  // the retriever is retained while collapsing 10 sequential multi-query chains into one batch.
  const candidateDomains = await Promise.all(
    candidates.map((c) => getEffectiveDomain(db, c.knowledge_id)),
  );
  const subjectScoped: KnowledgeSimilarityCandidate[] = candidates.filter(
    (_c, i) => candidateDomains[i] === targetDomain,
  );

  // (3) decide MATCH vs PROPOSE. matchKnowledgeBySimilarity returns nearest-first and the
  // subject filter preserves that order, so the first candidate is the nearest IN-SUBJECT one.
  // MATCH when it is within the (distance) threshold.
  const nearest = subjectScoped[0];
  if (nearest && nearest.cosine_distance <= threshold) {
    const matchingCandidates = subjectScoped.filter(
      (c: KnowledgeSimilarityCandidate) => c.cosine_distance <= threshold,
    );
    const matchingIds = matchingCandidates.map((c) => c.knowledge_id);

    // Audit-only MATCH event (YUK-540) — this branch previously wrote ZERO event ("NO new KC
    // created, NO event written" per the docstring above), making a wrong silent match
    // completely untraceable even though knowledge_ids feed mastery/FSRS one hop downstream via
    // question.knowledge_ids. Mirrors the PROPOSE branch's audit shape (same actor_ref,
    // subject_kind:'knowledge', outcome:'success') with a DISTINCT action name — reusing
    // `experimental:auto_tag_kc_created` would corrupt the fold reducer
    // (core/projections/knowledge.ts:180, which treats that exact action as a node CREATE) and
    // kc_dedup_nightly's `recent_auto` CTE (which would then treat an old, established KC as
    // "recently auto-created"). Best-effort (never throws): unlike PROPOSE's event (paired with
    // a real mutation inside one tx), this event has NOTHING to roll back, so a transient write
    // failure must not turn a successful MATCH decision into a routed-to-review failure —
    // mirrors kc_dedup_nightly's own audit-event catch (kc_dedup_nightly.ts:244-275).
    try {
      await writeEvent(db, {
        id: newId(),
        session_id: null,
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
          threshold,
          primary_knowledge_id: nearest.knowledge_id,
          matches: matchingCandidates.map((c) => ({
            knowledge_id: c.knowledge_id,
            name: c.name,
            cosine_distance: c.cosine_distance,
          })),
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

  // (4) PROPOSE — name a child KC (LLM, OUTSIDE any DB tx), then auto-approve + audit.
  const subjectId = subjectIdFromRoot(input.subjectRootId);
  const { kc_name } = await nameKcFn({
    questionText: input.questionText,
    knowledgeHint,
    // When the root id isn't the canonical seed shape, fall back to the first known subject
    // so the naming invoker still has a valid pinned vocabulary entry (anti-hallucination).
    subjectId: subjectId ?? knownSubjects[0].id,
    knownSubjects,
  });

  // Defensive: nameKcFn is injectable and ultimately model-backed; an empty / whitespace-only
  // name would persist a blank KC (OCR #562). Fail loud instead. The bridge schema already
  // caps length (≤60 chars), so we only guard the empty case here.
  if (!kc_name || !kc_name.trim()) {
    throw new Error('tagKnowledge: nameKcFn returned an empty KC name');
  }

  // Batch-coherence (design §4): a sibling this run already proposed this name under this
  // root → reuse its id instead of minting a duplicate. Returned as a propose result (it WAS
  // a propose decision) but creates nothing.
  if (deps.batchCache) {
    const key = batchCacheKey(input.subjectRootId, kc_name);
    const cachedId = deps.batchCache.get(key);
    if (cachedId) {
      return { kind: 'propose', knowledge_ids: [cachedId], kc_name };
    }
  }

  // Automatic approval remains atomic with its creation event and projection.
  const newKcId = await db.transaction(async (tx) => {
    // One event timestamp defines the new node metadata.
    const now = new Date();
    const createdId = await prepareProposedKnowledgeId(tx, {
      mutation: 'propose_new',
      name: kc_name,
      parent_id: input.subjectRootId,
    });
    await writeEvent(tx, {
      id: newId(),
      session_id: null,
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
        reasoning: `unified tagging auto-created KC "${kc_name}" under ${input.subjectRootId} (no live KC within MATCH_THRESHOLD=${threshold}); auto-approved day-one, applied as ${createdId}`,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    // The recorded event is the only source of the new node.
    await projectKnowledgeNodeGuarded(tx, createdId);
    return createdId;
  });

  if (deps.batchCache) {
    deps.batchCache.set(batchCacheKey(input.subjectRootId, kc_name), newKcId);
  }

  return { kind: 'propose', knowledge_ids: [newKcId], kc_name };
}
