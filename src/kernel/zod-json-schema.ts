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

const SCHEMA_RECORD_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

const SCHEMA_ARRAY_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

const SCHEMA_NODE_KEYS = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'contains',
  'if',
  'then',
  'else',
  'propertyNames',
  'contentSchema',
]);

/**
 * A positional array. `closed` already forbids items past the prefix
 * (`additionalItems: false`, `items: false`, or `maxItems` within the prefix).
 * `open` has a tail schema that applies past the prefix.
 */
type TupleShape =
  | { readonly kind: 'absent' }
  | { readonly kind: 'closed'; readonly positions: readonly unknown[] }
  | { readonly kind: 'open'; readonly positions: readonly unknown[]; readonly tail: unknown };

function lengthCapped(node: JsonObject, positions: number): boolean {
  return typeof node.maxItems === 'number' && node.maxItems <= positions;
}

function readPrefixedTuple(node: JsonObject, positions: readonly unknown[]): TupleShape {
  if (
    lengthCapped(node, positions.length) ||
    node.items === false ||
    node.additionalItems === false
  ) {
    return { kind: 'closed', positions };
  }
  if (isJsonObject(node.items)) return { kind: 'open', positions, tail: node.items };
  if (node.items === true) return { kind: 'open', positions, tail: {} };
  if (isJsonObject(node.additionalItems))
    return { kind: 'open', positions, tail: node.additionalItems };
  if (node.additionalItems === true || node.items === undefined) {
    return { kind: 'open', positions, tail: {} };
  }
  return { kind: 'closed', positions };
}

function readDraft07Tuple(node: JsonObject, positions: readonly unknown[]): TupleShape {
  if (lengthCapped(node, positions.length) || node.additionalItems === false) {
    return { kind: 'closed', positions };
  }
  if (isJsonObject(node.additionalItems))
    return { kind: 'open', positions, tail: node.additionalItems };
  if (node.additionalItems === true || node.additionalItems === undefined) {
    return { kind: 'open', positions, tail: {} };
  }
  return { kind: 'closed', positions };
}

function readTupleShape(node: JsonObject): TupleShape {
  if (Array.isArray(node.prefixItems)) return readPrefixedTuple(node, node.prefixItems);
  if (Array.isArray(node.items)) return readDraft07Tuple(node, node.items);
  return { kind: 'absent' };
}

function collapseItemSchemas(schemas: readonly unknown[]): unknown {
  const unique = schemas.filter(
    (item, index) =>
      schemas.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index,
  );
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) return {};
  if (
    unique.some((item) => item === true || (isJsonObject(item) && Object.keys(item).length === 0))
  ) {
    return {};
  }
  return { anyOf: unique };
}

function flattenSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flattenTupleItems);
  return flattenTupleItems(value);
}

function flattenAtSchemaKey(key: string, value: unknown): unknown {
  if (key === 'items' || key === 'additionalItems') return flattenSchemaValue(value);
  if (SCHEMA_RECORD_KEYS.has(key)) {
    if (!isJsonObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, schema]) => [name, flattenTupleItems(schema)]),
    );
  }
  if (SCHEMA_ARRAY_KEYS.has(key)) {
    return Array.isArray(value) ? value.map(flattenTupleItems) : value;
  }
  if (SCHEMA_NODE_KEYS.has(key)) return flattenTupleItems(value);
  return value;
}

function rewriteTupleNode(node: JsonObject): JsonObject {
  const shape = readTupleShape(node);
  if (shape.kind === 'absent') return node;
  const { prefixItems: _prefix, additionalItems: _additional, ...rest } = node;
  const items =
    shape.kind === 'closed'
      ? collapseItemSchemas(shape.positions)
      : collapseItemSchemas([...shape.positions, shape.tail]);
  return sortSchemaKeys({
    ...rest,
    items,
    minItems: rest.minItems ?? shape.positions.length,
    ...(shape.kind === 'closed' ? { maxItems: rest.maxItems ?? shape.positions.length } : {}),
  });
}

/**
 * Tuple arrays (`z.tuple`) compile to draft-07 `items: [...]` + `additionalItems`
 * (or `prefixItems`). mimo-v2.6-pro rejects that form with 400 (YUK-1718: the
 * `range` tuple on search_bank / file_bank_gap). The wire uses one `items`
 * schema. Closed tuples keep their length. An open tail is not capped at the
 * prefix: `items` is the union of the prefix schemas and the tail, and no
 * `maxItems` is added. Registry tools still validate with the original Zod
 * tuple. Instance data (`default`, `const`, `enum`, `examples`) is not walked.
 */
function flattenTupleItems(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, flattenAtSchemaKey(key, nested)]),
  );
  return rewriteTupleNode(node);
}

/**
 * Tool-parameters wire contract: providers reject roots without type:"object".
 * A union of object branches gets the root type; any other root is a contract
 * violation and throws instead of being masked as an empty object. Tuple items
 * are flattened to the single-schema form every provider accepts.
 */
export function ensureToolParametersObjectRoot(
  input: JsonObject,
  projectUnionProperties = false,
): JsonObject {
  const schema = flattenTupleItems(input) as JsonObject;
  if (schema.type === 'object') return schema;
  const union = schema.anyOf ?? schema.oneOf;
  if (
    schema.type === undefined &&
    Array.isArray(union) &&
    union.length > 0 &&
    union.every((branch) => isJsonObject(branch) && branch.type === 'object')
  ) {
    if (!projectUnionProperties) return sortSchemaKeys({ ...schema, type: 'object' });
    // Providers also discover fields through root properties; keep the branch constraints.
    const branches = union.filter(isJsonObject);
    const strict = branches.every(
      (branch) => branch.additionalProperties === false && isJsonObject(branch.properties),
    );
    if (
      !strict ||
      schema.properties !== undefined ||
      schema.required !== undefined ||
      schema.additionalProperties !== undefined
    )
      return sortSchemaKeys({ ...schema, type: 'object' });
    const fields = new Map<string, unknown[]>();
    for (const branch of branches) {
      for (const [key, value] of Object.entries(branch.properties as JsonObject)) {
        const variants = fields.get(key) ?? [];
        if (!variants.some((other) => JSON.stringify(other) === JSON.stringify(value)))
          variants.push(value);
        fields.set(key, variants);
      }
    }
    const properties = Object.fromEntries(
      [...fields].map(([key, variants]) => {
        const constants = variants.filter(isJsonObject).map((variant) => variant.const);
        const value =
          variants.length === 1
            ? variants[0]
            : constants.length === variants.length &&
                constants.every((constant) => constant !== undefined)
              ? {
                  ...(variants.every(
                    (variant) =>
                      isJsonObject(variant) && variant.type === (variants[0] as JsonObject).type,
                  ) && typeof (variants[0] as JsonObject).type === 'string'
                    ? { type: (variants[0] as JsonObject).type }
                    : {}),
                  enum: constants,
                }
              : { anyOf: variants };
        return [key, value];
      }),
    );
    const required = Array.isArray(branches[0].required)
      ? branches[0].required.filter((key) =>
          branches.every(
            (branch) => Array.isArray(branch.required) && branch.required.includes(key),
          ),
        )
      : [];
    return sortSchemaKeys({
      ...schema,
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    });
  }
  throw new Error(
    `tool parameters root must declare type:"object"; got ${JSON.stringify({
      type: schema.type ?? null,
      keys: Object.keys(schema).slice(0, 12),
    })}`,
  );
}

/**
 * Tool-parameters conversion only; ordinary schema output keeps whatever root Zod
 * produced.
 */
export function zodToToolParametersSchema(
  schema: ZodTypeAny,
  params: ZodJsonSchemaCompatParams,
  projectUnionProperties = false,
): JsonObject {
  return ensureToolParametersObjectRoot(
    zodToJsonSchemaCompat(schema, params),
    projectUnionProperties,
  );
}
