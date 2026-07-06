// YUK-572 PR-2 review fix (MAJOR #1) — pure exit-code decision table for the E-1..E-4
// harness. Before this fix, `process.exit(blockingOk && e1 ? 0 : e2Inconclusive ? 3 : 2)`
// used `blockingOk = (e2Pass || e2Inconclusive) && e3 && e4` — treating an INCONCLUSIVE
// E-2 (flat OAuth lane, total_cost_usd=0, cost aggregation unmeasurable) as a PASS and
// exiting 0, directly contradicting the file's own header ("E-2 ... NOT a pass"). This
// pins the corrected contract: INCONCLUSIVE must NEVER exit 0.
//
// Round-2 review MAJOR #1 fix: the round-1 formula ALSO let an inconclusive E-2 mask a
// genuine E-3/E-4 failure (exit 3 even when e3/e4 are false) — a developer skimming only
// the "E-2 INCONCLUSIVE" line could miss a real blocking failure and flip the flag
// anyway. Exit 3 is now reserved for the case where E-3 AND E-4 are BOTH independently
// confirmed passing (the ONLY reason blockingOk is false is E-2's unmeasured delta).

import { describe, expect, it } from 'vitest';
import { classifyE2, computeExitCode } from './yuk572-e1-e4-spawn-checks';

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

  it('round-2 fix: exits 2 (NOT 3) when e3/e4 genuinely fail even though E-2 is inconclusive — inconclusive must never mask a real blocking failure', () => {
    // This is the exact regression review round-2 MAJOR #1 flagged: the round-1 formula
    // returned 3 here, letting a developer who only reads "E-2 INCONCLUSIVE" miss that
    // E-3/E-4 genuinely failed and flip the flag anyway.
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: true, e3: false, e4: false }),
    ).toBe(2);
  });

  it('exits 3 only when e3 AND e4 are BOTH independently confirmed passing (the only reason blockingOk failed is E-2)', () => {
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: true, e3: true, e4: false }),
    ).toBe(2); // e4 alone failing still routes to 2, not 3
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: true, e3: false, e4: true }),
    ).toBe(2); // e3 alone failing still routes to 2, not 3
  });

  it('exits 2 (not 3) when E-2 genuinely fails but is NOT inconclusive (cost measured, but no delta)', () => {
    expect(
      computeExitCode({ e1: true, e2Pass: false, e2Inconclusive: false, e3: true, e4: true }),
    ).toBe(2);
  });
});

describe('classifyE2 — round-2 review MINOR #4 (null cost vs literal-zero cost)', () => {
  it('is INCONCLUSIVE with a MISSING-field message when either cost is null (SDK regression, not a flat zero)', () => {
    const r = classifyE2(null, 0.01);
    expect(r.e2Inconclusive).toBe(true);
    expect(r.e2Pass).toBe(false);
    expect(r.reasonLine).toMatch(/MISSING/);
  });

  it('is INCONCLUSIVE with a flat-rate-zero message when spawnCost is literal 0 (measured, not missing)', () => {
    const r = classifyE2(0, 0);
    expect(r.e2Inconclusive).toBe(true);
    expect(r.e2Pass).toBe(false);
    expect(r.reasonLine).toMatch(/flat OAuth lane/);
    expect(r.reasonLine).not.toMatch(/MISSING/);
  });

  it('passes when both costs are measured and spawn cost exceeds no-spawn cost', () => {
    const r = classifyE2(0.05, 0.01);
    expect(r.e2Pass).toBe(true);
    expect(r.e2Inconclusive).toBe(false);
  });

  it('fails (not inconclusive) when spawn cost is measured-nonzero but does not exceed no-spawn cost', () => {
    const r = classifyE2(0.01, 0.01);
    expect(r.e2Pass).toBe(false);
    expect(r.e2Inconclusive).toBe(false);
  });
});
