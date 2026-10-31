// Named advisory-lock key templates. Helpers derive the hash argument here and
// keep their existing SQL. This module does not acquire locks and does not record
// or prove a lock order.

export type HashtextLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtext';
  /** Exact text passed to hashtext(). */
  readonly key: string;
};

export type HashtextExtendedLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtextextended';
  /** Literal second argument of hashtextextended. Only salt 0 is registered. */
  readonly salt: 0;
  /** Stable prefix, including the separator before the first suffix field. */
  readonly keyPrefix: string;
  /** Suffix field names, joined with ':' in this order after keyPrefix. */
  readonly suffixFields: readonly string[];
};

export type AdvisoryLockNamespace = HashtextLockNamespace | HashtextExtendedLockNamespace;

export const advisoryLockRegistry = {
  learningStateWrite: {
    family: 'learning-state:write',
    encoding: 'hashtext',
    key: 'learning-state:write',
  },
  providerAttempt: {
    family: 'provider-attempt',
    encoding: 'hashtextextended',
    salt: 0,
    keyPrefix: 'provider-attempt:',
    suffixFields: ['attemptId'],
  },
  providerAttemptLane: {
    family: 'provider-attempt-lane',
    encoding: 'hashtextextended',
    salt: 0,
    keyPrefix: 'provider-attempt-lane:',
    suffixFields: ['lane'],
  },
  providerAttemptOperationKind: {
    family: 'provider-attempt-operation-kind',
    encoding: 'hashtextextended',
    salt: 0,
    keyPrefix: 'provider-attempt-operation-kind:',
    suffixFields: ['operationId', 'provider', 'lane', 'operationKind'],
  },
} as const satisfies Record<string, AdvisoryLockNamespace>;

export function deriveHashtextLockKey<T extends string>(namespace: {
  readonly encoding: 'hashtext';
  readonly key: T;
}): T {
  return namespace.key;
}

export function deriveHashtextExtendedLockKey<const Fields extends readonly string[]>(
  namespace: {
    readonly encoding: 'hashtextextended';
    readonly salt: 0;
    readonly keyPrefix: string;
    readonly suffixFields: Fields;
  },
  parts: { readonly [K in Fields[number]]: string },
): string {
  const segments: string[] = [];
  for (const field of namespace.suffixFields) {
    // for-of widens a generic tuple element to string.
    segments.push(parts[field as Fields[number]]);
  }
  return `${namespace.keyPrefix}${segments.join(':')}`;
}
