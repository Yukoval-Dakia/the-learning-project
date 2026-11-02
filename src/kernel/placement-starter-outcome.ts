import { z } from 'zod';
import { QuizGenOutput } from '@/core/schema/quiz_gen';

const MAX_ISSUES = 16;
const MAX_PATH_DEPTH = 12;
const REDACTED = '[redacted]';

// Only schema-owned field names may cross the failure boundary. Record keys and
// validation messages can contain provider content, so neither is retained.
function schemaFieldNames(schema: unknown, fields = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const child of schema) schemaFieldNames(child, fields);
  } else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const name of Object.keys(value)) fields.add(name);
      }
      schemaFieldNames(value, fields);
    }
  }
  return fields;
}

const fieldNames = schemaFieldNames(z.toJSONSchema(QuizGenOutput, { io: 'input' }));
const SchemaIssue = z
  .object({
    code: z.enum([
      'invalid_type',
      'too_big',
      'too_small',
      'invalid_format',
      'not_multiple_of',
      'unrecognized_keys',
      'invalid_union',
      'invalid_key',
      'invalid_element',
      'invalid_value',
      'custom',
    ]),
    path: z
      .array(z.union([z.enum([...fieldNames, REDACTED]), z.number().int().min(0).max(1_000_000)]))
      .max(MAX_PATH_DEPTH),
    path_truncated: z.boolean(),
  })
  .strict();

export const PlacementStarterFailureSchema = z.discriminatedUnion('code', [
  z
    .object({
      code: z.literal('schema_invalid'),
      issues: z.array(SchemaIssue).min(1).max(MAX_ISSUES),
      issue_count: z.number().int().min(1).max(1_000_000),
      issues_truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      code: z.enum([
        'json_invalid',
        'json_object_missing',
        'underfilled',
        'verification_timeout',
        'interrupted',
        'cost_unknown',
        'budget_exhausted',
        'delivery_lost',
        'authority_unknown',
        'unknown',
      ]),
    })
    .strict(),
]);
export type PlacementStarterFailure = z.infer<typeof PlacementStarterFailureSchema>;

export function placementSchemaFailure(issues: z.ZodIssue[]): PlacementStarterFailure {
  return {
    code: 'schema_invalid',
    issues: issues.slice(0, MAX_ISSUES).map((issue) => ({
      code: issue.code,
      path: issue.path.slice(0, MAX_PATH_DEPTH).map((segment) => {
        if (typeof segment === 'string' && fieldNames.has(segment)) return segment;
        if (
          typeof segment === 'number' &&
          Number.isInteger(segment) &&
          segment >= 0 &&
          segment <= 1_000_000
        )
          return segment;
        return REDACTED;
      }),
      path_truncated: issue.path.length > MAX_PATH_DEPTH,
    })),
    issue_count: Math.min(issues.length, 1_000_000),
    issues_truncated: issues.length > MAX_ISSUES,
  };
}

const Binding = z.object({
  session_id: z.string(),
  goal_id: z.string().nullable(),
  semantic_goal_revision_id: z.string().nullable(),
  subject_id: z.string().nullable(),
  claim_id: z.string().nullable(),
});
const ClaimBinding = Binding.extend({
  goal_id: z.string(),
  semantic_goal_revision_id: z.string(),
  subject_id: z.string(),
  claim_id: z.string(),
});

export const PlacementStarterOutcomeSchema = z.discriminatedUnion('state', [
  Binding.extend({
    claim_id: z.null(),
    state: z.literal('absent'),
    next_action: z.enum(['provide_goal', 'source_questions']),
    failure_reason: z.null(),
  }),
  ClaimBinding.extend({
    state: z.literal('pending'),
    next_action: z.literal('wait_for_supply'),
    failure_reason: PlacementStarterFailureSchema.nullable(),
  }),
  ClaimBinding.extend({
    state: z.literal('satisfied'),
    next_action: z.literal('continue_placement'),
    failure_reason: z.null(),
  }),
  ClaimBinding.extend({
    state: z.literal('exhausted'),
    next_action: z.literal('review_supply_failure'),
    failure_reason: PlacementStarterFailureSchema,
  }),
  Binding.extend({
    state: z.literal('unknown'),
    next_action: z.literal('resolve_unknown_outcome'),
    failure_reason: PlacementStarterFailureSchema,
  }),
]);
export type PlacementStarterOutcome = z.infer<typeof PlacementStarterOutcomeSchema>;

export function readPlacementStarterFailure(row: {
  last_error_class: string | null;
  last_error_code: string | null;
  last_error: string | null;
}): PlacementStarterFailure {
  if (
    row.last_error_class === 'placement_starter_failure_v1' &&
    row.last_error &&
    row.last_error.length <= 16_384
  ) {
    try {
      const parsed = PlacementStarterFailureSchema.safeParse(JSON.parse(row.last_error));
      if (parsed.success && parsed.data.code === row.last_error_code) return parsed.data;
    } catch {
      // Historical free text is never copied into the public reason.
    }
  }
  switch (row.last_error_code) {
    case 'cost_unknown':
      return { code: 'cost_unknown' };
    case 'budget_exhausted':
      return { code: 'budget_exhausted' };
    case 'inflight_delivery_lost':
      return { code: 'delivery_lost' };
    default:
      return { code: 'unknown' };
  }
}
