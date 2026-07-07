// YUK-573 — judge-calibration agreement stats read model. READ-ONLY (pure
// drizzle reads, zero writes, zero flags — calibration-maturity /
// conjecture-scores precedent). Aggregates the report-only observation events
// written by the practice `judge_calibration_sample` job:
//   - experimental:judge_calibration_sample      (one per re-judged pair)
//   - experimental:judge_calibration_run_summary (one per run — health signal)
//
// Honesty rails baked into the response shape:
//   - MIN_N gate (S4): a stratum below MIN_N returns { status:
//     'insufficient_data', n } — never a bare ratio on tiny n.
//   - same_lane exclusion (MF5): samples whose inferred original lane equals
//     the re-judge lane (Opus-vs-Opus self-consistency, not a contrast) are
//     EXCLUDED from the headline + strata and only counted separately.
//   - notes[] carries agreement≠accuracy + the same_lane inference-staleness
//     caveat (复核吸收 2: the inference reads SAMPLE-TIME env; a lane flip
//     inside the window skews it — per-row snapshots allow recomputation).
//
// Re-judge run dilution (S1): re-judge runs share task_kind with production
// judge runs in ai_task_runs / cost_ledger. Their id set is identifiable via
// each sample's rejudge_task_run_id (surfaced in recent_samples); existing
// admin runs/cost surfaces do NOT yet exclude them (out of scope — design doc
// §8 follow-up).

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

export const JUDGE_CALIBRATION_MIN_N = 5;
const RECENT_SAMPLES_LIMIT = 20;
const RECENT_RUNS_LIMIT = 10;

const SAMPLE_ACTION = 'experimental:judge_calibration_sample';
const RUN_SUMMARY_ACTION = 'experimental:judge_calibration_run_summary';

/** Fail-closed payload reader: malformed rows are dropped from aggregates. */
const SamplePayload = z
  .object({
    original_outcome: z.string(),
    rejudge_outcome: z.string(),
    agreed: z.boolean(),
    bit_agreed: z.boolean(),
    rejudge_route: z.string(),
    rejudge_provider: z.string(),
    rejudge_task_run_id: z.string().nullable(),
    same_lane_suspected: z.boolean(),
    sampled_at: z.string(),
  })
  .passthrough();

const RunSummaryPayload = z
  .object({
    sampled: z.number(),
    agreed: z.number(),
    disagreed: z.number(),
    skipped: z.number(),
    skipped_unsupported: z.number(),
    errors: z.number(),
    batch_max: z.number(),
  })
  .passthrough();

export type JudgeCalibrationStratum =
  | {
      status: 'ok';
      n: number;
      agreed: number;
      bit_agreed: number;
      agreement_rate: number;
      bit_agreement_rate: number;
    }
  | { status: 'insufficient_data'; n: number };

export interface JudgeCalibrationRecentSample {
  sampled_at: string;
  original_outcome: string;
  rejudge_outcome: string;
  agreed: boolean;
  bit_agreed: boolean;
  rejudge_route: string;
  rejudge_provider: string;
  rejudge_task_run_id: string | null;
  same_lane_suspected: boolean;
}

export interface JudgeCalibrationRecentRun {
  at: string;
  sampled: number;
  agreed: number;
  disagreed: number;
  skipped: number;
  skipped_unsupported: number;
  errors: number;
  batch_max: number;
}

export interface JudgeCalibrationStats {
  total_samples: number;
  same_lane_suspected_count: number;
  headline: JudgeCalibrationStratum;
  by_route: Record<string, JudgeCalibrationStratum>;
  by_original_outcome: Record<string, JudgeCalibrationStratum>;
  recent_samples: JudgeCalibrationRecentSample[];
  recent_runs: JudgeCalibrationRecentRun[];
  notes: string[];
}

type ParsedSample = z.infer<typeof SamplePayload>;

function stratum(rows: ParsedSample[]): JudgeCalibrationStratum {
  const n = rows.length;
  if (n < JUDGE_CALIBRATION_MIN_N) return { status: 'insufficient_data', n };
  const agreed = rows.filter((r) => r.agreed).length;
  const bitAgreed = rows.filter((r) => r.bit_agreed).length;
  return {
    status: 'ok',
    n,
    agreed,
    bit_agreed: bitAgreed,
    agreement_rate: agreed / n,
    bit_agreement_rate: bitAgreed / n,
  };
}

function groupBy(rows: ParsedSample[], key: (r: ParsedSample) => string) {
  const groups = new Map<string, ParsedSample[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = groups.get(k) ?? [];
    bucket.push(r);
    groups.set(k, bucket);
  }
  return Object.fromEntries([...groups.entries()].map(([k, v]) => [k, stratum(v)]));
}

export async function loadJudgeCalibrationStats(db: Db): Promise<JudgeCalibrationStats> {
  const sampleRows = await db
    .select({
      payload: event.payload,
      caused_by_event_id: event.caused_by_event_id,
      created_at: event.created_at,
    })
    .from(event)
    .where(eq(event.action, SAMPLE_ACTION))
    .orderBy(desc(event.created_at));

  // Defensive DISTINCT by caused_by (MF8 边带): the partial unique index makes
  // duplicates structurally impossible; this is a read-side backstop only.
  const byJudge = new Map<string, ParsedSample>();
  for (const row of sampleRows) {
    const key = row.caused_by_event_id ?? '';
    if (byJudge.has(key)) continue;
    const parsed = SamplePayload.safeParse(row.payload);
    if (!parsed.success) continue; // fail-closed: malformed rows never enter aggregates
    byJudge.set(key, parsed.data);
  }
  const all = [...byJudge.values()];
  const sameLane = all.filter((r) => r.same_lane_suspected);
  const contrastive = all.filter((r) => !r.same_lane_suspected);

  const runRows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(eq(event.action, RUN_SUMMARY_ACTION))
    .orderBy(desc(event.created_at))
    .limit(RECENT_RUNS_LIMIT);
  const recentRuns: JudgeCalibrationRecentRun[] = [];
  for (const row of runRows) {
    const parsed = RunSummaryPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    recentRuns.push({
      at: row.created_at.toISOString(),
      sampled: parsed.data.sampled,
      agreed: parsed.data.agreed,
      disagreed: parsed.data.disagreed,
      skipped: parsed.data.skipped,
      skipped_unsupported: parsed.data.skipped_unsupported,
      errors: parsed.data.errors,
      batch_max: parsed.data.batch_max,
    });
  }

  return {
    total_samples: all.length,
    same_lane_suspected_count: sameLane.length,
    headline: stratum(contrastive),
    by_route: groupBy(contrastive, (r) => r.rejudge_route),
    by_original_outcome: groupBy(contrastive, (r) => r.original_outcome),
    recent_samples: all.slice(0, RECENT_SAMPLES_LIMIT).map((r) => ({
      sampled_at: r.sampled_at,
      original_outcome: r.original_outcome,
      rejudge_outcome: r.rejudge_outcome,
      agreed: r.agreed,
      bit_agreed: r.bit_agreed,
      rejudge_route: r.rejudge_route,
      rejudge_provider: r.rejudge_provider,
      rejudge_task_run_id: r.rejudge_task_run_id,
      same_lane_suspected: r.same_lane_suspected,
    })),
    recent_runs: recentRuns,
    notes: [
      'agreement ≠ accuracy：第二 judge 不是 ground truth，本面只测两 lane 判定一致性（S4）。',
      'same_lane_suspected 推断基于采样时点 env 快照 —— owner 在选样窗内翻过 lane 时推断失准；逐样本行携 rejudge_provider 与双 env 快照，可事后重算（复核吸收 2；根治=原判 event 记 provider，§8 follow-up）。',
    ],
  };
}
