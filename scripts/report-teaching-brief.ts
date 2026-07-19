// YUK-710 (P0F/6) — the two-week teaching-brief survival report CLI + DB loader.
//
// Reads the append-only interaction ledger (experimental:brief_seen /
// experimental:primary_action_started) plus the EXISTING canonical events (rate decisions,
// mind_probe questions, experimental:probe_result) and prints the raw survival facts for an
// owner's two-week go/no-go read. It is READ-ONLY (every statement is a SELECT), a standalone
// operational script NOT wired into any request path, and adds no new pnpm test gate.
//
// The pure computation + formatting live in scripts/lib/teaching-brief-report.ts (unit-tested);
// this file only shapes the window-filtered DB facts and prints. The window is an inclusive
// Asia/Shanghai calendar-day range (learnerDayWindowUtc), the project-wide learner day boundary.
//
// CLI:
//   pnpm report:teaching-brief --from 2026-07-06 --to 2026-07-19   # text report
//   pnpm report:teaching-brief --from 2026-07-06 --to 2026-07-19 --json

// Load `.env` BEFORE importing `@/db/client`. Must be first (see rebuild-projection.ts).
import './load-env';

import { fileURLToPath } from 'node:url';
import type {
  BriefSeenPayload,
  PrimaryActionStartedPayload,
} from '@/capabilities/shell/server/teaching-brief-interactions';
import { isLearnerLocalDay, learnerDayWindowUtc } from '@/core/learner-day';
import {
  BRIEF_SEEN_ACTION,
  PRIMARY_ACTION_STARTED_ACTION,
  PROBE_QUESTION_SOURCE,
  PROBE_RESULT_ACTION,
  type PrimaryActionKind,
} from '@/core/schema/conjecture';
import { type Db, db } from '@/db/client';
import { event, question } from '@/db/schema';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  type BriefSeenFact,
  type DecisionFact,
  type PrimaryActionFact,
  type ProbeResultFact,
  type ProbeServedFact,
  type TeachingBriefReportInput,
  computeTeachingBriefReport,
  formatTeachingBriefReport,
} from './lib/teaching-brief-report';

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Load every window-filtered fact the report needs. Interaction rows are filtered by their
 * stored `payload.local_day` (already Asia/Shanghai, `YYYY-MM-DD` lexical = chronological);
 * every other event/question is filtered by `created_at` inside the UTC instant range that the
 * inclusive Shanghai-day window maps to — one consistent JS-computed instant pair, no JS/SQL
 * timezone mixing.
 */
export async function loadTeachingBriefReportInput(
  database: Db,
  from: string,
  to: string,
): Promise<TeachingBriefReportInput> {
  const window = learnerDayWindowUtc(from, to);

  // brief_seen — filtered by the learner-local day stored on the row.
  const seenRows = await database
    .select({ brief_id: event.subject_id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, BRIEF_SEEN_ACTION),
        sql`${event.payload}->>'local_day' >= ${from}`,
        sql`${event.payload}->>'local_day' <= ${to}`,
      ),
    );
  // Validate at the boundary against the shared payload type: our writer always sets a valid
  // local_day + seen_at, so a row missing them is a foreign / corrupt event — drop it rather than
  // coerce to '' (which would phantom-count an empty day). No throw: one bad row never crashes the
  // report.
  const briefSeen: BriefSeenFact[] = [];
  for (const row of seenRows) {
    const p = row.payload as unknown as Partial<BriefSeenPayload>;
    if (typeof p.local_day !== 'string' || !isLearnerLocalDay(p.local_day)) continue;
    if (typeof p.seen_at !== 'string') continue;
    briefSeen.push({ brief_id: row.brief_id, local_day: p.local_day, seen_at: p.seen_at });
  }

  // primary_action_started — same local-day filter.
  const actionRows = await database
    .select({ brief_id: event.subject_id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PRIMARY_ACTION_STARTED_ACTION),
        sql`${event.payload}->>'local_day' >= ${from}`,
        sql`${event.payload}->>'local_day' <= ${to}`,
      ),
    );
  const primaryActions: PrimaryActionFact[] = [];
  for (const row of actionRows) {
    const p = row.payload as unknown as Partial<PrimaryActionStartedPayload>;
    // Drop rows missing a valid day / timestamp / kind (foreign or corrupt). action_kind is passed
    // through unchecked-against-the-enum on purpose: the pure fn validates it against
    // PRIMARY_ACTION_KINDS and counts any unrecognized value as missing data (never a NaN phantom).
    if (typeof p.local_day !== 'string' || !isLearnerLocalDay(p.local_day)) continue;
    if (typeof p.started_at !== 'string' || typeof p.action_kind !== 'string') continue;
    primaryActions.push({
      brief_id: row.brief_id,
      action_kind: p.action_kind as PrimaryActionKind,
      local_day: p.local_day,
      started_at: p.started_at,
      ...(typeof p.result_event_id === 'string' && p.result_event_id.length > 0
        ? { result_event_id: p.result_event_id }
        : {}),
    });
  }

  // Conjecture proposal decisions — the canonical `rate` event, joined back to the proposal so
  // only conjecture decisions are counted. accept/edit split on the accept path's calibration
  // anchor; dismiss carries no anchor, so the EXISTS join is what proves it is a conjecture.
  const decisionRows = await database
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'event'),
        gte(event.created_at, window.from),
        lt(event.created_at, window.to),
        sql`EXISTS (
          SELECT 1 FROM ${event} AS proposal
          WHERE proposal.id = ${event.subject_id}
            AND proposal.action = 'experimental:proposal'
            AND proposal.subject_kind = 'mind_model'
            AND proposal.payload->'ai_proposal'->>'kind' = 'conjecture'
        )`,
      ),
    );
  const decisions: DecisionFact[] = [];
  for (const row of decisionRows) {
    const p = toRecord(row.payload);
    if (p.rating === 'accept') {
      decisions.push({ kind: p.calibration_anchor === 'edit' ? 'edit' : 'accept' });
    } else if (p.rating === 'dismiss') {
      decisions.push({ kind: 'dismiss' });
    }
  }

  // Probes served — mind_probe questions created in-window. `has_result` is then a set
  // membership over the probe_result subjects (two plain queries beat a correlated EXISTS in
  // the SELECT, whose in-`sql` outer-column correlation is fragile to render). The answered
  // query is bounded by the SAME created_at window as the served query and the outcome query
  // below: an in-window probe answered OUTSIDE the window is NOT completion here, so the
  // completion rate can never inflate past the confirmed/retired counts that share the window
  // (a within-window served → answered funnel, not "answered ever").
  const servedRows = await database
    .select({ probe_question_id: question.id })
    .from(question)
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        gte(question.created_at, window.from),
        lt(question.created_at, window.to),
      ),
    );
  const servedIds = servedRows.map((row) => row.probe_question_id);
  const answeredRows =
    servedIds.length === 0
      ? []
      : await database
          .select({ subject_id: event.subject_id })
          .from(event)
          .where(
            and(
              eq(event.action, PROBE_RESULT_ACTION),
              eq(event.subject_kind, 'question'),
              inArray(event.subject_id, servedIds),
              gte(event.created_at, window.from),
              lt(event.created_at, window.to),
            ),
          );
  const answeredIds = new Set(answeredRows.map((row) => row.subject_id));
  const probesServed: ProbeServedFact[] = servedRows.map((row) => ({
    probe_question_id: row.probe_question_id,
    has_result: answeredIds.has(row.probe_question_id),
  }));

  // Probe outcomes — canonical probe_result events in-window; only legal resolution/outcome pairs.
  const resultRows = await database
    .select({ result_event_id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.subject_kind, 'question'),
        gte(event.created_at, window.from),
        lt(event.created_at, window.to),
        sql`((${event.payload}->>'resolution' = 'confirmed' AND ${event.payload}->>'outcome' = '0')
          OR (${event.payload}->>'resolution' = 'retired' AND ${event.payload}->>'outcome' = '1'))`,
      ),
    );
  const probeResults: ProbeResultFact[] = resultRows.map((row) => ({
    result_event_id: row.result_event_id,
    resolution: toRecord(row.payload).resolution === 'confirmed' ? 'confirmed' : 'retired',
  }));

  return { from, to, briefSeen, primaryActions, decisions, probesServed, probeResults };
}

function parseArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const from = parseArg('from');
  const to = parseArg('to');
  const asJson = process.argv.includes('--json');
  if (!from || !to) {
    console.error('usage: pnpm report:teaching-brief --from YYYY-MM-DD --to YYYY-MM-DD [--json]');
    process.exitCode = 2;
    return;
  }

  const input = await loadTeachingBriefReportInput(db, from, to);
  const report = computeTeachingBriefReport(input);
  console.log(asJson ? JSON.stringify(report, null, 2) : formatTeachingBriefReport(report));
}

// CLI-gate: only run as the CLI entry point so the DB test can import loadTeachingBriefReportInput
// without the top-level run firing. NEVER process.exit() — that can terminate before a piped stdout
// (`--json | tee`) is flushed, truncating the report. Instead set process.exitCode and close the
// pg pool so the event loop drains and Node exits naturally AFTER stdout has flushed.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .catch((err) => {
      console.error('[report-teaching-brief] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void db.$client.end();
    });
}
