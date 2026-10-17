// YUK-1514 — question serving hold read projection.
//
// Contract (yuk1514-serving-holds-ui-contract.md): every question-bank row
// reports a `serving` object — whether the group can be served right now, why
// not (`hold_reason`), since when (`held_since`), the one command the owner
// may run (`next_action`), and any still-running command (`pending_action`).
//
// Derivation reuses existing truth only — question_group_lifecycle (admission
// state + withheld reason / suspension / withdrawal), question.draft_status,
// question_admission_verification (which check failed), the frozen current
// revision through the issuance gate's own decideAutomaticServing
// (no_input_renderer / invalid_presentation), the serving-action command
// event log, and in-flight pg-boss jobs. No parallel state store.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  type AutomaticServingDecision,
  PublishedQuestionRevision,
  type ServingUnavailableReason,
  decideAutomaticServing,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  event,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { revisionRowToContract } from '@/kernel/records/assessment-issuance';

export const SERVING_HOLD_REASONS = [
  'awaiting_admission',
  'admission_failed',
  'source_check_failed',
  'verify_hold',
  'retraction_hold',
  'no_input_renderer',
  'invalid_presentation',
  'withdrawn',
] as const;
export type ServingHoldReason = (typeof SERVING_HOLD_REASONS)[number];

export const SERVING_ACTION_COMMANDS = [
  'reverify',
  'recheck_source',
  'release_verify_hold',
] as const;
export type ServingActionCommand = (typeof SERVING_ACTION_COMMANDS)[number];

/** Command ledger action. Generic experimental:* — payload is a loose record. */
export const SERVING_ACTION_EVENT_ACTION = 'experimental:question_serving_action' as const;

/** Question-family queue that re-runs scoring admission (YUK-1445 C1 / YUK-1507). */
export const SERVING_ADMISSION_JOB = 'question_admission_run' as const;
export const SERVING_SOURCE_VERIFY_JOB = 'source_verify' as const;

/** UI contract: awaiting_admission offers no action for the first N hours. */
export const AWAITING_ADMISSION_REVERIFY_AFTER_MS = 6 * 60 * 60 * 1000;

export interface QuestionServingActionRef {
  command: ServingActionCommand;
  method: 'POST';
  path: string;
}

export interface QuestionServing {
  servable: boolean;
  hold_reason: ServingHoldReason | null;
  /** ISO-8601; null while servable. */
  held_since: string | null;
  next_action: QuestionServingActionRef | null;
  pending_action: { command: ServingActionCommand; since: string } | null;
}

export interface ServingCounts {
  not_servable_total: number;
  by_reason: Partial<Record<ServingHoldReason, number>>;
}

const NOT_SERVABLE: QuestionServing = {
  servable: false,
  hold_reason: null,
  held_since: null,
  next_action: null,
  pending_action: null,
};

/** "not servable, reason unknown" — list-item placeholder pre-attach and the
 * UI contract's generic fallback for unclassifiable holds. */
export const UNKNOWN_SERVING: QuestionServing = { ...NOT_SERVABLE };

type RevisionRow = typeof question_revision.$inferSelect;

const SERVING_ACTION_PAYLOAD = {
  parse(payload: unknown): { command: ServingActionCommand; accepted: boolean } | null {
    if (payload == null || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    const command = record.command;
    if (
      command !== 'reverify' &&
      command !== 'recheck_source' &&
      command !== 'release_verify_hold'
    ) {
      return null;
    }
    return { command, accepted: record.accepted !== false };
  },
};

function servingActionPath(groupId: string, command: ServingActionCommand): string {
  return `/api/questions/${groupId}/serving-actions/${command}`;
}

/** Serving-unavailable reasons the UI enum can name; everything else stays null. */
function holdReasonForServingDecision(reason: ServingUnavailableReason): ServingHoldReason | null {
  if (reason === 'no_input_renderer' || reason === 'invalid_presentation') return reason;
  return null;
}

type ServingJobRow = Record<string, unknown> & {
  name: string;
  data: unknown;
};

/**
 * Batch serving derivation for group-root question ids. A part id resolves to
 * its parent group (parent_question_id ?? id). Returns one entry per INPUT id.
 * Batched — four relation reads + one pgboss probe for any page size.
 */
export async function readQuestionServing(
  db: Db | Tx,
  questionIds: readonly string[],
  options: { now?: Date } = {},
): Promise<Map<string, QuestionServing>> {
  const now = options.now ?? new Date();
  const result = new Map<string, QuestionServing>();
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return result;

  const rows = await db
    .select({
      id: question.id,
      parentId: question.parent_question_id,
      draftStatus: question.draft_status,
      createdAt: question.created_at,
    })
    .from(question)
    .where(inArray(question.id, ids));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const groupOf = (id: string) => rowById.get(id)?.parentId ?? id;
  const groupIds = [...new Set(ids.map(groupOf))];

  const lifecycles = groupIds.length
    ? await db
        .select()
        .from(question_group_lifecycle)
        .where(inArray(question_group_lifecycle.group_id, groupIds))
    : [];
  const lifecycleByGroup = new Map(lifecycles.map((row) => [row.group_id, row]));

  const revisionIds = lifecycles
    .map((row) => row.current_revision_id)
    .filter((id): id is string => id != null);
  const revisions = revisionIds.length
    ? await db
        .select()
        .from(question_revision)
        .where(inArray(question_revision.revision_id, revisionIds))
    : [];
  const revisionById = new Map(revisions.map((row) => [row.revision_id, row]));

  // Latest verification row per group (any revision) — names WHICH check last
  // produced a verdict, distinguishing a failed source check from a failed
  // scoring admission behind the same 'verification_failed' withheld reason.
  const verifyRows = groupIds.length
    ? await db
        .select({
          groupId: question_revision.group_id,
          policyId: question_admission_verification.policy_id,
          outcome: question_admission_verification.outcome,
          recordedAt: question_admission_verification.recorded_at,
        })
        .from(question_admission_verification)
        .innerJoin(
          question_revision,
          eq(question_admission_verification.revision_id, question_revision.revision_id),
        )
        .where(inArray(question_revision.group_id, groupIds))
        .orderBy(desc(question_admission_verification.recorded_at))
    : [];
  const latestVerifyByGroup = new Map<
    string,
    { policyId: string; outcome: string; recordedAt: Date }
  >();
  for (const row of verifyRows) {
    if (!latestVerifyByGroup.has(row.groupId)) latestVerifyByGroup.set(row.groupId, row);
  }

  // Serving command events per group, newest first — pending_action's event
  // half. Kept as a list per group (not just the latest): a later REJECTED or
  // finished command must not mask an earlier async command whose job is
  // still in flight.
  const commandRows = groupIds.length
    ? await db
        .select({
          subjectId: event.subject_id,
          payload: event.payload,
          createdAt: event.created_at,
        })
        .from(event)
        .where(
          and(eq(event.action, SERVING_ACTION_EVENT_ACTION), inArray(event.subject_id, groupIds)),
        )
        .orderBy(desc(event.created_at))
    : [];
  const commandsByGroup = new Map<
    string,
    { command: ServingActionCommand; accepted: boolean; createdAt: Date }[]
  >();
  for (const row of commandRows) {
    const parsed = SERVING_ACTION_PAYLOAD.parse(row.payload);
    if (parsed == null) continue;
    const bucket = commandsByGroup.get(row.subjectId);
    const entry = { ...parsed, createdAt: row.createdAt };
    if (bucket) bucket.push(entry);
    else commandsByGroup.set(row.subjectId, [entry]);
  }

  // In-flight queue half of pending_action: an async command stays "submitted"
  // while its job is still created/retry/active. pgboss.job is pg-boss owned —
  // a raw probe like admission/receipt.ts's, not a new dependency. to_regclass
  // keeps the projection honest on databases the worker schema never reached.
  const inflightAdmission = new Set<string>();
  const inflightSourceVerify = new Set<string>();
  const pgbossProbe =
    groupIds.length > 0
      ? await db.execute<{ reg: string | null }>(sql`select to_regclass('pgboss.job') as reg`)
      : [];
  if (pgbossProbe[0]?.reg != null) {
    const groupParamList = sql.join(
      groupIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const jobRows = await db.execute<ServingJobRow>(sql`
      select name, data from pgboss.job
      where state in ('created','retry','active')
        and (
          (name = ${SERVING_ADMISSION_JOB} and data->>'question_id' in (${groupParamList}))
          or (name = ${SERVING_SOURCE_VERIFY_JOB} and data->'question_ids' ?| array[${groupParamList}])
        )
    `);
    for (const job of jobRows) {
      const data = (job.data ?? {}) as { question_id?: string; question_ids?: string[] };
      if (job.name === SERVING_ADMISSION_JOB && data.question_id != null) {
        inflightAdmission.add(data.question_id);
      } else if (job.name === SERVING_SOURCE_VERIFY_JOB) {
        for (const qid of data.question_ids ?? []) inflightSourceVerify.add(qid);
      }
    }
  }

  for (const id of ids) {
    const row = rowById.get(id);
    if (row == null) {
      result.set(id, { ...NOT_SERVABLE });
      continue;
    }
    const groupId = row.parentId ?? id;
    const lifecycle = lifecycleByGroup.get(groupId);
    const revision: RevisionRow | undefined = lifecycle?.current_revision_id
      ? revisionById.get(lifecycle.current_revision_id)
      : undefined;
    const latestVerify = latestVerifyByGroup.get(groupId);
    const commands = commandsByGroup.get(groupId);

    // Frozen-plan serving decision (the issuance gate's own read-only check).
    // Parts are evaluated individually — a group is servable when at least one
    // part can be issued (check_bank / bank-search precedent).
    let anyPartServable = false;
    let firstUnavailableReason: ServingUnavailableReason | null = null;
    if (revision != null) {
      const parsed = PublishedQuestionRevision.safeParse(revisionRowToContract(revision));
      if (!parsed.success) {
        firstUnavailableReason = 'invalid_presentation';
      } else {
        for (const part of parsed.data.structure.parts) {
          const decision: AutomaticServingDecision = decideAutomaticServing(parsed.data, [
            part.part_id,
          ]);
          if (decision.kind === 'admitted') {
            anyPartServable = true;
          } else if (firstUnavailableReason == null) {
            firstUnavailableReason = decision.reason;
          }
        }
      }
    }

    const isDraft = row.draftStatus === 'draft';
    const servable =
      lifecycle != null &&
      !lifecycle.withdrawn &&
      !lifecycle.suspended &&
      lifecycle.scoring_admission_state === 'admitted' &&
      !isDraft &&
      anyPartServable;

    const sourceCheckFailed =
      latestVerify?.policyId === 'source_verify@1' && latestVerify.outcome === 'failed';

    let holdReason: ServingHoldReason | null = null;
    let heldSince: Date | null = null;
    if (!servable) {
      if (lifecycle?.withdrawn === true) {
        holdReason = 'withdrawn';
        heldSince = lifecycle.withdrawn_at ?? lifecycle.updated_at;
      } else if (lifecycle?.suspended === true) {
        heldSince = lifecycle.updated_at;
        holdReason =
          lifecycle.suspension_reason === 'retraction_hold'
            ? 'retraction_hold'
            : sourceCheckFailed
              ? 'source_check_failed'
              : 'verify_hold';
      } else if (lifecycle == null || lifecycle.scoring_admission_state === 'withheld') {
        const withheldReason = lifecycle?.scoring_admission_withheld_reason ?? null;
        heldSince = latestVerify?.recordedAt ?? lifecycle?.updated_at ?? row.createdAt;
        if (withheldReason === 'verification_failed') {
          holdReason = sourceCheckFailed ? 'source_check_failed' : 'admission_failed';
        } else if (withheldReason === 'no_admitted_executor') {
          holdReason = 'admission_failed';
        } else if (withheldReason === 'owner_hold') {
          // Deliberate owner withhold — no enum claims it and no release
          // command undoes it; the UI shows the generic "暂不出题" badge.
          holdReason = null;
        } else {
          holdReason = 'awaiting_admission';
        }
      } else if (isDraft) {
        // Admission passed but the row is still a draft awaiting promote.
        holdReason = 'awaiting_admission';
        heldSince = lifecycle?.updated_at ?? row.createdAt;
      } else {
        holdReason =
          firstUnavailableReason != null
            ? holdReasonForServingDecision(firstUnavailableReason)
            : null;
        heldSince = lifecycle?.updated_at ?? row.createdAt;
      }
    }

    // pending_action = command event + in-flight job. A release_verify_hold is
    // synchronous, so it never reports pending; a rejected command never counts
    // at all. Scan newest-first and take the first accepted command whose job
    // is still running.
    let pendingAction: QuestionServing['pending_action'] = null;
    for (const commandEvent of commands ?? []) {
      if (!commandEvent.accepted) continue;
      if (commandEvent.command === 'reverify' && inflightAdmission.has(groupId)) {
        pendingAction = {
          command: 'reverify',
          since: commandEvent.createdAt.toISOString(),
        };
        break;
      }
      if (commandEvent.command === 'recheck_source' && inflightSourceVerify.has(groupId)) {
        pendingAction = {
          command: 'recheck_source',
          since: commandEvent.createdAt.toISOString(),
        };
        break;
      }
    }

    let nextAction: QuestionServing['next_action'] = null;
    if (!servable && pendingAction == null) {
      const command: ServingActionCommand | null =
        holdReason === 'admission_failed'
          ? 'reverify'
          : holdReason === 'awaiting_admission' &&
              heldSince != null &&
              now.getTime() - heldSince.getTime() >= AWAITING_ADMISSION_REVERIFY_AFTER_MS
            ? 'reverify'
            : holdReason === 'source_check_failed'
              ? 'recheck_source'
              : holdReason === 'verify_hold'
                ? 'release_verify_hold'
                : null;
      if (command != null) {
        nextAction = { command, method: 'POST', path: servingActionPath(groupId, command) };
      }
    }

    result.set(id, {
      servable,
      hold_reason: servable ? null : holdReason,
      held_since: servable ? null : (heldSince?.toISOString() ?? null),
      next_action: nextAction,
      pending_action: pendingAction,
    });
  }

  return result;
}

/** Pagination-independent counts over a computed serving set. */
export function aggregateServingCounts(servings: Iterable<QuestionServing>): ServingCounts {
  const counts: ServingCounts = { not_servable_total: 0, by_reason: {} };
  for (const serving of servings) {
    if (serving.servable) continue;
    counts.not_servable_total += 1;
    if (serving.hold_reason != null) {
      counts.by_reason[serving.hold_reason] = (counts.by_reason[serving.hold_reason] ?? 0) + 1;
    }
  }
  return counts;
}
