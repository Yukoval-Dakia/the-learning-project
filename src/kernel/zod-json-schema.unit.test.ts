import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodToJsonSchemaCompat } from './zod-json-schema';

const DRAFT_07_INPUT = {
  target: 'draft-07',
  io: 'input',
  reused: 'inline',
} as const;

function collectRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    if (key === '$ref' && typeof nested === 'string') return [nested];
    return collectRefs(nested);
  });
}

describe('zodToJsonSchemaCompat', () => {
  it('preserves exclusive-union semantics when converting z.xor()', () => {
    // Given
    const schema = z.xor([z.object({ left: z.string() }), z.object({ right: z.string() })]);

    // When
    const converted = zodToJsonSchemaCompat(schema, DRAFT_07_INPUT);

    // Then
    expect(converted.oneOf).toHaveLength(2);
    expect(converted).not.toHaveProperty('anyOf');
  });

  it('preserves sibling metadata when folding a nullable primitive', () => {
    // Given
    const schema = z.string().nullable().default('fallback');

    // When
    const converted = zodToJsonSchemaCompat(schema, DRAFT_07_INPUT);

    // Then
    expect(converted).toMatchObject({ type: ['string', 'null'], default: 'fallback' });
  });

  it('keeps discriminated unions in the supported anyOf compatibility form', () => {
    // Given
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('left'), value: z.string() }),
      z.object({ kind: z.literal('right'), value: z.number() }),
    ]);

    // When
    const converted = zodToJsonSchemaCompat(schema, DRAFT_07_INPUT);

    // Then
    expect(converted.anyOf).toHaveLength(2);
    expect(converted).not.toHaveProperty('oneOf');
  });

  it('preserves recursive references instead of widening cycles to empty schemas', () => {
    // Given
    type RecursiveNode = {
      readonly value: string;
      readonly children?: readonly RecursiveNode[];
    };
    const recursiveNode: z.ZodType<RecursiveNode> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(recursiveNode).optional() }),
    );
    const schema = z.object({ root: recursiveNode.nullable() });

    // When
    const converted = zodToJsonSchemaCompat(schema, DRAFT_07_INPUT);

    // Then
    expect(converted.definitions).toBeDefined();
    expect(collectRefs(converted).some((ref) => ref.startsWith('#/definitions/'))).toBe(true);
  });

  it('sorts equal-rank metadata keys independently of insertion order', () => {
    // Given
    const zetaFirst = z.string().meta({ zeta: true, alpha: true });
    const alphaFirst = z.string().meta({ alpha: true, zeta: true });

    // When
    const firstJson = JSON.stringify(zodToJsonSchemaCompat(zetaFirst, DRAFT_07_INPUT));
    const secondJson = JSON.stringify(zodToJsonSchemaCompat(alphaFirst, DRAFT_07_INPUT));

    // Then
    expect(firstJson).toBe(secondJson);
    expect(firstJson).toBe(
      '{"type":"string","$schema":"http://json-schema.org/draft-07/schema#","alpha":true,"zeta":true}',
    );
  });
});
