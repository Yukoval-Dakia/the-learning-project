// Undo and replay safety for the settlement ledger. Owns the refusal taxonomy,
// single-member reversal (theta and FSRS segments from their sealed brackets),
// the preserved-user-rating rule, and detection of newer writes that no closure
// member explains. Every refusal is a replay_required result, never a partial undo.

import { and, eq, inArray } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import {
  difficulty_calibration_evidence,
  difficulty_calibration_label,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import { resetPosteriorToPriorIfNoEvidence } from '@/server/mastery/item-calibration';
import { unfoldFamilyCalibration } from '@/server/mastery/personalized-difficulty';
import { clearCalibrationBelowThreshold } from '@/server/mastery/recalibration';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';
import {
  type AppliedSettlementEvent,
  type FsrsSubject,
  type SettlementEventRow,
  coerceMs,
  subjectKey,
} from './settle-read';

export type ReplayRequired =
  | { kind: 'family_fold_missing'; settlementEventId: string }
  | { kind: 'family_fold_drift'; settlementEventId: string }
  | { kind: 'unreplayable_member'; settlementEventId: string; reason: string }
  | { kind: 'unattributed_newer_write'; subject: string; detail: string }
  | { kind: 'revert_failed'; settlementEventId: string; refusal: string }
  | { kind: 'reapply_failed'; settlementEventId: string; reason: string };

/** Undo one live member. A failed undo is ReplayRequired, not a partial revert. */
export async function revertSettlementMember(
  tx: Tx,
  member: AppliedSettlementEvent,
  options: { skipFsrsSegment?: boolean } = {},
): Promise<ReplayRequired | null> {
  // The sealed residual is enough to un-fold. Order does not matter for this mean.
  // drift means the record says it folded while calibrated_n is 0. Something else wrote. Fail closed.
  if (member.familyObservationRecorded) {
    if (member.familyFold === null) {
      return { kind: 'family_fold_missing', settlementEventId: member.id };
    }
    const un = await unfoldFamilyCalibration(tx, { record: member.familyFold, now: new Date() });
    if (un === 'drift') {
      return { kind: 'family_fold_drift', settlementEventId: member.id };
    }
  }
  const segments: Array<'theta' | 'fsrs'> = member.fsrsOnly
    ? ['fsrs']
    : options.skipFsrsSegment
      ? ['theta']
      : ['theta', 'fsrs'];
  for (const segment of segments) {
    const checkpointId = `${member.id}:checkpoint:${segment}`;
    const result = await orchestrateCascadeRevert(tx, checkpointId, {
      reasonContext: { note: `assessment settlement replay (revert ${member.id})` },
    });
    if (!result.ok) {
      if (result.refusal === 'no_checkpoint') {
        // No bracket means this segment never moved. Continue with the other segment.
        continue;
      }
      return {
        kind: 'revert_failed',
        settlementEventId: member.id,
        refusal: `${result.refusal}: ${result.reason}`,
      };
    }
  }
  // YUK-439 (A4「更正跟随有效判分」) — 同判别子删联合标定证据（reapply 落新 settlement
  // id ⇒ 新证据行，不双计）。**对所有成员执行**，包括 fsrsOnly / retained-FSRS 的 replay
  // 成员：theta 虽 abstain，executePlan 仍按 plan.calibration 写过证据行，提前 return 会
  // 漏删。删后该题若无证据行，同事务把后验修回先验——标定批的候选只从有证据的题里选，
  // 零证据题不会再进批，不修就会把已撤销作答永久留在 effectiveB 读链里（幽灵校准）。
  const removedEvidence = await tx
    .delete(difficulty_calibration_evidence)
    .where(eq(difficulty_calibration_evidence.attempt_event_id, member.id))
    .returning({ question_id: difficulty_calibration_evidence.question_id });
  for (const questionId of new Set(removedEvidence.map((row) => row.question_id))) {
    await resetPosteriorToPriorIfNoEvidence(tx, questionId);
  }

  // Drop this member's difficulty label. Reapply mints a new event id, so the old label would double.
  // Falling under the minimum does not clear b_calib by itself. Clear it here,
  // or the undone attempt keeps feeding effectiveB.
  // 〔YUK-439：b_calib 已退出 effectiveB 读链，clear 保留为旧列的 hygiene（无害）；
  //   读链头 b_post 的修复见上面的 evidence 删除 + 后验回先验。〕
  if (member.fsrsOnly) return null;
  const removedLabels = await tx
    .delete(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.attempt_event_id, member.id))
    .returning({ question_id: difficulty_calibration_label.question_id });
  for (const { question_id: questionId } of removedLabels) {
    // Savepoint, not a bare catch: a SQL error aborts the caller's transaction and
    // every later statement would fail. Same discipline as the settle-apply hooks.
    try {
      await tx.transaction((sp) => clearCalibrationBelowThreshold(sp, questionId));
    } catch (err) {
      console.warn(
        `[assessment-settle] clearCalibrationBelowThreshold failed for ${questionId} (non-fatal):`,
        err,
      );
    }
  }
  return null;
}

/** User FSRS writes remain the scheduling authority for their own occurrence.
 * A later correction can supersede the event without undoing its FSRS segment,
 * so both live and preserved historical receipts matter. Other groups never
 * qualify; their schedules continue normally and are replayed in occurrence order. */
export function preservedUserRatingExists(
  rows: SettlementEventRow[],
  subjectKeys: readonly string[],
  groupId: string,
): boolean {
  const wanted = new Set(subjectKeys);
  return rows.some(
    (row) =>
      row.groupId === groupId &&
      row.inputs?.ratingSource === 'user' &&
      row.fsrsApplied.some((key) => wanted.has(key)),
  );
}

/**
 * A trace after this occurrence, on a subject this settlement writes, must belong
 * to a closure member. Otherwise it cannot be replayed.
 */
export async function findUnattributedNewerWrites(
  tx: Tx,
  input: {
    occurrenceMs: number;
    /** FSRS subjects this call will write. A null rating writes none, so skip the check. */
    fsrsSubjects: FsrsSubject[];
    /** Theta KCs this call will write. Abstain writes none. */
    thetaKcIds: string[];
    /** ability_global domain, only when theta was applied and hierarchical elo is on. */
    abilityIds: string[];
    reapplySet: AppliedSettlementEvent[];
    liveIds: Set<string>;
  },
): Promise<Record<string, unknown> | null> {
  const fsrsWanted = new Map<string, 'knowledge' | 'question'>();
  for (const s of input.fsrsSubjects) fsrsWanted.set(s.id, s.kind);

  const memberBySubjectAndOcc = new Map<string, AppliedSettlementEvent>();
  for (const m of input.reapplySet) {
    for (const s of m.subjects) memberBySubjectAndOcc.set(`${s}@${m.occurrenceMs}`, m);
  }

  if (fsrsWanted.size > 0) {
    const rows = await tx
      .select({
        subject_kind: material_fsrs_state.subject_kind,
        subject_id: material_fsrs_state.subject_id,
        state: material_fsrs_state.state,
        last_review_event_id: material_fsrs_state.last_review_event_id,
      })
      .from(material_fsrs_state)
      .where(
        and(
          inArray(material_fsrs_state.subject_kind, ['knowledge', 'question']),
          inArray(material_fsrs_state.subject_id, [...fsrsWanted.keys()]),
        ),
      );
    for (const row of rows) {
      if (fsrsWanted.get(row.subject_id) !== row.subject_kind) continue;
      const key = subjectKey(row.subject_kind, row.subject_id);
      const lastReview = coerceMs(
        (row.state as { last_review?: Date | string | null } | null)?.last_review ?? null,
      );
      if (lastReview === null || lastReview <= input.occurrenceMs) continue;
      const writer = row.last_review_event_id;
      if (writer !== null && input.liveIds.has(writer)) {
        const member = input.reapplySet.find((m) => m.id === writer);
        if (member && member.occurrenceMs === lastReview) continue;
      }
      return {
        kind: 'unattributed_newer_write',
        subject: key,
        detail: `material_fsrs_state.last_review ${new Date(lastReview).toISOString()} by '${writer ?? 'unknown'}'`,
      };
    }
  }

  if (input.thetaKcIds.length > 0) {
    const rows = await tx
      .select({
        subject_id: mastery_state.subject_id,
        lastOutcomeAt: mastery_state.last_outcome_at,
      })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'knowledge'),
          inArray(mastery_state.subject_id, input.thetaKcIds),
        ),
      );
    for (const row of rows) {
      const at = coerceMs(row.lastOutcomeAt);
      if (at === null || at <= input.occurrenceMs) continue;
      if (memberBySubjectAndOcc.has(`knowledge:${row.subject_id}@${at}`)) continue;
      return {
        kind: 'unattributed_newer_write',
        subject: `knowledge:${row.subject_id}`,
        detail: `mastery_state.last_outcome_at ${new Date(at).toISOString()}`,
      };
    }
  }
  if (input.abilityIds.length > 0) {
    const rows = await tx
      .select({
        subject_id: mastery_state.subject_id,
        lastOutcomeAt: mastery_state.last_outcome_at,
      })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'ability_global'),
          inArray(mastery_state.subject_id, input.abilityIds),
        ),
      );
    for (const row of rows) {
      const at = coerceMs(row.lastOutcomeAt);
      if (at === null || at <= input.occurrenceMs) continue;
      if (memberBySubjectAndOcc.has(`ability_global:${row.subject_id}@${at}`)) continue;
      return {
        kind: 'unattributed_newer_write',
        subject: `ability_global:${row.subject_id}`,
        detail: `mastery_state(ability_global).last_outcome_at ${new Date(at).toISOString()}`,
      };
    }
  }
  return null;
}
