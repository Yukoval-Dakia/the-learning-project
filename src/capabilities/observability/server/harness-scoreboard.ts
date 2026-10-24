// YUK-1557 / ADR-0075 C6-2 — deterministic harness scoreboard.
//
// The metric definitions live in ADR-0075 §D7 (M1–M7). This module only reads
// raw tables and folds them; it never invokes a model and never writes business
// state. M3/M4/M5 are lists of ADR sub-items (`parts`); each part states its own
// numerator/denominator, basis and definition, so a sub-item the raw tables
// cannot answer is marked instead of replaced by a different number.
//
// Consumers:
//   - jobs/harness_scoreboard_daily.ts (daily projection event)
//   - api/harness-scoreboard.ts (status page read)
//   - scripts/harness-scoreboard.ts (recompute CLI)

import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { learnerDayWindowUtc, learnerLocalDay } from '@/core/learner-day';
import {
  HARNESS_SCOREBOARD_EVENT_ACTION,
  HARNESS_SCOREBOARD_VERSION,
  type HarnessMetricBasisT,
  type HarnessMetricPartT,
  type HarnessMetricRayT,
  HarnessScoreboardV2,
  type HarnessScoreboardV2T,
} from '@/core/schema/harness-scoreboard';
import type { Db } from '@/db/client';
import {
  ai_task_runs,
  cost_ledger,
  event,
  knowledge,
  knowledge_edge,
  question,
  tool_call_log,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { type ProposalInboxRow, listProposalInboxRows } from '@/kernel/proposals/inbox';

const LOOP_THRESHOLD = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const KR_WRITE_TOOLS = [
  'propose_knowledge_mutation',
  'propose_knowledge_edge',
  'mcp__loom__write_proposal',
  'write_proposal',
];

const DUPLICATE_SUBMIT_REASONS = new Set(['duplicate_exact', 'duplicate_source', 'near_dup']);

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function usageField(usage: unknown, key: string): number | null {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricPart(input: {
  key: string;
  value: number | null;
  numerator?: number | null;
  denominator?: number | null;
  basis: HarnessMetricBasisT;
  note: string;
}): HarnessMetricPartT {
  return {
    key: input.key,
    value: input.value,
    numerator: input.numerator ?? null,
    denominator: input.denominator ?? null,
    basis: input.basis,
    note: input.note,
  };
}

/** Metric-level basis: measured only when every sub-item is measured. */
function partsBasis(parts: readonly HarnessMetricPartT[]): HarnessMetricBasisT {
  if (parts.length === 0) return 'unavailable';
  if (parts.every((part) => part.basis === 'measured')) return 'measured';
  if (parts.every((part) => part.basis === 'unavailable')) return 'unavailable';
  return 'proxy';
}

function normalizeToolRow(row: { tool_name: string; input_json: unknown }): {
  key: string;
  layer: 'bridge' | 'mirror' | 'other';
} {
  const mirrorPrefix = 'mcp__loom__';
  const mirror = row.tool_name.startsWith(mirrorPrefix);
  return {
    key: `${mirror ? row.tool_name.slice(mirrorPrefix.length) : row.tool_name}:${createHash(
      'sha256',
    )
      .update(JSON.stringify(row.input_json ?? {}))
      .digest('hex')}`,
    layer: mirror ? 'mirror' : row.tool_name.startsWith('mcp__') ? 'other' : 'bridge',
  };
}

interface ToolGroup {
  task_kind: string;
  bridge: number;
  mirror: number;
  other: number;
}

function toolGroups(
  rows: ReadonlyArray<{
    task_run_id: string;
    task_kind: string;
    tool_name: string;
    input_json: unknown;
  }>,
): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  for (const row of rows) {
    const normalized = normalizeToolRow(row);
    const key = `${row.task_run_id}:${normalized.key}`;
    const group = groups.get(key) ?? {
      task_kind: row.task_kind,
      bridge: 0,
      mirror: 0,
      other: 0,
    };
    group[normalized.layer] += 1;
    groups.set(key, group);
  }
  return groups;
}

function addRay(
  bucket: Map<string, { numerator: number; denominator: number }>,
  key: string,
  n: number,
  d: number,
) {
  const row = bucket.get(key) ?? { numerator: 0, denominator: 0 };
  row.numerator += n;
  row.denominator += d;
  bucket.set(key, row);
}

function rays(
  bucket: Map<string, { numerator: number; denominator: number }>,
): HarnessMetricRayT[] {
  return [...bucket.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => ({
      key,
      value: ratio(values.numerator, values.denominator),
      numerator: values.numerator,
      denominator: values.denominator,
    }));
}

/**
 * M3 — dropped paid output per producer, following the ADR's four sub-items.
 * Each part counts dropped attempts over attempts that reached the producer's
 * terminal record, so 1 - value is the delivered share.
 */
async function computeM3(
  db: Db,
  from: Date,
  to: Date,
): Promise<HarnessScoreboardV2T['m3_dropped_paid_output']> {
  const inWindow = (column: AnyPgColumn) => and(gte(column, from), lt(column, to));

  const quizRows = await db
    .select({ outcome: event.outcome, payload: event.payload })
    .from(event)
    .where(and(eq(event.action, 'experimental:quiz_gen'), inWindow(event.created_at)));
  let quizAttempts = 0;
  let quizDropped = 0;
  for (const row of quizRows) {
    if (row.outcome !== 'success' && row.outcome !== 'failure') continue;
    quizAttempts += 1;
    if (row.outcome === 'success') continue;
    // 'event'/'dispatch' failures happen after the drafts were persisted, so the
    // paid batch did land even though the job reported failure.
    const stage = asRecord(row.payload).failure_stage;
    if (stage === 'event' || stage === 'dispatch') continue;
    quizDropped += 1;
  }

  const verifyRows = await db
    .select({ subjectId: event.subject_id, outcome: event.outcome })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:source_verify'),
        eq(event.subject_kind, 'question'),
        inWindow(event.created_at),
      ),
    );
  const verifyFailedByQuestion = new Map<string, boolean>();
  for (const row of verifyRows) {
    if (row.subjectId === null) continue;
    if (row.outcome !== 'success' && row.outcome !== 'failure') continue;
    const failed = verifyFailedByQuestion.get(row.subjectId) ?? false;
    verifyFailedByQuestion.set(row.subjectId, failed || row.outcome === 'failure');
  }
  const verifiedQuestions = verifyFailedByQuestion.size;
  const rejectedQuestions = [...verifyFailedByQuestion.values()].filter(Boolean).length;

  const noteRows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:artifact_lifecycle'),
        eq(event.actor_ref, 'note_generate'),
        inWindow(event.created_at),
        sql`${event.payload}->>'op' = 'set_generation_status'`,
        sql`${event.payload}->>'generation_status' in ('ready', 'failed')`,
      ),
    );
  let noteAttempts = 0;
  let noteDropped = 0;
  for (const row of noteRows) {
    const generationStatus = asRecord(row.payload).generation_status;
    if (generationStatus !== 'ready' && generationStatus !== 'failed') continue;
    noteAttempts += 1;
    if (generationStatus === 'failed') noteDropped += 1;
  }

  const krRows = await db
    .select({ output: tool_call_log.output_json, error: tool_call_log.error_reason })
    .from(tool_call_log)
    .where(
      and(
        eq(tool_call_log.task_kind, 'KnowledgeReviewTask'),
        inArray(tool_call_log.tool_name, KR_WRITE_TOOLS),
        inWindow(tool_call_log.occurred_at),
      ),
    );
  let krAttempts = 0;
  let krDropped = 0;
  for (const row of krRows) {
    krAttempts += 1;
    if (!proposalWriteLanded(row)) krDropped += 1;
  }

  const parts = [
    metricPart({
      key: 'quiz_gen_batches',
      value: ratio(quizDropped, quizAttempts),
      numerator: quizDropped,
      denominator: quizAttempts,
      basis: 'measured',
      note: 'terminal experimental:quiz_gen batches; a failure counts as dropped unless the drafts were already persisted (failure_stage event/dispatch).',
    }),
    metricPart({
      key: 'source_consistency_questions',
      value: ratio(rejectedQuestions, verifiedQuestions),
      numerator: rejectedQuestions,
      denominator: verifiedQuestions,
      basis: 'measured',
      note: 'questions with a terminal experimental:source_verify verdict in the window; rejected = at least one failure verdict. Transient outcome=error is excluded.',
    }),
    metricPart({
      key: 'note_generation_attempts',
      value: ratio(noteDropped, noteAttempts),
      numerator: noteDropped,
      denominator: noteAttempts,
      basis: 'measured',
      note: 'note_generate terminal set_generation_status transitions; every paid attempt is one event, so a retry counts separately.',
    }),
    metricPart({
      key: 'knowledge_review_writes',
      value: ratio(krDropped, krAttempts),
      numerator: krDropped,
      denominator: krAttempts,
      basis: 'measured',
      note: 'KnowledgeReviewTask proposal tool calls; landed = no error_reason and status=proposed (legacy write_proposal: proposal_id). 1 - value is the KR write success rate.',
    }),
  ];
  return {
    parts,
    basis: partsBasis(parts),
    note: 'dropped/attempted per sub-item; each part note names the attempt and rejection definition.',
  };
}

interface KnowledgeRefs {
  /** Every referenced knowledge node; used for conflict detection. */
  ids: string[];
  /** Nodes whose missing/archived state blocks acceptance; used for closable. */
  preconditionIds: string[];
  expectedVersions: Map<string, number>;
  archiveEdgeIds: string[];
}

function proposalKnowledgeRefs(row: ProposalInboxRow): KnowledgeRefs {
  const refs: KnowledgeRefs = {
    ids: [],
    preconditionIds: [],
    expectedVersions: new Map(),
    archiveEdgeIds: [],
  };
  const change = asRecord(row.payload.proposed_change);
  const addId = (value: unknown, precondition = false) => {
    if (typeof value !== 'string' || value.length === 0) return;
    refs.ids.push(value);
    if (precondition) refs.preconditionIds.push(value);
  };
  const addVersion = (id: unknown, version: unknown) => {
    if (typeof id === 'string' && typeof version === 'number' && Number.isFinite(version)) {
      refs.expectedVersions.set(id, version);
    }
  };

  switch (row.kind) {
    case 'knowledge_node':
      // The new node's id is minted at accept; only the parent is an existing node.
      addId(change.parent_id, true);
      break;
    case 'knowledge_mutation': {
      const mutation = change.mutation;
      if (mutation === 'reparent') {
        addId(change.node_id, true);
        addId(change.new_parent_id, true);
        addVersion(change.node_id, change.expected_version);
      } else if (mutation === 'merge') {
        for (const id of Array.isArray(change.from_ids) ? change.from_ids : []) addId(id, true);
        addId(change.into_id, true);
        for (const [id, version] of Object.entries(asRecord(change.expected_versions))) {
          addVersion(id, version);
        }
      } else if (mutation === 'split') {
        addId(change.from_id, true);
        for (const branch of Array.isArray(change.into) ? change.into : []) {
          addId(asRecord(branch).parent_id, true);
        }
        addVersion(change.from_id, change.expected_version);
      }
      break;
    }
    case 'archive':
      addId(change.node_id, true);
      addVersion(change.node_id, change.expected_version);
      break;
    case 'knowledge_edge':
      addId(change.from_knowledge_id, true);
      addId(change.to_knowledge_id, true);
      if (typeof change.archive_edge_id === 'string')
        refs.archiveEdgeIds.push(change.archive_edge_id);
      break;
    case 'image_candidate':
    case 'question_draft':
      for (const id of Array.isArray(change.knowledge_ids) ? change.knowledge_ids : []) addId(id);
      break;
    case 'goal_scope':
      for (const id of Array.isArray(change.scope_knowledge_ids) ? change.scope_knowledge_ids : [])
        addId(id);
      break;
    default:
      break;
  }
  refs.ids = [...new Set(refs.ids)];
  refs.preconditionIds = [...new Set(refs.preconditionIds)];
  return refs;
}

function isClosable(
  refs: KnowledgeRefs,
  liveVersions: ReadonlyMap<string, number>,
  liveEdgeIds: ReadonlySet<string>,
): boolean {
  for (const id of refs.preconditionIds) {
    if (!liveVersions.has(id)) return true;
  }
  for (const [id, expected] of refs.expectedVersions) {
    if (liveVersions.get(id) !== expected) return true;
  }
  for (const edgeId of refs.archiveEdgeIds) {
    if (!liveEdgeIds.has(edgeId)) return true;
  }
  return false;
}

/**
 * M4 — inbox backlog as of the window end. Pending membership reuses the inbox
 * projection with `asOf` so terminal rates/corrections after the window do not
 * retroactively empty the backlog; admission checks still read current rows.
 */
async function computeM4(db: Db, to: Date): Promise<HarnessScoreboardV2T['m4_inbox_backlog']> {
  const pendingRows = await listProposalInboxRows(db, { status: 'pending', asOf: to });
  const pending = pendingRows.length;
  const oldest = pendingRows.reduce<Date | null>(
    (best, row) => (best === null || row.proposed_at < best ? row.proposed_at : best),
    null,
  );
  const oldestDays =
    oldest === null ? null : Math.max(0, (to.getTime() - oldest.getTime()) / DAY_MS);

  const refsByRow = new Map<string, KnowledgeRefs>();
  const knowledgeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const row of pendingRows) {
    const refs = proposalKnowledgeRefs(row);
    refsByRow.set(row.id, refs);
    for (const id of refs.ids) knowledgeIds.add(id);
    for (const id of refs.archiveEdgeIds) edgeIds.add(id);
  }

  const knowledgeRows =
    knowledgeIds.size === 0
      ? []
      : await db
          .select({
            id: knowledge.id,
            version: knowledge.version,
            archivedAt: knowledge.archived_at,
          })
          .from(knowledge)
          .where(inArray(knowledge.id, [...knowledgeIds]));
  const liveVersions = new Map(
    knowledgeRows
      .filter((row) => row.archivedAt === null)
      .map((row) => [row.id, row.version] as const),
  );

  const edgeRows =
    edgeIds.size === 0
      ? []
      : await db
          .select({ id: knowledge_edge.id, archivedAt: knowledge_edge.archived_at })
          .from(knowledge_edge)
          .where(inArray(knowledge_edge.id, [...edgeIds]));
  const liveEdgeIds = new Set(
    edgeRows.filter((row) => row.archivedAt === null).map((row) => row.id),
  );

  let closable = 0;
  const rowsByKnowledgeId = new Map<string, Set<string>>();
  let pendingWithKnowledgeRefs = 0;
  for (const row of pendingRows) {
    const refs = refsByRow.get(row.id);
    if (!refs) continue;
    if (isClosable(refs, liveVersions, liveEdgeIds)) closable += 1;
    if (refs.ids.length > 0) pendingWithKnowledgeRefs += 1;
    for (const id of refs.ids) {
      const holders = rowsByKnowledgeId.get(id) ?? new Set<string>();
      holders.add(row.id);
      rowsByKnowledgeId.set(id, holders);
    }
  }
  let conflictInvolved = 0;
  for (const row of pendingRows) {
    const refs = refsByRow.get(row.id);
    if (!refs || refs.ids.length === 0) continue;
    if (refs.ids.some((id) => (rowsByKnowledgeId.get(id)?.size ?? 0) > 1)) conflictInvolved += 1;
  }

  const parts = [
    metricPart({
      key: 'pending',
      value: pending,
      basis: 'measured',
      note: 'inbox projection rows still pending at the window end; rates and corrections after `to` are ignored. Inadmissible block merges are already hidden by the projection.',
    }),
    metricPart({
      key: 'oldest_pending_days',
      value: oldestDays,
      basis: 'measured',
      note: 'age of the oldest pending row measured at the window end.',
    }),
    metricPart({
      key: 'closable',
      value: ratio(closable, pending),
      numerator: closable,
      denominator: pending,
      basis: 'measured',
      note: 'pending rows whose required knowledge target (parent, mutation node or edge endpoint) is missing/archived, whose expected_version no longer matches, or whose archive edge target is already gone. Other already-satisfied kinds are not covered by this predicate.',
    }),
    metricPart({
      key: 'conflict_involved',
      value: ratio(conflictInvolved, pendingWithKnowledgeRefs),
      numerator: conflictInvolved,
      denominator: pendingWithKnowledgeRefs,
      basis: 'measured',
      note: 'pending rows sharing at least one referenced knowledge node with another pending row; denominator = pending rows that reference a knowledge node.',
    }),
  ];
  return {
    parts,
    basis: partsBasis(parts),
    note: 'pending/oldest are gauges at the window end; closable/conflict are ratios over that pending set.',
  };
}

/**
 * M5 — new-ingest duplicate rate plus same-name twins among window-created
 * knowledge nodes (same normalized name AND same parent).
 */
async function computeM5(
  db: Db,
  from: Date,
  to: Date,
): Promise<HarnessScoreboardV2T['m5_duplicate_rate']> {
  const inWindow = (column: AnyPgColumn) => and(gte(column, from), lt(column, to));

  const [newQuestions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(question)
    .where(inWindow(question.created_at));
  const newQuestionCount = asNumber(newQuestions?.count);

  const submitRows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.action, 'experimental:question_draft_submit'), inWindow(event.created_at)));
  let submitDuplicates = 0;
  for (const row of submitRows) {
    const receipt = asRecord(asRecord(row.payload).receipt);
    if (
      receipt.status === 'conflict' &&
      typeof receipt.reason === 'string' &&
      DUPLICATE_SUBMIT_REASONS.has(receipt.reason)
    ) {
      submitDuplicates += 1;
    }
  }

  const quizGenRows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.action, 'experimental:quiz_gen'), inWindow(event.created_at)));
  let quizGenExactDuplicates = 0;
  for (const row of quizGenRows) {
    quizGenExactDuplicates += asNumber(asRecord(row.payload).exact_duplicate_count);
  }
  const duplicates = submitDuplicates + quizGenExactDuplicates;

  const knowledgeRows = await db
    .select({ name: knowledge.name, parentId: knowledge.parent_id })
    .from(knowledge)
    .where(inWindow(knowledge.created_at));
  const twinGroups = new Map<string, number>();
  for (const row of knowledgeRows) {
    const key = `${row.name.trim().toLowerCase()}\u0000${row.parentId ?? ''}`;
    twinGroups.set(key, (twinGroups.get(key) ?? 0) + 1);
  }
  let twinPairs = 0;
  for (const count of twinGroups.values()) if (count > 1) twinPairs += count - 1;

  const parts = [
    metricPart({
      key: 'new_question_duplicates',
      value: ratio(duplicates, newQuestionCount),
      numerator: duplicates,
      denominator: newQuestionCount,
      basis: 'measured',
      note: 'numerator = question_draft_submit duplicate_exact/duplicate_source/near_dup conflicts + QuizGen exact_duplicate_count; denominator = question rows created in the window (drafts included; promotion does not move created_at). The ratio can exceed 1.',
    }),
    metricPart({
      key: 'same_name_same_parent_pairs',
      value: twinPairs,
      basis: 'measured',
      note: 'knowledge rows created in the window grouped by normalized name + parent_id; each extra row in a group is one twin pair.',
    }),
  ];
  return {
    parts,
    basis: partsBasis(parts),
    note: 'duplicates per newly banked question plus same-parent same-name twin pairs created in the window.',
  };
}

/** True when a KR proposal tool call actually wrote a proposal event. */
function proposalWriteLanded(row: { output: unknown; error: string | null }): boolean {
  if (row.error !== null) return false;
  const output = asRecord(row.output);
  if (output.status === 'proposed') return true;
  // Pre-YUK-1553 custom tool returned { proposal_id, kind } with no status.
  return typeof output.proposal_id === 'string' && typeof output.status !== 'string';
}

export async function computeHarnessScoreboard(
  db: Db,
  input: { fromDay: string; toDay: string; now?: Date },
): Promise<HarnessScoreboardV2T> {
  const { from, to } = learnerDayWindowUtc(input.fromDay, input.toDay);
  const now = input.now ?? new Date();
  const windowWhere = (column: AnyPgColumn) => and(gte(column, from), lt(column, to));

  const runRows = await db
    .select({
      task_kind: ai_task_runs.task_kind,
      status: ai_task_runs.status,
      provider: ai_task_runs.provider,
      model: ai_task_runs.model,
      usage_json: ai_task_runs.usage_json,
      cost_usd: ai_task_runs.cost_usd,
      started_at: ai_task_runs.started_at,
    })
    .from(ai_task_runs)
    .where(windowWhere(ai_task_runs.started_at));

  const m1ByTask = new Map<string, { numerator: number; denominator: number }>();
  let failedInputTokens = 0;
  let totalInputTokens = 0;
  let terminalRuns = 0;
  let runsMissingUsageFields = 0;
  let failedRuns = 0;
  let failedRunsNullCost = 0;

  for (const run of runRows) {
    const inputTokens = asNumber(usageField(run.usage_json, 'inputTokens'));
    const terminal = run.status !== 'running';
    totalInputTokens += inputTokens;
    addRay(m1ByTask, run.task_kind, run.status === 'failure' ? inputTokens : 0, inputTokens);
    if (terminal) {
      terminalRuns += 1;
      const missing =
        usageField(run.usage_json, 'numTurns') === null ||
        usageField(run.usage_json, 'cacheReadTokens') === null ||
        usageField(run.usage_json, 'cacheWriteTokens') === null;
      if (missing) runsMissingUsageFields += 1;
    }
    if (run.status === 'failure') {
      failedInputTokens += inputTokens;
      failedRuns += 1;
      if (run.cost_usd === null) failedRunsNullCost += 1;
    }
  }

  const toolRows = await db
    .select({
      task_run_id: tool_call_log.task_run_id,
      task_kind: tool_call_log.task_kind,
      tool_name: tool_call_log.tool_name,
      input_json: tool_call_log.input_json,
    })
    .from(tool_call_log)
    .where(windowWhere(tool_call_log.occurred_at));

  const groups = toolGroups(toolRows);
  const m2ByTask = new Map<string, { numerator: number; denominator: number }>();
  let duplicateToolCallRows = 0;
  for (const group of groups.values()) {
    const actualCalls = group.bridge > 0 ? group.bridge : group.mirror + group.other;
    addRay(m2ByTask, group.task_kind, actualCalls > LOOP_THRESHOLD ? 1 : 0, 1);
    duplicateToolCallRows += Math.min(group.bridge, group.mirror);
  }

  const dailyCostRows = await db
    .select({
      day: sql<string>`to_char(${cost_ledger.occurred_at} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      cost: sql<number>`coalesce(sum(${cost_ledger.cost}), 0)`,
    })
    .from(cost_ledger)
    .where(
      and(
        eq(cost_ledger.currency, 'USD'),
        gte(cost_ledger.occurred_at, from),
        lt(cost_ledger.occurred_at, to),
      ),
    )
    .groupBy(sql`1`);
  const dailyTokenRows = await db
    .select({
      day: sql<string>`to_char(${ai_task_runs.started_at} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      tokens: sql<number>`coalesce(sum((${ai_task_runs.usage_json}->>'inputTokens')::numeric), 0)`,
    })
    .from(ai_task_runs)
    .where(windowWhere(ai_task_runs.started_at))
    .groupBy(sql`1`);
  const dailyUserRows = await db
    .select({
      day: sql<string>`to_char(${event.created_at} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      events: sql<number>`count(*)::int`,
    })
    .from(event)
    .where(and(eq(event.actor_kind, 'user'), gte(event.created_at, from), lt(event.created_at, to)))
    .groupBy(sql`1`);

  const costByDay = new Map(dailyCostRows.map((row) => [row.day, asNumber(row.cost)]));
  const tokensByDay = new Map(dailyTokenRows.map((row) => [row.day, asNumber(row.tokens)]));
  const userByDay = new Map(dailyUserRows.map((row) => [row.day, asNumber(row.events)]));
  const daily: HarnessScoreboardV2T['m6_idle_spend']['daily'] = [];
  for (
    let cursor = Date.parse(`${input.fromDay}T00:00:00.000Z`);
    cursor <= Date.parse(`${input.toDay}T00:00:00.000Z`);
    cursor += DAY_MS
  ) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    daily.push({
      day,
      user_events: userByDay.get(day) ?? 0,
      cost_usd: costByDay.get(day) ?? 0,
      input_tokens: tokensByDay.get(day) ?? 0,
    });
  }
  const idleDays = daily.filter((row) => row.user_events === 0);
  const activeDays = daily.filter((row) => row.user_events > 0);
  const average = (rows: typeof daily, key: 'cost_usd' | 'input_tokens') =>
    rows.length === 0 ? null : rows.reduce((sum, row) => sum + row[key], 0) / rows.length;

  const exaRows = toolRows.filter((row) => row.tool_name.startsWith('mcp__exa__')).length;

  const [m3, m4, m5] = await Promise.all([
    computeM3(db, from, to),
    computeM4(db, to),
    computeM5(db, from, to),
  ]);

  return {
    version: HARNESS_SCOREBOARD_VERSION,
    generated_at: now.toISOString(),
    window: {
      from_day: input.fromDay,
      to_day: input.toDay,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    m1_zero_yield_token_share: {
      value: ratio(failedInputTokens, totalInputTokens),
      failed_input_tokens: failedInputTokens,
      total_input_tokens: totalInputTokens,
      by_task: rays(m1ByTask),
      basis: 'measured',
      note: 'failed=ai_task_runs.status=failure; empty-output runs have no separate outcome column yet.',
    },
    m2_loop_runs: {
      value: rays(m2ByTask).reduce((sum, row) => sum + row.numerator, 0),
      threshold: LOOP_THRESHOLD,
      by_task: rays(m2ByTask),
      basis: 'measured',
      note: 'one (run, tool, canonical input) group; bridge rows win over legacy mirror rows so the pre-YUK-1557 double write cannot inflate a loop.',
    },
    m3_dropped_paid_output: m3,
    m4_inbox_backlog: m4,
    m5_duplicate_rate: m5,
    m6_idle_spend: {
      currency: 'USD',
      daily,
      idle_days: idleDays.length,
      idle_daily_avg_usd: average(idleDays, 'cost_usd'),
      active_daily_avg_usd: average(activeDays, 'cost_usd'),
      basis: 'measured',
      note: 'idle day = zero actor_kind=user events in that Asia/Shanghai calendar day; USD rows only, CNY is never mixed in.',
    },
    health: {
      checked_at: now.toISOString(),
      terminal_runs: terminalRuns,
      runs_missing_usage_fields: runsMissingUsageFields,
      duplicate_tool_call_rows: duplicateToolCallRows,
      exa_tool_call_rows: exaRows,
      failed_runs: failedRuns,
      failed_runs_null_cost: failedRunsNullCost,
    },
  };
}

/** Persist one deterministic daily projection; first write wins for a version+day range. */
export async function writeHarnessScoreboard(
  db: Db,
  scoreboard: HarnessScoreboardV2T,
): Promise<string> {
  const id = `harness_scoreboard_v${scoreboard.version}_${scoreboard.window.from_day}_${scoreboard.window.to_day}`;
  await writeEvent(db, {
    id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'harness_scoreboard',
    action: HARNESS_SCOREBOARD_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: id,
    outcome: 'success',
    payload: scoreboard,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    // Meta projection: never feed the memory pipeline.
    ingest_at: new Date(scoreboard.generated_at),
    created_at: new Date(scoreboard.generated_at),
  });
  return id;
}

/** Latest persisted scoreboard (status page read). */
export async function readLatestHarnessScoreboard(
  db: Db,
  now: Date = new Date(),
): Promise<{ scoreboard: HarnessScoreboardV2T; age_hours: number } | null> {
  const rows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(eq(event.action, HARNESS_SCOREBOARD_EVENT_ACTION))
    .orderBy(sql`${event.created_at} desc`)
    .limit(1);
  const row = rows[0];
  if (!row || row.payload === null || typeof row.payload !== 'object') return null;
  const parsed = HarnessScoreboardV2.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    scoreboard: parsed.data,
    age_hours: Math.max(0, (now.getTime() - row.created_at.getTime()) / (60 * 60 * 1000)),
  };
}

/** Run the daily job for yesterday's Asia/Shanghai day. */
export async function runHarnessScoreboardDaily(
  db: Db,
  now: Date = new Date(),
): Promise<{ eventId: string; scoreboard: HarnessScoreboardV2T }> {
  const toDay = learnerLocalDay(new Date(now.getTime() - DAY_MS));
  const scoreboard = await computeHarnessScoreboard(db, { fromDay: toDay, toDay, now });
  const eventId = await writeHarnessScoreboard(db, scoreboard);
  return { eventId, scoreboard };
}
