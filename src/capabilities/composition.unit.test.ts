import { validateComposition } from '@/kernel/manifest';
import { describe, expect, it } from 'vitest';
import { capabilities } from './index';

describe('composition root', () => {
  it('passes composition validation', () => {
    expect(() => validateComposition(capabilities)).not.toThrow();
  });
});
