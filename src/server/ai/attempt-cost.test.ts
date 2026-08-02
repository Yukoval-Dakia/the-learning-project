import { describe, expect, it } from 'vitest';
import { ANTHROPIC_SUB_CONTRACT_REF, ATTEMPT_PRICEBOOK_VERSION } from './pricing';
import { resolveAttemptCostTruth } from './attempt-cost';

const tokens = { inputTokens: 1000, outputTokens: 500 };

describe('resolveAttemptCostTruth', () => {
  it('accepts Anthropic direct reported zero and positive amounts', () => {
    expect(
      resolveAttemptCostTruth({
        provider: 'anthropic',
        model: 'claude-sonnet',
        tokens,
        reportedCostUsd: 0,
      }),
    ).toEqual({ basis: 'reported', amountUsd: 0, ref: 'sdk:total_cost_usd' });
    expect(
      resolveAttemptCostTruth({
        provider: 'anthropic',
        model: 'claude-sonnet',
        tokens,
        reportedCostUsd: 0.42,
      }),
    ).toEqual({ basis: 'reported', amountUsd: 0.42, ref: 'sdk:total_cost_usd' });
  });

  it('classifies Xiaomi placeholder zero as a versioned estimate', () => {
    const truth = resolveAttemptCostTruth({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      tokens,
      reportedCostUsd: 0,
    });

    expect(truth.basis).toBe('estimated');
    expect(truth.amountUsd).toBeGreaterThan(0);
    expect(truth.ref).toBe(`pricebook:${ATTEMPT_PRICEBOOK_VERSION}/xiaomi/mimo-v2.5-pro`);
    expect(resolveAttemptCostTruth({ provider: 'xiaomi', model: 'mimo-v2.5-pro', tokens })).toEqual(
      truth,
    );
  });

  it('keeps an unpriced Xiaomi model unknown/null', () => {
    expect(
      resolveAttemptCostTruth({
        provider: 'xiaomi',
        model: 'mimo-future',
        tokens,
        reportedCostUsd: 0,
      }),
    ).toEqual({ basis: 'unknown', amountUsd: null, ref: 'unpriced:xiaomi/mimo-future' });
  });

  it('refuses a non-finite or negative local estimate', () => {
    for (const inputTokens of [Number.NaN, -1000]) {
      expect(
        resolveAttemptCostTruth({
          provider: 'xiaomi',
          model: 'mimo-v2.5-pro',
          tokens: { inputTokens, outputTokens: 0 },
        }),
      ).toEqual({
        basis: 'unknown',
        amountUsd: null,
        ref: 'unpriced:xiaomi/mimo-v2.5-pro',
      });
    }
  });

  it('uses an explicit flat-subscription contract reference', () => {
    expect(
      resolveAttemptCostTruth({
        provider: 'anthropic-sub',
        model: 'claude-opus-4-8',
        tokens,
        reportedCostUsd: 0,
      }),
    ).toEqual({ basis: 'estimated', amountUsd: 0, ref: ANTHROPIC_SUB_CONTRACT_REF });
  });

  it('treats compatibility zero, missing, negative, and NaN as unknown when unpriced', () => {
    for (const reportedCostUsd of [0, undefined, -1, Number.NaN]) {
      expect(
        resolveAttemptCostTruth({
          provider: 'zhipu',
          model: 'glm-5.2',
          tokens,
          reportedCostUsd,
        }),
      ).toEqual({ basis: 'unknown', amountUsd: null, ref: 'unpriced:zhipu/glm-5.2' });
    }
  });

  it('accepts a positive compatibility SDK amount as reported evidence', () => {
    expect(
      resolveAttemptCostTruth({
        provider: 'zhipu',
        model: 'glm-5.2',
        tokens,
        reportedCostUsd: 0.1,
      }),
    ).toEqual({ basis: 'reported', amountUsd: 0.1, ref: 'sdk:total_cost_usd' });
  });
});
