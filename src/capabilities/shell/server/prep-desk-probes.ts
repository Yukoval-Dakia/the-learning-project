// YUK-567 slice-2 — 备课台 active-probes read model (the "待你试做" queue).
//
// Lists the served-but-unanswered mind_probe questions: `source='mind_probe'`
// questions with NO `experimental:probe_result` event. This is the LIST counterpart
// to `countActiveProbes` (probe-lifecycle.ts) — same "served-not-answered" predicate,
// surfaced for the 作答区 UI. Bounded by MAX_CONCURRENT_ACTIVE_PROBES (3) at serve
// time; the reader caps defensively at the same felt size.
//
// Anti-guilt (same contract as loadPrepDeskConjectures): NO calibration number
// crosses the wire — a probe carries only its prompt (the question the team is about
// to ask). The claim is deliberately NOT surfaced here: the owner already saw it when
// they accepted the conjecture; the 作答区 shows the neutral probe question, not a
// "we think you're wrong about X" primer.

import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  PROBE_RESULT_ACTION,
} from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

// Single-source the persisted probe contract from core without reaching into the
// agency capability's server implementation.
export const ACTIVE_PROBES_MAX = MAX_CONCURRENT_ACTIVE_PROBES;

export interface ActiveProbe {
  /** The mind_probe question id — target of POST /api/conjecture/probe/[id]/answer. */
  probe_question_id: string;
  /** The probe prompt — the question the team is about to ask. */
  prompt_md: string;
  /** The KC the probe targets (first knowledge id), or null. */
  knowledge_id: string | null;
}

export interface ActiveProbesResult {
  probes: ActiveProbe[];
}

/**
 * Load the ≤3 served-but-unanswered probes, newest first. A probe is "active" when
 * its `mind_probe` question row has no `experimental:probe_result` event yet.
 */
export async function loadActiveProbes(db: Db): Promise<ActiveProbesResult> {
  const rows = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
      ),
    )
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(ACTIVE_PROBES_MAX);

  const probes: ActiveProbe[] = rows.map((row) => ({
    probe_question_id: row.id,
    prompt_md: row.prompt_md ?? '',
    knowledge_id: row.knowledge_ids?.[0] ?? null,
  }));
  return { probes };
}
