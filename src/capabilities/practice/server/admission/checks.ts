// YUK-1468 — the admit/withhold decision shared by submit and the admission job.
// Submit has no verdict yet, so a new question stays withheld. The job passes the
// dual-solve verdict; a full pass on live knowledge is the only admitted result.

import { and, inArray, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';

export interface QuestionAdmissionUnitSummary {
  unit_id: string;
  judgeable_today: boolean;
  withheld_reason?: string;
}

export interface QuestionAdmissionVerdict {
  status: 'admitted' | 'withheld' | 'pending';
  per_unit: {
    scoring_unit_id: string;
    status: 'admitted' | 'withheld' | 'pending';
    reason?: string;
  }[];
}

export interface QuestionAdmissionCheckResult {
  admission:
    | { state: 'withheld'; reason: 'unverified_rules' }
    | { state: 'admitted'; evidence: null };
  per_unit: {
    unit_id: string;
    status: 'admitted' | 'withheld' | 'pending';
    reason?: string;
  }[];
  group_blockers: { code: string; detail: string }[];
}

function withheldUnits(
  unitSummary: QuestionAdmissionUnitSummary[],
): QuestionAdmissionCheckResult['per_unit'] {
  return unitSummary.map((unit) => ({
    unit_id: unit.unit_id,
    status: unit.judgeable_today ? 'pending' : 'withheld',
    ...(unit.judgeable_today
      ? { reason: 'verification_pending' }
      : { reason: unit.withheld_reason ?? 'unjudgeable' }),
  }));
}

/**
 * Dead knowledge blocks the group. Without a verdict the question stays withheld
 * even when every unit is judgeable. A verdict admits only when it and every
 * unit are admitted and no knowledge id is missing or archived.
 */
export async function runQuestionAdmissionChecks(
  db: Db | Tx,
  input: {
    knowledgeIds: string[];
    unitSummary: QuestionAdmissionUnitSummary[];
    verdict?: QuestionAdmissionVerdict | null;
  },
): Promise<QuestionAdmissionCheckResult> {
  const groupBlockers: QuestionAdmissionCheckResult['group_blockers'] = [];
  if (input.knowledgeIds.length > 0) {
    const liveRows = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, input.knowledgeIds), isNull(knowledge.archived_at)));
    const live = new Set(liveRows.map((row) => row.id));
    const dead = input.knowledgeIds.filter((id) => !live.has(id));
    if (dead.length > 0) {
      groupBlockers.push({
        code: 'dead_knowledge_node',
        detail: `knowledge ids 不存在或已归档: ${dead.join(', ')}`,
      });
    }
  }
  if (groupBlockers.length > 0 || input.verdict == null) {
    return {
      admission: { state: 'withheld', reason: 'unverified_rules' },
      per_unit: withheldUnits(input.unitSummary),
      group_blockers: groupBlockers,
    };
  }
  const passed =
    input.verdict.status === 'admitted' &&
    input.verdict.per_unit.length > 0 &&
    input.verdict.per_unit.every((unit) => unit.status === 'admitted');
  if (!passed) {
    const byId = new Map(input.verdict.per_unit.map((unit) => [unit.scoring_unit_id, unit]));
    return {
      admission: { state: 'withheld', reason: 'unverified_rules' },
      per_unit: input.unitSummary.map((unit) => {
        const verdict = byId.get(unit.unit_id);
        if (verdict == null) {
          return {
            unit_id: unit.unit_id,
            status: 'withheld' as const,
            reason: unit.withheld_reason ?? 'unjudgeable',
          };
        }
        return {
          unit_id: unit.unit_id,
          status: verdict.status,
          ...(verdict.reason != null ? { reason: verdict.reason } : {}),
        };
      }),
      group_blockers: [],
    };
  }
  return {
    admission: { state: 'admitted', evidence: null },
    per_unit: input.verdict.per_unit.map((unit) => ({
      unit_id: unit.scoring_unit_id,
      status: 'admitted' as const,
    })),
    group_blockers: [],
  };
}
