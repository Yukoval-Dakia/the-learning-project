// YUK-567 slice-2 — 备课台 active-probes read model (the "待你试做" queue).
//
// Lists the served-but-unanswered mind_probe questions for active conjectures:
// `source='mind_probe'` questions with NO `experimental:probe_result` event and no
// effective correction on their proposal. This is the LIST counterpart to
// `countActiveProbes` (probe-lifecycle.ts), surfaced for the 作答区 UI. Bounded by
// MAX_CONCURRENT_ACTIVE_PROBES (3) at serve time; the reader caps defensively at
// the same felt size.
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
import { getCorrectionStatuses } from '@/kernel/events';
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

const ACTIVE_PROBE_SCAN_BATCH = 50;

function extractConjectureId(metadata: unknown): string | null {
  const record =
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const id = record.conjecture_proposal_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Load the ≤3 served-but-unanswered probes for active conjectures, newest first.
 */
export async function loadActiveProbes(db: Db): Promise<ActiveProbesResult> {
  const probes: ActiveProbe[] = [];
  let offset = 0;
  while (probes.length < ACTIVE_PROBES_MAX) {
    const rows = await db
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        knowledge_ids: question.knowledge_ids,
        metadata: question.metadata,
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
      .limit(ACTIVE_PROBE_SCAN_BATCH)
      .offset(offset);
    if (rows.length === 0) break;
    offset += rows.length;
    const conjectureIds = [
      ...new Set(
        rows
          .map((row) => extractConjectureId(row.metadata))
          .filter((id): id is string => id !== null),
      ),
    ];
    const correctionStatuses = await getCorrectionStatuses(db, conjectureIds);
    for (const row of rows) {
      const conjectureId = extractConjectureId(row.metadata);
      // Preserve visibility for corrupt provenance so the user can surface and
      // repair it rather than silently losing a slot.
      if (conjectureId && correctionStatuses.get(conjectureId)?.state !== 'active') continue;
      probes.push({
        probe_question_id: row.id,
        prompt_md: row.prompt_md ?? '',
        knowledge_id: row.knowledge_ids?.[0] ?? null,
      });
      if (probes.length === ACTIVE_PROBES_MAX) break;
    }
    if (rows.length < ACTIVE_PROBE_SCAN_BATCH) break;
  }
  return { probes };
}
