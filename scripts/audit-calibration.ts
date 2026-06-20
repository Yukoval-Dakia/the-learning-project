// pnpm audit:calibration (YUK-461, axis-2 Wave-0) — READ-ONLY, REPORT-ONLY retro-
// validation of the already-LIVE A1 SRT mastery engine via the keystone gate V-A1-fwd.
//
// ⚠ NEVER WRITES. NEVER FLIPS A FLAG. The script only SELECTs the event log + calibration
//   rows, replays the per-KC θ̂ trajectory IN-MEMORY under SRT on/off, and prints a
//   verdict. SRT_ENABLED / HIERARCHICAL_ELO_ENABLED / EARLY_KLP_ENABLED stay untouched.
//
// Mirrors scripts/audit-profile.ts (runCli/main/direct-run guard, --json) and
// scripts/worker.ts (loadEnv BEFORE any @/db/client import — the db client throws at
// module load if DATABASE_URL is unset, and most consumers run env from .env.local).
//
// The DB-touching loadAttempts() is the ONLY non-pure code; the math/replay/gate it
// feeds are fully unit-tested. loadAttempts is exercised manually via this script against
// dev data (not unit-tested — it is the thin seam).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// loadEnv MUST run before importing @/db/client (worker.ts:29 pattern). The db client +
// schema + mastery helpers are dynamic-imported inside main()/runCli so this stays first.
import { loadEnv } from '../server/env';

loadEnv();

// Owner-tunable RNG seed for the bootstrap (deterministic report across re-runs of the
// SAME data). The mulberry32 import is pure (no DB) so it is safe at module top.
import { mulberry32 } from '@/server/calibration/rng';

const BOOTSTRAP_SEED = 0x5eed_a1c0;

// ─────────────────────────────────────────────────────────────────────────────────────
// Loader — the thin DB seam. Reads the event log + calibration and builds the per-KC
// ReplayAttempt lists the pure engine consumes. EVERY exclusion mirrors a production
// θ̂-skip guard with an inline comment mapping it to the source line.
// ─────────────────────────────────────────────────────────────────────────────────────

interface LoadResult {
  // The FULL time-ordered (created_at, id) ReplayAttempt list — every attempt, every KC
  // interleaved (YUK-466). assembleForwardClusters replays this WHOLE list once per variant
  // so θ_global accumulates correctly across all KCs of a domain, then buckets the forward-
  // scorable single-KC steps by scoredKnowledgeId. (Previously this was a per-KC partition,
  // which let each KC's θ_global see only its own attempts — missing sibling-KC domain drift.)
  orderedAttempts: import('@/server/calibration/replay').ReplayAttempt[];
  nTotalScorable: number;
  familyDeltaApplied: number;
  familyDeltaTotal: number;
  partialDropped: number;
  foldableAttempts: number;
  skippedUnsupported: number;
}

/**
 * Robustly parse an event's created_at into epoch ms (OCR finding 9). Drizzle normally
 * hands back a Date, but the loader must tolerate a number (epoch ms) or an ISO string
 * without silently yielding NaN (which would corrupt the time-ordering the replay relies
 * on). Anything unparseable throws — a verdict tool must not order attempts by a bogus key.
 */
export function parseCreatedAt(value: unknown, eventId: string): number {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t))
      throw new Error(`audit-calibration: invalid Date created_at for event ${eventId}`);
    return t;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `audit-calibration: non-finite numeric created_at for event ${eventId} (got ${value})`,
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isNaN(t)) {
      throw new Error(
        `audit-calibration: unparseable created_at string for event ${eventId} (got "${value}")`,
      );
    }
    return t;
  }
  throw new Error(
    `audit-calibration: unsupported created_at type for event ${eventId} (got ${typeof value})`,
  );
}

async function loadAttempts(): Promise<LoadResult> {
  // Dynamic imports — keep loadEnv() the first side effect (db client reads DATABASE_URL
  // at module top). All of these are READ-ONLY helpers.
  const { and, asc, eq, inArray } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { event, item_calibration, question } = await import('@/db/schema');
  const { difficultyToLogitB } = await import('@/core/theta');
  const { effectiveB } = await import('@/server/mastery/recalibration');
  const { effectiveFamilyB } = await import('@/server/mastery/personalized-difficulty');
  const { batchResolveFamilyKeys } = await import('@/server/mastery/family-key');
  const { getEffectiveDomain } = await import('@/capabilities/knowledge/server/domain');
  const { item_family_calibration } = await import('@/db/schema');
  type ReplayAttempt = import('@/server/calibration/replay').ReplayAttempt;

  const DIFFICULTY_PROXY_WEIGHT = 0.3;

  // 1. The attempt events, time-ordered (created_at ASC, id ASC — stable tiebreak).
  //    Solo review path: action='review'; paper path: action='attempt'. Both subject_kind
  //    ='question' (submit.ts:507-509, paper-submit.ts:508-510).
  const attemptEvents = await db
    .select({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      payload: event.payload,
      created_at: event.created_at,
      subject_id: event.subject_id,
    })
    .from(event)
    .where(and(inArray(event.action, ['review', 'attempt']), eq(event.subject_kind, 'question')))
    .orderBy(asc(event.created_at), asc(event.id));

  // 2. FOLDABILITY GATE (M5). An attempt is foldable iff the production θ̂ path provably
  //    ran. The robust proxy (robust to paper's forced-'failure' outcome write,
  //    paper-submit.ts:257,511) is a SIBLING judge event:
  //      action='judge', caused_by_event_id = attempt.id, payload.coarse_outcome != 'unsupported'.
  //    BOTH call sites write that judge event under EXACTLY the production θ̂-gate:
  //      - paper (paper-submit.ts:528): !photoOnlyUnsupported && invoked && judgeResult
  //        → mirrors the θ̂ gate paper-submit.ts:591 (!photoOnlyUnsupported && scheduled
  //        && coarseOutcome !== 'unsupported').
  //      - solo  (submit.ts:551): judgeResult && judgeRoute && JudgeKindZ.safeParse(route)
  //        → present whenever the solo θ̂ update ran (submit.ts:611; auto_rate+unsupported
  //        throws 422 before any write, submit.ts:285).
  //    So: include an attempt ONLY if it has a sibling judge event with a non-unsupported
  //    coarse_outcome. This is more robust than inverting the forced 'failure' outcome.
  const attemptIds = attemptEvents.map((e) => e.id);
  const judgeByAttemptId = new Map<string, string>(); // attempt id → judge coarse_outcome
  if (attemptIds.length > 0) {
    const judgeEvents = await db
      .select({
        caused_by: event.caused_by_event_id,
        payload: event.payload,
      })
      .from(event)
      .where(
        and(
          eq(event.action, 'judge'),
          eq(event.subject_kind, 'event'),
          inArray(event.caused_by_event_id, attemptIds),
        ),
      );
    for (const j of judgeEvents) {
      if (j.caused_by === null) continue;
      const co = (j.payload as Record<string, unknown> | null)?.coarse_outcome;
      if (typeof co === 'string') judgeByAttemptId.set(j.caused_by, co);
    }
  }

  // 3. Per-question metadata (knowledge_ids, difficulty, kind, source) for the attempts.
  const questionIds = Array.from(
    new Set(attemptEvents.map((e) => e.subject_id).filter((id): id is string => id !== null)),
  );
  const questionRows =
    questionIds.length > 0
      ? await db
          .select({
            id: question.id,
            knowledge_ids: question.knowledge_ids,
            difficulty: question.difficulty,
            kind: question.kind,
            source: question.source,
          })
          .from(question)
          .where(inArray(question.id, questionIds))
      : [];
  const questionById = new Map(questionRows.map((q) => [q.id, q]));

  // 4. item_calibration (track='hard') b anchor per question.
  const calByQuestion = new Map<
    string,
    { b: number | null; b_anchor: number | null; b_calib: number | null }
  >();
  if (questionIds.length > 0) {
    const calRows = await db
      .select({
        question_id: item_calibration.question_id,
        b: item_calibration.b,
        b_anchor: item_calibration.b_anchor,
        b_calib: item_calibration.b_calib,
      })
      .from(item_calibration)
      .where(
        and(inArray(item_calibration.question_id, questionIds), eq(item_calibration.track, 'hard')),
      );
    for (const r of calRows) {
      calByQuestion.set(r.question_id, { b: r.b, b_anchor: r.b_anchor, b_calib: r.b_calib });
    }
  }

  // 5. Memoize per-KC effective domain (getEffectiveDomain throws on orphan → null, matching
  //    production's degrade, state.ts:586-591).
  //
  // OCR finding 10: distinguish a GENUINE "no domain" (orphan / structural) from a
  // TRANSIENT DB error. The original blanket `catch { null }` cached null for ANY throw,
  // so one transient connection blip while resolving a KC would permanently mark that KC
  // domain-less for the whole run (poisoning every later attempt that touches it). Only
  // the deterministic structural errors thrown by getEffectiveDomain itself (node-not-
  // found / root-null-domain / max-depth) mean "no resolvable domain" → cache null. Any
  // OTHER error is transient (query/connection) → rethrow, do NOT poison the cache.
  const STRUCTURAL_NO_DOMAIN = [
    'knowledge node not found',
    'root node has null domain',
    'max depth',
  ];
  const isStructuralNoDomain = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return STRUCTURAL_NO_DOMAIN.some((m) => msg.includes(m));
  };
  const domainCache = new Map<string, string | null>();
  const resolveDomain = async (kc: string): Promise<string | null> => {
    if (domainCache.has(kc)) return domainCache.get(kc) as string | null;
    let domain: string | null;
    try {
      domain = await getEffectiveDomain(db, kc);
    } catch (err) {
      if (!isStructuralNoDomain(err)) {
        // Transient (DB/connection) — let it propagate; the run fails loud rather than
        // silently treating a reachable KC as domain-less.
        throw err;
      }
      domain = null; // genuine orphan / unresolved structure (production degrade).
    }
    domainCache.set(kc, domain);
    return domain;
  };

  // 5b. BATCH family-key + family-calibration (OCR finding 1 — kill the N+1).
  //     The original loop called resolveFamilyKeyForQuestion + getFamilyCalibration once
  //     PER attempt event — each a DB round-trip (and resolveFamilyKeyForQuestion does its
  //     own getEffectiveDomain inside), so a long event log issued thousands of serial
  //     queries (the audit was pathologically slow). Resolve BOTH once over the distinct
  //     question set BEFORE the loop, then read from Maps in the loop. Results are
  //     identical: family_key is a pure function of (question primaryKnowledgeId, kind,
  //     source) and the family row is keyed by family_key — neither depends on the attempt.
  const familyKeyByQuestion = await batchResolveFamilyKeys(
    db,
    questionRows.map((q) => ({
      questionId: q.id,
      primaryKnowledgeId: q.knowledge_ids[0] ?? null, // canonical primary (state.ts:521, F2).
      kind: q.kind,
      source: q.source,
    })),
  );
  const distinctFamilyKeys = Array.from(
    new Set(Array.from(familyKeyByQuestion.values()).filter((k): k is string => k !== null)),
  );
  const familyCalByKey = new Map<
    string,
    import('@/server/mastery/personalized-difficulty').FamilyCalibrationRow
  >();
  if (distinctFamilyKeys.length > 0) {
    const famRows = await db
      .select({
        family_key: item_family_calibration.family_key,
        b_delta: item_family_calibration.b_delta,
        evidence_count: item_family_calibration.evidence_count,
        confidence: item_family_calibration.confidence,
        calibrated_n: item_family_calibration.calibrated_n,
      })
      .from(item_family_calibration)
      .where(inArray(item_family_calibration.family_key, distinctFamilyKeys));
    for (const r of famRows) familyCalByKey.set(r.family_key, r);
  }

  // 5c. PRELOAD per-KC effective domains once (OCR finding 1 — the resolveDomain memo was
  //     populated lazily INSIDE the loop, one DB round-trip per first-seen KC). Warm the
  //     cache up front over the distinct KC set so the loop only reads the Map. Transient
  //     errors still propagate (finding 10); structural no-domain caches null.
  const distinctKcs = new Set<string>();
  for (const q of questionRows) {
    for (const kc of q.knowledge_ids) {
      const t = kc.trim();
      if (t.length > 0) distinctKcs.add(t);
    }
  }
  for (const ev of attemptEvents) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    if (Array.isArray(payload.referenced_knowledge_ids)) {
      for (const x of payload.referenced_knowledge_ids as unknown[]) {
        if (typeof x === 'string' && x.trim().length > 0) distinctKcs.add(x.trim());
      }
    }
  }
  for (const kc of distinctKcs) await resolveDomain(kc);

  // 6. Build a flat, time-ordered list of foldable ReplayAttempts (each carrying its FULL
  //    KC set). This list is returned AS-IS — the assembler replays the whole list (YUK-466).
  const ordered: ReplayAttempt[] = [];
  let familyDeltaApplied = 0;
  let familyDeltaTotal = 0;
  let partialDropped = 0;
  let foldableAttempts = 0;
  let skippedUnsupported = 0;

  for (const ev of attemptEvents) {
    if (ev.subject_id === null) continue;
    const q = questionById.get(ev.subject_id);
    if (q === undefined) continue; // question deleted — cannot reconstruct b/KCs.

    // FOLDABILITY (M5): require a sibling judge with a non-unsupported coarse_outcome.
    const judgeCoarse = judgeByAttemptId.get(ev.id);
    if (judgeCoarse === undefined || judgeCoarse === 'unsupported') {
      skippedUnsupported++;
      continue; // production θ̂ path did NOT run for this attempt.
    }

    // OUTCOME: 'success'→1, 'failure'→0. DROP 'partial' (no clean binary 1PL label —
    // production folds partial as 1, but the forward 1PL needs a clean binary; excluding
    // partial is the conservative documented choice). Report the dropped count.
    const rawOutcome = ev.outcome;
    let outcome: 0 | 1;
    if (rawOutcome === 'success') outcome = 1;
    else if (rawOutcome === 'failure') outcome = 0;
    else {
      partialDropped++;
      continue;
    }

    const payload = (ev.payload ?? {}) as Record<string, unknown>;

    // knowledgeIds: the FULL set production updates (B2). payload.referenced_knowledge_ids
    // (submit.ts:528 / paper-submit.ts:515) with fallback to question.knowledge_ids.
    const refIds = Array.isArray(payload.referenced_knowledge_ids)
      ? (payload.referenced_knowledge_ids as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    const fullKcSet = refIds.length > 0 ? refIds : q.knowledge_ids;
    const dedupKcs = Array.from(
      new Set(fullKcSet.map((s) => s.trim()).filter((s) => s.length > 0)),
    );
    if (dedupKcs.length === 0) continue; // production early-returns (state.ts:460).

    // scoredKnowledgeId: the single KC iff the QUESTION is single-KC (B2 resolution b —
    // multi-KC attempts are replayed for trajectory fidelity but never forward-scored).
    const questionIsSingleKc = q.knowledge_ids.length === 1;
    const scoredKnowledgeId = questionIsSingleKc ? q.knowledge_ids[0] : null;

    // responseTimeMs: payload.duration_ms (solo only — paper writes none → null → binary).
    const durationMs = payload.duration_ms;
    const responseTimeMs =
      typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : null;

    // b RECONSTRUCTION (B3 — production's exact b): effectiveB → columnarB (difficulty
    // fallback) → effectiveFamilyB(columnarB, familyRow). bWeight keyed on the columnar
    // anchor source (state.ts:495-500, 515-531).
    const calRow = calByQuestion.get(ev.subject_id) ?? null;
    const calB = effectiveB(calRow);
    const columnarB = calB ?? difficultyToLogitB(q.difficulty);
    const bWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT;
    let b = columnarB;
    familyDeltaTotal++;
    // family_key uses q.knowledge_ids[0] (canonical primary — state.ts:521, F2 fix).
    // OCR finding 1: read the PREBATCHED key + row (no per-attempt DB round-trip). The
    // key is keyed by question id; the row by family_key — both attempt-independent, so
    // this is byte-identical to the former per-attempt resolveFamilyKeyForQuestion +
    // getFamilyCalibration, minus the N+1.
    const familyKey = familyKeyByQuestion.get(ev.subject_id) ?? null;
    if (familyKey !== null) {
      const familyRow = familyCalByKey.get(familyKey) ?? null;
      b = effectiveFamilyB(columnarB, familyRow);
      if (familyRow !== null && familyRow.b_delta !== 0) familyDeltaApplied++;
    }

    // domainByKc: per KC effective domain (memoized).
    const domainByKc: Record<string, string | null> = {};
    for (const kc of dedupKcs) {
      domainByKc[kc] = await resolveDomain(kc);
    }

    ordered.push({
      knowledgeIds: dedupKcs,
      scoredKnowledgeId,
      domainByKc,
      outcome,
      difficulty: q.difficulty,
      b,
      bWeight,
      responseTimeMs,
      // OCR finding 9: robustly parse Date | string (ISO) | number. The old
      // `Number(ev.created_at)` fallback returned NaN for an ISO string (the normal
      // Drizzle row is a Date, but the fallback must not silently produce a NaN epoch that
      // would scramble the time-ordering the replay engine depends on).
      createdAt: parseCreatedAt(ev.created_at, ev.id),
      eventId: ev.id,
    });
    foldableAttempts++;
  }

  // 7. Return the FULL time-ordered list AS-IS (YUK-466). No per-KC partition: the assembler
  //    replays this whole list once per variant so θ_global accumulates across every KC in a
  //    domain — partitioning per KC would let each KC's θ_global see only its own attempts,
  //    dropping the drift contributed by sibling-KC attempts in the same domain.
  //
  // nTotalScorable = single-KC forward-scorable steps incl. RT-less (the assembler computes
  //    the authoritative count over the same full list; this is the loader's identical view).
  let nTotalScorable = 0;
  for (const a of ordered) if (a.scoredKnowledgeId !== null) nTotalScorable++;

  return {
    orderedAttempts: ordered,
    nTotalScorable,
    familyDeltaApplied,
    familyDeltaTotal,
    partialDropped,
    foldableAttempts,
    skippedUnsupported,
  };
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const { assembleForwardClustersDetailed, evaluateVA1Forward, formatReport } = await import(
    '@/server/calibration/v-a1-fwd'
  );

  const loaded = await loadAttempts();
  const { clusters, nTotalScorable } = assembleForwardClustersDetailed(loaded.orderedAttempts);
  const result = evaluateVA1Forward(clusters, {}, mulberry32(BOOTSTRAP_SEED), {
    nTotalScorable: Math.max(nTotalScorable, loaded.nTotalScorable),
    familyDeltaAppliedCount: loaded.familyDeltaApplied,
    familyDeltaTotal: loaded.familyDeltaTotal,
    partialDropped: loaded.partialDropped,
  });

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          ...result,
          loaderStats: {
            foldableAttempts: loaded.foldableAttempts,
            skippedUnsupported: loaded.skippedUnsupported,
            partialDropped: loaded.partialDropped,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(result));
    console.log('');
    console.log('Loader stats (READ-ONLY over the event log):');
    console.log(
      `  foldable attempts (sibling judge, non-unsupported) = ${loaded.foldableAttempts}`,
    );
    console.log(
      `  skipped (no foldable judge / unsupported)          = ${loaded.skippedUnsupported}`,
    );
    console.log(`  dropped 'partial' outcomes                         = ${loaded.partialDropped}`);
  }

  // EXIT CODE (REPORT-ONLY): PASS → 0; INSUFFICIENT → 0 (A1 stays live PROVISIONALLY —
  // thin data is NOT a failure); FAIL → 1 (it IS a gate verdict). Never mutates anything.
  return result.verdict === 'FAIL' ? 1 : 0;
}

export async function main(): Promise<void> {
  // OCR finding 11: wrap the run with a friendly error + non-zero exit (mirrors the
  // audit-script pattern). A DB / dynamic-import / query failure would otherwise reject
  // with a raw unhandled-rejection stack and an ambiguous exit. Operational failures use
  // exit code 2 to stay distinct from the FAIL gate verdict (exit 1, a real result).
  try {
    process.exitCode = await runCli();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`audit:calibration failed (operational error, NOT a gate verdict): ${msg}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 2;
  } finally {
    // audit-calibration is the ONLY DB-connecting audit: @/db/client opens a postgres-js
    // pool (max:10) that holds the event loop open, so WITHOUT closing it the process HANGS
    // after the report prints — the other audits scan source files, never connect, so they
    // exit naturally. Close the singleton pool here so this script exits cleanly (graceful
    // close lets stdout flush — preferable to process.exit() which can truncate piped output).
    // Best-effort: the verdict is already printed; a close error must not mask it.
    try {
      const { db } = await import('@/db/client');
      await db.$client.end({ timeout: 5 });
    } catch {
      // pool already closed / never opened — nothing to clean up.
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
