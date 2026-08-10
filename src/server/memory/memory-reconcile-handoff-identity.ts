import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MEMORY_RECONCILE_HANDOFF_ACTION = 'experimental:memory_reconcile_handoff';
export const MEMORY_RECONCILE_HANDOFF_VERSION = 1;
export const MEMORY_RECONCILE_HANDOFF_KINDS = {
  addStarted: 'add_started',
  ingestCompleted: 'ingest_completed',
  reconcileIntent: 'reconcile_intent',
  reconcileDispatchComplete: 'reconcile_dispatch_complete',
  recoveryCursor: 'recovery_cursor',
} as const;
export type ReconcileMemInput = {
  readonly id: string;
  readonly text: string;
  readonly created_ms: number;
  readonly kind: string;
};
export const ReconcileMemInputSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    created_ms: z.number().int(),
    kind: z.string().min(1),
  })
  .strict();

export class MemoryReconcileHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryReconcileHandoffError';
  }
}

export function canonicalHandoffJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalHandoffJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalHandoffJson(item)}`)
    .join(',')}}`;
}

export function normalizeReconcileInputs(
  inputs: readonly ReconcileMemInput[],
): readonly ReconcileMemInput[] {
  const byId = new Map<string, ReconcileMemInput>();
  for (const raw of inputs) {
    const input = ReconcileMemInputSchema.parse(raw);
    const prior = byId.get(input.id);
    if (prior && canonicalHandoffJson(prior) !== canonicalHandoffJson(input)) {
      throw new MemoryReconcileHandoffError(`conflicting duplicate Mem0 result id ${input.id}`);
    }
    byId.set(input.id, input);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function memoryIntentDigest(inputs: readonly ReconcileMemInput[]): string {
  return createHash('sha256')
    .update(canonicalHandoffJson(normalizeReconcileInputs(inputs)))
    .digest('hex');
}

export function memoryReconcileHandoffEventId(
  kind: string,
  sourceId: string,
  memoryId = '',
): string {
  const hash = createHash('sha256')
    .update(`memory-reconcile-v1\0${kind}\0${sourceId}\0${memoryId}`)
    .digest('hex');
  return `memory_reconcile_v1_${kind}_${hash.slice(0, 24)}`;
}
