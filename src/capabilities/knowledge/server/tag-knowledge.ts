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
import { knowledge } from '@/db/schema';
import { embedText } from '@/server/ai/embed';
import { questionEmbedText } from '@/server/ai/embed-source';
import { writeEvent } from '@/server/events/queries';
// YUK-471 W1 PR-A2b — accept-time projection parity assert (dev/test throws, prod warns).
import { assertKnowledgeNodeParity, knowledgeLiveRowToSnapshot } from '@/server/projections/parity';
import { KNOWN_SUBJECT_IDS } from '@/subjects/profile-schema';
import { eq } from 'drizzle-orm';
import { getEffectiveDomain } from './domain';
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
   *
   * CONTRACT — calls sharing one `batchCache` MUST run SEQUENTIALLY (await each before the
   * next), NOT concurrently (no `Promise.all`). The cache GET (miss) and SET straddle two
   * awaits (the propose tx), so concurrent siblings proposing the same name would BOTH miss
   * and double-create, the later SET silently overwriting the first (OCR #562). All P3
   * callers loop sequentially (auto-enroll per-question, import per-block), satisfying this.
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
  // Guard the explicit-empty-array case too: `?? default` fires only on `undefined`, so a
  // caller passing `[]` would otherwise leave `knownSubjectIds[0]` undefined and propagate
  // `[undefined]` into the naming invoker (OCR #562). Treat empty as "use the default vocab".
  const knownSubjectIds = input.knownSubjectIds?.length ? input.knownSubjectIds : KNOWN_SUBJECT_IDS;
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
    const matchingIds = subjectScoped
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

  // Auto-approve + audit, ATOMIC (OCR #562). applyProposeNew inserts an APPROVED child
  // (domain:null → inherits the subject via the parent chain) and asserts the parent exists;
  // the audit-only event records provenance. Both share ONE tx so a writeEvent failure rolls
  // back the KC rather than orphaning it — safe because NO model call sits between them (the
  // LLM naming already ran above, OUTSIDE any tx — design §3).
  //
  // Audit event design: a PLAIN event with a DISTINCT action so it is NEVER a pending inbox
  // proposal (proposalWhere() folds only `propose` / `experimental:knowledge_%` /
  // `experimental:proposal` / `experimental:propose_learning_intent` — a generic
  // `experimental:auto_tag_kc_created` matches none) and has no acceptProposal re-apply path.
  // Generalizes auto-enroll.ts's `experimental:cold_start_kc_created` to the unified tagger.
  const newKcId = await db.transaction(async (tx) => {
    // YUK-471 W1 PR-A2b — single accept/create-time `now` shared by BOTH the row
    // (applyProposeNew stamps created_at/updated_at) and the auto_tag event's
    // created_at. The node reducer stamps an auto_tag-created row's timestamps from
    // the EVENT's created_at (auto_tag is NOT a proposal — its create IS the write
    // moment), so the row and the event must carry the SAME instant for fold == row.
    // (Previously applyProposeNew's internal `new Date()` and the event's defaulted
    // created_at diverged, so the projection's created_at would not match the row.)
    const now = new Date();
    const createdId = await applyProposeNew(
      tx,
      {
        mutation: 'propose_new',
        name: kc_name,
        parent_id: input.subjectRootId,
      },
      now,
    );
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

    // YUK-471 W1 PR-A2b — accept-time projection parity. The auto_tag create writes
    // the row + the auto_tag genesis event in this tx; re-project that node and assert
    // fold(events) == the row just written. The reducer reconstructs the row from the
    // auto_tag event (subject_kind/subject_id on the envelope, name/parent_id from the
    // payload, timestamps from the event's created_at = `now`). Dev/test THROW on
    // divergence; prod warn+returns (see parity.ts).
    const writtenRow = (
      await tx.select().from(knowledge).where(eq(knowledge.id, createdId)).limit(1)
    )[0];
    await assertKnowledgeNodeParity(
      tx,
      createdId,
      writtenRow ? knowledgeLiveRowToSnapshot(writtenRow) : null,
    );
    return createdId;
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
