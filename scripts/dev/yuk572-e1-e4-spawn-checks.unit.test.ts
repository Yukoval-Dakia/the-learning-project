// YUK-572 PR-2 review fix (MAJOR #1) — pure exit-code decision table for the E-1..E-4
// harness. Before this fix, `process.exit(blockingOk && e1 ? 0 : e2Inconclusive ? 3 : 2)`
// used `blockingOk = (e2Pass || e2Inconclusive) && e3 && e4` — treating an INCONCLUSIVE
// E-2 (flat OAuth lane, total_cost_usd=0, cost aggregation unmeasurable) as a PASS and
// exiting 0, directly contradicting the file's own header ("E-2 ... NOT a pass"). This
// pins the corrected contract: INCONCLUSIVE must NEVER exit 0.

import { describe, expect, it } from 'vitest';
import { computeExitCode } from './yuk572-e1-e4-spawn-checks';

const allPass = { e1: true, e2Pass: true, e2Inconclusive: false, e3: true, e4: true };

describe('computeExitCode', () => {
  it('exits 0 only when e1 AND all three blocking checks (e2Pass/e3/e4) pass', () => {
    expect(computeExitCode(allPass)).toBe(0);
  });

  it('exits 2 (fail) when e1 fails even though e2/e3/e4 all pass', () => {
    expect(computeExitCode({ ...allPass, e1: false })).toBe(2);
  });

  it('exits 2 when e3 (mcpServers resolution) fails', () => {
    expect(computeExitCode({ ...allPass, e3: false })).toBe(2);
  });

  it('exits 2 when e4 (bypassPermissions hook-deny) fails', () => {
    expect(computeExitCode({ ...allPass, e4: false })).toBe(2);
  });

  it('NEVER exits 0 when E-2 is inconclusive — exits 3 (manual cost-aggregation check required)', () => {
    // total_cost_usd===0 on the flat OAuth lane ⇒ e2Pass is necessarily false alongside
    // e2Inconclusive in the real harness, but this pins the CONTRACT directly regardless:
    // inconclusive can never masquerade as a pass. This is the exact regression the
    // review flagged — the old `(e2Pass || e2Inconclusive)` blockingOk formula would have
    // returned 0 here.
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: true, e3: true, e4: true }),
    ).toBe(3);
  });

  it('exits 3 for inconclusive even when e3/e4 also fail (inconclusive takes precedence over generic fail)', () => {
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: true, e3: false, e4: false }),
    ).toBe(3);
  });

  it('exits 2 (not 3) when E-2 genuinely fails but is NOT inconclusive (cost measured, but no delta)', () => {
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: false, e3: true, e4: true }),
    ).toBe(2);
  });
});
