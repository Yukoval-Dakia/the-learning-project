import { getCurrentFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';

// Knowledge graph read tools. Traversal stays server-side so callers get bounded,
// named context instead of raw rows.

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { masteryDecayBucket } from '@/core/mastery-freshness';
import type { Db } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { loadKnowledgeFailureRuns } from '@/kernel/read-models/learner-activity';
import {
  abilityReadingsByIdOrFail,
  readLearnerJudgments,
} from '@/kernel/read-models/learner-judgment';
import { type MasteryStateRow, getMasteryStates } from '@/kernel/read-models/mastery-state';
import { KNOWLEDGE_EXCERPT_MAX, TOOL_COURTESY_DEFAULTS } from '@/kernel/tools/budgets';
import type { DomainTool, ToolContext } from './types';

const TEXT_SNIPPET_MAX = KNOWLEDGE_EXCERPT_MAX;
const MAX_NODES = 60;
const QUERY_FAILURE_LIMIT = 10;
const MASTERY_WEAK_BELOW = 0.55;
const STREAK_WEAK_AT_LEAST = 2;
const ERROR_RATE_WEAK_AT_LEAST = 0.5;
const ERROR_RATE_MIN_GRADED = 2;
const REPEATED_CAUSE_AT_LEAST = 2;
// Window behind the recent_failure_count_30d stat, owned solely by this reader:
// the stat name fixes it at 30 days and no other consumer derives from it, so
// keeping the literal inline cannot drift against a shared definition.
export const RECENT_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type KnowledgeRow = {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  // Optimistic-concurrency version, needed for every structural mutation proposal.
  version: number;
  // Fallback for the any-event clock on never-touched nodes; preserves the
  // retired view's COALESCE(last_active_at, created_at) shape.
  created_at: Date;
};

type EdgeRow = {
  id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight: number;
  reasoning: string | null;
};

function excerpt(value: string | null | undefined, max = TEXT_SNIPPET_MAX): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

async function loadKnowledgeRows(db: Db, subjectId?: string): Promise<KnowledgeRow[]> {
  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      version: knowledge.version,
      created_at: knowledge.created_at,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  if (!subjectId) return rows;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const effectiveDomain = (row: KnowledgeRow): string | null => {
    let current: KnowledgeRow | undefined = row;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.domain) return current.domain;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return null;
  };
  return rows.filter((row) => effectiveDomain(row) === subjectId);
}

async function loadEdges(db: Db, ids?: string[], relationTypes?: string[]): Promise<EdgeRow[]> {
  const conditions = [isNull(knowledge_edge.archived_at)];
  if (ids && ids.length > 0) {
    const idCondition = or(
      inArray(knowledge_edge.from_knowledge_id, ids),
      inArray(knowledge_edge.to_knowledge_id, ids),
    );
    if (idCondition) conditions.push(idCondition);
  }
  if (relationTypes && relationTypes.length > 0) {
    conditions.push(inArray(knowledge_edge.relation_type, relationTypes));
  }
  return await db
    .select({
      id: knowledge_edge.id,
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
      weight: knowledge_edge.weight,
      reasoning: knowledge_edge.reasoning,
    })
    .from(knowledge_edge)
    .where(and(...conditions));
}

function nodeMap(rows: KnowledgeRow[]): Map<string, KnowledgeRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

function pathFor(id: string, byId: Map<string, KnowledgeRow>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

function childCount(id: string, rows: KnowledgeRow[]): number {
  return rows.filter((row) => row.parent_id === id).length;
}

function edgeCount(id: string, edges: EdgeRow[]): number {
  return edges.filter((edge) => edge.from_knowledge_id === id || edge.to_knowledge_id === id)
    .length;
}

function recentFailureCutoff(now = new Date()): Date {
  return new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS);
}

type ModelSignal<T> = {
  value: T | null;
  known: boolean;
  source: string;
  asOf: string;
  missingReason: string | null;
};

function knownSignal<T>(value: T, source: string, asOf: string): ModelSignal<T> {
  return { value, known: true, source, asOf, missingReason: null };
}

function unknownSignal<T>(source: string, asOf: string, missingReason: string): ModelSignal<T> {
  return { value: null, known: false, source, asOf, missingReason };
}

function modelSignalSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable(),
    known: z.boolean(),
    source: z.string(),
    asOf: z.string().datetime(),
    missingReason: z.string().nullable(),
  });
}

const FailureCauseSignalSchema = modelSignalSchema(z.string());
const EvidenceEventIdsSignalSchema = modelSignalSchema(z.array(z.string()));
const WeaknessReadingsSchema = z.object({
  mastery: modelSignalSchema(z.number()),
  consecutive_errors: modelSignalSchema(z.number().int().nonnegative()),
  error_rate: modelSignalSchema(z.number()),
  trend: modelSignalSchema(z.enum(['improving', 'flat', 'worsening'])),
  days_since_practice: modelSignalSchema(z.number().int().nonnegative()),
  cause_frequency: modelSignalSchema(
    z.array(z.object({ cause: z.string(), count: z.number().int().positive() })),
  ),
});
type WeaknessReadings = z.infer<typeof WeaknessReadingsSchema>;

function failureCauseSignal(row: FailureAttempt, asOf: string): ModelSignal<string> {
  const cause = effectiveCauseForFailureAttempt(row);
  if (!cause) return unknownSignal('failure_attempt', asOf, 'no_cause_attribution');
  return knownSignal(
    cause.primary_category,
    cause.source === 'user' ? 'user_cause.primary_category' : 'judge.cause.primary_category',
    cause.created_at.toISOString(),
  );
}

function causeFrequency(
  failures: FailureAttempt[],
  ids: ReadonlySet<string>,
): Map<string, Array<{ cause: string; count: number }>> {
  const counts = new Map<string, Map<string, number>>();
  for (const failure of failures) {
    const cause = effectiveCauseForFailureAttempt(failure);
    if (!cause) continue;
    for (const id of new Set(failure.referenced_knowledge_ids)) {
      if (!ids.has(id)) continue;
      const byCause = counts.get(id) ?? new Map<string, number>();
      byCause.set(cause.primary_category, (byCause.get(cause.primary_category) ?? 0) + 1);
      counts.set(id, byCause);
    }
  }
  const out = new Map<string, Array<{ cause: string; count: number }>>();
  for (const [id, byCause] of counts) {
    out.set(
      id,
      [...byCause]
        .map(([cause, count]) => ({ cause, count }))
        .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause)),
    );
  }
  return out;
}

function daysSincePractice(
  state: MasteryStateRow | undefined,
  asOf: Date,
  asOfIso: string,
): ModelSignal<number> {
  const source = 'mastery_state.last_outcome_at';
  if (!state) return unknownSignal(source, asOfIso, 'no_mastery_state');
  if (!state.last_outcome_at || state.evidence_count <= 0) {
    return unknownSignal(source, asOfIso, 'no_dated_practice');
  }
  const days = Math.max(
    0,
    Math.floor((asOf.getTime() - state.last_outcome_at.getTime()) / 86_400_000),
  );
  return knownSignal(days, source, asOfIso);
}

function readingsForNode(
  mastery: number | null | undefined,
  state: MasteryStateRow | undefined,
  streak: number | undefined,
  causes: Array<{ cause: string; count: number }> | undefined,
  asOf: Date,
  asOfIso: string,
): WeaknessReadings {
  const graded = state ? state.success_count + state.fail_count : 0;
  const trendSource = 'mastery_state.last_theta_delta';
  let trend: ModelSignal<'improving' | 'flat' | 'worsening'>;
  if (!state || state.last_theta_delta == null) {
    trend = unknownSignal(trendSource, asOfIso, state ? 'no_theta_delta' : 'no_mastery_state');
  } else if (state.last_theta_delta < 0) {
    trend = knownSignal('worsening', trendSource, asOfIso);
  } else if (state.last_theta_delta > 0) {
    trend = knownSignal('improving', trendSource, asOfIso);
  } else {
    trend = knownSignal('flat', trendSource, asOfIso);
  }
  const rateSource = 'mastery_state.success_count_fail_count';
  return {
    mastery:
      typeof mastery === 'number'
        ? knownSignal(mastery, 'learner_judgment.ability.mastery', asOfIso)
        : unknownSignal('learner_judgment.ability.mastery', asOfIso, 'no_observed_mastery'),
    consecutive_errors:
      streak === undefined
        ? unknownSignal('learner_answer_failure_run', asOfIso, 'no_graded_answer_in_scan_window')
        : knownSignal(streak, 'learner_answer_failure_run', asOfIso),
    error_rate: !state
      ? unknownSignal(rateSource, asOfIso, 'no_mastery_state')
      : graded < ERROR_RATE_MIN_GRADED
        ? unknownSignal(rateSource, asOfIso, 'fewer_than_2_graded_outcomes')
        : knownSignal(state.fail_count / graded, rateSource, asOfIso),
    trend,
    days_since_practice: daysSincePractice(state, asOf, asOfIso),
    cause_frequency: knownSignal(causes ?? [], 'failure_attempts_30d.effective_cause', asOfIso),
  };
}

function nodeIsWeak(readings: WeaknessReadings, asOf: Date): boolean {
  const mastery = readings.mastery;
  if (mastery.known && mastery.value != null && mastery.value < MASTERY_WEAK_BELOW) return true;
  const streak = readings.consecutive_errors;
  if (streak.known && streak.value != null && streak.value >= STREAK_WEAK_AT_LEAST) return true;
  const rate = readings.error_rate;
  if (rate.known && rate.value != null && rate.value >= ERROR_RATE_WEAK_AT_LEAST) return true;
  if (readings.trend.known && readings.trend.value === 'worsening') return true;
  const days = readings.days_since_practice;
  if (days.known && days.value != null) {
    const at = new Date(asOf.getTime() - days.value * 86_400_000);
    if (masteryDecayBucket(1, at, asOf) === 'stale') return true;
  }
  const causes = readings.cause_frequency;
  if (causes.known && causes.value?.some((row) => row.count >= REPEATED_CAUSE_AT_LEAST))
    return true;
  return false;
}

function countFailures(rows: FailureAttempt[], ids: string[]): Map<string, number> {
  const idSet = new Set(ids);
  const counts = new Map(ids.map((id) => [id, 0]));
  for (const row of rows) {
    for (const id of row.referenced_knowledge_ids) {
      if (idSet.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Mastery band plus the contract's unified evidence clocks. */
type MasteryMapEntry = {
  mastery: number | null;
  // Practice clock: the mastery_state settlement time, same field the
  // knowledge page and question detail render.
  last_evidence_at: string | null;
  // Any-event clock: latest touching event from the event spine, falling back
  // to the node's created_at like the retired view's COALESCE did.
  last_active_at: string | null;
};

async function loadMasteryMap(db: Db, rows: KnowledgeRow[]): Promise<Map<string, MasteryMapEntry>> {
  if (rows.length === 0) return new Map();
  // One judgment-contract read owns mastery and both evidence clocks.
  const batch = await readLearnerJudgments(db, {
    knowledge_ids: rows.map((row) => row.id),
    context: 'any',
    as_of: new Date(),
  });
  const readings = abilityReadingsByIdOrFail(batch);
  const timingById = new Map(batch.items.map((item) => [item.knowledge_id, item.evidence_timing]));
  const out = new Map<string, MasteryMapEntry>();
  for (const row of rows) {
    const proj = readings.get(row.id);
    const timing = timingById.get(row.id);
    out.set(row.id, {
      mastery: proj ? proj.mastery : null,
      last_evidence_at: timing?.last_outcome_at?.toISOString() ?? null,
      last_active_at: timing?.last_activity_at?.toISOString() ?? row.created_at.toISOString(),
    });
  }
  return out;
}

async function loadRecentFailures(
  db: Db,
  ids: string[],
  asOf: string,
  limit = 10,
): Promise<
  Array<{
    event_id: string;
    question_id: string;
    cause: ModelSignal<string>;
    created_at: string;
    excerpt: string;
  }>
> {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const rows = (await getCurrentFailureAttemptsForDerivation(db))
    .filter((row) => row.referenced_knowledge_ids.some((id) => idSet.has(id)))
    .slice(0, limit);
  return rows.map((row) => ({
    event_id: row.attempt_event_id,
    question_id: row.question_id,
    cause: failureCauseSignal(row, asOf),
    created_at: row.created_at.toISOString(),
    excerpt: excerpt(row.answer_md),
  }));
}

async function loadWindowFailures(db: Db, asOf: Date): Promise<FailureAttempt[]> {
  return getCurrentFailureAttemptsForDerivation(db, { since: recentFailureCutoff(asOf) });
}

async function loadWeaknessReadings(
  db: Db,
  rows: KnowledgeRow[],
  mastery: Map<string, MasteryMapEntry>,
  asOf: Date,
  failures: FailureAttempt[],
): Promise<Map<string, WeaknessReadings>> {
  const ids = rows.map((row) => row.id);
  const asOfIso = asOf.toISOString();
  const [states, streaks] = await Promise.all([
    getMasteryStates(db, ids),
    loadKnowledgeFailureRuns(db),
  ]);
  const frequency = causeFrequency(failures, new Set(ids));
  const out = new Map<string, WeaknessReadings>();
  for (const id of ids) {
    out.set(
      id,
      readingsForNode(
        mastery.get(id)?.mastery,
        states.get(id),
        streaks.get(id)?.count,
        frequency.get(id),
        asOf,
        asOfIso,
      ),
    );
  }
  return out;
}

const ProposalEvidenceSchema = z.object({
  ai_proposal: z.object({
    evidence_refs: z.array(z.object({ kind: z.string(), id: z.string() })),
  }),
});

async function loadEdgeEvidence(
  db: Db,
  edgeIds: string[],
  asOf: string,
): Promise<Map<string, ModelSignal<string[]>>> {
  const source = 'knowledge_edge_proposal.evidence_refs';
  const out = new Map<string, ModelSignal<string[]>>();
  for (const id of edgeIds) out.set(id, unknownSignal(source, asOf, 'no_generate_event'));
  if (edgeIds.length === 0) return out;
  const generates = await db
    .select({
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
      id: event.id,
    })
    .from(event)
    .where(
      and(
        eq(event.action, 'generate'),
        eq(event.subject_kind, 'knowledge_edge'),
        eq(event.outcome, 'success'),
        inArray(event.subject_id, edgeIds),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const proposeByEdge = new Map<string, string | null>();
  for (const row of generates) {
    if (proposeByEdge.has(row.subject_id)) continue;
    const proposeId = (row.payload as { propose_event_id?: unknown }).propose_event_id;
    proposeByEdge.set(
      row.subject_id,
      typeof proposeId === 'string' && proposeId ? proposeId : null,
    );
  }
  const proposeIds = [...proposeByEdge.values()].filter((id): id is string => id != null);
  const proposes =
    proposeIds.length === 0
      ? []
      : await db
          .select({ id: event.id, payload: event.payload, created_at: event.created_at })
          .from(event)
          .where(inArray(event.id, proposeIds));
  const proposeById = new Map(proposes.map((row) => [row.id, row]));
  for (const [edgeId, proposeId] of proposeByEdge) {
    if (!proposeId) {
      out.set(edgeId, unknownSignal(source, asOf, 'generate_without_proposal'));
      continue;
    }
    const propose = proposeById.get(proposeId);
    const parsed = propose ? ProposalEvidenceSchema.safeParse(propose.payload) : null;
    if (!propose || !parsed?.success) {
      out.set(edgeId, unknownSignal(source, asOf, 'proposal_evidence_unreadable'));
      continue;
    }
    const ids = [
      ...new Set(
        parsed.data.ai_proposal.evidence_refs
          .filter((ref) => ref.kind === 'event')
          .map((ref) => ref.id),
      ),
    ];
    out.set(edgeId, knownSignal(ids, source, propose.created_at.toISOString()));
  }
  return out;
}

async function loadRecentFailureCounts(
  db: Db,
  ids: string[],
  since: Date,
): Promise<Map<string, number>> {
  const uniqueIds = Array.from(new Set(ids));
  const counts = new Map(uniqueIds.map((id) => [id, 0]));
  if (uniqueIds.length === 0) return counts;

  const rows = await getCurrentFailureAttemptsForDerivation(db, { since });

  const idSet = new Set(uniqueIds);
  for (const row of rows) {
    for (const id of row.referenced_knowledge_ids) {
      if (idSet.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

const RelationSchema = z.object({
  type: z.string(),
  direction: z.enum(['directed', 'symmetric']),
  meaning: z.string(),
});

const DEFAULT_RELATIONS = [
  {
    type: 'prerequisite',
    direction: 'directed' as const,
    meaning: 'from node is useful before learning to node',
  },
  { type: 'related_to', direction: 'symmetric' as const, meaning: 'nearby concepts' },
  {
    type: 'contrasts_with',
    direction: 'symmetric' as const,
    meaning: 'concepts that are easy to confuse',
  },
  { type: 'applied_in', direction: 'directed' as const, meaning: 'concept used in target context' },
  {
    type: 'derived_from',
    direction: 'directed' as const,
    meaning: 'from concept is derived from / builds on the to concept',
  },
];

const OverviewInputSchema = z.object({
  subjectId: z.string().min(1),
  includeWeaknessSummary: z.boolean().optional(),
});

const OverviewOutputSchema = z.object({
  subject_id: z.string(),
  graph_version: z.number().int(),
  root_nodes: z.array(z.object({ id: z.string(), name: z.string() })),
  relation_types: z.array(RelationSchema),
  clusters: z.array(
    z.object({
      name: z.string(),
      root_id: z.string(),
      child_count: z.number().int(),
      edge_count: z.number().int(),
      weak_node_count: z.number().int().optional(),
      recent_failure_count_30d: z.number().int().optional(),
    }),
  ),
  reading_hint: z.string(),
});

type OverviewInput = z.infer<typeof OverviewInputSchema>;
type OverviewOutput = z.infer<typeof OverviewOutputSchema>;

async function executeOverview(ctx: ToolContext, raw: OverviewInput): Promise<OverviewOutput> {
  const input = OverviewInputSchema.parse(raw);
  const asOf = new Date();
  const rows = await loadKnowledgeRows(ctx.db, input.subjectId);
  const ids = rows.map((row) => row.id);
  const edges = await loadEdges(ctx.db, ids);
  const mastery = input.includeWeaknessSummary ? await loadMasteryMap(ctx.db, rows) : new Map();
  const windowFailures = input.includeWeaknessSummary ? await loadWindowFailures(ctx.db, asOf) : [];
  const recentFailureCounts = input.includeWeaknessSummary
    ? countFailures(windowFailures, ids)
    : new Map<string, number>();
  const weakness = input.includeWeaknessSummary
    ? await loadWeaknessReadings(ctx.db, rows, mastery, asOf, windowFailures)
    : new Map<string, WeaknessReadings>();
  const roots = rows.filter((row) => !row.parent_id || !ids.includes(row.parent_id));
  const clusters = roots.map((root) => {
    const descendantIds = new Set<string>([root.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.parent_id && descendantIds.has(row.parent_id) && !descendantIds.has(row.id)) {
          descendantIds.add(row.id);
          changed = true;
        }
      }
    }
    const cluster = {
      name: root.name,
      root_id: root.id,
      child_count: descendantIds.size - 1,
      edge_count: edges.filter(
        (edge) =>
          descendantIds.has(edge.from_knowledge_id) || descendantIds.has(edge.to_knowledge_id),
      ).length,
    } as OverviewOutput['clusters'][number];
    if (input.includeWeaknessSummary) {
      cluster.weak_node_count = [...descendantIds].filter((id) => {
        const readings = weakness.get(id);
        return readings ? nodeIsWeak(readings, asOf) : false;
      }).length;
      cluster.recent_failure_count_30d = [...descendantIds].reduce(
        (sum, id) => sum + (recentFailureCounts.get(id) ?? 0),
        0,
      );
    }
    return cluster;
  });

  return OverviewOutputSchema.parse({
    subject_id: input.subjectId,
    graph_version: 1,
    root_nodes: roots.map((row) => ({ id: row.id, name: row.name })),
    relation_types: DEFAULT_RELATIONS,
    clusters,
    reading_hint:
      'Use knowledge.parent_id as the backbone tree; knowledge_edge is a typed mesh for prerequisites, contrasts, applications, and derived links.',
  });
}

const NonEmptyKnowledgeSelectorSchema = z.string().trim().min(1);

const QueryKnowledgeInputSchema = z.object({
  subjectId: NonEmptyKnowledgeSelectorSchema.describe('Domain scope (e.g. math), never a node id.'),
  query: NonEmptyKnowledgeSelectorSchema.optional().describe(
    'Text match — mutually exclusive with nodeId.',
  ),
  nodeId: NonEmptyKnowledgeSelectorSchema.optional().describe(
    'Exact node selector — mutually exclusive with query.',
  ),
  include: z
    .array(z.enum(['ancestors', 'children', 'neighbors', 'stats', 'recent_failures']))
    .optional()
    .describe('Extra layers; unrequested layers are not observed.'),
  relationTypes: z
    .array(NonEmptyKnowledgeSelectorSchema)
    .optional()
    .describe('Mesh edge types to include.'),
  limit: z.number().int().min(1).max(50).optional().describe('1–50.'),
});

const QueryKnowledgeOutputSchema = z.object({
  query_scope: z.object({
    subject_domain: z.string(),
    subject_id_semantics: z.literal('active_effective_domain'),
    node_id: z.string().nullable(),
    query: z.string().nullable(),
    active_only: z.literal(true),
    limit: z.number().int().positive(),
    include: z.array(z.enum(['ancestors', 'children', 'neighbors', 'stats', 'recent_failures'])),
    relation_types: z.array(z.string()).nullable(),
  }),
  lookup_status: z.enum([
    'matched_active_nodes',
    'no_active_node_match_in_subject_domain',
    'no_active_query_match_in_subject_domain',
    'no_active_nodes_in_subject_domain',
  ]),
  coverage: z.object({
    seed_match_count: z.number().int().nonnegative(),
    selected_seed_expansion_candidate_count: z.number().int().nonnegative(),
    returned_node_count: z.number().int().nonnegative(),
    seed_matches_complete: z.boolean(),
    returned_nodes_complete_after_expansion: z.boolean(),
    edges_complete_between_returned_nodes_for_requested_relation_types: z.literal(true),
    stats_observation: z.enum(['not_requested', 'no_returned_nodes', 'observed']),
    recent_failures_observation: z.enum(['not_requested', 'no_returned_nodes', 'observed']),
    recent_failures_time_scope: z.literal('all_recorded_attempts'),
    recent_failures_limit: z.literal(QUERY_FAILURE_LIMIT),
  }),
  // One honest scope sentence: what this result covers and what was not checked.
  claim_boundaries: z.string(),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      parent_id: z.string().nullable(),
      path: z.array(z.string()),
      children_count: z.number().int(),
      edge_count: z.number().int(),
      version: z.number().int(),
      stats: z
        .object({
          recent_failure_count_30d: z.number().int(),
          last_touched_at: z.string().nullable(),
          // unified practice clock, the same evidence_timing field the
          // knowledge page and question detail render.
          last_evidence_at: z.string().nullable(),
          mastery_estimate: z.number().nullable(),
        })
        .optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from_knowledge_id: z.string(),
      to_knowledge_id: z.string(),
      relation_type: z.string(),
      weight: z.number(),
      evidence_event_ids: EvidenceEventIdsSignalSchema,
    }),
  ),
  recent_failures: z
    .array(
      z.object({
        event_id: z.string(),
        question_id: z.string(),
        cause: FailureCauseSignalSchema,
        created_at: z.string(),
        excerpt: z.string(),
      }),
    )
    .optional(),
});

type QueryKnowledgeInput = z.infer<typeof QueryKnowledgeInputSchema>;
type QueryKnowledgeOutput = z.infer<typeof QueryKnowledgeOutputSchema>;

async function executeQueryKnowledge(
  ctx: ToolContext,
  raw: QueryKnowledgeInput,
): Promise<QueryKnowledgeOutput> {
  const input = QueryKnowledgeInputSchema.parse(raw);
  if (input.nodeId !== undefined && input.query !== undefined) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'nodeId and query are mutually exclusive exact selectors',
        path: ['nodeId'],
      },
    ]);
  }
  const asOfIso = new Date().toISOString();
  const limit = input.limit ?? TOOL_COURTESY_DEFAULTS.query_knowledge;
  // [] is the model's spelling for "no filter"; treat it like omission.
  const relationTypes = input.relationTypes?.length ? input.relationTypes : undefined;
  const rows = await loadKnowledgeRows(ctx.db, input.subjectId);
  const byId = nodeMap(rows);
  const allEdges = await loadEdges(
    ctx.db,
    rows.map((row) => row.id),
    relationTypes,
  );
  let seedMatches = rows;
  if (input.nodeId) {
    seedMatches = rows.filter((row) => row.id === input.nodeId);
  } else if (input.query) {
    const q = input.query.toLowerCase();
    seedMatches = rows.filter(
      (row) => row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q),
    );
  }
  const included = input.include ?? [];
  const selected = new Map<string, KnowledgeRow>();
  const addSelected = (id: string) => {
    const row = byId.get(id);
    if (row && !selected.has(row.id)) selected.set(row.id, row);
  };
  for (const row of seedMatches.slice(0, limit)) addSelected(row.id);
  const seedIds = [...selected.keys()];

  if (included.includes('ancestors')) {
    for (const id of seedIds) {
      let current = byId.get(id);
      const seen = new Set<string>();
      while (current?.parent_id && !seen.has(current.id)) {
        seen.add(current.id);
        addSelected(current.parent_id);
        current = byId.get(current.parent_id);
      }
    }
  }
  if (included.includes('children')) {
    for (const id of seedIds) {
      for (const row of rows) {
        if (row.parent_id === id) addSelected(row.id);
      }
    }
  }
  if (included.includes('neighbors')) {
    const seedSet = new Set(seedIds);
    for (const edge of allEdges) {
      if (seedSet.has(edge.from_knowledge_id)) addSelected(edge.to_knowledge_id);
      if (seedSet.has(edge.to_knowledge_id)) addSelected(edge.from_knowledge_id);
    }
  }

  const matches = [...selected.values()].slice(0, limit);
  const ids = matches.map((row) => row.id);
  const mastery = included.includes('stats') ? await loadMasteryMap(ctx.db, matches) : new Map();
  const failureCounts = included.includes('stats')
    ? await loadRecentFailureCounts(ctx.db, ids, recentFailureCutoff())
    : new Map<string, number>();
  const failures = included.includes('recent_failures')
    ? await loadRecentFailures(ctx.db, ids, asOfIso, QUERY_FAILURE_LIMIT)
    : undefined;

  const selectedIds = new Set(ids);
  const returnedEdges = allEdges.filter(
    (edge) => selectedIds.has(edge.from_knowledge_id) && selectedIds.has(edge.to_knowledge_id),
  );
  const edgeEvidence = await loadEdgeEvidence(
    ctx.db,
    returnedEdges.map((edge) => edge.id),
    asOfIso,
  );
  const expansionComplete = seedMatches.length <= limit && selected.size <= limit;
  const observationStatus = (section: 'stats' | 'recent_failures') =>
    !included.includes(section)
      ? 'not_requested'
      : ids.length === 0
        ? 'no_returned_nodes'
        : 'observed';
  const lookupStatus: QueryKnowledgeOutput['lookup_status'] =
    seedMatches.length > 0
      ? 'matched_active_nodes'
      : input.nodeId
        ? 'no_active_node_match_in_subject_domain'
        : input.query
          ? 'no_active_query_match_in_subject_domain'
          : 'no_active_nodes_in_subject_domain';

  return QueryKnowledgeOutputSchema.parse({
    query_scope: {
      subject_domain: input.subjectId,
      subject_id_semantics: 'active_effective_domain',
      node_id: input.nodeId ?? null,
      query: input.query ?? null,
      active_only: true,
      limit,
      include: included,
      relation_types: relationTypes ?? null,
    },
    lookup_status: lookupStatus,
    coverage: {
      seed_match_count: seedMatches.length,
      selected_seed_expansion_candidate_count: selected.size,
      returned_node_count: matches.length,
      seed_matches_complete: seedMatches.length <= limit,
      returned_nodes_complete_after_expansion: expansionComplete,
      edges_complete_between_returned_nodes_for_requested_relation_types: true,
      stats_observation: observationStatus('stats'),
      recent_failures_observation: observationStatus('recent_failures'),
      recent_failures_time_scope: 'all_recorded_attempts',
      recent_failures_limit: QUERY_FAILURE_LIMIT,
    },
    claim_boundaries:
      `Returned ${matches.length} active node(s) in domain '${input.subjectId}'` +
      `${expansionComplete ? ' with complete expansion' : ' with expansion truncated by the limit'}; ` +
      'edges cover only the returned nodes' +
      `${relationTypes ? ` and relation types ${relationTypes.join(', ')}` : ''}; ` +
      'stats and recent_failures cover only requested, returned nodes; ' +
      'absence of nodes, edges, or failures outside this result was not checked. ' +
      'evidence_event_ids is unknown when the edge has no proposal lineage; an unknown signal is not an empty list.',
    nodes: matches.map((row) => {
      const m = mastery.get(row.id);
      return {
        id: row.id,
        name: row.name,
        parent_id: row.parent_id,
        path: pathFor(row.id, byId),
        children_count: childCount(row.id, rows),
        edge_count: edgeCount(row.id, allEdges),
        version: row.version,
        ...(included.includes('stats')
          ? {
              stats: {
                recent_failure_count_30d: failureCounts.get(row.id) ?? 0,
                // Any-event clock (最近学习时间), derived from the event spine.
                last_touched_at: m?.last_active_at ?? null,
                // Practice clock (最近证据时间), the unified reading.
                last_evidence_at: m?.last_evidence_at ?? null,
                mastery_estimate: m?.mastery ?? null,
              },
            }
          : {}),
      };
    }),
    edges: returnedEdges.map((edge) => ({
      id: edge.id,
      from_knowledge_id: edge.from_knowledge_id,
      to_knowledge_id: edge.to_knowledge_id,
      relation_type: edge.relation_type,
      weight: edge.weight,
      evidence_event_ids:
        edgeEvidence.get(edge.id) ??
        unknownSignal('knowledge_edge_proposal.evidence_refs', asOfIso, 'no_generate_event'),
    })),
    ...(failures ? { recent_failures: failures } : {}),
  });
}

const ExpandInputSchema = z.object({
  centerNodeId: z.string().min(1),
  depth: z.number().int().min(1).max(3).optional(),
  include: z
    .array(z.enum(['ancestors', 'children', 'neighbors', 'recent_failures', 'mastery']))
    .optional(),
  relationTypes: z.array(z.string()).optional(),
  maxNodes: z.number().int().min(1).max(MAX_NODES).optional(),
});

const ExpandOutputSchema = z.object({
  center: z
    .object({
      id: z.string(),
      name: z.string(),
      path: z.array(z.string()),
      version: z.number().int(),
    })
    .nullable(),
  /** YUK-1601 — set when the parent chain is corrupt (a parent_id cycle); the
   * bounded walk stops at the cycle instead of looping forever. */
  structure_error: z.string().optional(),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.array(z.string()),
      role: z.enum(['ancestor', 'child', 'neighbor', 'center']),
      version: z.number().int(),
    }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), relation_type: z.string(), weight: z.number() }),
  ),
  paths: z.array(
    z.object({ from: z.string(), to: z.string(), relation_type: z.string(), reason: z.string() }),
  ),
  evidence: z.object({
    recent_failures: z.array(
      z.object({
        event_id: z.string(),
        question_id: z.string(),
        cause: FailureCauseSignalSchema,
        excerpt: z.string(),
      }),
    ),
    weak_points: z.array(
      z.object({
        knowledge_id: z.string(),
        readings: WeaknessReadingsSchema,
      }),
    ),
  }),
});

type ExpandInput = z.infer<typeof ExpandInputSchema>;
type ExpandOutput = z.infer<typeof ExpandOutputSchema>;

async function executeExpand(ctx: ToolContext, raw: ExpandInput): Promise<ExpandOutput> {
  const input = ExpandInputSchema.parse(raw);
  const maxNodes = input.maxNodes ?? TOOL_COURTESY_DEFAULTS.expand_knowledge_subgraph;
  const allRows = await loadKnowledgeRows(ctx.db);
  const byId = nodeMap(allRows);
  const center = byId.get(input.centerNodeId);
  if (!center) {
    return ExpandOutputSchema.parse({
      center: null,
      nodes: [],
      edges: [],
      paths: [],
      evidence: { recent_failures: [], weak_points: [] },
    });
  }
  const allEdges = await loadEdges(ctx.db, undefined, input.relationTypes);
  const included = input.include ?? ['ancestors', 'children', 'neighbors'];
  const selected = new Map<string, 'ancestor' | 'child' | 'neighbor' | 'center'>([
    [center.id, 'center'],
  ]);
  // YUK-1601 — the ancestor walk must terminate inside the process budget even when
  // the tree already contains an illegal parent cycle: a visited set bounds it
  // synchronously (no Promise timeout can interrupt a runaway loop), and the cycle is
  // reported as a structure error instead of hanging the request.
  let structureError: string | undefined;
  if (included.includes('ancestors')) {
    const seen = new Set<string>([center.id]);
    let current = center;
    while (current.parent_id) {
      const parent = byId.get(current.parent_id);
      if (!parent) break;
      if (seen.has(parent.id)) {
        structureError =
          `knowledge structure error: parent_id cycle detected on the ancestor chain of ` +
          `${center.id} (re-entered ${parent.id}); ancestors were gathered only up to the cycle`;
        break;
      }
      seen.add(parent.id);
      selected.set(parent.id, 'ancestor');
      current = parent;
    }
  }
  if (included.includes('children')) {
    let frontier = [center.id];
    for (let d = 0; d < (input.depth ?? 1); d += 1) {
      const next = allRows.filter((row) => row.parent_id && frontier.includes(row.parent_id));
      for (const row of next) selected.set(row.id, 'child');
      frontier = next.map((row) => row.id);
    }
  }
  if (included.includes('neighbors')) {
    for (const edge of allEdges) {
      if (edge.from_knowledge_id === center.id && byId.has(edge.to_knowledge_id)) {
        selected.set(edge.to_knowledge_id, 'neighbor');
      }
      if (edge.to_knowledge_id === center.id && byId.has(edge.from_knowledge_id)) {
        selected.set(edge.from_knowledge_id, 'neighbor');
      }
    }
  }
  const selectedIds = [...selected.keys()].slice(0, maxNodes);
  const selectedSet = new Set(selectedIds);
  const asOf = new Date();
  const failures = included.includes('recent_failures')
    ? await loadRecentFailures(ctx.db, selectedIds, asOf.toISOString(), 10)
    : [];
  const masteryRows = selectedIds.map((id) => byId.get(id) as KnowledgeRow);
  const mastery = included.includes('mastery')
    ? await loadMasteryMap(ctx.db, masteryRows)
    : new Map();
  const weakness = included.includes('mastery')
    ? await loadWeaknessReadings(
        ctx.db,
        masteryRows,
        mastery,
        asOf,
        await loadWindowFailures(ctx.db, asOf),
      )
    : new Map<string, WeaknessReadings>();

  return ExpandOutputSchema.parse({
    center: {
      id: center.id,
      name: center.name,
      path: pathFor(center.id, byId),
      version: center.version,
    },
    ...(structureError ? { structure_error: structureError } : {}),
    nodes: selectedIds.map((id) => {
      const row = byId.get(id) as KnowledgeRow;
      return {
        id,
        name: row.name,
        path: pathFor(id, byId),
        role: selected.get(id) ?? 'neighbor',
        version: row.version,
      };
    }),
    edges: allEdges
      .filter(
        (edge) => selectedSet.has(edge.from_knowledge_id) && selectedSet.has(edge.to_knowledge_id),
      )
      .map((edge) => ({
        from: edge.from_knowledge_id,
        to: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        weight: edge.weight,
      })),
    paths: allEdges
      .filter(
        (edge) =>
          (edge.from_knowledge_id === center.id || edge.to_knowledge_id === center.id) &&
          byId.has(edge.from_knowledge_id) &&
          byId.has(edge.to_knowledge_id),
      )
      .map((edge) => ({
        from: edge.from_knowledge_id,
        to: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        reason: edge.reasoning ?? `${edge.relation_type} relation around ${center.name}`,
      })),
    evidence: {
      recent_failures: failures.map((f) => ({
        event_id: f.event_id,
        question_id: f.question_id,
        cause: f.cause,
        excerpt: f.excerpt,
      })),
      weak_points: [...weakness.entries()]
        .filter(([, readings]) => nodeIsWeak(readings, asOf))
        .map(([knowledgeId, readings]) => ({
          knowledge_id: knowledgeId,
          readings,
        })),
    },
  });
}

const PathsInputSchema = z.object({
  fromKnowledgeId: z.string().min(1),
  toKnowledgeId: z.string().min(1),
  maxDepth: z.number().int().min(1).max(5).optional(),
  relationTypes: z.array(z.string()).optional(),
});

const PathsOutputSchema = z.object({
  paths: z.array(
    z.object({
      node_ids: z.array(z.string()),
      node_names: z.array(z.string()),
      edge_types: z.array(z.string()),
      explanation: z.string(),
    }),
  ),
});

type PathsInput = z.infer<typeof PathsInputSchema>;
type PathsOutput = z.infer<typeof PathsOutputSchema>;

async function executePaths(ctx: ToolContext, raw: PathsInput): Promise<PathsOutput> {
  const input = PathsInputSchema.parse(raw);
  const maxDepth = input.maxDepth ?? 4;
  const rows = await loadKnowledgeRows(ctx.db);
  const byId = nodeMap(rows);
  const edges = await loadEdges(ctx.db, undefined, input.relationTypes);
  const adjacency = new Map<string, Array<{ to: string; type: string }>>();
  const add = (from: string, to: string, type: string) => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, type });
    adjacency.set(from, list);
  };
  for (const row of rows) {
    if (row.parent_id) {
      add(row.parent_id, row.id, 'tree_child');
      add(row.id, row.parent_id, 'tree_parent');
    }
  }
  for (const edge of edges) {
    add(edge.from_knowledge_id, edge.to_knowledge_id, edge.relation_type);
    if (edge.relation_type === 'related_to' || edge.relation_type === 'contrasts_with') {
      add(edge.to_knowledge_id, edge.from_knowledge_id, edge.relation_type);
    }
  }

  const found: PathsOutput['paths'] = [];
  const queue: Array<{ ids: string[]; types: string[] }> = [
    { ids: [input.fromKnowledgeId], types: [] },
  ];
  while (queue.length > 0 && found.length < 5) {
    const current = queue.shift() as { ids: string[]; types: string[] };
    const last = current.ids[current.ids.length - 1];
    if (last === input.toKnowledgeId) {
      const names = current.ids.map((id) => byId.get(id)?.name ?? id);
      found.push({
        node_ids: current.ids,
        node_names: names,
        edge_types: current.types,
        explanation: `${names.join(' → ')} via ${current.types.join(' / ') || 'same node'}`,
      });
      continue;
    }
    if (current.types.length >= maxDepth) continue;
    for (const next of adjacency.get(last) ?? []) {
      if (current.ids.includes(next.to)) continue;
      queue.push({ ids: [...current.ids, next.to], types: [...current.types, next.type] });
    }
  }
  return PathsOutputSchema.parse({ paths: found });
}

export const getSubjectGraphOverviewTool: DomainTool<OverviewInput, OverviewOutput> = {
  name: 'get_subject_graph_overview',
  description:
    'Read a compact subject knowledge graph overview: roots, relation legend, clusters, and reading hint. weak_node_count includes low mastery and also a consecutive-error run, a high error rate, a worsening theta move, a stale practice gap, or a cause repeated in 30 days. Unknown readings are not zero. Do not tell the learner those counts.',
  effect: 'read',
  inputSchema: OverviewInputSchema,
  outputSchema: OverviewOutputSchema,
  costClass: 'local',
  execute: executeOverview,
  summarize(input, output) {
    return `graph overview · ${input.subjectId} · ${output.root_nodes.length} roots · ${output.clusters.length} clusters`;
  },
  mirrorEvent: 'when_user_visible',
};

export const queryKnowledgeTool: DomainTool<QueryKnowledgeInput, QueryKnowledgeOutput> = {
  name: 'query_knowledge',
  description:
    'Find active knowledge nodes by id or text inside one effective subject domain; returns path, local edge counts and requested layers. Empty nodes means no active match in that exact scope — never proof of global or archived absence, or that a node never existed; edges cover returned nodes only. recent_failures.cause is the effective attribution (learner over judge), null when none was recorded; edges.evidence_event_ids is unknown, not empty, when lineage is unknown. Do not tell the learner evidence-event counts. Read query_scope, lookup_status, coverage and claim_boundaries before any negative or complete-expansion claim.',
  effect: 'read',
  inputSchema: QueryKnowledgeInputSchema,
  outputSchema: QueryKnowledgeOutputSchema,
  costClass: 'local',
  execute: executeQueryKnowledge,
  summarize(input, output) {
    const target = input.nodeId ?? input.query ?? input.subjectId;
    return `knowledge · ${target} · ${output.nodes.length} nodes · ${output.edges.length} edges`;
  },
  mirrorEvent: 'when_user_visible',
};

export const expandKnowledgeSubgraphTool: DomainTool<ExpandInput, ExpandOutput> = {
  name: 'expand_knowledge_subgraph',
  description:
    'Read a bounded local graph around one knowledge node: ancestors, children, mesh neighbors, and optional evidence. weak_points carry mastery, consecutive errors, error rate, trend, days since practice, and 30-day cause frequency. A node is listed when any known reading is weak, not only when mastery is below 0.55. Unknown readings stay null. Do not tell the learner those counts.',
  effect: 'read',
  inputSchema: ExpandInputSchema,
  outputSchema: ExpandOutputSchema,
  costClass: 'local',
  execute: executeExpand,
  summarize(input, output) {
    return `subgraph · ${input.centerNodeId} · ${output.nodes.length} nodes · ${output.edges.length} edges`;
  },
  mirrorEvent: 'when_user_visible',
};

export const findKnowledgePathsTool: DomainTool<PathsInput, PathsOutput> = {
  name: 'find_knowledge_paths',
  description:
    'Find short tree/mesh paths between two knowledge nodes for "why are these related" explanations.',
  effect: 'read',
  inputSchema: PathsInputSchema,
  outputSchema: PathsOutputSchema,
  costClass: 'local',
  execute: executePaths,
  summarize(input, output) {
    return `knowledge paths · ${input.fromKnowledgeId}→${input.toKnowledgeId} · ${output.paths.length} paths`;
  },
  mirrorEvent: 'when_user_visible',
};
