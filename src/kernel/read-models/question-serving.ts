// Question serving hold projection. Every bank row reports whether it is servable,
// the hold reason and since when, the owner's next action, and any in-flight action.
//
// Derives from existing truth only: lifecycle rows, draft status, admission
// verification, the frozen revision through the issuance gate, serving-action
// events, and in-flight pg-boss jobs.

import { type SQL, and, desc, eq, inArray, sql } from 'drizzle-orm';
import { QUESTION_ADMISSION_PAID_UNITS } from '@/core/question-admission-policy';

import {
  type AutomaticServingDecision,
  PublishedQuestionRevision,
  type PublishedQuestionRevisionT,
  type ServingUnavailableReason,
  decideAutomaticServing,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
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

/** Question-family queue that re-runs scoring admission. */
export const SERVING_ADMISSION_JOB = 'question_admission_run' as const;
export const SERVING_SOURCE_VERIFY_JOB = 'source_verify' as const;

/** Admission paid-effect family; a literal because kernel may not import the capability. */
const PAID_EFFECT_ADMISSION_FAMILY = 'question_admission_run' as const;
const PAID_EFFECT_ADMISSION_UNITS = QUESTION_ADMISSION_PAID_UNITS;

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

type ServingState =
  | ServingHoldReason
  | 'revision_check'
  | 'legacy_unpublished'
  | 'draft'
  | 'owner_hold';

/** Lifecycle diagnosis shared by page projections, SQL counts and SQL filtering. */
function servingFactsQuery(filters: SQL[]): SQL {
  return sql`
    select ${question.id} as id, diagnosis.state,
      l.group_id is null as legacy_unpublished,
      applied.entity_id is null as may_reverify,
      case
        when l.withdrawn then coalesce(l.withdrawn_at, l.updated_at)
        when l.suspended then l.updated_at
        when l.group_id is null then null
        when l.scoring_admission_state = 'withheld' then
          case when diagnosis.state in ('source_check_failed', 'admission_failed')
            then coalesce(verification.recorded_at, l.updated_at)
            else l.updated_at end
        when not ${notDraftPredicate(question.draft_status)} then null
        else l.updated_at
      end as held_since
    from ${question}
    left join ${question_group_lifecycle} l
      on l.group_id = coalesce(${question.parent_question_id}, ${question.id})
    left join ${question_revision} r on r.revision_id = l.current_revision_id
    left join lateral (
      select v.policy_id, v.outcome, v.recorded_at
      from ${question_admission_verification} v
      join ${question_revision} vr on vr.revision_id = v.revision_id
      where vr.group_id = l.group_id
      order by v.recorded_at desc limit 1
    ) verification on true
    left join lateral (
      select p.entity_id, p.application_json->>'status' as status
      from ${paid_effect} p
      where p.entity_id = l.group_id and p.entity_revision = r.integrity_digest
        and p.family = ${PAID_EFFECT_ADMISSION_FAMILY}
        and p.unit in (${sql.join(
          PAID_EFFECT_ADMISSION_UNITS.map((unit) => sql`${unit}`),
          sql`, `,
        )})
        and p.state = 'applied'
      order by p.created_at desc limit 1
    ) applied on true
    cross join lateral (
      select case
        when l.withdrawn then 'withdrawn'
        when l.suspended then case
          when l.suspension_reason = 'retraction_hold' then 'retraction_hold'
          when verification.policy_id = 'source_verify@1' and verification.outcome = 'failed'
            then 'source_check_failed'
          else 'verify_hold' end
        when l.group_id is null then 'legacy_unpublished'
        when l.scoring_admission_state = 'withheld' then case
          when verification.policy_id = 'source_verify@1' and verification.outcome = 'failed'
            then 'source_check_failed'
          when applied.status = 'withheld'
            or l.scoring_admission_withheld_reason in ('verification_failed', 'no_admitted_executor')
            then 'admission_failed'
          when l.scoring_admission_withheld_reason = 'owner_hold' then 'owner_hold'
          else 'awaiting_admission' end
        when not ${notDraftPredicate(question.draft_status)} then 'draft'
        else 'revision_check'
      end as state
    ) diagnosis
    where ${and(...filters) ?? sql`true`}
  `;
}

function stateHoldReason(state: ServingState): ServingHoldReason | null {
  switch (state) {
    case 'revision_check':
    case 'legacy_unpublished':
    case 'draft':
    case 'owner_hold':
      return null;
    default:
      return state;
  }
}

/** Runs inside the list's repeatable-read snapshot. Frozen scoring/presentation
 * validation stays in the issuance gate, not a SQL copy. */
export async function questionServingSet(db: Db | Tx, filters: SQL[]): Promise<SQL> {
  const facts = servingFactsQuery(filters);
  const unavailable: { id: string; reason: ServingHoldReason | null }[] = [];
  let after: string | null = null;
  for (;;) {
    const batch: { id: string }[] = await db.execute<{ id: string }>(sql`
      select id from (${facts}) facts
      where state = 'revision_check' ${after === null ? sql`` : sql`and id > ${after}`}
      order by id limit 200
    `);
    if (batch.length === 0) break;
    const serving = await readQuestionServing(
      db,
      batch.map((row) => row.id),
    );
    for (const [id, item] of serving.byId) {
      if (!item.servable) unavailable.push({ id, reason: item.hold_reason });
    }
    after = batch[batch.length - 1].id;
  }
  return sql`
    select facts.id, facts.legacy_unpublished,
      facts.state = 'revision_check' and gate.id is null as servable,
      case when facts.state = 'revision_check' then gate.reason
        when facts.state in ('legacy_unpublished', 'draft', 'owner_hold') then null
        else facts.state end as hold_reason
    from (${facts}) facts
    left join jsonb_to_recordset(${JSON.stringify(unavailable)}::jsonb)
      as gate(id text, reason text) on gate.id = facts.id
  `;
}

export async function countQuestionServing(db: Db | Tx, servingSet: SQL): Promise<ServingCounts> {
  const rows = await db.execute<{
    hold_reason: ServingHoldReason | null;
    count: number;
    legacy: number;
  }>(sql`
    select hold_reason, count(*)::int as count,
      count(*) filter (where legacy_unpublished)::int as legacy
    from (${servingSet}) serving where not servable group by hold_reason
  `);
  const counts: ServingCounts = { not_servable_total: 0, by_reason: {}, legacy_unpublished: 0 };
  for (const row of rows) {
    counts.not_servable_total += row.count;
    counts.legacy_unpublished += row.legacy;
    if (row.hold_reason !== null) counts.by_reason[row.hold_reason] = row.count;
  }
  return counts;
}

/**
 * Batch serving derivation for question ids. A part resolves to its parent group for
 * shared lifecycle facts, but its verdict comes from the issuance gate's own per-part
 * scope: a root is checked with every part, a part with itself.
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

  const facts = await db.execute<{
    id: string;
    state: ServingState;
    legacy_unpublished: boolean;
    may_reverify: boolean;
    held_since: string | Date | null;
  }>(servingFactsQuery([inArray(question.id, ids)]));
  const factsById = new Map(facts.map((row) => [row.id, row]));

  // Keep every command per group, newest first: a later rejected or finished
  // command must not mask an earlier in-flight one.
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

  // In-flight job half of pending_action. pgboss.job is pg-boss owned; to_regclass
  // keeps this honest on databases the worker schema never reached.
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

  // Parse each group's frozen contract once; scope differs per item but the parse
  // is shared.
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
    const fact = factsById.get(id);
    if (row == null || fact == null) {
      result.set(id, { ...NOT_SERVABLE });
      continue;
    }
    const groupId = row.parentId ?? id;
    const partId = row.parentId != null ? id : null;
    const lifecycle = lifecycleByGroup.get(groupId);
    const commands = commandsByGroup.get(groupId);
    const contractEntry = contractByGroup.get(groupId);
    if (fact.legacy_unpublished) legacyUnpublished.add(id);

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

    const servable = fact.state === 'revision_check' && decisionAdmitted;
    const holdReason =
      fact.state === 'revision_check' && itemUnavailableReason != null
        ? holdReasonForServingDecision(itemUnavailableReason)
        : stateHoldReason(fact.state);
    const heldSince = fact.held_since == null ? null : new Date(fact.held_since);

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
      // reverify only when a claim could still produce a new verdict: never run,
      // stuck pending, or a resumable error. An applied verdict for the current
      // digest is terminal and never re-paid.
      const mayReverify = fact.may_reverify;
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
