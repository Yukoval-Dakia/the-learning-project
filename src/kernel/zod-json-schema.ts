import { type ZodTypeAny, z } from 'zod';

type JsonObject = Record<string, unknown>;

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

function normalizeNode(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema')
      .map(([key, nested]) => [key, normalizeNestedSchema(key, nested)]),
  );
  const nullableType = nullablePrimitiveType(normalized.anyOf);
  if (nullableType) return { type: [nullableType, 'null'] };
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
  return Object.fromEntries(
    Object.entries(normalized)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => {
        const leftRank = KEY_RANK.get(left) ?? KEY_ORDER.length - 1;
        const rightRank = KEY_RANK.get(right) ?? KEY_ORDER.length - 1;
        return leftRank - rightRank;
      }),
  );
}

function inlineDefinitions(
  value: unknown,
  definitions: JsonObject,
  resolving: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => inlineDefinitions(nested, definitions, resolving));
  }
  if (!isJsonObject(value)) return value;

  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/definitions/')) {
    const name = value.$ref.slice('#/definitions/'.length);
    const definition = definitions[name];
    if (definition === undefined || resolving.has(name)) return {};
    return inlineDefinitions(definition, definitions, new Set([...resolving, name]));
  }

  const inlined = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'definitions')
      .map(([key, nested]) => [key, inlineDefinitions(nested, definitions, resolving)]),
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

export function zodToJsonSchemaCompat(
  schema: ZodTypeAny,
  params: z.core.ToJSONSchemaParams,
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
      },
    }),
  );
  if (!isJsonObject(normalized)) throw new TypeError('Zod JSON Schema output must be an object');
  if (!isJsonObject(normalized.definitions)) return normalized;
  const inlined = inlineDefinitions(normalized, normalized.definitions);
  if (!isJsonObject(inlined)) throw new TypeError('Inlined JSON Schema output must be an object');
  return inlined;
}
