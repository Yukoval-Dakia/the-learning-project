import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProviderAttemptLifecycle source boundary', () => {
  it('stays unwired from runner and run lifecycle and never writes the legacy cost ledger', () => {
    // Given the new lifecycle and the two locked existing runtime seams.
    const root = process.cwd();
    const lifecycle = readFileSync(
      join(root, 'src/server/ai/provider-attempt-lifecycle.ts'),
      'utf8',
    );
    const runner = readFileSync(join(root, 'src/server/ai/runner.ts'), 'utf8');
    const runLifecycle = readFileSync(join(root, 'src/server/ai/run-lifecycle.ts'), 'utf8');

    // When source boundaries are inspected, Then no caller migration or legacy ledger write exists.
    expect(runner).not.toContain('provider-attempt-lifecycle');
    expect(runLifecycle).not.toContain('provider-attempt-lifecycle');
    expect(lifecycle).not.toContain('cost_ledger');
    expect(lifecycle).not.toContain('provider_session_admission');
  });
});
