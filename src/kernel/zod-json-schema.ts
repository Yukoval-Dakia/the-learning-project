import { type ZodTypeAny, z } from 'zod';

type JsonObject = Record<string, unknown>;

type SchemaOverride = NonNullable<z.core.ToJSONSchemaParams['override']>;

type ZodJsonSchemaCompatParams = Readonly<{
  io: 'input';
  reused: 'inline';
}> &
  (
    | Readonly<{
        target: 'draft-07';
        override?: never;
        unrepresentable?: never;
      }>
    | Readonly<{
        target: 'openapi-3.0';
        override?: SchemaOverride;
        unrepresentable: 'any';
      }>
  );

const KEY_ORDER = [
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'multipleOf',
  'default',
  'description',
  '$schema',
] as const;

const KEY_RANK = new Map<string, number>(KEY_ORDER.map((key, index) => [key, index]));

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullablePrimitiveType(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [left, right] = value;
  if (!isJsonObject(left) || !isJsonObject(right)) return undefined;
  const nonNull = left.type === 'null' ? right : right.type === 'null' ? left : undefined;
  if (!nonNull || Object.keys(nonNull).length !== 1) return undefined;
  return typeof nonNull.type === 'string' ? nonNull.type : undefined;
}

function normalizeSchemaMap(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, schema]) => [key, normalizeNode(schema)]),
  );
}

function normalizeNestedSchema(key: string, value: unknown): unknown {
  if (key === 'properties' || key === '$defs' || key === 'definitions') {
    return normalizeSchemaMap(value);
  }
  if (key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'prefixItems') {
    return Array.isArray(value) ? value.map(normalizeNode) : value;
  }
  if (key === 'items' || key === 'additionalProperties' || key === 'not' || key === 'contains') {
    return normalizeNode(value);
  }
  return value;
}

function sortSchemaKeys(node: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(node).sort(([left], [right]) => {
      const leftRank = KEY_RANK.get(left) ?? KEY_ORDER.length;
      const rightRank = KEY_RANK.get(right) ?? KEY_ORDER.length;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }),
  );
}

function normalizeNode(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema')
      .map(([key, nested]) => [key, normalizeNestedSchema(key, nested)]),
  );
  const nullableType = nullablePrimitiveType(normalized.anyOf);
  if (nullableType) {
    normalized.type = [nullableType, 'null'];
    normalized.anyOf = undefined;
  }
  if (normalized.type === 'integer' && normalized.minimum === Number.MIN_SAFE_INTEGER) {
    normalized.minimum = undefined;
  }
  if (normalized.type === 'integer' && normalized.maximum === Number.MAX_SAFE_INTEGER) {
    normalized.maximum = undefined;
  }
  if (normalized.type === 'object' && !('additionalProperties' in normalized)) {
    normalized.additionalProperties = false;
  }
  if ('$schema' in value) normalized.$schema = value.$schema;
  return sortSchemaKeys(
    Object.fromEntries(Object.entries(normalized).filter(([, nested]) => nested !== undefined)),
  );
}

function inlineDefinitions(
  value: unknown,
  definitions: JsonObject,
  preserveCycles: boolean,
  resolving: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => inlineDefinitions(nested, definitions, preserveCycles, resolving));
  }
  if (!isJsonObject(value)) return value;

  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/definitions/')) {
    const name = value.$ref.slice('#/definitions/'.length);
    const definition = definitions[name];
    if (definition === undefined || resolving.has(name)) return preserveCycles ? value : {};
    return inlineDefinitions(
      definition,
      definitions,
      preserveCycles,
      new Set([...resolving, name]),
    );
  }

  const inlined = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'definitions')
      .map(([key, nested]) => [
        key,
        inlineDefinitions(nested, definitions, preserveCycles, resolving),
      ]),
  );
  if (
    Array.isArray(inlined.allOf) &&
    inlined.allOf.length === 1 &&
    isJsonObject(inlined.allOf[0])
  ) {
    const { allOf: _allOf, ...siblings } = inlined;
    return { ...inlined.allOf[0], ...siblings };
  }
  return inlined;
}

function containsDefinitionRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDefinitionRef);
  if (!isJsonObject(value)) return false;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/definitions/')) return true;
  return Object.values(value).some(containsDefinitionRef);
}

export function zodToJsonSchemaCompat(
  schema: ZodTypeAny,
  params: ZodJsonSchemaCompatParams,
): JsonObject {
  const callerOverride = params.override;
  const normalized = normalizeNode(
    z.toJSONSchema(schema, {
      ...params,
      override: (context) => {
        if (context.zodSchema instanceof z.ZodDate) {
          context.jsonSchema.type = 'string';
          context.jsonSchema.format = 'date-time';
        }
        callerOverride?.(context);
        if (
          context.zodSchema instanceof z.ZodDiscriminatedUnion &&
          Array.isArray(context.jsonSchema.oneOf)
        ) {
          context.jsonSchema.anyOf = context.jsonSchema.oneOf;
          context.jsonSchema.oneOf = undefined;
        }
      },
    }),
  );
  if (!isJsonObject(normalized)) throw new TypeError('Zod JSON Schema output must be an object');
  if (isJsonObject(normalized.definitions)) {
    const inlined = inlineDefinitions(
      normalized,
      normalized.definitions,
      params.target === 'draft-07',
    );
    if (!isJsonObject(inlined)) throw new TypeError('Inlined JSON Schema output must be an object');
    if (params.target === 'draft-07' && containsDefinitionRef(inlined)) {
      inlined.definitions = normalized.definitions;
    }
    return inlined;
  }
  return normalized;
}

/**
 * YUK-1547 / YUK-1559 — the tool-parameters wire contract: provider
 * function-calling APIs reject a `parameters` document whose root does not
 * declare `type:"object"` (observed 400: `schema must be a JSON Schema of
 * 'type: "object"', got 'type: null'`).
 *
 * A union of pure object branches compiles to a bare `anyOf`/`oneOf` root —
 * declare the root type and keep the branches untouched; the validation
 * semantics are identical because every branch already requires an object.
 * A root that is genuinely not an object (array / primitive / unconstrained /
 * allOf-only / $ref-only) is a tool-contract violation: it throws with the
 * offending shape so the owning consumer fixes the real contract instead of
 * being masked behind an empty object.
 */
export function ensureToolParametersObjectRoot(schema: JsonObject): JsonObject {
  if (schema.type === 'object') return schema;
  const union = schema.anyOf ?? schema.oneOf;
  if (
    schema.type === undefined &&
    Array.isArray(union) &&
    union.length > 0 &&
    union.every((branch) => isJsonObject(branch) && branch.type === 'object')
  ) {
    return sortSchemaKeys({ ...schema, type: 'object' });
  }
  throw new Error(
    `tool parameters root must declare type:"object"; got ${JSON.stringify({
      type: schema.type ?? null,
      keys: Object.keys(schema).slice(0, 12),
    })}`,
  );
}

/**
 * `zodToJsonSchemaCompat` scoped to the tool-parameters boundary: same
 * conversion, plus the object-root contract above. This is the ONLY boundary
 * the root guarantee applies to — ordinary (non-tool) JSON Schema output
 * keeps whatever root the Zod schema produced.
 */
export function zodToToolParametersSchema(
  schema: ZodTypeAny,
  params: ZodJsonSchemaCompatParams,
): JsonObject {
  return ensureToolParametersObjectRoot(zodToJsonSchemaCompat(schema, params));
}
