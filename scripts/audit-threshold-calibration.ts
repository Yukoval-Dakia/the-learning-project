// pnpm audit:threshold-calibration (YUK-677) — READ-ONLY, REPORT-ONLY distance-distribution
// replay for the three embedding cosine-distance thresholds that all shipped UNTUNED with
// their calibration follow-up orphaned on YUK-396 (the poolFetch operator ticket — it never
// carried calibration scope). This audit is that follow-up.
//
//   Axis A — MATCH_THRESHOLD            (tagging-flags.ts, env TAGGING_MATCH_THRESHOLD)
//            question→KC match-or-propose ceiling. Positives = a question's distance to its
//            OWN assigned KCs; negatives = its distance to the nearest NON-assigned KC.
//            The decision replay preserves production order: GLOBAL top-RETRIEVAL_TOP_K
//            retrieval FIRST (tag-knowledge.ts → matchKnowledgeBySimilarity topK=10), the
//            effective-domain subject gate SECOND — an in-domain KC ranked beyond the
//            window is invisible to production and is counted as retrieval-starved.
//   Axis B — DEDUP_DISTANCE_MAX         (dedup-flags.ts, env KC_DEDUP_DISTANCE_MAX)
//            KC↔KC near-duplicate ceiling for kc_dedup_nightly merge proposals.
//   Axis C — MATCHER_COSINE_MAX_DISTANCE (matcher.ts, hard const)
//            KC-centric query→pool axis. The checked matcher path recalls candidates via
//            poolFetch(knowledgeId, activeOnly:false) — knowledge_ids @> [KC] INCLUDING
//            drafts — so the candidate set is by construction same-KC only: a cross-KC
//            "wrong" serve is structurally impossible, and the ceiling trades ONLY
//            serve-pool vs residual-generate (宁残余不塞次品). Evidence = KC→own-questions
//            distances (the KC embedding is the closest corpus-side proxy for the free-text
//            demand query) + same-KC q↔q pair cohesion + the at-ceiling servable/starved
//            split. There is NO negative distribution on this axis.
//
// ⚠ NEVER WRITES. NEVER FLIPS A THRESHOLD. The script only SELECTs knowledge/question
//   embedding vectors + the auto-tag event log, replays cosine distances IN-MEMORY, and
//   prints n + quantiles + a mechanically-derived suggested band per axis. The thresholds
//   themselves are read back from the live flag modules (env overrides included), so the
//   report always evaluates the value that would actually take effect.
//
// Mirrors scripts/audit-calibration.ts (runCli/main/direct-run guard, --json, exit 0 on
// success / 2 on operational error) and scripts/worker.ts (loadEnv BEFORE anything that
// could touch the DB).
//
// CONNECTION: `AUDIT_READ_DATABASE_URL` (registered in src/server/env.ts) wins when set —
// point it at a read-only role or replica for a corpus-bearing DB; otherwise falls back to
// DATABASE_URL. Either way the session is pinned `default_transaction_read_only=on` at the
// protocol level, so the read-only guarantee does not rest on the role being configured
// correctly. A dedicated postgres-js client is used (NOT the shared @/db/client pool) so
// the audit never borrows the app pool and never inherits its write capability.
//
// n=1 upper bound (same caveat as audit-calibration): this loads the full embedded corpus
// into memory and computes pair distances in JS — tractable for the solo-owner deployment.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// loadEnv MUST run first — fills process.env from .env/.env.local (empty slots only) and
// returns the validated server env (worker.ts:29 pattern).
import { loadEnv } from '../server/env';

const env = loadEnv();

// postgres + the pure helpers are side-effect-free at import. The flag modules are NOT
// statically imported: they read process.env at module top, and ESM hoisting would evaluate
// them BEFORE loadEnv() fills .env/.env.local — an env-file override would be missed. They
// are dynamic-imported inside runCli() after loadEnv (the audit-calibration.ts pattern), so
// the report evaluates the SAME resolved value the runtime would boot with.
import postgres from 'postgres';
import { fromSqlVector } from '@/db/vector';

// pgvector `<=>` semantics: 0 = identical direction, 1 = orthogonal, 2 = opposite.
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineDistance: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  // A zero-norm vector has no direction — pgvector `<=>` returns NaN there too. Surface it
  // as NaN (filtered + counted by the caller) rather than silently coercing to a distance.
  if (na === 0 || nb === 0) return Number.NaN;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Interpolated quantile (numpy "linear"/type-7 convention) over a PRE-SORTED array. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const QUANTILE_GRID = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95] as const;

export interface DistSummary {
  n: number;
  min: number;
  p05: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
}

export function summarize(values: readonly number[]): DistSummary {
  const clean = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((x, y) => x - y);
  const q = (p: number) => quantile(clean, p);
  return {
    n: clean.length,
    min: clean[0] ?? Number.NaN,
    p05: q(QUANTILE_GRID[0]),
    p10: q(QUANTILE_GRID[1]),
    p25: q(QUANTILE_GRID[2]),
    p50: q(QUANTILE_GRID[3]),
    p75: q(QUANTILE_GRID[4]),
    p90: q(QUANTILE_GRID[5]),
    p95: q(QUANTILE_GRID[6]),
    max: clean[clean.length - 1] ?? Number.NaN,
  };
}

/** Fraction of values `<= ceiling` over a PRE-SORTED array. */
export function fractionUnder(sorted: readonly number[], ceiling: number): number {
  if (sorted.length === 0) return Number.NaN;
  let hi = sorted.length;
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= ceiling) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(4) : '—';
}

function fmtSummary(label: string, s: DistSummary): string {
  if (s.n === 0) return `  ${label}: n=0`;
  return (
    `  ${label}: n=${s.n}  min=${fmt(s.min)}  p05=${fmt(s.p05)}  p10=${fmt(s.p10)}  ` +
    `p25=${fmt(s.p25)}  p50=${fmt(s.p50)}  p75=${fmt(s.p75)}  p90=${fmt(s.p90)}  ` +
    `p95=${fmt(s.p95)}  max=${fmt(s.max)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Loader — the thin DB seam (the ONLY non-pure code). Three SELECTs, nothing else.
// ─────────────────────────────────────────────────────────────────────────────────────

interface KcVector {
  id: string;
  name: string;
  embedding: number[];
}

interface Corpus {
  /** Active + embedded KCs (the matchable/proposable population). */
  kcs: KcVector[];
  /** id → effective domain (in-memory parent climb; null where getEffectiveDomain throws). */
  domainByKc: Map<string, string | null>;
  questions: Array<{
    id: string;
    knowledge_ids: string[];
    draft_status: string | null;
    source: string;
    embedding: number[];
  }>;
  /** KCs minted by the unified tagging lane (all-time — production scans a window). */
  autoCreatedKcIds: Set<string>;
  questionTotal: number;
  knowledgeTotal: number;
}

async function loadCorpus(sql: postgres.Sql): Promise<Corpus> {
  // `embedding::text` makes the wire format the pgvector literal `[a,b,...]` regardless of
  // driver decoding; fromSqlVector is the house parser (src/db/vector.ts).
  const kcVectors = await sql<
    Array<{ id: string; name: string; embedding_text: string }>
  >`SELECT id, name, embedding::text AS embedding_text
    FROM knowledge
    WHERE archived_at IS NULL AND embedding IS NOT NULL`;

  // ALL rows (unfiltered) for the effective-domain climb — mirrors batchResolveEffectiveDomains
  // (archived-INCLUSIVE load so a walk through an archived ancestor resolves identically).
  const kcTree = await sql<
    Array<{ id: string; domain: string | null; parent_id: string | null }>
  >`SELECT id, domain, parent_id FROM knowledge`;

  const questions = await sql<
    Array<{
      id: string;
      knowledge_ids: unknown;
      draft_status: string | null;
      source: string;
      embedding_text: string;
    }>
  >`SELECT id, knowledge_ids, draft_status, source, embedding::text AS embedding_text
    FROM question
    WHERE embedding IS NOT NULL`;

  const autoCreated = await sql<Array<{ id: string }>>`SELECT DISTINCT subject_id AS id
    FROM event
    WHERE action = 'experimental:auto_tag_kc_created'
      AND subject_kind = 'knowledge'
      AND outcome = 'success'`;

  const counts = await sql<
    Array<{ q_total: string; kc_total: string }>
  >`SELECT (SELECT count(*) FROM question) AS q_total,
           (SELECT count(*) FROM knowledge) AS kc_total`;

  // In-memory effective-domain climb — the exact structural mirror of getEffectiveDomain /
  // batchResolveEffectiveDomains (domain-bearing ancestor walk, MAX_DEPTH-bounded so a cycle
  // yields null instead of looping).
  const MAX_DEPTH = 32;
  const byId = new Map(kcTree.map((r) => [r.id, r]));
  const domainByKc = new Map<string, string | null>();
  for (const kc of kcVectors) {
    let cur: string = kc.id;
    let domain: string | null = null;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const row = byId.get(cur);
      if (!row) break; // node not found
      if (row.domain !== null) {
        domain = row.domain;
        break;
      }
      if (row.parent_id === null) break; // root with null domain
      cur = row.parent_id;
    }
    domainByKc.set(kc.id, domain);
  }

  return {
    kcs: kcVectors.map((r) => ({
      id: r.id,
      name: r.name,
      embedding: fromSqlVector(r.embedding_text),
    })),
    domainByKc,
    questions: questions.map((r) => ({
      id: r.id,
      knowledge_ids: Array.isArray(r.knowledge_ids)
        ? (r.knowledge_ids as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      draft_status: r.draft_status,
      source: r.source,
      embedding: fromSqlVector(r.embedding_text),
    })),
    autoCreatedKcIds: new Set(autoCreated.map((r) => r.id)),
    questionTotal: Number(counts[0]?.q_total ?? 0),
    knowledgeTotal: Number(counts[0]?.kc_total ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Pure replay — everything below is testable without a DB.
// ─────────────────────────────────────────────────────────────────────────────────────

export interface AxisResult {
  summaries: Record<string, DistSummary>;
  gridFractions: Record<string, Record<string, number>>;
  extras: Record<string, number | string>;
  closestPairs?: Array<{ a: string; b: string; distance: number; sameDomain: boolean }>;
}

/**
 * Axis A — question→KC, mirroring production tagKnowledge's decision shape
 * (tag-knowledge.ts): production FIRST retrieves the GLOBALLY nearest
 * `retrievalTopK` KCs (matchKnowledgeBySimilarity, topK=RETRIEVAL_TOP_K) and only THEN
 * drops cross-domain candidates — `nearest in-domain candidate inside the window
 * ≤ ceiling → MATCH`. An assigned in-domain KC ranked beyond the window is invisible
 * to production, so it is counted separately as retrieval-starved rather than allowed
 * to inflate accept-correct. The replay uses each question's PRIMARY assigned KC's
 * effective domain as the target domain (the honest proxy for the caller-resolved
 * subjectRootId). For every embedded question carrying knowledge_ids: distance to each
 * RESOLVABLE assigned KC (positives — domain-agnostic, a labelled pair is evidence
 * wherever it lives), plus the in-window decision distributions (nearest in-domain
 * assigned / NON-assigned / overall). `ceiling` is the threshold under review — used
 * only for the at-ceiling confusion breakdown.
 */
export function analyzeTaggingAxis(
  corpus: Corpus,
  ceiling: number,
  retrievalTopK: number,
): AxisResult {
  const kcIndex = new Map(corpus.kcs.map((k, i) => [k.id, i]));
  const positives: number[] = [];
  const nearestAssigned: number[] = [];
  const nearestRival: number[] = [];
  const nearestOverall: number[] = [];
  let hitAt1 = 0;
  let taggedQuestions = 0;
  let assignedMissing = 0; // assigned ids that resolve to no active+embedded KC
  let nanDistances = 0;
  // Confusion breakdown AT the ceiling under review: what the live
  // `nearest in-window in-domain ≤ T → MATCH` rule would do to THIS corpus.
  let acceptCorrect = 0; // nearest in-window in-domain ≤ T and it IS an assigned KC
  let acceptWrong = 0; // nearest in-window in-domain ≤ T but NOT assigned → mis-tag
  let proposeThresholdStarved = 0; // in-window in-domain assigned KC existed but > T
  let proposeRetrievalStarved = 0; // in-domain assigned KC exists only BEYOND the top-K window
  let proposeNoAssigned = 0; // no in-domain assigned KC anywhere → legit propose
  let unscopedQuestions = 0; // primary KC's domain unresolvable → unfiltered pool

  for (const q of corpus.questions) {
    const assigned = new Set(q.knowledge_ids);
    if (assigned.size === 0) continue;
    taggedQuestions++;
    for (const id of assigned) {
      if (!kcIndex.has(id)) assignedMissing++;
    }
    // Production resolves the target subject's effective domain once and drops every
    // cross-domain candidate BEFORE the threshold read. Proxy: the PRIMARY assigned KC's
    // domain (knowledge_ids[0] is the canonical primary). Null → cannot scope → keep the
    // pool unfiltered and count it (matches production only insofar as a subject always
    // resolves there — the count flags how much of the report is unscoped).
    const targetDomain =
      q.knowledge_ids.length > 0 ? (corpus.domainByKc.get(q.knowledge_ids[0]) ?? null) : null;
    if (targetDomain === null) unscopedQuestions++;

    // Step 1 (production order): GLOBAL nearest-first ranking over ALL active embedded
    // KCs, truncated to the retrieval window. Positives stay domain-agnostic — they are
    // collected over the full ranking before the window/domain gates.
    const ranked: Array<{ kcId: string; d: number }> = [];
    for (const kc of corpus.kcs) {
      const d = cosineDistance(q.embedding, kc.embedding);
      if (Number.isNaN(d)) {
        nanDistances++;
        continue;
      }
      if (assigned.has(kc.id)) positives.push(d);
      ranked.push({ kcId: kc.id, d });
    }
    ranked.sort((a, b) => a.d - b.d);

    // Step 2 (production order): the subject-scope gate applies INSIDE the window only.
    const inDomain = (kcId: string) =>
      targetDomain === null || corpus.domainByKc.get(kcId) === targetDomain;
    let bestAssigned = Number.POSITIVE_INFINITY;
    let bestRival = Number.POSITIVE_INFINITY;
    let bestOverall = Number.POSITIVE_INFINITY;
    let nearestIsAssigned = false;
    let assignedBeyondWindow = false;
    for (let rank = 0; rank < ranked.length; rank++) {
      const { kcId, d } = ranked[rank];
      if (!inDomain(kcId)) continue;
      if (rank >= retrievalTopK) {
        // Beyond the production window: only recorded so a ranked-out true positive is
        // attributed as retrieval starvation, never as an accept/propose decision.
        if (assigned.has(kcId)) assignedBeyondWindow = true;
        continue;
      }
      if (assigned.has(kcId)) {
        if (d < bestAssigned) bestAssigned = d;
      } else if (d < bestRival) {
        bestRival = d;
      }
      if (d < bestOverall) {
        bestOverall = d;
        nearestIsAssigned = assigned.has(kcId);
      }
    }
    if (bestAssigned !== Number.POSITIVE_INFINITY) nearestAssigned.push(bestAssigned);
    if (bestRival !== Number.POSITIVE_INFINITY) nearestRival.push(bestRival);
    if (bestOverall !== Number.POSITIVE_INFINITY) {
      nearestOverall.push(bestOverall);
      if (nearestIsAssigned) hitAt1++;
      if (bestOverall <= ceiling) {
        if (nearestIsAssigned) acceptCorrect++;
        else acceptWrong++;
      } else if (bestAssigned !== Number.POSITIVE_INFINITY) {
        proposeThresholdStarved++;
      } else if (assignedBeyondWindow) {
        proposeRetrievalStarved++;
      } else {
        proposeNoAssigned++;
      }
    } else if (assignedBeyondWindow) {
      // No in-domain KC inside the window at all, but a true KC was ranked out.
      proposeRetrievalStarved++;
    } else {
      proposeNoAssigned++;
    }
  }

  const posSorted = positives.filter(Number.isFinite).sort((a, b) => a - b);
  const rivalSorted = nearestRival.filter(Number.isFinite).sort((a, b) => a - b);
  const grid = [0.25, 0.35, 0.45, 0.55, 0.65, 0.75];

  const summaries: Record<string, DistSummary> = {
    'q→assigned KC (positives)': summarize(posSorted),
    'q→nearest in-domain assigned KC (top-K window)': summarize(nearestAssigned),
    'q→nearest in-domain NON-assigned KC (top-K window)': summarize(nearestRival),
    'q→nearest in-domain KC overall (top-K window)': summarize(nearestOverall),
  };
  const gridFractions: Record<string, Record<string, number>> = {
    'positives under ceiling': Object.fromEntries(
      grid.map((g) => [`<=${g}`, fractionUnder(posSorted, g)]),
    ),
    'rivals under ceiling': Object.fromEntries(
      grid.map((g) => [`<=${g}`, fractionUnder(rivalSorted, g)]),
    ),
  };

  const p90pos = summaries['q→assigned KC (positives)'].p90;
  const p10neg = summaries['q→nearest in-domain NON-assigned KC (top-K window)'].p10;
  const band =
    Number.isFinite(p90pos) && Number.isFinite(p10neg) && p90pos < p10neg
      ? `[${fmt(p90pos)}, ${fmt(p10neg)}] — clean separation; any cutoff inside preserves ranking`
      : Number.isFinite(p90pos) && Number.isFinite(p10neg)
        ? `overlap [neg p10=${fmt(p10neg)} < pos p90=${fmt(p90pos)}] — no clean cutoff at this n`
        : 'insufficient data';

  return {
    summaries,
    gridFractions,
    extras: {
      'retrieval window (RETRIEVAL_TOP_K, global rank before domain gate)': retrievalTopK,
      'tagged embedded questions': taggedQuestions,
      'assigned KC refs unresolvable (archived/unembedded/unknown)': assignedMissing,
      'questions with unresolvable primary domain (unscoped pool)': unscopedQuestions,
      'NaN distances (zero-norm vector)': nanDistances,
      'hit@1 (nearest in-window in-domain KC is assigned)': `${hitAt1}/${nearestOverall.length}`,
      [`at ceiling ${ceiling}: correct-accept`]: acceptCorrect,
      [`at ceiling ${ceiling}: wrong-accept (mis-tag)`]: acceptWrong,
      [`at ceiling ${ceiling}: propose, assigned KC in window but > T`]: proposeThresholdStarved,
      [`at ceiling ${ceiling}: propose, assigned KC ranked beyond top-K`]: proposeRetrievalStarved,
      [`at ceiling ${ceiling}: propose, nothing resolvable`]: proposeNoAssigned,
      'suggested band (pos p90 .. neg p10)': band,
    },
  };
}

/**
 * Axis B — KC↔KC. ALL unordered pairs of active+embedded KCs (the dedup scan's candidate
 * universe), the same-domain subset, and the production scan population (pairs touching an
 * auto-created KC — all-time here; the nightly job further narrows to a window).
 */
export function analyzeDedupAxis(corpus: Corpus): AxisResult {
  const all: number[] = [];
  const sameDomain: number[] = [];
  const autoTouching: number[] = [];
  const pairs: Array<{ a: string; b: string; distance: number; sameDomain: boolean }> = [];
  let nanDistances = 0;

  for (let i = 0; i < corpus.kcs.length; i++) {
    for (let j = i + 1; j < corpus.kcs.length; j++) {
      const d = cosineDistance(corpus.kcs[i].embedding, corpus.kcs[j].embedding);
      if (Number.isNaN(d)) {
        nanDistances++;
        continue;
      }
      const sd =
        corpus.domainByKc.get(corpus.kcs[i].id) != null &&
        corpus.domainByKc.get(corpus.kcs[i].id) === corpus.domainByKc.get(corpus.kcs[j].id);
      all.push(d);
      if (sd) sameDomain.push(d);
      if (
        corpus.autoCreatedKcIds.has(corpus.kcs[i].id) ||
        corpus.autoCreatedKcIds.has(corpus.kcs[j].id)
      ) {
        autoTouching.push(d);
      }
      pairs.push({
        a: corpus.kcs[i].name,
        b: corpus.kcs[j].name,
        distance: d,
        sameDomain: sd,
      });
    }
  }
  pairs.sort((x, y) => x.distance - y.distance);

  const allSorted = all.slice().sort((a, b) => a - b);
  const grid = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3];

  // Largest-gap elbow over the closest pairs: the natural seam between a near-identical
  // cluster and the bulk. Report-only evidence for the human call.
  let elbow: string = 'insufficient data (n<6 pairs)';
  if (allSorted.length >= 6) {
    const window = allSorted.slice(0, Math.min(20, allSorted.length));
    let bestGap = 0;
    let bestIdx = 0;
    for (let i = 1; i < window.length; i++) {
      const gap = window[i] - window[i - 1];
      if (gap > bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    elbow = `closest-cluster ends ≈ ${fmt(window[bestIdx - 1])} (gap ${fmt(bestGap)} before next pair at ${fmt(window[bestIdx])})`;
  }

  return {
    summaries: {
      'KC↔KC all pairs': summarize(allSorted),
      'KC↔KC same-domain pairs': summarize(sameDomain),
      'KC↔KC pairs touching auto-created KC': summarize(autoTouching),
    },
    gridFractions: {
      'all pairs under ceiling': Object.fromEntries(
        grid.map((g) => [`<=${g}`, fractionUnder(allSorted, g)]),
      ),
    },
    extras: {
      'NaN distances (zero-norm vector)': nanDistances,
      'auto-created KCs in corpus': corpus.autoCreatedKcIds.size,
      'near-duplicate elbow (largest gap, closest ≤20)': elbow,
    },
    closestPairs: pairs.slice(0, 10),
  };
}

/**
 * Axis C — KC-centric query→pool (the checked matcher axis). The production recall is
 * poolFetch(knowledgeId, activeOnly:false): `question.knowledge_ids @> [knowledgeId]`
 * INCLUDING drafts (drafts reach the lazy verify-promote arbitration, so they are real
 * candidates). The cosine ceiling then drops over-distance candidates — 宁残余不塞次品,
 * the shortfall falls to residual generation. Because the WHERE clause already restricts
 * candidates to questions carrying the demand KC, a cross-KC "wrong" serve is
 * STRUCTURALLY IMPOSSIBLE in this path — there is no negative distribution to bound the
 * ceiling from above. The ceiling trades ONLY: serve an in-pool candidate vs starve the
 * demand into residual generation.
 *
 * Evidence: per-KC distances to its own pool questions (the KC `name\ndomain` embedding
 * is the closest corpus-side proxy for the free-text demand query — resolveQueryEmbedding
 * takes a caller-supplied queryEmbedding/queryText that does not exist in the corpus),
 * same-KC q↔q pair cohesion, and the at-ceiling per-KC servable/starved split (a KC is
 * servable iff ≥1 of its pool questions is ≤ ceiling — demand limit≥1 satisfiable).
 * `ceiling` is the threshold under review, used only for the at-ceiling breakdown.
 */
export function analyzeMatcherAxis(corpus: Corpus, ceiling: number): AxisResult {
  // poolFetch(activeOnly:false) recalls drafts too — the pool is ALL embedded questions.
  const pool = corpus.questions;

  // Group pool questions by assigned KC — one entry per poolFetch(knowledgeId) pool.
  const byKc = new Map<string, number[]>();
  for (let i = 0; i < pool.length; i++) {
    for (const kc of pool[i].knowledge_ids) {
      const list = byKc.get(kc) ?? [];
      list.push(i);
      byKc.set(kc, list);
    }
  }

  const sameKcPairs: number[] = [];
  let nanDistances = 0;
  const seenPair = new Set<string>();
  for (const members of byKc.values()) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const key = `${members[a]}:${members[b]}`;
        if (seenPair.has(key)) continue; // a pair sharing TWO KCs counts once
        seenPair.add(key);
        const d = cosineDistance(pool[members[a]].embedding, pool[members[b]].embedding);
        if (Number.isNaN(d)) nanDistances++;
        else sameKcPairs.push(d);
      }
    }
  }

  // KC-centric read of the q×k matrix: per KC, distance to each of its OWN pool
  // questions — the recall set production thresholds on. At-ceiling breakdown over KCs
  // that HAVE ≥1 pool question: is the demand servable from the pool or starved into
  // residual generation?
  const kcToOwn: number[] = [];
  let kcWithPool = 0;
  let servable = 0; // ≥1 own pool question ≤ ceiling → demand fillable from pool
  let starved = 0; // every own pool question > ceiling → residual generation
  for (const kc of corpus.kcs) {
    const members = byKc.get(kc.id);
    if (!members || members.length === 0) continue;
    kcWithPool++;
    let anyUnderCeiling = false;
    for (const qi of members) {
      const d = cosineDistance(kc.embedding, pool[qi].embedding);
      if (Number.isNaN(d)) {
        nanDistances++;
        continue;
      }
      kcToOwn.push(d);
      if (d <= ceiling) anyUnderCeiling = true;
    }
    if (anyUnderCeiling) servable++;
    else starved++;
  }

  const sameSorted = sameKcPairs.slice().sort((a, b) => a - b);
  const ownSorted = kcToOwn.slice().sort((a, b) => a - b);
  const grid = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65];

  // Serve-side evidence only: no negative distribution exists on this axis (cross-KC
  // questions can never enter the recall pool). The band frames the tradeoff that IS
  // real — a lower ceiling starves more demands into residual generation; a higher one
  // serves weaker same-KC candidates.
  const own = summarize(ownSorted);
  const band =
    Number.isFinite(own.p50) && Number.isFinite(own.p90)
      ? `[${fmt(own.p50)}, ${fmt(own.p90)}] — ceiling ≥ p90 serves ~90% of pool candidates; ` +
        'below p50 over half of every pool starves into residual (no cross-KC bound exists)'
      : 'insufficient data';

  return {
    summaries: {
      'q↔q same-KC pairs (pool cohesion)': summarize(sameSorted),
      'KC→own pool questions (query proxy)': summarize(ownSorted),
    },
    gridFractions: {
      'same-KC pairs under ceiling': Object.fromEntries(
        grid.map((g) => [`<=${g}`, fractionUnder(sameSorted, g)]),
      ),
      'KC→own pool questions under ceiling': Object.fromEntries(
        grid.map((g) => [`<=${g}`, fractionUnder(ownSorted, g)]),
      ),
    },
    extras: {
      'embedded questions in matcher recall pool (drafts included, activeOnly:false)': pool.length,
      'NaN distances (zero-norm vector)': nanDistances,
      'KCs with ≥1 pool question': kcWithPool,
      [`at ceiling ${ceiling}: servable (≥1 pool candidate ≤ ceiling)`]: servable,
      [`at ceiling ${ceiling}: starved (all pool candidates > ceiling → residual)`]: starved,
      'suggested band on KC-query proxy (serve-side only, no negative bound)': band,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────────────

interface ThresholdSpec {
  axis: string;
  name: string;
  current: number;
  source: string;
}

function printAxis(spec: ThresholdSpec, result: AxisResult): void {
  console.log(`\n── ${spec.axis}: ${spec.name} = ${spec.current} (${spec.source}) ──`);
  for (const [label, s] of Object.entries(result.summaries)) {
    console.log(fmtSummary(label, s));
  }
  for (const [label, fractions] of Object.entries(result.gridFractions)) {
    const sortedKeys = Object.keys(fractions);
    const parts = sortedKeys.map(
      (k) => `${k.replace('<=', '≤')}: ${(fractions[k] * 100 || 0).toFixed(1)}%`,
    );
    console.log(`  ${label}: ${parts.join('  ')}`);
  }
  for (const [label, v] of Object.entries(result.extras)) {
    console.log(`  ${label}: ${v}`);
  }
  if (result.closestPairs && result.closestPairs.length > 0) {
    console.log('  closest KC pairs:');
    for (const p of result.closestPairs) {
      console.log(
        `    ${fmt(p.distance)}  "${p.a}" ↔ "${p.b}"${p.sameDomain ? ' (same domain)' : ''}`,
      );
    }
  }
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  // Dynamic imports AFTER loadEnv() — these modules resolve their env overrides at module
  // top, so they must evaluate only once process.env is fully populated. RETRIEVAL_TOP_K
  // comes from the same module (single truth: tag-knowledge.ts imports it from there too)
  // so the axis-A replay uses the live production window, not a driftable copy.
  const { MATCH_THRESHOLD, RETRIEVAL_TOP_K } = await import(
    '@/capabilities/knowledge/server/tagging-flags'
  );
  const { DEDUP_DISTANCE_MAX } = await import('@/capabilities/knowledge/server/dedup-flags');
  const { MATCHER_COSINE_MAX_DISTANCE } = await import(
    '@/capabilities/practice/server/quiz/matcher'
  );

  const url = env.AUDIT_READ_DATABASE_URL ?? env.DATABASE_URL;
  const usingAuditUrl = env.AUDIT_READ_DATABASE_URL != null;

  // Dedicated read-only client — NOT the shared @/db/client pool. `options` is sent as a
  // startup parameter: the session itself is pinned read-only + statement-bounded, so the
  // guarantee holds even when falling back to a read-write DATABASE_URL.
  const isLocal = /localhost|127\.0\.0\.1/.test(url) || /[?&]sslmode=disable\b/.test(url);
  const sql = postgres(url, {
    ssl: isLocal ? false : 'require',
    max: 2,
    connection: {
      application_name: 'audit:threshold-calibration',
      options: '-c default_transaction_read_only=on -c statement_timeout=120000',
    },
  });

  try {
    const corpus = await loadCorpus(sql);
    const tagged = corpus.questions.filter((q) => q.knowledge_ids.length > 0).length;
    // Corpus descriptor only — the axis-C recall pool itself is ALL embedded questions
    // (poolFetch activeOnly:false includes drafts; the axis reports its own count).
    const nonDraft = corpus.questions.filter((q) => q.draft_status !== 'draft').length;

    const axes: Array<[ThresholdSpec, AxisResult]> = [
      [
        {
          axis: 'Axis A — tagging match-or-propose',
          name: 'MATCH_THRESHOLD',
          current: MATCH_THRESHOLD,
          source: 'tagging-flags.ts / TAGGING_MATCH_THRESHOLD',
        },
        analyzeTaggingAxis(corpus, MATCH_THRESHOLD, RETRIEVAL_TOP_K),
      ],
      [
        {
          axis: 'Axis B — kc_dedup_nightly near-duplicate',
          name: 'DEDUP_DISTANCE_MAX',
          current: DEDUP_DISTANCE_MAX,
          source: 'dedup-flags.ts / KC_DEDUP_DISTANCE_MAX',
        },
        analyzeDedupAxis(corpus),
      ],
      [
        {
          axis: 'Axis C — quiz matcher pool',
          name: 'MATCHER_COSINE_MAX_DISTANCE',
          current: MATCHER_COSINE_MAX_DISTANCE,
          source: 'matcher.ts (hard const)',
        },
        analyzeMatcherAxis(corpus, MATCHER_COSINE_MAX_DISTANCE),
      ],
    ];

    if (args.includes('--json')) {
      console.log(
        JSON.stringify(
          {
            connection: usingAuditUrl ? 'AUDIT_READ_DATABASE_URL' : 'DATABASE_URL (fallback)',
            corpus: {
              knowledgeTotal: corpus.knowledgeTotal,
              kcEmbeddedActive: corpus.kcs.length,
              questionTotal: corpus.questionTotal,
              questionEmbedded: corpus.questions.length,
              questionEmbeddedTagged: tagged,
              questionEmbeddedNonDraft: nonDraft,
              autoCreatedKcIds: corpus.autoCreatedKcIds.size,
            },
            thresholds: axes.map(([spec]) => ({
              name: spec.name,
              current: spec.current,
              source: spec.source,
            })),
            axes: Object.fromEntries(
              axes.map(([spec, result]) => [
                spec.name,
                {
                  summaries: result.summaries,
                  gridFractions: result.gridFractions,
                  extras: result.extras,
                  closestPairs: result.closestPairs ?? null,
                },
              ]),
            ),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.log('=== YUK-677 threshold calibration replay (READ-ONLY / REPORT-ONLY) ===');
    console.log(
      `connection: ${usingAuditUrl ? 'AUDIT_READ_DATABASE_URL' : 'DATABASE_URL (fallback)'} ` +
        '+ session default_transaction_read_only=on',
    );
    console.log(
      `corpus: knowledge total=${corpus.knowledgeTotal} embedded-active=${corpus.kcs.length}; ` +
        `question total=${corpus.questionTotal} embedded=${corpus.questions.length} ` +
        `tagged=${tagged} non-draft=${nonDraft}; auto-created KCs=${corpus.autoCreatedKcIds.size}`,
    );
    for (const [spec, result] of axes) printAxis(spec, result);
    console.log(
      '\nREPORT-ONLY: nothing was written and no threshold was changed. The mechanical ' +
        'bands above are evidence for a human calibration call, not a recommendation engine.',
    );
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runCli();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`audit:threshold-calibration failed (operational error, NOT a verdict): ${msg}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
