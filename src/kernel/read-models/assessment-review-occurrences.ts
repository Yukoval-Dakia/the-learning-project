import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { settlementReversions } from '@/core/assessment-settlement-liveness';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { filterActiveRows } from '@/kernel/events';
import { nativeAttemptOutcome, resolveVerdictsForNativeAttempts } from './assessment-verdict';

const SettlementReceipt = z.object({
  evaluation_group_id: z.string(),
  effect: z.string(),
  occurrence_at: z.string().nullish(),
  effects: z
    .object({ fsrs_applied: z.array(z.string()).default([]) })
    .default({ fsrs_applied: [] }),
  supersedes_settlement_event_id: z.string().nullish(),
  reverted_settlement_event_ids: z.array(z.string()).default([]),
  replay_of: z.string().nullish(),
  replay_inputs: z
    .object({
      kind: z.literal('plan'),
      groupId: z.string(),
      occurrenceAt: z.string(),
      rating: z.enum(['again', 'hard', 'good']).nullable(),
      ratingSource: z.enum(['user', 'verdict', 'none']),
    })
    .nullish(),
});

type ReceiptEvent = Pick<typeof event.$inferSelect, 'id' | 'payload'>;
export interface NativeReviewOccurrence {
  id: string;
  groupId: string;
  settlementId: string;
  questionIds: string[];
  occurredAt: Date;
  rating: 'again' | 'hard' | 'good';
  ratingSource: 'user' | 'verdict' | 'none';
  outcome: 'success' | 'failure' | 'partial' | 'pending' | 'unsupported';
  fsrsSubjects: string[];
}

/** Pure scheduling receipt projection; callers supply validated, visible occurrence groups. */
export function projectNativeReviewOccurrences(
  events: readonly ReceiptEvent[],
  groups: ReadonlyMap<
    string,
    { questionIds: string[]; outcome: NativeReviewOccurrence['outcome'] }
  >,
): NativeReviewOccurrence[] {
  const rows = events.flatMap((row) => {
    const parsed = SettlementReceipt.safeParse(row.payload);
    if (!parsed.success) return [];
    const p = parsed.data;
    return [
      {
        id: row.id,
        groupId: p.evaluation_group_id,
        effect: p.effect,
        inputs: p.replay_inputs,
        fsrsApplied: p.effects.fsrs_applied,
        supersedesSettlementEventId: p.supersedes_settlement_event_id ?? null,
        revertedIds: p.reverted_settlement_event_ids,
        replayOf: p.replay_of ?? null,
      },
    ];
  });
  const { dead, deadFsrs } = settlementReversions(rows);
  const withdrawn = new Set(
    rows.filter((row) => row.effect === 'withdrawn').map((row) => row.groupId),
  );
  const byGroup = new Map<string, NativeReviewOccurrence>();
  for (const row of rows) {
    const scope = groups.get(row.groupId);
    const plan = row.inputs;
    if (
      !scope ||
      withdrawn.has(row.groupId) ||
      row.effect !== 'applied' ||
      !plan ||
      plan.groupId !== row.groupId ||
      !plan.rating ||
      !row.fsrsApplied.length
    )
      continue;
    if (dead.has(row.id) && (deadFsrs.has(row.id) || plan.ratingSource !== 'user')) continue;
    const occurredAt = new Date(plan.occurrenceAt);
    if (!Number.isFinite(occurredAt.getTime())) continue;
    const occurrence: NativeReviewOccurrence = {
      id: `assessment:${row.groupId}`,
      groupId: row.groupId,
      settlementId: row.id,
      questionIds: scope.questionIds,
      occurredAt,
      rating: plan.rating,
      ratingSource: plan.ratingSource,
      outcome: scope.outcome,
      fsrsSubjects: row.fsrsApplied,
    };
    const prior = byGroup.get(row.groupId);
    // Retained explicit user scheduling takes precedence over a later automatic suggestion.
    if (!prior || (prior.ratingSource !== 'user' && occurrence.ratingSource === 'user'))
      byGroup.set(row.groupId, occurrence);
  }
  return [...byGroup.values()].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
  );
}

export async function loadNativeReviewOccurrences(db: Db | Tx) {
  const rows = await db
    .select()
    .from(event)
    .where(
      inArray(event.action, [
        'experimental:assessment_attempt',
        'experimental:assessment_settlement',
      ]),
    );
  const anchors = rows.filter((row) => row.action === 'experimental:assessment_attempt');
  const active = new Set((await filterActiveRows(db, anchors)).map((row) => row.id));
  const verdicts = await resolveVerdictsForNativeAttempts(db, anchors);
  const groups = new Map<
    string,
    { questionIds: string[]; outcome: NativeReviewOccurrence['outcome'] }
  >();
  const hidden = new Set<string>();
  for (const anchor of anchors) {
    const verdict = verdicts.get(anchor.id);
    if (!verdict) continue;
    const groupId = verdict.submission.evaluation_group_id;
    // The resolver hides abandoned/incomplete buffered paper generations. No grade/rating leak.
    if (
      !active.has(anchor.id) ||
      (anchor.payload.paper_feedback_policy === 'judge_now_show_later' && !verdict.effective)
    ) {
      hidden.add(groupId);
      continue;
    }
    const entry = groups.get(groupId) ?? {
      questionIds: [],
      outcome: nativeAttemptOutcome(verdict),
    };
    entry.questionIds.push(anchor.subject_id);
    groups.set(groupId, entry);
  }
  for (const id of hidden) groups.delete(id);
  return projectNativeReviewOccurrences(
    rows.filter((row) => row.action === 'experimental:assessment_settlement'),
    groups,
  );
}
