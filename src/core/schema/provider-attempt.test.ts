import { describe, expect, it } from 'vitest';
import {
  CurrencyCode,
  ProviderAttemptTerminalEvidence,
  ProviderAttemptUsageTruth,
  ProviderRequestIdentity,
} from './provider-attempt';

const IDENTITY = {
  attemptId: '00000000-0000-4000-8000-000000000851',
  operationId: '00000000-0000-4000-8000-000000000852',
  attemptKind: 'wire',
  provider: 'xiaomi',
  model: 'mimo-v2.5',
  lane: 'generation',
  protocol: 'anthropic-compatible',
  endpointClass: 'messages',
  caller: 'worker',
  operationKind: 'QuestionGenerateTask',
} as const;

describe('ProviderAttempt schemas', () => {
  it('parses a strict readonly provider-attempt identity', () => {
    // Given a complete public identity.
    const input = { ...IDENTITY, externalRequestId: 'provider-request-1' };

    // When it crosses the schema boundary.
    const parsed = ProviderRequestIdentity.parse(input);

    // Then every identity dimension is retained.
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('canonicalizes UUID identity fields before branding', () => {
    // Given UUIDs containing uppercase hexadecimal digits.
    const input = {
      ...IDENTITY,
      attemptId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      operationId: 'BbBbBbBb-BbBb-4bBb-8bBb-BbBbBbBbBbBb',
    };

    // When the identity crosses the schema boundary.
    const parsed = ProviderRequestIdentity.parse(input);

    // Then storage and fingerprint inputs use one canonical lowercase spelling.
    expect(parsed.attemptId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(parsed.operationId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('brands only canonical ISO currency codes', () => {
    // Given a canonical and several malformed currency values.
    // When/Then only the canonical boundary value is accepted.
    expect(CurrencyCode.parse('USD')).toBe('USD');
    expect(CurrencyCode.safeParse('usd').success).toBe(false);
    expect(CurrencyCode.safeParse('US').success).toBe(false);
    expect(CurrencyCode.safeParse('US1').success).toBe(false);
  });

  it('rejects unknown identity fields', () => {
    // Given an identity with an undeclared field.
    const input = { ...IDENTITY, retry: 1 };

    // When/Then strict parsing rejects it.
    expect(ProviderRequestIdentity.safeParse(input).success).toBe(false);
  });

  it('requires known usage to contain at least one finite nonnegative value', () => {
    // Given known usage with no measured quantity.
    const emptyKnown = {
      basis: 'reported',
      unit: 'tokens',
      input: null,
      output: null,
      total: null,
      source: 'sdk:usage',
    };

    // When/Then it is rejected, while explicit measured zero remains valid.
    expect(ProviderAttemptUsageTruth.safeParse(emptyKnown).success).toBe(false);
    expect(ProviderAttemptUsageTruth.parse({ ...emptyKnown, input: 0 })).toMatchObject({
      basis: 'reported',
      input: 0,
    });
    expect(ProviderAttemptUsageTruth.safeParse({ ...emptyKnown, input: Number.NaN }).success).toBe(
      false,
    );
    expect(ProviderAttemptUsageTruth.safeParse({ ...emptyKnown, input: -1 }).success).toBe(false);
  });

  it('represents unknown usage and cost with null rather than synthetic zero', () => {
    // Given a terminal attempt whose provider exposed no accounting values.
    const input = {
      terminal: 'unknown',
      reason: 'provider stream ended without a terminal frame',
      wireCount: null,
      usage: {
        basis: 'unknown',
        unit: null,
        input: null,
        output: null,
        total: null,
        source: 'provider:no-usage',
      },
      cost: {
        basis: 'unknown',
        amount: null,
        currency: null,
        source: 'pricebook:no-entry',
      },
    } as const;

    // When it crosses the terminal evidence boundary.
    const parsed = ProviderAttemptTerminalEvidence.parse(input);

    // Then unknown values remain explicitly null.
    expect(parsed.usage.input).toBeNull();
    expect(parsed.cost.amount).toBeNull();
  });

  it('accepts reported zero cost but rejects malformed truth shapes', () => {
    // Given a successful zero-cost provider attempt.
    const valid = {
      terminal: 'succeeded',
      reason: 'completed',
      wireCount: 1,
      usage: {
        basis: 'reported',
        unit: 'tokens',
        input: 0,
        output: 0,
        total: 0,
        source: 'sdk:usage',
      },
      cost: {
        basis: 'reported',
        amount: 0,
        currency: 'USD',
        source: 'sdk:total_cost',
      },
    } as const;

    // When/Then explicit zero is valid and noncanonical currency is not.
    expect(ProviderAttemptTerminalEvidence.parse(valid).cost.amount).toBe(0);
    expect(
      ProviderAttemptTerminalEvidence.safeParse({
        ...valid,
        cost: { ...valid.cost, currency: 'usd' },
      }).success,
    ).toBe(false);
  });

  it('trims only for nonblank validation and preserves terminal reason verbatim', () => {
    // Given evidence whose reason has meaningful original spacing.
    const input = {
      terminal: 'aborted',
      reason: '  caller cancelled  ',
      wireCount: 1,
      usage: {
        basis: 'unknown',
        unit: null,
        input: null,
        output: null,
        total: null,
        source: 'provider:no-usage',
      },
      cost: {
        basis: 'unknown',
        amount: null,
        currency: null,
        source: 'provider:no-cost',
      },
    } as const;

    // When it parses, Then the original reason is retained and blank is rejected.
    expect(ProviderAttemptTerminalEvidence.parse(input).reason).toBe(input.reason);
    expect(ProviderAttemptTerminalEvidence.safeParse({ ...input, reason: '   ' }).success).toBe(
      false,
    );
  });
});
