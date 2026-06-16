// scripts/replay-urnings-lite.ts
/**
 * YUK-361 Phase 7 (Task 12) — OFFLINE Urnings replay spike.
 *
 * This is an ANALYSIS SPIKE, not a production feature. It does NOT touch
 * mastery_state / item_calibration (read-only replay; everything computed
 * in-memory). NO schema, NO migration, NO pg-boss job, NO route.
 *
 * What it does:
 *   1. Reads historical attempts from the `event` table (action='attempt',
 *      subject_kind='question'), resolving each to its knowledge node(s) +
 *      the difficulty anchor b in effect at the time.
 *   2. Replays FOUR θ-estimation variants over the time-ordered stream per node:
 *        - elo_point     — REUSES production src/core/theta.ts (Elo/MLE point)
 *        - elo_precision — REUSES production Phase 2 (Elo + theta_precision)
 *        - glicko_rd     — SPIKE (Glicko/RD-style uncertainty)
 *        - urnings       — SPIKE (full Urnings urn prototype, player half only)
 *   3. Reports per-variant metrics: log loss, Brier, θ volatility, MFI top-k
 *      regret proxy, and the number of families meeting a density threshold.
 *   4. Emits an HONEST verdict. The verdict is DATA-GATED: on the fresh n=1
 *      post-rebuild stack there is little/no historical attempt data, so the
 *      script reports "INSUFFICIENT DATA — N attempts, K dense families" rather
 *      than fabricating a conclusion. It EXITS 0 on sparse/zero data (it ran
 *      correctly; there's just nothing to conclude yet), and the doc default
 *      stays on Elo+precision per ADR-0042.
 *
 * Data-access tension (handled, see resolveAnchor): the `item_calibration` table
 * may not exist yet in a given DB (it's introduced by an earlier YUK-361 phase's
 * migration that may not have run against this DB). The script probes for the
 * table via information_schema and falls back to question.difficulty →
 * difficultyToLogitB (the ADR-0042-documented crude-MFI prototype anchor) when it
 * is absent. b_source is reported per row so the anchor quality is explicit.
 *
 * Run:
 *   pnpm replay:urnings            # against DATABASE_URL (.env.local locally)
 *   pnpm replay:urnings --json     # machine-readable report to stdout
 *   pnpm replay:urnings --density=10   # override the dense-family threshold
 *
 * Exit codes:
 *   0 — ran successfully (INCLUDING the insufficient-data / zero-data path)
 *   2 — could not run (no DATABASE_URL / DB unreachable / `event` table missing)
 */

import './load-env'; // loads .env (DATABASE_URL) before @/db/client is constructed
import { difficultyToLogitB } from '@/core/theta';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { effectiveB } from '@/server/mastery/recalibration';
import { inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_DENSITY_THRESHOLD,
  DEFAULT_REPLAY_CONFIG,
  type FamilyDensity,
  type ReplayAttempt,
  type ReplayConfig,
  VARIANT_META,
  brierScore,
  familyDensities,
  logLoss,
  mfiTopKRegret,
  mulberry32,
  replayEloPoint,
  replayEloPrecision,
  replayGlickoRd,
  replayUrnings,
  thetaVolatility,
  toBinaryOutcome,
} from './lib/urnings-replay-estimators';

const REPLAY_SEED = 0x5eed_361; // deterministic Urnings MH draws per run

interface RawAttemptRow {
  id: string;
  question_id: string;
  outcome: 'success' | 'failure' | 'partial';
  referenced_knowledge_ids: string[];
  created_at: Date;
}

/** Probe whether a table exists in the public schema (handles the item_calibration tension). */
async function tableExists(name: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(
    sql`SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${name}
        ) AS exists`,
  );
  // drizzle/postgres-js returns an array-like of rows
  const first = (rows as unknown as Array<{ exists: boolean }>)[0];
  return Boolean(first?.exists);
}

/**
 * Read all attempt events, time-ordered ascending. Returns the scorable rows plus
 * the count of UN-JUDGED captures dropped (F1: structurally has an outcome enum but
 * is semantically "未判分" — must not be scored as right/wrong).
 */
async function readAttempts(): Promise<{ rows: RawAttemptRow[]; unjudgedSkipped: number }> {
  const rows = await db.execute<{
    id: string;
    subject_id: string;
    outcome: string;
    payload: { referenced_knowledge_ids?: string[]; unsupported_judge?: boolean };
    created_at: Date;
  }>(
    sql`SELECT id, subject_id, outcome, payload, created_at
        FROM event
        WHERE action = 'attempt' AND subject_kind = 'question'
        ORDER BY created_at ASC`,
  );
  const arr = rows as unknown as Array<{
    id: string;
    subject_id: string;
    outcome: string;
    payload: { referenced_knowledge_ids?: string[]; unsupported_judge?: boolean };
    created_at: Date;
  }>;
  let unjudgedSkipped = 0;
  const scorable: RawAttemptRow[] = [];
  for (const r of arr) {
    if (r.payload?.unsupported_judge === true) {
      unjudgedSkipped += 1;
      continue;
    }
    scorable.push({
      id: r.id,
      question_id: r.subject_id,
      outcome: r.outcome as RawAttemptRow['outcome'],
      referenced_knowledge_ids: r.payload?.referenced_knowledge_ids ?? [],
      created_at: new Date(r.created_at),
    });
  }
  return { rows: scorable, unjudgedSkipped };
}

interface AnchorResolver {
  /** b in effect for a question (logit). null = unresolvable → row skipped. */
  resolve(questionId: string): { b: number; bSource: ReplayAttempt['bSource'] } | null;
}

/**
 * Build the anchor resolver. Prefers item_calibration.effectiveB when the table
 * exists; otherwise falls back to question.difficulty → difficultyToLogitB (the
 * ADR-0042 crude-MFI prototype anchor, a WEAK proxy). Reports which path was used.
 */
async function buildAnchorResolver(
  questionIds: string[],
): Promise<{ resolver: AnchorResolver; calibrationAvailable: boolean }> {
  const ids = [...new Set(questionIds)];
  // question.difficulty is always present (fallback anchor)
  const qRows = ids.length
    ? await db
        .select({ id: question.id, difficulty: question.difficulty })
        .from(question)
        .where(inArray(question.id, ids))
    : [];
  const difficultyById = new Map(qRows.map((q) => [q.id, q.difficulty]));

  const calibrationAvailable = await tableExists('item_calibration');
  const calibById = new Map<
    string,
    { b: number | null; b_anchor: number | null; b_calib: number | null }
  >();
  if (calibrationAvailable && ids.length) {
    const cal = await db.execute<{
      question_id: string;
      b: number | null;
      b_anchor: number | null;
      b_calib: number | null;
    }>(
      sql`SELECT question_id, b, b_anchor, b_calib
          FROM item_calibration
          WHERE question_id IN ${sql`(${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `,
          )})`}`,
    );
    for (const c of cal as unknown as Array<{
      question_id: string;
      b: number | null;
      b_anchor: number | null;
      b_calib: number | null;
    }>) {
      calibById.set(c.question_id, { b: c.b, b_anchor: c.b_anchor, b_calib: c.b_calib });
    }
  }

  const resolver: AnchorResolver = {
    resolve(questionId) {
      const cal = calibById.get(questionId);
      const calB = cal ? effectiveB(cal) : null;
      if (calB != null) return { b: calB, bSource: 'item_calibration' };
      const difficulty = difficultyById.get(questionId);
      if (difficulty != null) {
        return { b: difficultyToLogitB(difficulty), bSource: 'difficulty_proxy' };
      }
      return null;
    },
  };
  return { resolver, calibrationAvailable };
}

interface VariantReport {
  variant: string;
  reusesProductionMath: boolean;
  simplification: string;
  logLoss: number;
  brier: number;
  thetaVolatility: number;
  /** MFI top-k regret vs the elo_precision reference (production uncertainty model). */
  mfiRegretVsReference: number;
}

interface ReplayReport {
  generatedAt: string;
  databaseUrlPresent: boolean;
  totalAttemptEvents: number;
  scorableAttempts: number;
  unjudgedSkipped: number;
  partialFoldedToFailure: number;
  calibrationTableAvailable: boolean;
  anchorSources: { item_calibration: number; difficulty_proxy: number; unresolved: number };
  densityThreshold: number;
  families: FamilyDensity[];
  denseFamilies: number;
  variants: VariantReport[];
  verdict: {
    sufficientData: boolean;
    headline: string;
    detail: string;
  };
}

function buildReport(
  attemptsByNode: Map<string, ReplayAttempt[]>,
  meta: {
    totalAttemptEvents: number;
    scorableAttempts: number;
    unjudgedSkipped: number;
    partialFoldedToFailure: number;
    calibrationAvailable: boolean;
    anchorSources: ReplayReport['anchorSources'];
    densityThreshold: number;
  },
  cfg: ReplayConfig,
): ReplayReport {
  const families = familyDensities(attemptsByNode, meta.densityThreshold);
  const denseFamilies = families.filter((f) => f.meetsThreshold).length;

  // Candidate b pool for the MFI regret proxy = the distinct anchors seen.
  const candidateBs = [
    ...new Set([...attemptsByNode.values()].flat().map((a) => Number(a.b.toFixed(6)))),
  ];

  // Aggregate predictions/trajectories across all nodes per variant.
  const uniform = mulberry32(REPLAY_SEED);
  const agg = {
    elo_point: {
      preds: [] as { pHat: number; outcome: 0 | 1 }[],
      vols: [] as number[],
      trajByNode: [] as number[][],
    },
    elo_precision: {
      preds: [] as { pHat: number; outcome: 0 | 1 }[],
      vols: [] as number[],
      trajByNode: [] as number[][],
    },
    glicko_rd: {
      preds: [] as { pHat: number; outcome: 0 | 1 }[],
      vols: [] as number[],
      trajByNode: [] as number[][],
    },
    urnings: {
      preds: [] as { pHat: number; outcome: 0 | 1 }[],
      vols: [] as number[],
      trajByNode: [] as number[][],
    },
  };

  for (const attempts of attemptsByNode.values()) {
    const v1 = replayEloPoint(attempts, cfg);
    const v2 = replayEloPrecision(attempts, cfg);
    const v3 = replayGlickoRd(attempts, cfg);
    const v4 = replayUrnings(attempts, uniform, cfg);
    agg.elo_point.preds.push(...v1.predictions);
    agg.elo_point.vols.push(thetaVolatility(v1.thetaTrajectory));
    agg.elo_point.trajByNode.push(v1.thetaTrajectory);
    agg.elo_precision.preds.push(...v2.predictions);
    agg.elo_precision.vols.push(thetaVolatility(v2.thetaTrajectory));
    agg.elo_precision.trajByNode.push(v2.thetaTrajectory);
    agg.glicko_rd.preds.push(...v3.predictions);
    agg.glicko_rd.vols.push(thetaVolatility(v3.thetaTrajectory));
    agg.glicko_rd.trajByNode.push(v3.thetaTrajectory);
    agg.urnings.preds.push(...v4.predictions);
    agg.urnings.vols.push(thetaVolatility(v4.thetaTrajectory));
    agg.urnings.trajByNode.push(v4.thetaTrajectory);
  }

  const mean = (xs: number[]): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

  // MFI regret per node vs the elo_precision reference, then mean across nodes.
  const regretFor = (trajByNode: number[][]): number => {
    if (!candidateBs.length) return Number.NaN;
    const perNode: number[] = [];
    trajByNode.forEach((traj, nodeIdx) => {
      const ref = agg.elo_precision.trajByNode[nodeIdx] ?? traj;
      const r = mfiTopKRegret(traj, ref, candidateBs);
      if (!Number.isNaN(r)) perNode.push(r);
    });
    return mean(perNode);
  };

  const variants: VariantReport[] = (
    ['elo_point', 'elo_precision', 'glicko_rd', 'urnings'] as const
  ).map((id) => ({
    variant: VARIANT_META[id].label,
    reusesProductionMath: VARIANT_META[id].reusesProductionMath,
    simplification: VARIANT_META[id].simplification,
    logLoss: logLoss(agg[id].preds),
    brier: brierScore(agg[id].preds),
    thetaVolatility: mean(agg[id].vols),
    mfiRegretVsReference: regretFor(agg[id].trajByNode),
  }));

  const sufficientData = denseFamilies > 0;
  // Anchor-quality gate on the verdict itself (review finding): the metric deltas are
  // only trustworthy if the b anchors are real (item_calibration), NOT the ordinal-1-5
  // difficulty_proxy fallback (difficultyToLogitB — explicitly weak/REFUTED in theta.ts).
  // A run can clear the DENSITY threshold while still being anchored entirely on proxy b,
  // which would make a full-Urnings decision rest on untrustworthy difficulty. So fold the
  // proxy fraction into the verdict block, not just the raw anchor-source counts.
  const resolvedAnchors = meta.anchorSources.item_calibration + meta.anchorSources.difficulty_proxy;
  const proxyFraction =
    resolvedAnchors > 0 ? meta.anchorSources.difficulty_proxy / resolvedAnchors : 1;
  const proxyCaveat =
    proxyFraction > 0
      ? ` ⚠ ANCHOR CAVEAT: ${(proxyFraction * 100).toFixed(0)}% of b anchors are difficulty_proxy (weak ordinal-1-5 fallback, not calibrated item_calibration.b). Until item_calibration is migrated + populated, the per-variant log-loss/Brier deltas rest on untrustworthy difficulty — do NOT anchor a full-Urnings decision on a proxy-heavy run.`
      : '';
  const verdict = sufficientData
    ? {
        sufficientData: true,
        headline: `DATA AVAILABLE — ${denseFamilies} dense family(ies) (≥${meta.densityThreshold} obs). See the decision table; apply the Task 12 step-4 criteria.${proxyCaveat}`,
        detail: `Full Urnings proceeds ONLY if it beats elo_precision on BOTH log loss AND Brier AND reduces MFI instability AND the dense-observation graph justifies the implementation complexity. Otherwise default = stay on Elo+precision per ADR-0042.${
          proxyFraction > 0
            ? ' NOTE: a proxy-heavy run is NOT a valid basis for the decision regardless of density — re-run after item_calibration anchors exist.'
            : ''
        }`,
      }
    : {
        sufficientData: false,
        headline: `INSUFFICIENT DATA — ${meta.scorableAttempts} scorable attempts / ${denseFamilies} dense families (threshold ${meta.densityThreshold}).`,
        detail:
          'No family meets the density threshold, so the variant log-loss / Brier deltas are noise, not signal. NO verdict is drawn. Default = stay on Elo+precision per ADR-0042 (urnings-lite amendment). Re-run this spike when objective attempt data accumulates.',
      };

  return {
    generatedAt: new Date().toISOString(),
    databaseUrlPresent: Boolean(process.env.DATABASE_URL),
    totalAttemptEvents: meta.totalAttemptEvents,
    scorableAttempts: meta.scorableAttempts,
    unjudgedSkipped: meta.unjudgedSkipped,
    partialFoldedToFailure: meta.partialFoldedToFailure,
    calibrationTableAvailable: meta.calibrationAvailable,
    anchorSources: meta.anchorSources,
    densityThreshold: meta.densityThreshold,
    families,
    denseFamilies,
    variants,
    verdict,
  };
}

function printHuman(report: ReplayReport): void {
  const fmt = (x: number): string => (Number.isNaN(x) ? 'n/a' : x.toFixed(4));
  console.log('\n═══ Offline Urnings replay spike (YUK-361 Phase 7, Task 12) ═══\n');
  console.log(`generated:                 ${report.generatedAt}`);
  console.log(`total attempt events:      ${report.totalAttemptEvents}`);
  console.log(`scorable attempts:         ${report.scorableAttempts}`);
  console.log(`  un-judged skipped:       ${report.unjudgedSkipped}`);
  console.log(`  partial→failure folded:  ${report.partialFoldedToFailure}`);
  console.log(
    `item_calibration table:    ${report.calibrationTableAvailable ? 'present' : 'ABSENT → difficulty_proxy fallback'}`,
  );
  console.log(
    `anchor sources:            item_calibration=${report.anchorSources.item_calibration}  difficulty_proxy=${report.anchorSources.difficulty_proxy}  unresolved=${report.anchorSources.unresolved}`,
  );
  console.log(`density threshold:         ≥${report.densityThreshold} objective observations`);
  console.log(`dense families:            ${report.denseFamilies} / ${report.families.length}\n`);

  console.log('per-family observation density:');
  if (report.families.length === 0) {
    console.log('  (no families — zero scorable attempts)');
  } else {
    for (const f of report.families) {
      console.log(
        `  ${f.meetsThreshold ? '✓' : '·'} ${f.knowledgeId.padEnd(36)} ${f.observations} obs`,
      );
    }
  }

  console.log('\nvariant × metric (lower is better for all four):');
  const labelWidth = Math.max(46, ...report.variants.map((v) => v.variant.length));
  console.log(
    `  ${'variant'.padEnd(labelWidth)} ${'logLoss'.padStart(9)} ${'Brier'.padStart(9)} ${'θ-volat'.padStart(9)} ${'MFIreg'.padStart(9)}  reuse`,
  );
  for (const v of report.variants) {
    console.log(
      `  ${v.variant.padEnd(labelWidth)} ${fmt(v.logLoss).padStart(9)} ${fmt(v.brier).padStart(9)} ${fmt(v.thetaVolatility).padStart(9)} ${fmt(v.mfiRegretVsReference).padStart(9)}  ${v.reusesProductionMath ? 'prod' : 'SPIKE'}`,
    );
  }

  console.log('\n─── VERDICT ───');
  console.log(report.verdict.headline);
  console.log(report.verdict.detail);
  console.log('');
}

async function main(): Promise<void> {
  const isJson = process.argv.includes('--json');
  const densityArg = process.argv.find((a) => a.startsWith('--density='));
  const densityThreshold = densityArg
    ? Number(densityArg.split('=')[1]) || DEFAULT_DENSITY_THRESHOLD
    : DEFAULT_DENSITY_THRESHOLD;
  const cfg = DEFAULT_REPLAY_CONFIG;

  if (!process.env.DATABASE_URL) {
    console.error(
      'FAIL: DATABASE_URL not set. Configure .env.local (local) or compose .env (NAS).',
    );
    process.exit(2);
  }

  // The `event` table is the hard requirement; everything else degrades gracefully.
  if (!(await tableExists('event'))) {
    console.error('FAIL: `event` table not found in this database — cannot read attempts.');
    process.exit(2);
  }

  const { rows: raw, unjudgedSkipped } = await readAttempts();
  const totalAttemptEvents = raw.length + unjudgedSkipped;

  // Resolve anchors + expand each attempt to its knowledge node(s).
  const questionIds = raw.map((r) => r.question_id);
  const { resolver, calibrationAvailable } = await buildAnchorResolver(questionIds);

  const attemptsByNode = new Map<string, ReplayAttempt[]>();
  const anchorSources = { item_calibration: 0, difficulty_proxy: 0, unresolved: 0 };
  let partialFoldedToFailure = 0;
  let scorableAttempts = 0;

  for (const r of raw) {
    const anchor = resolver.resolve(r.question_id);
    if (!anchor) {
      anchorSources.unresolved += 1;
      continue;
    }
    if (r.outcome === 'partial') partialFoldedToFailure += 1;
    const outcome = toBinaryOutcome(r.outcome);
    const nodes = r.referenced_knowledge_ids.length
      ? r.referenced_knowledge_ids
      : [`q:${r.question_id}`];
    // multi-KC attempt: replay it once per node (offline, in-memory; the online
    // path uses conjunctive credit, but the offline per-node trajectory is the
    // comparison unit here — documented simplification).
    for (const knowledgeId of nodes) {
      const list = attemptsByNode.get(knowledgeId) ?? [];
      list.push({
        questionId: r.question_id,
        knowledgeId,
        outcome,
        timestamp: r.created_at.getTime(),
        b: anchor.b,
        bSource: anchor.bSource,
      });
      attemptsByNode.set(knowledgeId, list);
    }
    anchorSources[anchor.bSource] += 1;
    scorableAttempts += 1;
  }

  // ensure per-node streams are time-ordered (they are, since raw is ordered, but
  // multi-KC interleaving across nodes keeps each node's relative order)
  for (const list of attemptsByNode.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  const report = buildReport(
    attemptsByNode,
    {
      totalAttemptEvents,
      scorableAttempts,
      unjudgedSkipped,
      partialFoldedToFailure,
      calibrationAvailable,
      anchorSources,
      densityThreshold,
    },
    cfg,
  );

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  // Honest exit: running successfully — INCLUDING the insufficient-data path —
  // is exit 0. Only a genuine inability to run (handled above) is non-zero.
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: replay crashed unexpectedly.');
  console.error(err);
  process.exit(2);
});
