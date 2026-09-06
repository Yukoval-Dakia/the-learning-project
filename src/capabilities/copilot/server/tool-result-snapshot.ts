import { z } from 'zod';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { COPILOT_TOOLS } from '@/kernel/tools/allowlists';
import { getTool } from '@/server/ai/tools/registry';
import {
  type CopilotToolResultSnapshot,
  CopilotToolResultSnapshotSchema,
  TOOL_RESULT_VALUE_MAX_BYTES,
  type ToolResultJson,
  type ToolResultOmission,
} from '../primary-view-contract';

// Explicit product policies, never an effect-based raw fallback. Typed readers
// reuse their owner's safe evidence/correction/coverage output contracts.
type PublicResultTool =
  | Exclude<
      (typeof COPILOT_TOOLS)[number],
      'read_agent_notes' | 'write_agent_note' | 'present_primary_view'
    >
  | 'attribute_mistake'
  | 'propose_variant';
type ResultPolicy =
  | 'reader'
  | 'record'
  | 'review'
  | 'events'
  | 'memory'
  | 'generated'
  | readonly string[];
const POLICIES: Record<string, ResultPolicy> = {
  query_memory_brief: 'reader',
  get_subject_graph_overview: 'reader',
  query_knowledge: 'reader',
  expand_knowledge_subgraph: 'reader',
  find_knowledge_paths: 'reader',
  query_records: 'reader',
  query_mistakes: 'reader',
  get_question_context: 'reader',
  get_attempt_context: 'reader',
  get_learning_item_context: 'reader',
  query_questions: 'reader',
  get_record_context: 'record',
  get_review_due: 'review',
  query_events: 'events',
  search_memory_facts: 'memory',
  generate_goal_outline: 'generated',
  generate_question_candidate: 'generated',
  propose_knowledge_edge: ['status', 'proposal_id'],
  propose_knowledge_mutation: ['status', 'proposal_id'],
  propose_learning_item_completion: ['status', 'proposal_id', 'learning_item_id', 'auto_applied'],
  propose_learning_item_relearn: ['status', 'proposal_id', 'learning_item_id', 'auto_applied'],
  propose_learning_item_defer: ['status', 'proposal_id', 'learning_item_id', 'auto_applied'],
  propose_learning_item_archive: ['status', 'proposal_id', 'learning_item_id', 'auto_applied'],
  author_question: [
    'status',
    'seed_mode',
    'proposal_ids',
    'mistake_variant_ids',
    'variant_question_ids',
    'question_ids',
  ],
  propose_question_edit: ['status', 'question_id', 'node_id', 'op', 'proposal_id'],
  attribute_mistake: ['status', 'judge_event_id', 'cause'],
  propose_variant: ['status', 'proposal_ids', 'mistake_variant_ids', 'variant_question_ids'],
  write_quiz: ['artifact_id', 'question_count', 'knowledge_ids', 'practice_path'],
  author_artifact: ['artifact_id', 'type', 'title', 'version', 'knowledge_ids'],
  update_artifact: ['artifact_id', 'previous_version', 'version'],
} satisfies Record<PublicResultTool, ResultPolicy>;
const INTERNAL = new Set(['read_agent_notes', 'write_agent_note', 'present_primary_view']);
const MEMORY_FACT = z.object({
  id: z.string().optional(),
  memory: z.string().optional(),
  score: z.number().optional(),
});
const FILTER_FIELDS = [
  'eventId',
  'actorKind',
  'actorRef',
  'action',
  'subjectKind',
  'subjectId',
  'outcome',
  'causedByEventId',
  'siblingOfEventId',
  'sinceDays',
  'limit',
];
const BUDGET_DIMENSION = z.object({
  used: z.number(),
  warning_limit: z.number(),
  hard_limit: z.number(),
  hard_remaining: z.number(),
});
const CONTEXT_BUDGET = z.object({
  level: z.enum(['warning', 'hard']),
  truncated: z.boolean(),
  dimensions: z.object({
    toolCalls: BUDGET_DIMENSION.optional(),
    nodesPlusEdges: BUDGET_DIMENSION.optional(),
    eventRows: BUDGET_DIMENSION.optional(),
  }),
  applied_limit: z.number().optional(),
  requested_limit: z.number().optional(),
  budget_remaining: z.number().optional(),
  dimension: z.enum(['nodesPlusEdges', 'eventRows']).optional(),
});
// Only natural top-level collections may be shortened. Question structure,
// relation paths, answer choices and coverage metadata remain atomic.
const COLLECTIONS = new Set([
  'nodes',
  'edges',
  'root_nodes',
  'clusters',
  'recent_failures',
  'paths',
  'rows',
  'items',
  'mistakes',
  'events',
  'facts',
  'attempts',
  'review_history',
  'records',
  'variants',
  'future_projections',
  'timeline',
  'linked_records',
  'recent_activity',
]);

function bare(name: string): string {
  return name.startsWith('mcp__loom__') ? name.slice(11) : name;
}
export function requiresToolResultLearningValidation(name: string): boolean {
  return POLICIES[bare(name)] === 'generated';
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function select(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}

// Unknown property names can themselves contain private data. Report only a
// count at the containing public path, never echo arbitrary discarded keys.
function collectOmissions(
  before: unknown,
  after: unknown,
  omissions: ToolResultOmission[],
  path = '/',
): void {
  if (omissions.length >= 99) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    after.forEach((value, i) => {
      collectOmissions(before[i], value, omissions, `${path}${i}/`);
    });
  } else if (record(before) && record(after)) {
    const removed = Object.keys(before).filter((key) => !Object.hasOwn(after, key)).length;
    if (removed)
      omissions.push({ path: path.slice(0, 240), reason: 'private', omitted_count: removed });
    for (const key of Object.keys(after))
      collectOmissions(before[key], after[key], omissions, `${path}${key}/`);
  }
}

function boundedSnapshot(
  value: ToolResultJson,
  omissions: ToolResultOmission[],
): CopilotToolResultSnapshot {
  const bytes = () => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  // Bound the complete object, not each list separately. Preserve original
  // totals/coverage and disclose display-only omissions separately.
  while (bytes() > TOOL_RESULT_VALUE_MAX_BYTES) {
    const candidates = record(value)
      ? Object.entries(value).filter(
          ([key, list]) => COLLECTIONS.has(key) && Array.isArray(list) && list.length > 0,
        )
      : [];
    candidates.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
    const candidate = candidates[0];
    if (!candidate) return { version: 1, state: 'unavailable', reason: 'size_limit' };
    const [key, items] = candidate as [string, ToolResultJson[]];
    const removed = items.length - Math.floor(items.length / 2);
    items.splice(items.length - removed, removed);
    const existing = omissions.find(
      (entry) => entry.reason === 'display_limit' && entry.path === `/${key}`,
    );
    if (existing) existing.omitted_count = (existing.omitted_count ?? 0) + removed;
    else omissions.unshift({ path: `/${key}`, reason: 'display_limit', omitted_count: removed });
  }
  return CopilotToolResultSnapshotSchema.parse({
    version: 1,
    state: 'available',
    value,
    sha256: sha256CanonicalJson(value),
    byte_length: bytes(),
    completeness: omissions.length ? 'projected' : 'complete',
    omissions: omissions.slice(0, 100),
  });
}

export function buildCopilotToolResultSnapshot(
  toolName: string,
  output: unknown,
): CopilotToolResultSnapshot {
  const name = bare(toolName);
  if (INTERNAL.has(name)) return { version: 1, state: 'unavailable', reason: 'internal_only' };
  const policy = POLICIES[name];
  const tool = getTool(name);
  if (!policy || !tool) return { version: 1, state: 'unavailable', reason: 'unsupported_result' };
  try {
    // Reuse the registered domain contract, not duplicate reader schemas or a
    // recursive vocabulary of supposedly safe field names.
    const parsed = tool.outputSchema.safeParse(output);
    if (!parsed.success || !record(parsed.data)) throw new Error('invalid observed output');
    let projected = structuredClone(parsed.data);
    if (policy === 'generated') projected = select(projected, ['text']);
    else if (Array.isArray(policy)) projected = select(projected, policy);
    else if (policy === 'record' && record(projected.attribution)) {
      projected.attribution = select(projected.attribution, ['chosen_source']);
    } else if (policy === 'review') {
      for (const [listKey, field] of [
        ['rows', 'fsrs_state'],
        ['future_projections', 'state'],
      ]) {
        const rows = projected[listKey];
        if (Array.isArray(rows)) for (const row of rows) if (record(row)) delete row[field];
      }
    } else if (policy === 'memory') {
      projected.facts = z.array(MEMORY_FACT).parse(projected.facts);
    } else if (policy === 'events' && record(projected.filter_applied)) {
      projected.filter_applied = z
        .record(z.string(), z.union([z.string(), z.number(), z.null()]))
        .parse(select(projected.filter_applied, FILTER_FIELDS));
    }
    if (policy !== 'generated' && record(output) && output.context_budget !== undefined)
      projected.context_budget = CONTEXT_BUDGET.parse(output.context_budget);
    const omissions: ToolResultOmission[] = [];
    // Domain schemas permit optional JS undefined; the wire representation
    // omits those object keys. Normalize exactly as transport persistence does.
    const value = z.json().parse(JSON.parse(JSON.stringify(projected)));
    collectOmissions(output, value, omissions);
    return boundedSnapshot(value, omissions);
  } catch {
    return { version: 1, state: 'unavailable', reason: 'unsupported_result' };
  }
}
