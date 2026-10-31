// Named advisory-lock key templates. Helpers derive the hashtext argument here and
// keep their existing SQL. This module does not acquire locks and does not record
// or prove a lock order.

export type AdvisoryLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtext';
  /** Exact text passed to hashtext(). */
  readonly key: string;
};

export const advisoryLockRegistry = {
  learningStateWrite: {
    family: 'learning-state:write',
    encoding: 'hashtext',
    key: 'learning-state:write',
  },
} as const satisfies Record<string, AdvisoryLockNamespace>;

export function deriveHashtextLockKey<T extends string>(namespace: {
  readonly encoding: 'hashtext';
  readonly key: T;
}): T {
  return namespace.key;
}
