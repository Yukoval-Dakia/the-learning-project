import { z } from 'zod';
import fixtureData from './data.json' with { type: 'json' };

// P-1 (2026-05-22): fixture schema is subject-local — does NOT touch
// framework schema (src/core/schema/*). Adds 4 physics-specific fields
// (reference_value / reference_unit / tolerance / expected_signals) for
// P2 unit_dimension@1 4 错误路径 test coverage.
// See docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md §3 P-1 #3.

export const ExpectedSignal = z.enum([
  'numeric_close',
  'numeric_off',
  'unit_mismatch_same_dimension',
  'dimension_mismatch',
  'missing_unit',
]);
export type ExpectedSignalT = z.infer<typeof ExpectedSignal>;

export const PhysicsFixtureTestCase = z.object({
  case: z.string().min(1),
  student_answer: z.string().min(1),
  expected_signal: ExpectedSignal,
});
export type PhysicsFixtureTestCaseT = z.infer<typeof PhysicsFixtureTestCase>;

export const PhysicsFixtureItemSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum(['single_choice', 'calculation']),
  prompt_md: z.string().min(1),
  choices_md: z.array(z.string().min(1)).optional(),
  reference_md: z.string().min(1),
  reference_value: z.number().optional(),
  reference_unit: z.string().optional(),
  tolerance: z.number().min(0).default(0.05),
  difficulty: z.number().int().min(1).max(5),
  knowledge_hint: z.string().min(1),
  expected_signals: z.array(PhysicsFixtureTestCase).min(1),
});
export type PhysicsFixtureItemT = z.infer<typeof PhysicsFixtureItemSchema>;

export const PhysicsFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('physics'),
  items: z.array(PhysicsFixtureItemSchema).length(10),
});

export function loadPhysicsFixtures(): PhysicsFixtureItemT[] {
  return PhysicsFixtureFileSchema.parse(fixtureData).items;
}
