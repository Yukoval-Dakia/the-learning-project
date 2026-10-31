// Named advisory-lock key templates. Helpers derive the lock argument here and
// keep their existing SQL. This module does not acquire locks and does not record
// or prove a lock order.

export type HashtextLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtext';
  /** Exact text passed to hashtext(). */
  readonly key: string;
};

export type HashtextTemplateLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtext';
  /** Stable prefix, including the separator before the first suffix field. */
  readonly keyPrefix: string;
  /** Suffix field names, joined with ':' in this order after keyPrefix. */
  readonly suffixFields: readonly string[];
  readonly template: true;
};

export type IntLiteralLockNamespace = {
  readonly family: string;
  readonly encoding: 'int-literal';
  /** Exact single-argument advisory-lock key. */
  readonly key: number;
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

export type HashtextExtendedIdentityLockNamespace = {
  readonly family: string;
  readonly encoding: 'hashtextextended';
  /** Literal second argument. The text argument is the caller id, unchanged. */
  readonly salt: 0 | 1;
  readonly identity: true;
};

export type AdvisoryLockNamespace =
  | HashtextLockNamespace
  | HashtextTemplateLockNamespace
  | IntLiteralLockNamespace
  | HashtextExtendedLockNamespace
  | HashtextExtendedIdentityLockNamespace;

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
  probeServeCap: {
    family: 'probe-serve-cap',
    encoding: 'int-literal',
    key: 406_440_3,
  },
  probeQuestion: {
    family: 'probe-question',
    encoding: 'hashtextextended',
    salt: 0,
    identity: true,
  },
  conjectureFold: {
    family: 'conjecture-fold',
    encoding: 'hashtextextended',
    salt: 1,
    identity: true,
  },
  interventionDeliver: {
    family: 'intervention-deliver',
    encoding: 'hashtext',
    keyPrefix: 'intervention:deliver:',
    suffixFields: ['questionId'],
    template: true,
  },
  streamCompose: {
    family: 'stream-compose',
    encoding: 'hashtext',
    keyPrefix: 'stream:compose:',
    suffixFields: ['date'],
    template: true,
  },
} as const satisfies Record<string, AdvisoryLockNamespace>;

export function deriveHashtextTemplateLockKey<const Fields extends readonly string[]>(
  namespace: {
    readonly encoding: 'hashtext';
    readonly keyPrefix: string;
    readonly suffixFields: Fields;
    readonly template: true;
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

export function deriveIntLiteralLockKey<T extends number>(namespace: {
  readonly encoding: 'int-literal';
  readonly key: T;
}): T {
  return namespace.key;
}

/** A prefix would hash a different key, so the text argument stays the caller id. */
export function deriveHashtextExtendedIdentityLock<S extends 0 | 1>(
  namespace: {
    readonly encoding: 'hashtextextended';
    readonly salt: S;
    readonly identity: true;
  },
  id: string,
): { readonly key: string; readonly salt: S } {
  return { key: id, salt: namespace.salt };
}
