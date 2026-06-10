import { validateComposition } from '@/kernel/manifest';
import { describe, expect, it } from 'vitest';
import { capabilities } from './index';

describe('composition root', () => {
  it('passes composition validation', () => {
    expect(() => validateComposition(capabilities)).not.toThrow();
  });

  it('includes the agent-notes pilot capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('agent-notes');
  });

  it('includes the practice capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('practice');
  });

  it('includes the ingestion capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('ingestion');
  });
});
