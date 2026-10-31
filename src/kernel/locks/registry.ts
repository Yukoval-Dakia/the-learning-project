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

/** hashtextextended text with no suffix. Distinct from a prefix so a fixed key cannot gain a trailing field. */
export type HashtextExtendedExactLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtextextended';
  readonly salt: 0;
  /** Exact text passed to hashtextextended(). */
  readonly key: string;
};

export type AdvisoryLockNamespace =
  | HashtextLockNamespace
  | HashtextExtendedLockNamespace
  | HashtextExtendedExactLockNamespace;

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
  interventionInstance: {
    family: 'intervention-instance',
    encoding: 'hashtextextended',
    salt: 0,
    keyPrefix: 'intervention:',
    suffixFields: ['interventionId', 'version'],
  },
  interventionCorrectionsAll: {
    family: 'intervention-corrections-all',
    encoding: 'hashtextextended',
    salt: 0,
    key: 'intervention:corrections:all',
  },
  interventionSource: {
    family: 'intervention-source',
    encoding: 'hashtextextended',
    salt: 0,
    keyPrefix: 'intervention:source:',
    suffixFields: ['eventId'],
  },
} as const satisfies Record<string, AdvisoryLockNamespace>;

export function deriveHashtextLockKey<T extends string>(namespace: {
  readonly encoding: 'hashtext';
  readonly key: T;
}): T {
  return namespace.key;
}

export function deriveHashtextExtendedExactLockKey<T extends string>(namespace: {
  readonly encoding: 'hashtextextended';
  readonly salt: 0;
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
