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
// ADDITIVE-ONLY: no entry point calls this yet (that is P3). Reference-answer generation
// is intentionally OUT of scope (that is P4a) — this is the pure CONTENT/KC axis (design §6),
// orthogonal to grading (YUK-488).
//
// The LLM naming call (PROPOSE path) runs OUTSIDE any DB transaction (design §3 — never a
// model call inside a DB tx). The only DB writes are applyProposeNew + the audit event.

import {
  ColdStartBridgeError,
  type ColdStartBridgeRunTaskFn,
  runColdStartBridge,
} from '@/capabilities/ingestion/server/cold-start-bridge';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { embedText } from '@/server/ai/embed';
import { questionEmbedText } from '@/server/ai/embed-source';
import { writeEvent } from '@/server/events/queries';
import { KNOWN_SUBJECT_IDS } from '@/subjects/profile-schema';
import { type KnowledgeSimilarityCandidate, matchKnowledgeBySimilarity } from './match-similarity';
import { applyProposeNew } from './proposals';
import { MATCH_THRESHOLD } from './tagging-flags';

/** Nearest-first candidates fetched per tag. Mirrors poolFetch's modest top-K. */
const RETRIEVAL_TOP_K = 10;

/**
 * Naming seam — given the question (subject already resolved), return a concise
 * child-KC name. Injected in tests (stub returns a controlled name so NO real model
 * is called). The production default delegates to ColdStartPlacementBridgeTask's
 * naming, reusing the existing invoker (no new AI registry task).
 */
export type NameKcFn = (args: {
  questionText: string;
  knowledgeHint: string | null;
  subjectId: string;
  knownSubjectIds: readonly string[];
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
  /** Name the proposed KC. Injected in tests. Defaults to the cold-start-bridge naming. */
  nameKcFn?: NameKcFn;
  /**
   * Forwarded to the default naming invoker's runTask seam (so callers/tests can stub the
   * model at the runTask layer instead of replacing nameKcFn). Ignored when nameKcFn is set.
   */
  runTaskFn?: ColdStartBridgeRunTaskFn;
  /** Override the MATCH cutoff (cosine distance). Defaults to MATCH_THRESHOLD. */
  threshold?: number;
  /**
   * Per-run batch-coherence cache (design §4): a Map keyed by
   * `${subjectRootId}::${normalizedName}` → knowledge_id. Sibling questions in one upload
   * that would PROPOSE the same name reuse the first-proposed KC id instead of re-proposing
   * a duplicate. The caller owns the Map's lifetime (one per upload pass) — `tagKnowledge`
   * reads + writes it but never clears it. Omit for one-shot tags.
   */
  batchCache?: Map<string, string>;
  /** Forwarded to runTask ctx (db / subjectProfile). Ignored when nameKcFn is set. */
  ctx?: unknown;
}

export interface TagKnowledgeInput {
  /** Extracted question prompt (+ optional reference / choices already folded by caller). */
  questionText: string;
  /** Soft topic hint from extraction (non-authoritative), or null. */
  knowledgeHint?: string | null;
  /** Resolved subject root id — `seed:<subjectId>:root`. The PROPOSE parent. */
  subjectRootId: string;
  /** Closed subject-id vocabulary (anti-hallucination for the naming invoker). */
  knownSubjectIds?: readonly string[];
}

/**
 * Discriminated result. `propose` ALWAYS yields a concrete (auto-approved) knowledge id —
 * the dead `knowledge_ids:[]` zero-match gate is gone (design §2/§3).
 *
 * - `match`: ≥1 existing KC within threshold. `knowledge_ids` are the matching ids,
 *   nearest-first. NO new KC created, NO event written.
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
 * tx), auto-approves it via applyProposeNew, writes the audit event, and caches the id.
 */
export async function tagKnowledge(
  deps: TagKnowledgeDeps,
  input: TagKnowledgeInput,
): Promise<TagKnowledgeResult> {
  const { db } = deps;
  const embedFn = deps.embedFn ?? embedText;
  const nameKcFn = deps.nameKcFn ?? makeDefaultNameKc(deps);
  const threshold = deps.threshold ?? MATCH_THRESHOLD;
  const knownSubjectIds = input.knownSubjectIds ?? KNOWN_SUBJECT_IDS;
  const knowledgeHint = input.knowledgeHint ?? null;

  // (1) embed the question text → query vector.
  const qvec = await embedFn(
    questionEmbedText({ prompt_md: input.questionText, reference_md: null, choices_md: null }),
  );

  // (2) retrieve nearest active embedded KCs (pure read; [] for empty query vec).
  const candidates = await matchKnowledgeBySimilarity(db, qvec, { topK: RETRIEVAL_TOP_K });

  // (3) decide MATCH vs PROPOSE. matchKnowledgeBySimilarity returns nearest-first, so the
  // first candidate is the nearest. MATCH when it is within the (distance) threshold.
  const nearest = candidates[0];
  if (nearest && nearest.cosine_distance <= threshold) {
    const matchingIds = candidates
      .filter((c: KnowledgeSimilarityCandidate) => c.cosine_distance <= threshold)
      .map((c) => c.knowledge_id);
    return { kind: 'match', knowledge_ids: matchingIds };
  }

  // (4) PROPOSE — name a child KC (LLM, OUTSIDE any DB tx), then auto-approve + audit.
  const subjectId = subjectIdFromRoot(input.subjectRootId);
  const { kc_name } = await nameKcFn({
    questionText: input.questionText,
    knowledgeHint,
    // When the root id isn't the canonical seed shape, fall back to the first known subject
    // so the naming invoker still has a valid pinned vocabulary entry (anti-hallucination).
    subjectId: subjectId ?? knownSubjectIds[0],
    knownSubjectIds,
  });

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

  // Auto-approve: applyProposeNew inserts an APPROVED child (domain:null → inherits the
  // subject via the parent chain) and asserts the parent exists. Then the audit-only event.
  const newKcId = await applyProposeNew(db, {
    mutation: 'propose_new',
    name: kc_name,
    parent_id: input.subjectRootId,
  });

  // Audit-only provenance — a PLAIN event with a DISTINCT action so it is NEVER a pending
  // inbox proposal (proposalWhere() folds only `propose` / `experimental:knowledge_%` /
  // `experimental:proposal` / `experimental:propose_learning_intent` — a generic
  // `experimental:auto_tag_kc_created` matches none) and has no acceptProposal re-apply path.
  // Generalizes auto-enroll.ts's `experimental:cold_start_kc_created` to the unified tagger.
  await writeEvent(db, {
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'tag_knowledge',
    action: 'experimental:auto_tag_kc_created',
    subject_kind: 'knowledge',
    subject_id: newKcId,
    outcome: 'success',
    payload: {
      source: 'tag_knowledge',
      auto_created_kc_id: newKcId,
      subject_root_id: input.subjectRootId,
      parent_id: input.subjectRootId,
      name: kc_name,
      knowledge_hint: knowledgeHint,
      generated_by: 'tag_knowledge',
      reasoning: `unified tagging auto-created KC "${kc_name}" under ${input.subjectRootId} (no live KC within MATCH_THRESHOLD=${threshold}); auto-approved day-one, applied as ${newKcId}`,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
  });

  if (deps.batchCache) {
    deps.batchCache.set(batchCacheKey(input.subjectRootId, kc_name), newKcId);
  }

  return { kind: 'propose', knowledge_ids: [newKcId], kc_name };
}

/**
 * Production naming fn — reuses ColdStartPlacementBridgeTask via its existing invoker, with
 * the subject PINNED (single-element known_subject_ids → the classifier cannot pick another
 * subject; anti-hallucination still satisfied). We read back ONLY `kc_name`; the bridge's
 * `subject_id` (pinned, redundant) and `reference_md` (P4a's concern, not ours) are discarded.
 * `existing_reference_md` is a non-empty placeholder so the bridge takes its ECHO path (no
 * answer-regeneration cost). `runTaskFn` / `ctx` thread through so the model can be stubbed at
 * the runTask layer (mirrors auto-enroll's `runColdStartBridgeFn` seam). `deps.db` is forwarded
 * only into the runTask ctx (naming is a pure LLM pass — no DB read), so it never touches a tx.
 */
function makeDefaultNameKc(deps: TagKnowledgeDeps): NameKcFn {
  return async ({ questionText, knowledgeHint, subjectId }) => {
    const bridge = await runColdStartBridge({
      db: deps.db,
      questionMd: questionText,
      existingReferenceMd: '(reference answer not needed for tagging)',
      knowledgeHint,
      knownSubjectIds: [subjectId],
      runTaskFn: deps.runTaskFn,
      ctx: deps.ctx ?? { db: deps.db },
    });
    return { kc_name: bridge.kc_name };
  };
}

export { ColdStartBridgeError };
