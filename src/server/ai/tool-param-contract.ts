// YUK-1547 / YUK-1559 (C1/C6) — shared tool-parameter contract repair.
//
// The observed wire failure: the model serializes an array/object field as a
// JSON STRING inside otherwise well-formed tool arguments (`"units":"[...]"`,
// `"per_unit":"[...]"`). The envelope parses, so the assistant turn lands —
// then the declared schema rejects the string field and the call is dead.
// Pi's own `validateToolArguments` runs BEFORE `AgentTool.execute` and its
// coercion pass does not JSON-parse strings, so the fix cannot live inside a
// tool's execute body; it must run at the `prepareArguments` seam pi calls
// ahead of validation.
//
// Policy (shared verbatim by the runtime mounts and the admission preflight
// script — no second implementation):
//   - for each field whose sub-schema expects array or object and does NOT
//     accept a string, a string value gets exactly ONE strict JSON.parse;
//   - the parsed value is adopted only when its structural type matches the
//     expectation AND it passes that sub-schema;
//   - a required repair that fails rejects the call with a
//     `ToolParamContractError` — the isError tool result carries actionable
//     feedback and the `[tool_param_contract]` marker so the bounded landing
//     machine can recognize this as the ONE correction-eligible failure.
//
// Never: guessing, markdown extraction, primitive coercion, provider/model/
// task-name special-casing, silent field deletion, recursive re-parsing of a
// parsed field, or schema loosening. Fields whose schema legitimately accepts
// strings are never touched.

import { z } from 'zod';

/** Marker carried by the isError result so the landing machine / evidence
 *  capture can identify the correction-eligible parameter-contract failure. */
export const TOOL_PARAM_CONTRACT_MARKER = '[tool_param_contract]';

export interface ToolParamCoercion {
  /** Dotted field path inside the arguments object; `(root)` when the whole
   *  arguments value was a serialized JSON string. */
  field_path: string;
  /** String length of the model's serialized value, before parsing. */
  original_length: number;
}

export interface ToolParamRepairOutcome {
  args: unknown;
  coercions: ToolParamCoercion[];
}

/**
 * Rejection for the correction-eligible parameter-contract failure. The marker
 * stays first so pi's error tool result is identifiable without parsing the
 * human-facing sentence.
 */
export class ToolParamContractError extends Error {
  constructor(detail: string) {
    super(`${TOOL_PARAM_CONTRACT_MARKER} ${detail}`);
    this.name = 'ToolParamContractError';
  }
}

export function isToolParamContractError(error: unknown): error is ToolParamContractError {
  return (
    error instanceof ToolParamContractError ||
    (error instanceof Error && error.message.startsWith(TOOL_PARAM_CONTRACT_MARKER))
  );
}

/**
 * True when an isError tool result failed at the argument-contract seam —
 * either our parameter-contract rejection or pi's own schema validation —
 * versus an unknown-tool lookup, a beforeToolCall block, or an abort. Used to
 * decide which non-executed calls get C6 raw-arguments evidence; the landing
 * correction is stricter (marker only, see the adapter).
 */
export function isToolArgumentContractFailure(result: {
  isError?: boolean;
  content?: unknown;
}): boolean {
  if (result.isError !== true) return false;
  const text = toolResultText(result.content);
  return text.includes(TOOL_PARAM_CONTRACT_MARKER) || text.startsWith('Validation failed for tool');
}

/** True when the result is OUR parameter-contract rejection (the one
 *  correction-eligible failure), not a generic schema validation error. */
export function isToolParamContractRejection(result: {
  isError?: boolean;
  content?: unknown;
}): boolean {
  return (
    result.isError === true && toolResultText(result.content).includes(TOOL_PARAM_CONTRACT_MARKER)
  );
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

// ─── JSON Schema expectation analysis ────────────────────────────────────────
//
// The walk inspects the tool's `parameters` document (the wire schema pi
// validates against) — plain draft-07 JSON Schema for every mount kind. Local
// `#/definitions/*` / `#/$defs/*` refs resolve against the document's own
// definition maps; anything unresolvable or cyclic is treated as opaque (no
// repair — the downstream validator remains the authority).

type SchemaNode = Record<string, unknown> | boolean;

function isNode(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === 'boolean' || isNode(value);
}

type Definitions = Record<string, unknown> | undefined;

/** Resolve a chain of local `#/definitions/*` / `#/$defs/*` refs. Cyclic or
 *  external refs return the node as-is (opaque — treated as unconstrained). */
function resolveNode(node: SchemaNode, defs: Definitions): SchemaNode {
  let current = node;
  const seen = new Set<string>();
  while (isNode(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
    if (!match || defs === undefined || seen.has(ref)) return current;
    seen.add(ref);
    const target = defs[match[2]];
    if (!isSchemaNode(target)) return current;
    current = target;
  }
  return current;
}

function typeSet(node: Record<string, unknown>): Set<string> {
  const declared = node.type;
  const out = new Set<string>();
  if (typeof declared === 'string') out.add(declared);
  else if (Array.isArray(declared)) {
    for (const entry of declared) if (typeof entry === 'string') out.add(entry);
  }
  return out;
}

function branchList(node: Record<string, unknown>, key: 'anyOf' | 'oneOf' | 'allOf'): SchemaNode[] {
  const list = node[key];
  return Array.isArray(list) ? list.filter(isSchemaNode) : [];
}

function unionBranches(node: Record<string, unknown>): SchemaNode[] {
  return [...branchList(node, 'anyOf'), ...branchList(node, 'oneOf')];
}

/**
 * Structural kinds a value must take to satisfy this node: 'array' / 'object'
 * from `type` or from combinator members. `seen` tracks resolved nodes so
 * recursive schemas terminate; siblings get a fresh copy because a shared
 * sub-schema is a distinct constraint position, not a cycle.
 */
function expectedCompositeKinds(
  node: SchemaNode,
  defs: Definitions,
  seen = new Set<SchemaNode>(),
): Set<'array' | 'object'> {
  const out = new Set<'array' | 'object'>();
  node = resolveNode(node, defs);
  if (!isNode(node) || seen.has(node)) return out;
  seen.add(node);
  const types = typeSet(node);
  if (types.has('array')) out.add('array');
  if (types.has('object')) out.add('object');
  for (const branch of [...unionBranches(node), ...branchList(node, 'allOf')]) {
    for (const kind of expectedCompositeKinds(branch, defs, new Set(seen))) out.add(kind);
  }
  return out;
}

/**
 * Whether a string value can satisfy this node at all. Only when it cannot is
 * a string the "model serialized the field" failure — repairing a field that
 * legitimately accepts strings would rewrite valid arguments.
 */
function acceptsString(node: SchemaNode, defs: Definitions, seen = new Set<SchemaNode>()): boolean {
  node = resolveNode(node, defs);
  if (node === true) return true;
  if (node === false) return false;
  if (!isNode(node)) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.const !== undefined) return typeof node.const === 'string';
  if (Array.isArray(node.enum)) return node.enum.some((v) => typeof v === 'string');
  const types = typeSet(node);
  if (types.has('string')) return true;
  const unions = unionBranches(node);
  const allof = branchList(node, 'allOf');
  if (unions.length === 0 && allof.length === 0) {
    // No combinators: an unconstrained node (no type, no properties/items)
    // accepts anything; a typed/structural node does not.
    return (
      types.size === 0 &&
      node.properties === undefined &&
      node.items === undefined &&
      node.prefixItems === undefined
    );
  }
  // A string satisfies a union if ANY member accepts it; it satisfies an
  // allOf only when EVERY member does (each member constrains it).
  if (unions.some((branch) => acceptsString(branch, defs, new Set(seen)))) return true;
  return allof.length > 0 && allof.every((branch) => acceptsString(branch, defs, new Set(seen)));
}

function structuralMatch(kind: 'array' | 'object', value: unknown): boolean {
  return kind === 'array' ? Array.isArray(value) : isNode(value);
}

// ─── sub-schema acceptance check ─────────────────────────────────────────────

const compiledSubSchemas = new WeakMap<Record<string, unknown>, z.ZodTypeAny | null>();

/**
 * Whether the parsed value satisfies this sub-schema, checked with the SAME
 * zod the domain parse runs (`z.fromJSONSchema` on the wire schema — the
 * `parameters` document pi validates against). Local refs resolve against the
 * document's definition maps. A schema the converter cannot express counts as
 * NOT passing — the repair is then treated as failed rather than adopted on
 * trust; the field fails at the real validator either way.
 */
function subSchemaAccepts(node: SchemaNode, value: unknown, defs: Definitions): boolean {
  node = resolveNode(node, defs);
  if (node === true) return true;
  if (node === false) return false;
  if (!isNode(node)) return true;
  const key = defs === undefined ? node : { ...node, definitions: defs };
  let compiled = compiledSubSchemas.get(key);
  if (compiled === undefined) {
    try {
      compiled = z.fromJSONSchema(key) as z.ZodTypeAny;
    } catch {
      compiled = null;
    }
    compiledSubSchemas.set(key, compiled);
  }
  if (compiled === null) return false;
  return compiled.safeParse(value).success;
}

// ─── schema-position traversal ───────────────────────────────────────────────

function collectPropertySchemas(
  node: SchemaNode,
  key: string,
  defs: Definitions,
  out: SchemaNode[],
  seen: Set<SchemaNode>,
): void {
  node = resolveNode(node, defs);
  if (!isNode(node) || seen.has(node)) return;
  seen.add(node);
  const properties = node.properties;
  if (isNode(properties) && key in properties) {
    const sub = properties[key];
    if (isSchemaNode(sub)) out.push(sub);
  } else if (isNode(node.additionalProperties)) {
    out.push(node.additionalProperties);
  }
  if (isNode(node.patternProperties)) {
    for (const [pattern, sub] of Object.entries(node.patternProperties)) {
      try {
        if (new RegExp(pattern).test(key) && isSchemaNode(sub)) out.push(sub);
      } catch {
        // A pattern the JS engine cannot compile is not ours to interpret.
      }
    }
  }
  for (const branch of [...unionBranches(node), ...branchList(node, 'allOf')]) {
    collectPropertySchemas(branch, key, defs, out, seen);
  }
}

function collectElementSchemas(
  node: SchemaNode,
  index: number,
  defs: Definitions,
  out: SchemaNode[],
  seen: Set<SchemaNode>,
): void {
  node = resolveNode(node, defs);
  if (!isNode(node) || seen.has(node)) return;
  seen.add(node);
  const items = node.items;
  if (Array.isArray(items)) {
    const sub = items[index];
    if (isSchemaNode(sub)) out.push(sub);
  } else if (isSchemaNode(items)) {
    out.push(items);
  }
  const prefix = node.prefixItems;
  if (Array.isArray(prefix)) {
    const sub = prefix[index];
    if (isSchemaNode(sub)) out.push(sub);
  }
  for (const branch of [...unionBranches(node), ...branchList(node, 'allOf')]) {
    collectElementSchemas(branch, index, defs, out, seen);
  }
}

interface RepairContext {
  definitions: Definitions;
  coercions: ToolParamCoercion[];
}

function kindPhrase(kinds: Set<'array' | 'object'>): string {
  if (kinds.size === 1) return kinds.has('array') ? 'a JSON array' : 'a JSON object';
  return 'a JSON array or object';
}

function rejectContract(path: string, kinds: Set<'array' | 'object'>): never {
  throw new ToolParamContractError(
    `field "${path}" must be ${kindPhrase(kinds)}, not a string. The string you sent ` +
      'is not valid JSON, parses to the wrong structural type, or does not satisfy the ' +
      `declared schema. Re-issue the call with "${path}" as an actual ${kindPhrase(kinds)} ` +
      'value — do not quote it or re-serialize it as a JSON string.',
  );
}

/**
 * Walk `value` against the candidate sub-schemas applying at this position.
 * Returns the original or repaired value; throws ToolParamContractError when a
 * string field REQUIRES repair (some candidate expects a composite and rejects
 * strings) but no candidate's repair succeeds.
 */
function repairValue(
  value: unknown,
  schemas: readonly SchemaNode[],
  path: string,
  ctx: RepairContext,
): unknown {
  if (typeof value === 'string') {
    let required: Set<'array' | 'object'> | undefined;
    for (const candidate of schemas) {
      const kinds = expectedCompositeKinds(candidate, ctx.definitions);
      if (kinds.size === 0 || acceptsString(candidate, ctx.definitions)) continue;
      required ??= kinds;
      // Exactly ONE strict parse per field — no markdown extraction, no
      // brace-slicing, no second attempt.
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue;
      }
      if (![...kinds].some((kind) => structuralMatch(kind, parsed))) continue;
      if (!subSchemaAccepts(candidate, parsed, ctx.definitions)) continue;
      ctx.coercions.push({
        field_path: path === '' ? '(root)' : path,
        original_length: value.length,
      });
      // The adopted value is walked on (nested string fields are their own
      // one-parse repairs) — the parsed value itself is never re-parsed.
      return repairValue(parsed, [candidate], path, ctx);
    }
    if (required !== undefined) rejectContract(path === '' ? '(root)' : path, required);
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((element, index) => {
      const candidates: SchemaNode[] = [];
      for (const schema of schemas)
        collectElementSchemas(schema, index, ctx.definitions, candidates, new Set());
      if (candidates.length === 0) return element;
      const repaired = repairValue(
        element,
        candidates,
        `${path === '' ? '(root)' : path}.${index}`,
        ctx,
      );
      if (repaired !== element) changed = true;
      return repaired;
    });
    return changed ? next : value;
  }
  if (isNode(value)) {
    let changed = false;
    const next: Record<string, unknown> = { ...value };
    for (const key of Object.keys(value)) {
      const candidates: SchemaNode[] = [];
      for (const schema of schemas)
        collectPropertySchemas(schema, key, ctx.definitions, candidates, new Set());
      if (candidates.length === 0) continue;
      const repaired = repairValue(
        value[key],
        candidates,
        path === '' ? key : `${path}.${key}`,
        ctx,
      );
      if (repaired !== value[key]) {
        next[key] = repaired;
        changed = true;
      }
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * Shared tool-parameter repair: one strict JSON.parse for each string field
 * whose sub-schema expects array/object and rejects strings. Adopted repairs
 * are recorded in `coercions` (field path + original length only — never the
 * payload). Throws {@link ToolParamContractError} when a required repair
 * fails; the caller turns that into the isError tool result.
 */
export function repairToolArguments(parameters: unknown, args: unknown): ToolParamRepairOutcome {
  const root: SchemaNode = isSchemaNode(parameters) ? parameters : {};
  const definitions = isNode(root)
    ? isNode(root.definitions)
      ? root.definitions
      : isNode(root.$defs)
        ? root.$defs
        : undefined
    : undefined;
  const ctx: RepairContext = { definitions, coercions: [] };
  const repaired = repairValue(args, [root], '', ctx);
  return { args: repaired, coercions: ctx.coercions };
}
