import { z } from 'zod';

// Epoch milliseconds use the ECMAScript date domain, fixed 24-hour days, and no clock reads.
export const EpochMsSchema = z
  .number()
  .int()
  .min(-8_640_000_000_000_000)
  .max(8_640_000_000_000_000)
  .brand<'EpochMs'>();
export const ScoreSchema = z.number().min(0).max(1).brand<'RetentionScore'>();
export const FractionSchema = z.number().min(0).max(1).brand<'Fraction01'>();
export const DigestSchema = z.string().min(1).brand<'Digest'>();
// The resolver supplies lexicographically sortable keys, including an immutable attempt tie-break.
export const SequenceKeySchema = z
  .string()
  .min(1)
  .regex(/^[ -~]+$/)
  .brand<'EffectiveOrderKey'>();
export const VersionSchema = z.string().min(1).brand<'Version'>();
export const LearnerIdSchema = z.string().min(1).brand<'LearnerId'>();
export const SkillIdSchema = z.string().min(1).brand<'SkillId'>();
export const ContextKeySchema = z.string().min(1).brand<'ContextKey'>();
export type EpochMs = z.infer<typeof EpochMsSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type Fraction = z.infer<typeof FractionSchema>;
export type Digest = z.infer<typeof DigestSchema>;
export type SequenceKey = z.infer<typeof SequenceKeySchema>;
export type Version = z.infer<typeof VersionSchema>;
export type LearnerId = z.infer<typeof LearnerIdSchema>;
export type SkillId = z.infer<typeof SkillIdSchema>;
export type ContextKey = z.infer<typeof ContextKeySchema>;
export type Known<T> = Readonly<{ kind: 'known'; value: T } | { kind: 'unknown'; reason: string }>;
export const ScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('context'), key: ContextKeySchema }),
]);
export type Scope = z.infer<typeof ScopeSchema>;
export const VersionsSchema = z.object({
  model: VersionSchema,
  parameters: VersionSchema,
  mapping: VersionSchema,
  order: VersionSchema,
});
export type Versions = Readonly<z.infer<typeof VersionsSchema>>;
const knownSequence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), value: SequenceKeySchema }),
  z.object({ kind: z.literal('unknown'), reason: z.string() }),
]);
const knownContext = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), value: ContextKeySchema }),
  z.object({ kind: z.literal('unknown'), reason: z.string() }),
]);
export const EffectiveObservationSchema = z.object({
  learnerId: LearnerIdSchema,
  attemptId: z.string().min(1),
  effectiveJudgmentId: z.string().min(1),
  skillId: SkillIdSchema,
  context: knownContext,
  occurredAt: EpochMsSchema,
  orderKey: SequenceKeySchema,
  evidenceDigest: DigestSchema,
  quality: FractionSchema,
  weight: FractionSchema.refine((value) => value > 0),
  independent: z.boolean(),
  evidenceRefs: z.array(z.string()),
  mappingNotes: z.array(z.string()),
});
export type EffectiveObservation = Readonly<z.infer<typeof EffectiveObservationSchema>>;
export const MemoryStateSchema = z.object({
  schemaVersion: z.literal('memory-kernel-state-v1'),
  learnerId: LearnerIdSchema,
  skillId: SkillIdSchema,
  scope: ScopeSchema,
  versions: VersionsSchema,
  inputDigest: DigestSchema,
  through: knownSequence,
  // Exact normalized last input makes current-receipt retries verifiable without retaining a second history.
  lastApplied: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('known'), value: EffectiveObservationSchema }),
    z.object({ kind: z.literal('unknown'), reason: z.string() }),
  ]),
  projection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('cold') }),
    z.object({
      kind: z.literal('warm'),
      eventCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      fast: z.number().nonnegative(),
      slow: z.number().nonnegative(),
      lastAt: EpochMsSchema,
      independentMass: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
    }),
  ]),
});
export type MemoryState = Readonly<z.infer<typeof MemoryStateSchema>>;
export type AdaptedObservation =
  | { kind: 'included'; observation: EffectiveObservation }
  | { kind: 'excluded'; evidenceRefs: readonly string[]; reason: string };
export const AppendReceiptSchema = z.object({
  previousInputDigest: DigestSchema,
  nextInputDigest: DigestSchema,
  nextThrough: SequenceKeySchema,
});
export type AppendReceipt = Readonly<z.infer<typeof AppendReceiptSchema>>;
export type Evolution =
  | { kind: 'updated'; state: MemoryState }
  | { kind: 'duplicate'; state: MemoryState }
  | { kind: 'rebuild_required'; reason: string }
  | { kind: 'invalid'; reason: string };
export type MemoryModel = Readonly<{
  versions: Versions;
  provenance: 'engineering';
  fastHalfLifeDays: number;
  slowHalfLifeDays: number;
  fastWeight: Fraction;
  gain: number;
  failureRate: number;
  spacingDays: number;
}>;
export const MemoryViewSchema = z.object({
  global: MemoryStateSchema,
  context: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('known'), value: MemoryStateSchema }),
    z.object({ kind: z.literal('unknown'), reason: z.string() }),
  ]),
  requestedScope: ScopeSchema,
});
export type MemoryView = Readonly<z.infer<typeof MemoryViewSchema>>;
export type RetentionPoint =
  | {
      kind: 'score';
      asOf: EpochMs;
      value: Score;
      calibration: 'uncalibrated';
      interval: 'not_estimated';
      scope: 'global' | 'context_shrunk' | 'global_borrowed';
    }
  | { kind: 'unknown'; asOf: EpochMs; reason: string };
export type Due =
  | { kind: 'due_now'; at: EpochMs; target: Score }
  | { kind: 'scheduled'; at: EpochMs; target: Score; toleranceMs: number }
  | { kind: 'beyond_horizon'; checkedThrough: EpochMs; scoreThere: Score }
  | { kind: 'unknown'; reason: string }
  | { kind: 'invalid_input'; reason: string };
