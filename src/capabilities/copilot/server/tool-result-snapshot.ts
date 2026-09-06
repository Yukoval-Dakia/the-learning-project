import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  type CopilotToolResultSnapshot,
  TOOL_RESULT_VALUE_MAX_BYTES,
  type ToolResultJson,
  type ToolResultOmission,
} from '../primary-view-contract';

/**
 * The public card is deliberately a projection, rather than a second DomainTool
 * contract.  This table is exhaustive for the two Copilot surfaces; adding a
 * tool requires choosing its public policy here.
 */
const COPILOT_TOOLS = new Set([
  'present_primary_view', 'query_memory_brief', 'generate_goal_outline',
  'generate_question_candidate', 'get_subject_graph_overview', 'query_knowledge',
  'query_events', 'query_records', 'get_record_context', 'get_question_context',
  'query_mistakes', 'get_attempt_context', 'get_review_due', 'get_learning_item_context',
  'expand_knowledge_subgraph', 'find_knowledge_paths', 'propose_knowledge_edge',
  'propose_knowledge_mutation', 'propose_learning_item_completion',
  'propose_learning_item_relearn', 'propose_learning_item_defer',
  'propose_learning_item_archive', 'author_question', 'search_memory_facts',
  'query_questions', 'write_quiz', 'author_artifact', 'update_artifact',
  'propose_question_edit', 'attribute_mistake', 'propose_variant',
  'read_agent_notes', 'write_agent_note', 'present_primary_view',
]);
const INTERNAL_TOOLS = new Set(['read_agent_notes', 'write_agent_note']);
const GENERATED_TOOLS = new Set(['generate_goal_outline', 'generate_question_candidate']);
const OPAQUE_TOOLS = new Set(['get_record_context', 'get_question_context', 'get_attempt_context']);
const NATURAL_LIST_KEYS = new Set(['items', 'results', 'records', 'questions', 'events', 'nodes', 'edges', 'paths', 'attempts', 'facts', 'observations']);
const PRIVATE_KEYS = /^(raw|debug|diagnostic|internal|provider|sdk|prompt|tool_input|tool_output|trace|rationale|gate|html|content_html|markdown|html_content)$/i;

export function requiresToolResultLearningValidation(toolName: string): boolean {
  return GENERATED_TOOLS.has(stripPrefix(toolName));
}

function stripPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

function project(value: unknown, path: string, omissions: ToolResultOmission[], opaque = false): ToolResultJson {
  if (value === null || typeof value !== 'object') return (typeof value === 'bigint' ? String(value) : value) as ToolResultJson;
  if (Array.isArray(value)) {
    return value.map((item, index) => project(item, `${path}/${index}`, omissions, opaque));
  }
  const out: Record<string, ToolResultJson> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}/${key}`;
    if (PRIVATE_KEYS.test(key)) { omissions.push({ path: childPath, reason: opaque ? 'opaque' : 'private' }); continue; }
    if (opaque && !['id', 'title', 'name', 'type', 'status', 'kind', 'summary', 'question', 'answer', 'score', 'created_at', 'updated_at', 'navigation', 'artifact_id', 'version'].includes(key)) {
      omissions.push({ path: childPath, reason: 'opaque' }); continue;
    }
    out[key] = project(child, childPath, omissions, false);
  }
  return out;
}

function trimNaturalLists(value: ToolResultJson, omissions: ToolResultOmission[], path = ''): ToolResultJson {
  if (Array.isArray(value)) return value.map((v, i) => trimNaturalLists(v, omissions, `${path}/${i}`));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, ToolResultJson> = {};
  for (const [key, child] of Object.entries(value)) {
    if (NATURAL_LIST_KEYS.has(key) && Array.isArray(child)) {
      const kept: ToolResultJson[] = [];
      for (let i = 0; i < child.length; i++) {
        const candidate = { ...out, [key]: [...kept, child[i]] };
        if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > TOOL_RESULT_VALUE_MAX_BYTES) break;
        kept.push(trimNaturalLists(child[i], omissions, `${path}/${key}/${i}`));
      }
      if (kept.length < child.length) omissions.push({ path: `${path}/${key}`, reason: 'display_limit', omitted_count: child.length - kept.length });
      out[key] = kept;
    } else out[key] = trimNaturalLists(child, omissions, `${path}/${key}`);
  }
  return out;
}

export function buildCopilotToolResultSnapshot(toolName: string, output: unknown): CopilotToolResultSnapshot {
  const name = stripPrefix(toolName);
  if (name === 'present_primary_view' || INTERNAL_TOOLS.has(name)) return { version: 1, state: 'unavailable', reason: 'internal_only' };
  if (!COPILOT_TOOLS.has(name)) return { version: 1, state: 'unavailable', reason: 'unsupported_result' };
  const omissions: ToolResultOmission[] = [];
  let value = project(output, '', omissions, OPAQUE_TOOLS.has(name));
  value = trimNaturalLists(value, omissions);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TOOL_RESULT_VALUE_MAX_BYTES) return { version: 1, state: 'unavailable', reason: 'size_limit' };
  const json = JSON.stringify(value);
  const snapshot = { version: 1 as const, state: 'available' as const, value, sha256: sha256CanonicalJson(value), byte_length: new TextEncoder().encode(json).byteLength, completeness: omissions.length ? 'projected' as const : 'complete' as const, omissions: omissions.slice(0, 100) };
  return JSON.parse(JSON.stringify(snapshot)) as CopilotToolResultSnapshot;
}
