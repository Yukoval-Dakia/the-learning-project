import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  PlacementStarterFailureSchema,
  placementSchemaFailure,
  readPlacementStarterFailure,
} from './placement-starter-outcome';

describe('placement failure privacy boundary', () => {
  it('retains bounded schema paths and codes without provider messages, values or dynamic keys', () => {
    const secret = 'provider-secret-and-private-prompt'.repeat(100);
    const issues: z.ZodIssue[] = Array.from({ length: 24 }, (_, i) => ({
      code: 'custom',
      path: [
        'questions',
        i,
        'rubric_json',
        'reference_solution',
        secret,
        ...Array(20).fill('final_answer'),
      ],
      message: secret,
      params: { output: secret },
    }));
    const reason = PlacementStarterFailureSchema.parse(placementSchemaFailure(issues));
    expect(reason.code).toBe('schema_invalid');
    if (reason.code !== 'schema_invalid') throw new Error('expected schema failure');
    expect(reason.issues).toHaveLength(16);
    expect(reason.issue_count).toBe(24);
    expect(reason.issues_truncated).toBe(true);
    expect(reason.issues[0]?.path.slice(0, 5)).toEqual([
      'questions',
      0,
      'rubric_json',
      'reference_solution',
      '[redacted]',
    ]);
    expect(reason.issues.every((issue) => issue.path.length === 12 && issue.path_truncated)).toBe(
      true,
    );
    expect(JSON.stringify(reason)).not.toContain(secret);
    expect(JSON.stringify(reason)).not.toContain('message');
    expect(JSON.stringify(reason)).not.toContain('params');
  });

  it('does not expose free text or forged schema reasons from historical error columns', () => {
    const secret = 'private-provider-output';
    for (const last_error of [
      secret,
      JSON.stringify({
        code: 'schema_invalid',
        issues: [{ code: 'custom', path: [secret], path_truncated: false }],
        issue_count: 1,
        issues_truncated: false,
      }),
      JSON.stringify({ code: 'interrupted', message: secret }),
    ]) {
      expect(
        readPlacementStarterFailure({
          last_error_class: 'placement_starter_failure_v1',
          last_error_code: 'schema_invalid',
          last_error,
        }),
      ).toEqual({ code: 'unknown' });
    }
    expect(
      readPlacementStarterFailure({
        last_error_class: null,
        last_error_code: null,
        last_error: secret,
      }),
    ).toEqual({ code: 'unknown' });
  });
});
