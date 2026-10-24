// YUK-1547 / YUK-1559 (C1/C6) — shared tool-parameter contract repair.
//
// Observed wire failure: the model serializes an array/object field as a JSON
// string inside otherwise well-formed arguments. The envelope parses and the
// assistant turn lands, but the declared schema rejects the field and the call is
// dead. pi validates before `AgentTool.execute` and does not JSON-parse strings,
// so the repair must run at the `prepareArguments` seam pi calls ahead of it.
//
// Policy (shared with the admission preflight — no second implementation): a
// string field whose sub-schema expects array/object and rejects strings gets
// exactly ONE strict JSON.parse, adopted only when the parsed value has the
// expected structure and passes that sub-schema. A required repair that fails
// rejects the call with `ToolParamContractError`, whose `[tool_param_contract]`
// marker identifies the one correction-eligible failure.
//
// Never: guessing, markdown extraction, primitive coercion, provider/model/task
// special-casing, silent field deletion, re-parsing a parsed field, or schema
// loosening. Fields whose schema accepts strings are never touched.

import { z } from 'zod';

/** Marker identifying the correction-eligible parameter-contract failure. */
export const TOOL_PARAM_CONTRACT_MARKER = '[tool_param_contract]';

export interface ToolParamCoercion {
  /** Dotted field path; `(root)` when the whole arguments value was a string. */
  field_path: string;
  /** String length of the model's serialized value, before parsing. */
  original_length: number;
}

export interface ToolParamRepairOutcome {
  args: unknown;
  coercions: ToolParamCoercion[];
}

/**
 * Rejection for the correction-eligible failure. The marker stays first so pi's
 * error result is identifiable without parsing the human-facing sentence.
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
 * True when an isError result failed at the argument-contract seam (our rejection
 * or pi's schema validation) rather than at lookup, a hook block or an abort —
 * these are the non-executed calls that get C6 raw-arguments evidence.
 */
export function isToolArgumentContractFailure(result: {
  isError?: boolean;
  content?: unknown;
}): boolean {
  if (result.isError !== true) return false;
  const text = toolResultText(result.content);
  return text.includes(TOOL_PARAM_CONTRACT_MARKER) || text.startsWith('Validation failed for tool');
}

/** True when the result is OUR contract rejection — the one correction-eligible failure. */
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
// The walk inspects the tool's `parameters` document — the wire schema pi
// validates against. Local refs resolve against the document's own definitions;
// anything unresolvable or cyclic stays opaque (no repair — the validator owns it).

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
 * Structural kinds that satisfy this node: 'array' / 'object' from `type` or
 * combinator members. `seen` terminates recursive schemas; siblings get a fresh
 * copy because a shared sub-schema is a distinct constraint position, not a cycle.
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
 * Whether a string can satisfy this node at all. Repairing a field that
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
 * Whether the parsed value satisfies this sub-schema, checked with the same zod
 * the domain parse runs (`z.fromJSONSchema` on the wire schema). A schema the
 * converter cannot express counts as NOT passing, so the repair fails here rather
 * than being adopted on trust.
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
 * Expand a node into conjunctive leaf positions: each anyOf/oneOf member becomes
 * its own position with sibling constraints folded in via allOf, so a repair
 * validates the WHOLE applicable sub-schema (discriminators, required fields)
 * instead of treating flattened alternatives as independent authorities.
 */
function collectConjunctive(
  node: SchemaNode,
  defs: Definitions,
  out: SchemaNode[],
  seen: Set<SchemaNode>,
): void {
  node = resolveNode(node, defs);
  if (!isNode(node) || seen.has(node)) return;
  seen.add(node);
  const unions = unionBranches(node);
  if (unions.length === 0) {
    out.push(node);
    return;
  }
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = node;
  const mergedAllOf = branchList(node, 'allOf');
  for (const branch of unions) {
    collectConjunctive({ ...rest, allOf: [...mergedAllOf, branch] }, defs, out, new Set(seen));
  }
}

/** Exactly one strict JSON.parse for a field, reused across candidates. */
function parseOnce(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/** Repair the fields of an object value under ONE conjunctive position. */
function repairObjectFields(
  value: Record<string, unknown>,
  position: Record<string, unknown>,
  path: string,
  ctx: RepairContext,
): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = { ...value };
  for (const key of Object.keys(value)) {
    const candidates: SchemaNode[] = [];
    collectPropertySchemas(position, key, ctx.definitions, candidates, new Set());
    if (candidates.length === 0) continue;
    const repaired = repairValue(value[key], candidates, path === '' ? key : `${path}.${key}`, ctx);
    if (repaired !== value[key]) {
      next[key] = repaired;
      changed = true;
    }
  }
  return changed ? next : value;
}

/** Repair the elements of an array value under ONE conjunctive position. */
function repairArrayElements(
  value: unknown[],
  position: Record<string, unknown>,
  path: string,
  ctx: RepairContext,
): unknown[] {
  let changed = false;
  const next = value.map((element, index) => {
    const candidates: SchemaNode[] = [];
    collectElementSchemas(position, index, ctx.definitions, candidates, new Set());
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

/**
 * Walk `value` against the sub-schemas at this position, returning the original or
 * repaired value and throwing ToolParamContractError when a required repair fails.
 *
 * Branch discipline: a value valid under ANY applicable schema is preserved
 * untouched — a valid string in one union branch is never reinterpreted through
 * another. A repair is adopted only when the whole repaired position validates
 * under the same conjunctive candidate and the original schema set (oneOf
 * uniqueness, sibling constraints). The first field-level error wins.
 */
function repairValue(
  value: unknown,
  schemas: readonly SchemaNode[],
  path: string,
  ctx: RepairContext,
): unknown {
  for (const schema of schemas) {
    if (subSchemaAccepts(schema, value, ctx.definitions)) return value;
  }
  const positions: SchemaNode[] = [];
  for (const schema of schemas) {
    collectConjunctive(schema, ctx.definitions, positions, new Set());
  }
  const wholeSchemaAccepts = (candidate: SchemaNode, repaired: unknown): boolean =>
    subSchemaAccepts(candidate, repaired, ctx.definitions) &&
    schemas.some((schema) => subSchemaAccepts(schema, repaired, ctx.definitions));

  if (typeof value === 'string') {
    let required: Set<'array' | 'object'> | undefined;
    let parsed: { ok: true; value: unknown } | { ok: false } | undefined;
    for (const position of positions) {
      const kinds = expectedCompositeKinds(position, ctx.definitions);
      if (kinds.size === 0 || acceptsString(position, ctx.definitions)) continue;
      required ??= kinds;
      if (parsed === undefined) parsed = parseOnce(value);
      if (!parsed.ok) continue;
      const parsedValue = parsed.value;
      if (![...kinds].some((kind) => structuralMatch(kind, parsedValue))) continue;
      if (!wholeSchemaAccepts(position, parsedValue)) continue;
      ctx.coercions.push({
        field_path: path === '' ? '(root)' : path,
        original_length: value.length,
      });
      return parsedValue;
    }
    if (required !== undefined) rejectContract(path === '' ? '(root)' : path, required);
    return value;
  }
  if (isNode(value)) {
    let firstError: ToolParamContractError | undefined;
    for (const position of positions) {
      if (!isNode(position)) continue;
      const mark = ctx.coercions.length;
      let next: Record<string, unknown>;
      try {
        next = repairObjectFields(value, position, path, ctx);
      } catch (error) {
        ctx.coercions.length = mark;
        if (isToolParamContractError(error)) {
          firstError ??= error;
          continue;
        }
        throw error;
      }
      if (next !== value && wholeSchemaAccepts(position, next)) return next;
      ctx.coercions.length = mark;
    }
    if (firstError !== undefined) throw firstError;
    return value;
  }
  if (Array.isArray(value)) {
    let firstError: ToolParamContractError | undefined;
    for (const position of positions) {
      if (!isNode(position)) continue;
      const mark = ctx.coercions.length;
      let next: unknown[];
      try {
        next = repairArrayElements(value, position, path, ctx);
      } catch (error) {
        ctx.coercions.length = mark;
        if (isToolParamContractError(error)) {
          firstError ??= error;
          continue;
        }
        throw error;
      }
      if (next !== value && wholeSchemaAccepts(position, next)) return next;
      ctx.coercions.length = mark;
    }
    if (firstError !== undefined) throw firstError;
    return value;
  }
  return value;
}

/**
 * Shared repair: one strict JSON.parse per string field whose sub-schema expects
 * array/object and rejects strings. `coercions` records path + original length
 * only, never the payload. Throws when a required repair fails.
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
