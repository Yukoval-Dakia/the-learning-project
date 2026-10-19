import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { auditCapabilityBoundaries } from './audit-capability-boundaries';

// @invariant security: YUK-1570 owner-approved architecture boundary ratchet rejects unrecorded debt reduction.
// @fails-if the public audit treats a lower measured pair count as success without tightening the baseline.
test('rejects reduced dependencies until the baseline is tightened', () => {
  const root = mkdtempSync(join(tmpdir(), 'capability-ratchet-'));
  try {
    const baseline = auditCapabilityBoundaries(root).dependencySnapshot;
    expect(auditCapabilityBoundaries(root, baseline).ok).toBe(true);
    baseline.debts.capabilityToServer.byOwnerPair['practice -> ai'] = 1;
    baseline.debts.capabilityToServer.total = 1;
    const result = auditCapabilityBoundaries(root, baseline);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.source === 'practice -> ai')).toBe(true);
  } finally {
    rmSync(root, { recursive: true });
  }
});
