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
  type PublishedQuestionRevisionT,
  type ServingUnavailableReason,
  decideAutomaticServing,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  event,
  paid_effect,
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

/** paid_effect family of the admission claim (mirrors ADMISSION_FAMILY in
 * practice/server/admission/enqueue.ts — duplicated as a literal because
 * kernel may not import capability modules). */
const PAID_EFFECT_ADMISSION_FAMILY = 'question_admission_run' as const;
const PAID_EFFECT_ADMISSION_UNIT = 'admission@1' as const;

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
  /** Rows with no lifecycle record at all — counted in not_servable_total and
   * by_reason-neutral (the contract keeps this key additive/optional). */
  legacy_unpublished: number;
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

export interface QuestionServingRead {
  /** One serving projection per INPUT question id (a part row reports its own
   * per-part verdict; pending_action stays group-level). */
  byId: Map<string, QuestionServing>;
  /** Input ids whose group has no question_group_lifecycle row — never
   * published (or published before lifecycle existed). Not servable, no
   * hold_reason, counted in legacy_unpublished. */
  legacyUnpublished: Set<string>;
}

/**
 * Batch serving derivation for question ids (roots or parts). A part id
 * resolves to its parent group (parent_question_id ?? id) for the shared
 * lifecycle facts, but its servable/hold_reason comes from the issuance
 * gate's own per-part check — mirroring the real issuance binding: a root is
 * checked with ONE decideAutomaticServing(revision, allPartIds), a part with
 * [partId]. Batched — five relation reads + one pgboss probe for any page.
 */
export async function readQuestionServing(
  db: Db | Tx,
  questionIds: readonly string[],
  options: { now?: Date } = {},
): Promise<QuestionServingRead> {
  const now = options.now ?? new Date();
  const result = new Map<string, QuestionServing>();
  const legacyUnpublished = new Set<string>();
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return { byId: result, legacyUnpublished };

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

  // Applied paid-effect verdicts for the CURRENT revision digest, per group.
  // reverify cannot change an applied verdict for an identical base — the
  // claim never re-pays it — so its presence suppresses next_action and turns
  // a second reverify call into a 409 (the command enforces the same read).
  const appliedRows = groupIds.length
    ? await db
        .select({
          groupId: paid_effect.entity_id,
          entityRevision: paid_effect.entity_revision,
          application: paid_effect.application_json,
          createdAt: paid_effect.created_at,
        })
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.family, PAID_EFFECT_ADMISSION_FAMILY),
            inArray(paid_effect.entity_id, groupIds),
            eq(paid_effect.unit, PAID_EFFECT_ADMISSION_UNIT),
            eq(paid_effect.state, 'applied'),
          ),
        )
        .orderBy(desc(paid_effect.created_at))
    : [];
  const appliedByGroupDigest = new Map<string, { status: string | null }>();
  for (const row of appliedRows) {
    const key = `${row.groupId}|${row.entityRevision}`;
    if (appliedByGroupDigest.has(key)) continue;
    const status =
      row.application != null &&
      typeof row.application === 'object' &&
      typeof (row.application as Record<string, unknown>).status === 'string'
        ? ((row.application as Record<string, unknown>).status as string)
        : null;
    appliedByGroupDigest.set(key, { status });
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

  // Parse each current revision's contract once per group — the part scope
  // differs per item (root = all parts, part = itself) but the frozen contract
  // parse is shared.
  const contractByGroup = new Map<
    string,
    { allPartIds: string[]; revision: PublishedQuestionRevisionT | null }
  >();
  for (const groupId of groupIds) {
    const lifecycle = lifecycleByGroup.get(groupId);
    const revision: RevisionRow | undefined = lifecycle?.current_revision_id
      ? revisionById.get(lifecycle.current_revision_id)
      : undefined;
    if (revision == null) {
      contractByGroup.set(groupId, { allPartIds: [], revision: null });
      continue;
    }
    const parsed = PublishedQuestionRevision.safeParse(revisionRowToContract(revision));
    contractByGroup.set(groupId, {
      allPartIds: parsed.success ? parsed.data.structure.parts.map((part) => part.part_id) : [],
      revision: parsed.success ? parsed.data : null,
    });
  }

  for (const id of ids) {
    const row = rowById.get(id);
    if (row == null) {
      result.set(id, { ...NOT_SERVABLE });
      continue;
    }
    const groupId = row.parentId ?? id;
    const partId = row.parentId != null ? id : null;
    const lifecycle = lifecycleByGroup.get(groupId);
    const latestVerify = latestVerifyByGroup.get(groupId);
    const commands = commandsByGroup.get(groupId);
    const contractEntry = contractByGroup.get(groupId);
    const currentDigest = lifecycle?.current_revision_id
      ? (revisionById.get(lifecycle.current_revision_id)?.integrity_digest ?? null)
      : null;
    const applied =
      currentDigest != null
        ? (appliedByGroupDigest.get(`${groupId}|${currentDigest}`) ?? null)
        : null;
    if (lifecycle == null) legacyUnpublished.add(id);

    // Frozen-plan serving decision for THIS item's issuance scope: the root
    // is checked once with every part; a part with only itself.
    let decisionAdmitted = false;
    let itemUnavailableReason: ServingUnavailableReason | null = null;
    if (contractEntry != null) {
      if (contractEntry.revision == null) {
        itemUnavailableReason = 'invalid_presentation';
      } else if (lifecycle?.current_revision_id != null) {
        const scope = partId != null ? [partId] : contractEntry.allPartIds;
        try {
          const decision: AutomaticServingDecision = decideAutomaticServing(
            contractEntry.revision,
            scope,
          );
          if (decision.kind === 'admitted') {
            decisionAdmitted = true;
          } else {
            itemUnavailableReason = decision.reason;
          }
        } catch {
          // A part_id absent from the frozen contract (tombstoned) or a
          // projection error is a fail-closed unavailable without an enum name.
          itemUnavailableReason = null;
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
      decisionAdmitted;

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
      } else if (lifecycle == null) {
        // Never published — generic hold, no enum name, no action.
        holdReason = null;
        heldSince = null;
      } else if (lifecycle.scoring_admission_state === 'withheld') {
        const withheldReason = lifecycle.scoring_admission_withheld_reason;
        if (sourceCheckFailed) {
          // The last recorded verdict is a failed SOURCE check — diagnosis and
          // recovery both route through recheck_source.
          holdReason = 'source_check_failed';
          heldSince = latestVerify?.recordedAt ?? lifecycle.updated_at;
        } else if (
          applied?.status === 'withheld' ||
          withheldReason === 'verification_failed' ||
          withheldReason === 'no_admitted_executor'
        ) {
          // An applied failed verdict for the current digest keeps the
          // diagnosis but loses the button — an identical base is never
          // re-paid, so reverify cannot change it (edit the content).
          holdReason = 'admission_failed';
          heldSince = latestVerify?.recordedAt ?? lifecycle.updated_at;
        } else if (withheldReason === 'owner_hold') {
          // Deliberate owner withhold — no enum claims it and no release
          // command undoes it; the UI shows the generic "暂不出题" badge.
          holdReason = null;
          heldSince = lifecycle.updated_at;
        } else {
          // Pending this verification cycle — held_since is the cycle start
          // (the re-pend / latest dimension update), not an earlier verify row.
          holdReason = 'awaiting_admission';
          heldSince = lifecycle.updated_at;
        }
      } else if (isDraft) {
        // Admission passed but the row is still a draft — same generic-hold
        // treatment as a never-published row: no enum, no dead button.
        holdReason = null;
        heldSince = null;
      } else {
        holdReason =
          itemUnavailableReason != null
            ? holdReasonForServingDecision(itemUnavailableReason)
            : null;
        heldSince = lifecycle.updated_at;
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
      // reverify only exists where a claim could still produce a NEW verdict:
      // a never-run or stuck pending cycle, or an errored/unknown outcome the
      // paid-effect claim allows to resume. An applied verdict for the current
      // digest is terminal — the identical base is never re-paid.
      const mayReverify = applied == null;
      const command: ServingActionCommand | null =
        holdReason === 'admission_failed' && mayReverify
          ? 'reverify'
          : holdReason === 'awaiting_admission' &&
              mayReverify &&
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

  return { byId: result, legacyUnpublished };
}

/** Pagination-independent counts over a computed serving set. */
export function aggregateServingCounts(
  servings: Iterable<QuestionServing>,
  legacyUnpublished: Iterable<string> = [],
): ServingCounts {
  const counts: ServingCounts = { not_servable_total: 0, by_reason: {}, legacy_unpublished: 0 };
  for (const serving of servings) {
    if (serving.servable) continue;
    counts.not_servable_total += 1;
    if (serving.hold_reason != null) {
      counts.by_reason[serving.hold_reason] = (counts.by_reason[serving.hold_reason] ?? 0) + 1;
    }
  }
  for (const _ of legacyUnpublished) counts.legacy_unpublished += 1;
  return counts;
}
