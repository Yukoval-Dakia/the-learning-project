// AI runs and provider truth: task runs, evidence checkpoints, provider
// attempts and admissions, tools, subagent runs, continuations, the cost
// ledger, and the provider catalog.

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { SealedHelpLatency } from '@/ai/help-latency';
import type { ProviderTransportEvidence } from '@/ai/task-result';
import type { ProviderAttemptUsageTruth } from '../../core/schema/provider-attempt';

type JsonObject = Record<string, unknown>;

// Phase 1c.1 Step 9.J — `dreaming_proposal` table DROPped. Proposals live as
// event(action='propose', subject_kind='knowledge') (Lane B ProposeKnowledge)
// plus experimental:knowledge_<mutation> namespace events.

export const ai_task_runs = pgTable(
  'ai_task_runs',
  {
    id: text('id').primaryKey(),
    task_kind: text('task_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    input_hash: text('input_hash').notNull(),
    // YUK-589 — run-bound provenance digests, written post-assembly by consumers
    // that need replay/tamper corroboration (JudgeInvoker and FULL intervention
    // validation). Nullable because most task kinds and legacy rows predate this
    // binding. Critical readers require both fields for their own task kinds.
    prompt_fingerprint: text('prompt_fingerprint'),
    result_digest: text('result_digest'),
    compiled_prompt_hash: text('compiled_prompt_hash'),
    prompt_codec_version: text('prompt_codec_version'),
    prompt_codec_mode: text('prompt_codec_mode'),
    prompt_context_digest: text('prompt_context_digest'),
    status: text('status').notNull().default('running'),
    finish_reason: text('finish_reason'),
    usage_json: jsonb('usage_json')
      .$type<{
        inputTokens: number;
        outputTokens: number;
        /** YUK-1557 — provider prompt-cache counters (0 = lane reported none). */
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        /** YUK-1557 — completed assistant turns. */
        numTurns?: number;
        thinkingBlocks?: number;
        thinkingCharacters?: number;
        /** YUK-1531 — estimated when a timeout had no provider usage payload. */
        usage_basis?: 'reported' | 'estimated';
        phases?: {
          prompt_build_ms?: number;
          model_ttft_ms?: number | null;
          model_total_ms?: number;
          stream_ms?: number;
          parse_ms?: number;
          validation_ms?: number;
          retry_count?: number;
          db_write_ms?: number;
        };
        /** YUK-1058 — D18 eval 镜像字段（可选；仅 task_kind='D18EvalHarness' 行）。 */
        d18_score?: { points_awarded: number; max_points: number };
        d18_escalated?: boolean;
        d18_latency_ms?: number;
        /** YUK-1630 — per-attempt provider transport evidence; metadata only. */
        transport?: ProviderTransportEvidence;
        /** Help attempts only. Unknown cost inside the seal stays null. */
        help_latency?: SealedHelpLatency;
      }>()
      .notNull()
      .default({ inputTokens: 0, outputTokens: 0 }),
    cost_usd: real('cost_usd'),
    // YUK-841 — one attempt has one explicit cost truth. Legacy rows keep both
    // fields NULL; new runner attempts persist reported / estimated / unknown
    // together with the evidence reference used to classify the amount.
    cost_basis: text('cost_basis'),
    cost_ref: text('cost_ref'),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_task_runs_task_kind_idx').on(t.task_kind, t.started_at.desc()),
    index('ai_task_runs_status_idx').on(t.status, t.started_at.desc()),
    check(
      'ai_task_runs_cost_truth_ck',
      sql`(
        ${t.cost_basis} IS NULL AND ${t.cost_ref} IS NULL
      ) OR (
        ${t.cost_basis} IS NOT NULL
        AND ${t.cost_basis} IN ('reported','estimated','unknown')
        AND ${t.cost_ref} IS NOT NULL
        AND btrim(${t.cost_ref}) <> ''
        AND (
          (${t.cost_basis} = 'unknown' AND ${t.cost_usd} IS NULL)
          OR (${t.cost_basis} IN ('reported','estimated') AND ${t.cost_usd} IS NOT NULL AND ${t.cost_usd} >= 0)
        )
      )`,
    ),
    check(
      'ai_task_runs_compiled_prompt_provenance_ck',
      sql`(
        ${t.compiled_prompt_hash} IS NULL
        AND ${t.prompt_codec_version} IS NULL
        AND ${t.prompt_codec_mode} IS NULL
        AND ${t.prompt_context_digest} IS NULL
      ) OR (
        ${t.compiled_prompt_hash} IS NOT NULL
        AND ${t.compiled_prompt_hash} ~ '^[0-9a-f]{64}$'
        AND ${t.prompt_codec_version} IS NOT NULL
        AND btrim(${t.prompt_codec_version}) <> ''
        AND ${t.prompt_codec_mode} IS NOT NULL
        AND ${t.prompt_codec_mode} IN ('cold','resume')
        AND ${t.prompt_context_digest} IS NOT NULL
        AND ${t.prompt_context_digest} ~ '^[0-9a-f]{64}$'
      )`,
    ),
  ],
);

export const copilot_evidence_checkpoint = pgTable(
  'copilot_evidence_checkpoint',
  {
    id: text('id').primaryKey(),
    task_kind: text('task_kind').notNull(),
    slot: text('slot').notNull(),
    protocol_version: integer('protocol_version').notNull(),
    prompt_fingerprint: text('prompt_fingerprint').notNull(),
    base_input_sha256: text('base_input_sha256').notNull(),
    source_catalog_sha256: text('source_catalog_sha256').notNull(),
    binding_extras: jsonb('binding_extras').$type<JsonObject>().notNull().default({}),
    status: text('status').notNull().default('open'),
    revision: integer('revision').notNull().default(0),
    records_json: jsonb('records_json').$type<JsonObject[]>().notNull().default([]),
    record_digests_json: jsonb('record_digests_json').$type<string[]>().notNull().default([]),
    attempts_json: jsonb('attempts_json').$type<JsonObject[]>().notNull().default([]),
    sealed_output_json: jsonb('sealed_output_json').$type<unknown>(),
    sealed_digest_sha256: text('sealed_digest_sha256'),
    sealed_task_run_id: text('sealed_task_run_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('copilot_evidence_checkpoint_expiry_idx').on(t.expires_at),
    check(
      'copilot_evidence_checkpoint_task_kind_ck',
      sql`${t.task_kind} IN ('CopilotEvidenceReviewTask','CopilotEvidenceVerificationTask')`,
    ),
    check('copilot_evidence_checkpoint_status_ck', sql`${t.status} IN ('open','sealed','expired')`),
    check('copilot_evidence_checkpoint_revision_ck', sql`${t.revision} >= 0`),
    check(
      'copilot_evidence_checkpoint_seal_ck',
      sql`(
        ${t.status} = 'open'
        AND ${t.sealed_output_json} IS NULL
        AND ${t.sealed_digest_sha256} IS NULL
        AND ${t.sealed_task_run_id} IS NULL
      ) OR (
        ${t.status} = 'sealed'
        AND ${t.sealed_output_json} IS NOT NULL
        AND ${t.sealed_digest_sha256} IS NOT NULL
        AND ${t.sealed_task_run_id} IS NOT NULL
      ) OR (
        ${t.status} = 'expired'
        AND ${t.sealed_output_json} IS NULL
        AND ${t.sealed_digest_sha256} IS NULL
        AND ${t.sealed_task_run_id} IS NULL
      )`,
    ),
  ],
);

export const provider_attempt = pgTable(
  'provider_attempt',
  {
    attempt_id: uuid('attempt_id').primaryKey(),
    operation_id: uuid('operation_id').notNull(),
    attempt_kind: text('attempt_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    lane_id: text('lane_id').notNull(),
    protocol: text('protocol').notNull(),
    endpoint_class: text('endpoint_class').notNull(),
    caller: text('caller').notNull(),
    operation_kind: text('operation_kind').notNull(),
    external_request_id: text('external_request_id'),
    terminal_status: text('terminal_status'),
    terminal_reason: text('terminal_reason'),
    wire_count: integer('wire_count'),
    usage_json: jsonb('usage_json').$type<ProviderAttemptUsageTruth>(),
    cost_basis: text('cost_basis'),
    cost_amount: doublePrecision('cost_amount'),
    cost_currency: text('cost_currency'),
    cost_source: text('cost_source'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    provider_start_reserved_at: timestamp('provider_start_reserved_at', { withTimezone: true }),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('provider_attempt_operation_idx').on(t.operation_id, t.started_at.desc(), t.attempt_id),
    index('provider_attempt_open_operation_idx')
      .on(t.operation_id, t.lane_id, t.started_at.desc())
      .where(sql`${t.finished_at} IS NULL`),
    index('provider_attempt_external_request_idx')
      .on(t.provider, t.external_request_id)
      .where(sql`${t.external_request_id} IS NOT NULL`),
    index('provider_attempt_lane_start_rate_idx')
      .on(t.lane_id, t.provider_start_reserved_at)
      .where(sql`${t.provider_start_reserved_at} IS NOT NULL`),
    check('provider_attempt_kind_ck', sql`${t.attempt_kind} IN ('wire','opaque_operation')`),
    check('provider_attempt_caller_ck', sql`${t.caller} IN ('api','worker')`),
    check(
      'provider_attempt_terminal_ck',
      sql`${t.terminal_status} IS NULL OR ${t.terminal_status} IN ('succeeded','failed','aborted','unknown')`,
    ),
    check(
      'provider_attempt_identity_ck',
      sql`btrim(${t.provider}) <> ''
        AND (${t.model} IS NULL OR btrim(${t.model}) <> '')
        AND btrim(${t.lane_id}) <> ''
        AND btrim(${t.protocol}) <> ''
        AND btrim(${t.endpoint_class}) <> ''
        AND btrim(${t.operation_kind}) <> ''
        AND (${t.external_request_id} IS NULL OR btrim(${t.external_request_id}) <> '')`,
    ),
    check('provider_attempt_wire_ck', sql`${t.wire_count} IS NULL OR ${t.wire_count} >= 0`),
    check(
      'provider_attempt_opaque_ck',
      sql`${t.attempt_kind} <> 'opaque_operation' OR ${t.wire_count} IS NULL`,
    ),
    check(
      'provider_attempt_terminal_shape_ck',
      sql`(
        ${t.finished_at} IS NULL AND ${t.terminal_status} IS NULL
        AND ${t.terminal_reason} IS NULL AND ${t.wire_count} IS NULL
        AND ${t.usage_json} IS NULL AND ${t.cost_basis} IS NULL
        AND ${t.cost_amount} IS NULL AND ${t.cost_currency} IS NULL AND ${t.cost_source} IS NULL
      ) OR (
        ${t.finished_at} IS NOT NULL AND ${t.terminal_status} IS NOT NULL
        AND ${t.terminal_reason} IS NOT NULL AND btrim(${t.terminal_reason}) <> ''
        AND ${t.usage_json} IS NOT NULL AND jsonb_typeof(${t.usage_json}) = 'object'
        AND ${t.usage_json} ?& ARRAY['basis','unit','input','output','total','source']
        AND ${t.usage_json} - ARRAY['basis','unit','input','output','total','source']::text[] = '{}'::jsonb
        AND jsonb_typeof(${t.usage_json}->'source') = 'string'
        AND btrim(${t.usage_json}->>'source') <> ''
        AND (
          (${t.usage_json}->>'basis' IN ('reported','estimated')
            AND jsonb_typeof(${t.usage_json}->'unit') = 'string'
            AND btrim(${t.usage_json}->>'unit') <> ''
            AND jsonb_typeof(${t.usage_json}->'input') IN ('number','null')
            AND jsonb_typeof(${t.usage_json}->'output') IN ('number','null')
            AND jsonb_typeof(${t.usage_json}->'total') IN ('number','null')
            AND (jsonb_typeof(${t.usage_json}->'input') = 'number'
              OR jsonb_typeof(${t.usage_json}->'output') = 'number'
              OR jsonb_typeof(${t.usage_json}->'total') = 'number')
            AND COALESCE((${t.usage_json}->>'input')::double precision, 0) >= 0
            AND COALESCE((${t.usage_json}->>'output')::double precision, 0) >= 0
            AND COALESCE((${t.usage_json}->>'total')::double precision, 0) >= 0)
          OR (${t.usage_json}->>'basis' = 'unknown'
            AND (jsonb_typeof(${t.usage_json}->'unit') = 'null'
              OR (jsonb_typeof(${t.usage_json}->'unit') = 'string'
                AND btrim(${t.usage_json}->>'unit') <> ''))
            AND jsonb_typeof(${t.usage_json}->'input') = 'null'
            AND jsonb_typeof(${t.usage_json}->'output') = 'null'
            AND jsonb_typeof(${t.usage_json}->'total') = 'null')
        )
        AND ${t.cost_basis} IS NOT NULL
        AND ${t.cost_source} IS NOT NULL
      )`,
    ),
    check(
      'provider_attempt_cost_shape_ck',
      sql`${t.cost_basis} IS NULL OR (
        btrim(${t.cost_source}) <> '' AND (
          (${t.cost_basis} IN ('reported','estimated') AND ${t.cost_amount} IS NOT NULL
            AND ${t.cost_amount} NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
            AND ${t.cost_amount} >= 0
            AND ${t.cost_currency} ~ '^[A-Z]{3}$')
          OR (${t.cost_basis} = 'unknown' AND ${t.cost_amount} IS NULL
            AND (${t.cost_currency} IS NULL OR ${t.cost_currency} ~ '^[A-Z]{3}$'))
        )
      )`,
    ),
    check(
      'provider_attempt_timeline_ck',
      sql`(${t.provider_start_reserved_at} IS NULL OR ${t.provider_start_reserved_at} >= ${t.started_at})
        AND (${t.finished_at} IS NULL OR ${t.finished_at} >= ${t.started_at})
        AND (${t.finished_at} IS NULL OR ${t.provider_start_reserved_at} IS NULL
          OR ${t.finished_at} >= ${t.provider_start_reserved_at})`,
    ),
  ],
);

export const provider_attempt_admission = pgTable(
  'provider_attempt_admission',
  {
    attempt_id: uuid('attempt_id').primaryKey(),
    identity_fingerprint: text('identity_fingerprint').notNull(),
    policy_fingerprint: text('policy_fingerprint').notNull(),
    lane_id: text('lane_id').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    lease_owner: uuid('lease_owner'),
    requested_at: timestamp('requested_at', { withTimezone: true }).notNull(),
    deadline_at: timestamp('deadline_at', { withTimezone: true }).notNull(),
    acquired_at: timestamp('acquired_at', { withTimezone: true }),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    terminal_at: timestamp('terminal_at', { withTimezone: true }),
    terminal_reason: text('terminal_reason'),
  },
  (t) => [
    index('provider_attempt_admission_lane_active_idx')
      .on(t.lane_id, t.lease_expires_at, t.attempt_id)
      .where(sql`${t.status} IN ('acquired','would_deny')`),
    index('provider_attempt_admission_lane_start_idx')
      .on(t.lane_id, t.acquired_at, t.attempt_id)
      .where(sql`${t.acquired_at} IS NOT NULL`),
    index('provider_attempt_admission_lane_terminal_idx')
      .on(t.lane_id, t.terminal_at, t.attempt_id)
      .where(sql`${t.terminal_at} IS NOT NULL`),
    check(
      'provider_attempt_admission_identity_ck',
      sql`btrim(${t.identity_fingerprint}) <> ''
        AND btrim(${t.policy_fingerprint}) <> ''
        AND btrim(${t.lane_id}) <> ''
        AND ${t.mode} IN ('off','observe','enforce')
        AND ${t.status} IN ('acquired','would_deny','denied','released','lease_expired')`,
    ),
    check(
      'provider_attempt_admission_state_ck',
      sql`(
        ${t.status} IN ('acquired','would_deny') AND ${t.lease_owner} IS NOT NULL
        AND ${t.acquired_at} IS NOT NULL AND ${t.lease_expires_at} IS NOT NULL
        AND ${t.terminal_at} IS NULL AND ${t.terminal_reason} IS NULL
        AND (
          (${t.status} = 'acquired'
            AND (${t.mode} = 'off' OR ${t.lease_expires_at} <= ${t.deadline_at}))
          OR (${t.status} = 'would_deny' AND ${t.mode} = 'observe')
        )
      ) OR (
        ${t.status} = 'denied' AND ${t.lease_owner} IS NULL
        AND ${t.mode} = 'enforce'
        AND ${t.acquired_at} IS NULL AND ${t.lease_expires_at} IS NULL
        AND ${t.terminal_at} IS NOT NULL AND ${t.terminal_reason} IS NOT NULL
        AND btrim(${t.terminal_reason}) <> ''
      ) OR (
        ${t.status} IN ('released','lease_expired') AND ${t.lease_owner} IS NOT NULL
        AND ${t.acquired_at} IS NOT NULL AND ${t.lease_expires_at} IS NOT NULL
        AND ${t.terminal_at} IS NOT NULL AND ${t.terminal_reason} IS NOT NULL
        AND btrim(${t.terminal_reason}) <> ''
        AND (${t.status} = 'released' OR ${t.terminal_at} >= ${t.lease_expires_at})
      )`,
    ),
  ],
);

// YUK-842 — cross-process provider-lane admission for complete SDK query sessions.
// One row is both the live lease state and the start-reservation ledger for one
// preallocated model-attempt identity. task_run_id and borrowed_from_task_run_id are intentional
// loose refs: waiting/timeout rows precede ai_task_runs, while the durable model attempt is created
// only after acquire. Admission correctness must not depend on a hard FK during restore. Rows are
// operational. Terminal rows become eligible after a seven-day diagnostic horizon for opportunistic
// pruning in bounded lane-local batches; there is no background TTL.
//
// One active same-lane descendant chain may share an active session-family root's concurrency slot
// while every child keeps its own row, start reservation, lease, and metrics. Parallel siblings must
// consume another root or wait. Cross-row facts remain runtime CAS invariants; the row-local CHECK
// only prevents impossible shapes and self-borrowing.
export const provider_session_admission = pgTable(
  'provider_session_admission',
  {
    // Primary-key uniqueness is the one-admission-row-per-attempt contract. Deliberately no FK.
    task_run_id: text('task_run_id').primaryKey(),
    lane_id: text('lane_id').notNull(),
    policy_fingerprint: text('policy_fingerprint').notNull(),
    mode: text('mode', { enum: ['observe', 'enforce'] }).notNull(),
    status: text('status', {
      enum: [
        'waiting',
        'acquired',
        'released',
        'timed_out',
        'cancelled',
        'rejected',
        'lease_expired',
      ],
    }).notNull(),
    // Loose parent-attempt correlation. Runtime permits it only for an active same-lane parent.
    borrowed_from_task_run_id: text('borrowed_from_task_run_id'),
    claim_token: uuid('claim_token'),
    requested_at: timestamp('requested_at', { withTimezone: true }).notNull(),
    wait_deadline_at: timestamp('wait_deadline_at', { withTimezone: true }).notNull(),
    acquired_at: timestamp('acquired_at', { withTimezone: true }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    // A lost short lease is not safe to recycle at an unfenceable external provider until this bound.
    hard_reclaim_at: timestamp('hard_reclaim_at', { withTimezone: true }),
    terminal_at: timestamp('terminal_at', { withTimezone: true }),
    terminal_reason: text('terminal_reason'),
  },
  (t) => [
    // Active rows feed family-root capacity accounting. One descendant chain is free only while an
    // active ancestor owns its family slot; parallel branches consume roots. When an ancestor ends,
    // its still-active child becomes the counted root.
    // A short-lease loss is terminal for ownership but remains quarantined through hard_reclaim_at.
    index('provider_session_admission_lane_active_idx')
      .on(t.lane_id, t.hard_reclaim_at, t.borrowed_from_task_run_id)
      .where(sql`${t.status} IN ('acquired','lease_expired')`),
    // Short-lease expiry scan; heartbeat/release remain token-fenced CAS updates.
    index('provider_session_admission_lane_lease_idx')
      .on(t.lane_id, t.lease_expires_at)
      .where(sql`${t.status} = 'acquired'`),
    // Sliding start-reservation rate counts every acquired row, including family children and
    // terminal rows.
    index('provider_session_admission_lane_start_idx')
      .on(t.lane_id, t.acquired_at)
      .where(sql`${t.acquired_at} IS NOT NULL`),
    index('provider_session_admission_lane_waiting_idx')
      .on(t.lane_id, t.requested_at, t.task_run_id)
      .where(sql`${t.status} = 'waiting'`),
    index('provider_session_admission_borrowed_from_idx')
      .on(t.borrowed_from_task_run_id)
      .where(sql`${t.borrowed_from_task_run_id} IS NOT NULL`),
    // Supports opportunistic lane-local pruning: at most 100 eligible rows per later lane tick.
    index('provider_session_admission_lane_terminal_idx')
      .on(t.lane_id, t.terminal_at)
      .where(sql`${t.terminal_at} IS NOT NULL`),
    check('provider_session_admission_mode_ck', sql`${t.mode} IN ('observe','enforce')`),
    check(
      'provider_session_admission_status_ck',
      sql`${t.status} IN ('waiting','acquired','released','timed_out','cancelled','rejected','lease_expired')`,
    ),
    check(
      'provider_session_admission_identifiers_ck',
      sql`${t.task_run_id} = btrim(${t.task_run_id})
        AND ${t.task_run_id} <> ''
        AND ${t.lane_id} = btrim(${t.lane_id})
        AND ${t.lane_id} <> ''
        AND ${t.policy_fingerprint} = btrim(${t.policy_fingerprint})
        AND ${t.policy_fingerprint} <> ''
        AND (${t.borrowed_from_task_run_id} IS NULL OR (
          ${t.borrowed_from_task_run_id} = btrim(${t.borrowed_from_task_run_id})
          AND ${t.borrowed_from_task_run_id} <> ''
        ))`,
    ),
    check(
      'provider_session_admission_acquisition_shape_ck',
      sql`(
          ${t.claim_token} IS NULL
          AND ${t.acquired_at} IS NULL
          AND ${t.heartbeat_at} IS NULL
          AND ${t.lease_expires_at} IS NULL
          AND ${t.hard_reclaim_at} IS NULL
        ) OR (
          ${t.claim_token} IS NOT NULL
          AND ${t.acquired_at} IS NOT NULL
          AND ${t.heartbeat_at} IS NOT NULL
          AND ${t.lease_expires_at} IS NOT NULL
          AND ${t.hard_reclaim_at} IS NOT NULL
        )`,
    ),
    check(
      'provider_session_admission_status_shape_ck',
      sql`(
          ${t.status} IN ('waiting','timed_out','rejected') AND ${t.acquired_at} IS NULL
        ) OR (
          ${t.status} IN ('acquired','released','lease_expired') AND ${t.acquired_at} IS NOT NULL
        ) OR ${t.status} = 'cancelled'`,
    ),
    check(
      'provider_session_admission_terminal_shape_ck',
      sql`(
          ${t.status} IN ('waiting','acquired')
          AND ${t.terminal_at} IS NULL
          AND ${t.terminal_reason} IS NULL
        ) OR (
          ${t.status} IN ('released','timed_out','cancelled','rejected','lease_expired')
          AND ${t.terminal_at} IS NOT NULL
          AND ${t.terminal_reason} IS NOT NULL
          AND btrim(${t.terminal_reason}) <> ''
        )`,
    ),
    check(
      'provider_session_admission_borrow_shape_ck',
      sql`${t.borrowed_from_task_run_id} IS NULL OR (
        ${t.borrowed_from_task_run_id} <> ${t.task_run_id}
        AND ${t.acquired_at} IS NOT NULL
        AND ${t.status} IN ('acquired','released','cancelled','lease_expired')
      )`,
    ),
    check(
      'provider_session_admission_timeline_ck',
      sql`${t.wait_deadline_at} > ${t.requested_at}
        AND (${t.acquired_at} IS NULL OR (
          ${t.acquired_at} >= ${t.requested_at}
          AND ${t.acquired_at} < ${t.wait_deadline_at}
          AND ${t.heartbeat_at} >= ${t.acquired_at}
          AND ${t.lease_expires_at} > ${t.heartbeat_at}
          AND ${t.hard_reclaim_at} >= ${t.lease_expires_at}
        ))
        AND (${t.terminal_at} IS NULL OR (
          ${t.terminal_at} >= ${t.requested_at}
          AND (${t.acquired_at} IS NULL OR ${t.terminal_at} >= ${t.acquired_at})
        ))
        AND (${t.status} <> 'timed_out' OR ${t.terminal_at} >= ${t.wait_deadline_at})
        AND (${t.status} <> 'lease_expired' OR ${t.terminal_at} >= ${t.lease_expires_at})`,
    ),
  ],
);

export const tool_call_log = pgTable('tool_call_log', {
  id: text('id').primaryKey(),
  // Intentional loose coupling — NO hard FK to ai_task_runs.id. task_run_id is
  // written during the run (frequently before the ai_task_runs row is committed),
  // so a real FK would break INSERTs. Treated as a free-form text correlation id.
  task_run_id: text('task_run_id').notNull(),
  task_kind: text('task_kind').notNull(),
  tool_name: text('tool_name').notNull(),
  // YUK-79 (Foundation D M1): DomainTool registry classification.
  // null = pre-registry runner.ts auto-mirror (existing path).
  // 'read' | 'propose' | 'write' = tool registered via src/server/ai/tools.
  effect: text('effect'),
  input_json: jsonb('input_json').$type<JsonObject>(),
  output_json: jsonb('output_json').$type<JsonObject>(),
  // YUK-79: hard-fail capture (timeout / parse error / unsupported input).
  // Soft-fail (empty result) uses output_json + summary, not error_reason.
  error_reason: text('error_reason'),
  iteration: integer('iteration').notNull(),
  latency_ms: real('latency_ms').notNull(),
  // YUK-359: always 0 by design — NOT a stub. DomainTools are local DB
  // operations with no LLM cost; the few tools that inline-nest a runTask
  // (e.g. author_question → QuestionAuthorTask) have their LLM cost recorded
  // authoritatively in cost_ledger (keyed by the nested task's own run id), so
  // recording it here too would double-count. Cost reports (/api/cost/today)
  // read cost_ledger, never this column. The per-turn→nested-task attribution
  // chain (which copilot turn drove which LLM spend) is the real gap, tracked
  // in YUK-204, not solvable by filling this column.
  cost: real('cost').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
  // YUK-79: FK to event when mirrorEvent policy fires.
  // Lane D writes this when the bridge mirrors a tool_use into the event log.
  mirrored_event_id: text('mirrored_event_id'),
});

export const tool_operation = pgTable(
  'tool_operation',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id'),
    task_run_id: text('task_run_id'),
    tool_name: text('tool_name').notNull(),
    effect: text('effect').notNull(),
    status: text('status').notNull().default('running'),
    process_id: text('process_id').notNull(),
    input_hash: text('input_hash').notNull(),
    input_json: jsonb('input_json').$type<JsonObject>().notNull(),
    result_json: jsonb('result_json').$type<JsonObject>(),
    error_json: jsonb('error_json').$type<{ code: string; message: string }>(),
    side_effect_risk: text('side_effect_risk'),
    cancelled_by: text('cancelled_by'),
    terminal_tool_call_log_id: text('terminal_tool_call_log_id'),
    hard_deadline_at: timestamp('hard_deadline_at', { withTimezone: true }),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    owner_heartbeat_at: timestamp('owner_heartbeat_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    settled_at: timestamp('settled_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_operation_running_lease_idx').on(t.status, t.lease_expires_at),
    index('tool_operation_session_idx').on(t.session_id, t.started_at),
    check('tool_operation_effect_ck', sql`${t.effect} IN ('read','propose','write')`),
    check('tool_operation_input_hash_ck', sql`${t.input_hash} ~ '^[0-9a-f]{64}$'`),
    check(
      'tool_operation_identity_bounds_ck',
      sql`char_length(${t.id}) BETWEEN 1 AND 256
        AND char_length(${t.tool_name}) BETWEEN 1 AND 256
        AND char_length(${t.process_id}) BETWEEN 1 AND 256
        AND (${t.session_id} IS NULL OR char_length(${t.session_id}) BETWEEN 1 AND 256)
        AND (${t.task_run_id} IS NULL OR char_length(${t.task_run_id}) BETWEEN 1 AND 256)
        AND (${t.terminal_tool_call_log_id} IS NULL
          OR char_length(${t.terminal_tool_call_log_id}) BETWEEN 1 AND 256)`,
    ),
    check(
      'tool_operation_json_bounds_ck',
      sql`jsonb_typeof(${t.input_json}) = 'object'
        AND octet_length(${t.input_json}::text) <= 131072
        AND (${t.result_json} IS NULL OR (
          jsonb_typeof(${t.result_json}) = 'object'
          AND octet_length(${t.result_json}::text) <= 131072
        ))`,
    ),
    check(
      'tool_operation_error_bounds_ck',
      sql`${t.error_json} IS NULL OR (
        jsonb_typeof(${t.error_json}) = 'object'
        AND ${t.error_json} ? 'code'
        AND ${t.error_json} ? 'message'
        AND char_length(${t.error_json}->>'code') BETWEEN 1 AND 100
        AND char_length(${t.error_json}->>'message') BETWEEN 1 AND 4000
      )`,
    ),
    check(
      'tool_operation_status_ck',
      sql`${t.status} IN ('running','succeeded','failed','cancelled','lost')`,
    ),
    check(
      'tool_operation_cancelled_by_ck',
      sql`${t.cancelled_by} IS NULL OR ${t.cancelled_by} IN ('model','system','user')`,
    ),
    check(
      'tool_operation_terminal_shape_ck',
      sql`(
        ${t.status} = 'running'
        AND ${t.settled_at} IS NULL
        AND ${t.result_json} IS NULL
        AND ${t.error_json} IS NULL
        AND ${t.side_effect_risk} IS NULL
        AND ${t.cancelled_by} IS NULL
      ) OR (
        ${t.status} = 'succeeded'
        AND ${t.settled_at} IS NOT NULL
        AND ${t.error_json} IS NULL
        AND ${t.side_effect_risk} IS NULL
        AND ${t.cancelled_by} IS NULL
      ) OR (
        ${t.status} = 'failed'
        AND ${t.settled_at} IS NOT NULL
        AND ${t.result_json} IS NULL
        AND ${t.error_json} IS NOT NULL
        AND ${t.side_effect_risk} IS NULL
        AND ${t.cancelled_by} IS NULL
      ) OR (
        ${t.status} = 'cancelled'
        AND ${t.settled_at} IS NOT NULL
        AND ${t.result_json} IS NULL
        AND ${t.error_json} IS NOT NULL
        AND ${t.side_effect_risk} IS NULL
        AND ${t.cancelled_by} IS NOT NULL
      ) OR (
        ${t.status} = 'lost'
        AND ${t.settled_at} IS NOT NULL
        AND ${t.result_json} IS NULL
        AND ${t.error_json} IS NOT NULL
        AND ${t.side_effect_risk} IN ('none','possible')
        AND ${t.cancelled_by} IS NULL
      )`,
    ),
    check(
      'tool_operation_timeline_ck',
      sql`${t.settled_at} IS NULL OR ${t.settled_at} >= ${t.started_at}`,
    ),
    check(
      'tool_operation_lease_timeline_ck',
      sql`${t.owner_heartbeat_at} >= ${t.started_at}
        AND ${t.lease_expires_at} > ${t.owner_heartbeat_at}`,
    ),
  ],
);

export const subagent_run = pgTable(
  'subagent_run',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id').notNull(),
    parent_turn_event_id: text('parent_turn_event_id').notNull(),
    launch_key: text('launch_key').notNull(),
    parent_task_run_id: text('parent_task_run_id'),
    objective_hash: text('objective_hash').notNull(),
    objective: text('objective').notNull(),
    status: text('status').notNull().default('queued'),
    cancel_requested_by: text('cancel_requested_by'),
    cancel_requested_at: timestamp('cancel_requested_at', { withTimezone: true }),
    claim_token: text('claim_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    hard_deadline_at: timestamp('hard_deadline_at', { withTimezone: true }),
    child_task_run_id: text('child_task_run_id'),
    started_event_id: text('started_event_id').notNull(),
    settled_event_id: text('settled_event_id'),
    pg_boss_job_id: text('pg_boss_job_id'),
    result_md: text('result_md'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp('started_at', { withTimezone: true }),
    settled_at: timestamp('settled_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subagent_run_parent_launch_uq').on(
      t.session_id,
      t.parent_turn_event_id,
      t.launch_key,
    ),
    index('subagent_run_recovery_idx').on(t.status, t.lease_expires_at),
    check('subagent_run_objective_hash_ck', sql`${t.objective_hash} ~ '^[0-9a-f]{64}$'`),
    check(
      'subagent_run_status_ck',
      sql`${t.status} IN ('queued','running','succeeded','failed','cancelled','lost')`,
    ),
    check(
      'subagent_run_cancel_owner_ck',
      sql`${t.cancel_requested_by} IS NULL OR ${t.cancel_requested_by} IN ('model','system','user')`,
    ),
    check(
      'subagent_run_bounds_ck',
      sql`char_length(${t.objective}) BETWEEN 1 AND 12000 AND char_length(${t.launch_key}) BETWEEN 1 AND 120`,
    ),
  ],
);

export const copilot_continuation = pgTable(
  'copilot_continuation',
  {
    id: text('id').primaryKey(),
    subagent_run_id: text('subagent_run_id').notNull(),
    session_id: text('session_id').notNull(),
    parent_turn_event_id: text('parent_turn_event_id').notNull(),
    result_event_id: text('result_event_id').notNull(),
    status: text('status').notNull().default('pending'),
    claim_token: text('claim_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    task_run_id: text('task_run_id'),
    reply_event_id: text('reply_event_id'),
    pg_boss_job_id: text('pg_boss_job_id'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp('started_at', { withTimezone: true }),
    settled_at: timestamp('settled_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('copilot_continuation_subagent_uq').on(t.subagent_run_id),
    uniqueIndex('copilot_continuation_result_event_uq').on(t.result_event_id),
    uniqueIndex('copilot_continuation_one_running_per_session_uq')
      .on(t.session_id)
      .where(sql`${t.status} = 'running'`),
    index('copilot_continuation_recovery_idx').on(t.status, t.lease_expires_at),
    check(
      'copilot_continuation_status_ck',
      sql`${t.status} IN ('pending','running','succeeded','failed','cancelled','lost','skipped')`,
    ),
  ],
);

export const cost_ledger = pgTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    // Intentional loose coupling — NO hard FK to ai_task_runs.id. task_run_id is
    // nullable and is often written before the ai_task_runs row exists, so a real
    // FK would break INSERTs. Treated as a free-form text correlation id.
    task_run_id: text('task_run_id'),
    task_kind: text('task_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    // Nullable only for entry_kind='attempt' + cost_basis='unknown'. Legacy
    // writers remain numeric and are deliberately not back-classified.
    cost: real('cost'),
    // YUK-359: `cost` 是原始计费值（evidence-first，不写入折算）；币种由本列标记。
    // 历史行 + runner(mimo USD) 默认 'USD'；GLM-OCR / memory(GLM/百炼) 写 'CNY'。
    // 读路径必须按 currency 分组聚合，绝不裸 SUM 混币（cost-today / ai-observability）。
    currency: text('currency').notNull().default('USD'),
    // YUK-841 — pre-cutover and non-runner correlation rows remain `legacy`.
    // The central AI runner is the only writer of `attempt` rows.
    entry_kind: text('entry_kind').notNull().default('legacy'),
    cost_basis: text('cost_basis'),
    cost_ref: text('cost_ref'),
    tokens_in: integer('tokens_in'),
    tokens_out: integer('tokens_out'),
    outcome: text('outcome').notNull().default('success'),
    pgboss_job_id: text('pgboss_job_id'),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('cost_ledger_task_run_idx').on(t.task_run_id),
    uniqueIndex('cost_ledger_attempt_task_run_uq')
      .on(t.task_run_id)
      .where(sql`${t.entry_kind} = 'attempt'`),
    check('cost_ledger_entry_kind_ck', sql`${t.entry_kind} IN ('legacy','attempt')`),
    check(
      'cost_ledger_cost_basis_ck',
      sql`${t.cost_basis} IS NULL OR ${t.cost_basis} IN ('reported','estimated','unknown')`,
    ),
    check(
      'cost_ledger_tokens_pair_ck',
      sql`(
        (${t.tokens_in} IS NULL AND ${t.tokens_out} IS NULL)
        OR (
          ${t.tokens_in} IS NOT NULL AND ${t.tokens_out} IS NOT NULL
          AND ${t.tokens_in} >= 0 AND ${t.tokens_out} >= 0
        )
      )`,
    ),
    check(
      'cost_ledger_attempt_truth_ck',
      sql`(
        ${t.entry_kind} = 'legacy'
        AND ${t.cost} IS NOT NULL
        AND ${t.cost_basis} IS NULL
        AND ${t.cost_ref} IS NULL
      ) OR (
        ${t.entry_kind} = 'attempt'
        AND ${t.task_run_id} IS NOT NULL
        AND ${t.cost_basis} IS NOT NULL
        AND ${t.cost_ref} IS NOT NULL
        AND btrim(${t.cost_ref}) <> ''
        AND (
          (${t.cost_basis} = 'unknown' AND ${t.cost} IS NULL)
          OR (${t.cost_basis} IN ('reported','estimated') AND ${t.cost} IS NOT NULL AND ${t.cost} >= 0)
        )
      )`,
    ),
  ],
);

// YUK-1563: one row, the last models.dev document that parsed. Absent or
// unreadable → readers stay on the committed snapshot. Refresh never deletes
// this row on a failed pull.
export const model_catalog_cache = pgTable(
  'model_catalog_cache',
  {
    id: smallint('id').primaryKey(),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull(),
    version: text('version').notNull(),
    upstream_version: text('upstream_version').notNull(),
    source_url: text('source_url').notNull(),
    payload: jsonb('payload').notNull(),
    findings: jsonb('findings').notNull(),
  },
  (t) => [check('model_catalog_cache_singleton', sql`${t.id} = 1`)],
);

// YUK-1563 part 4 — runtime-configured custom providers. Authored config, no
// secret: api_key_env holds the env var NAME; the key value stays in the
// operator's env. Model facts live in model_catalog_cache under a synthetic
// `custom:<slug>` bucket, never here.
export const custom_provider = pgTable(
  'custom_provider',
  {
    id: text('id').primaryKey(),
    display_name: text('display_name').notNull(),
    base_url: text('base_url').notNull(),
    api_key_env: text('api_key_env').notNull(),
    protocol: text('protocol').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('custom_provider_id_prefix_ck', sql`${t.id} LIKE 'custom:%'`),
    check(
      'custom_provider_protocol_ck',
      sql`${t.protocol} IN ('openai-completions', 'anthropic-messages')`,
    ),
    check(
      'custom_provider_base_url_ck',
      sql`${t.base_url} LIKE 'https://%' AND ${t.base_url} NOT LIKE '%@%' AND ${t.base_url} NOT LIKE '%?%' AND ${t.base_url} NOT LIKE '%#%'`,
    ),
  ],
);
