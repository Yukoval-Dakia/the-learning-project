import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditAgentControlPlane } from './audit-agent-control-plane';

describe('agent control-plane audit', () => {
  it('keeps the checked-in guidance, hooks, and skills aligned', () => {
    expect(auditAgentControlPlane(resolve(import.meta.dirname, '..'))).toEqual([]);
  });
});
