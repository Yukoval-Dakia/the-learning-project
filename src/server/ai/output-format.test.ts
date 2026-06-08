// YUK-299 — unit for the Zod → Agent SDK outputFormat adapter.
//
// Pure no-DB unit: imports only ./output-format (→ zod-to-json-schema, a pure JS
// converter) + @/core/schema/business (Zod). No @/db / pg / drizzle / SDK runtime
// surface, so this lives in the fast (unit) partition. It MUST be enumerated in
// fastTestInclude (vitest.shared.ts): src/server/ai/** has no unit glob (only
// judges/**), so without the explicit entry the db config's src/**/*.test.ts glob
// would sweep it into the testcontainer partition.
//
// Assertions are pinned to a REAL zodToJsonSchema(VariantVerificationResult) run,
// so OSS upgrades / dialect drift are caught here (this wrapper is the one dialect
// seam — §3.4 of the plan).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { VariantVerificationResult } from '@/core/schema/business';
import { zodToJsonSchemaOutputFormat } from './output-format';

// Recursively collect every object key in a JSON-Schema value, so we can assert
// the absence of dialect keys ($ref / $schema) anywhere in the tree.
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('zodToJsonSchemaOutputFormat', () => {
  const result = zodToJsonSchemaOutputFormat(VariantVerificationResult);
  const schema = result.schema as {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: unknown;
  };
  const props = schema.properties ?? {};

  it('returns the json_schema envelope shape', () => {
    expect(result.type).toBe('json_schema');
    expect(typeof result.schema).toBe('object');
    expect(schema.type).toBe('object');
  });

  it('converts an enum to {type:string, enum:[...]}', () => {
    expect(props.verdict).toEqual({ type: 'string', enum: ['pass', 'fail'] });
    expect(props.cause_targeting).toEqual({
      type: 'string',
      enum: ['on_target', 'off_target', 'unclear'],
    });
  });

  it('converts an array with item min/max + maxItems', () => {
    expect(props.failure_reasons).toMatchObject({
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 500 },
      maxItems: 10,
    });
  });

  it('emits the default keyword for a .default([]) field', () => {
    expect(props.failure_reasons?.default).toEqual([]);
  });

  it('omits a .default([]) field from required', () => {
    expect(schema.required).toEqual(['verdict', 'cause_targeting', 'summary_md', 'confidence']);
    expect(schema.required).not.toContain('failure_reasons');
  });

  it('converts number min/max to minimum/maximum', () => {
    expect(props.confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('converts string min/max to minLength/maxLength', () => {
    expect(props.summary_md).toMatchObject({ type: 'string', minLength: 1, maxLength: 1000 });
  });

  it('strips the $schema meta-schema pointer (dialect coercion)', () => {
    expect('$schema' in result.schema).toBe(false);
  });

  it('preserves additionalProperties:false (dialect decision)', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it('emits no $ref anywhere (inline form)', () => {
    expect(collectKeys(result.schema).has('$ref')).toBe(false);
  });

  it('emits no $schema anywhere (stripped at the top, none nested)', () => {
    expect(collectKeys(result.schema).has('$schema')).toBe(false);
  });

  it('handles a nested object schema without $ref (inline form holds)', () => {
    // Belt-and-braces for the long-tail (judges) shapes the seam will migrate:
    // a nested object must inline, not produce a $ref/definitions envelope.
    const nested = z.object({
      outer: z.object({ inner: z.string() }),
      list: z.array(z.object({ v: z.number() })),
    });
    const out = zodToJsonSchemaOutputFormat(nested);
    expect(collectKeys(out.schema).has('$ref')).toBe(false);
    expect(out.type).toBe('json_schema');
  });
});
